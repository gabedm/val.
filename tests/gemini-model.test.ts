import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { GoogleAuth } from "google-auth-library";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { GeminiModelClient, geminiConversationModel, geminiModel } from "../src/server/gemini-model";
import { createModelClient } from "../src/server/model-client";
import { runModelTask } from "../src/server/responses-loop";
import { modelVersion } from "../src/server/model-settings";
import { boundedJudgeRequest, modelCostMicros } from "../src/server/judge-budget";
import { modelAvailabilityError, transientModelRetryDelay } from "../src/server/model-availability";
import { ModelServiceError } from "../src/server/model-service-error";
import { responseSources } from "../src/server/live-discovery";
import { searchAttributions } from "../src/server/search-attributions";
import { SearchAttributions } from "../src/client/SearchAttributions";

const config = { project: "example-val-project", location: "global" };
const schema = {
  type: "object",
  properties: { reply: { type: "string" } },
  required: ["reply"],
  additionalProperties: false,
};
const request = (): ResponseCreateParamsNonStreaming => ({
  model: geminiModel,
  store: false,
  instructions: "Help with subscription needs.",
  input: [{ role: "user", content: "Offline music, only me." }],
  text: { format: { type: "json_schema", name: "Answer", schema, strict: true } },
});
function native(parts: object[], extra: object = {}) {
  return {
    responseId: "google-test",
    modelVersion: geminiModel,
    candidates: [{ content: { role: "model", parts }, finishReason: "STOP" }],
    usageMetadata: {
      promptTokenCount: 100,
      candidatesTokenCount: 20,
      thoughtsTokenCount: 30,
      toolUsePromptTokenCount: 40,
      cachedContentTokenCount: 50,
    },
    ...extra,
  };
}
function fixture(values: object[]) {
  const calls: {
    url: string;
    body?: any;
    headers?: HeadersInit;
    method?: string;
    redirect?: RequestRedirect;
  }[] = [];
  const token = vi.fn(async () => "synthetic-test-token");
  const transport = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers,
      method: init?.method,
      redirect: init?.redirect,
    });
    if (init?.method === "HEAD")
      return new Response(null, { status: 302, headers: { location: "https://provider.com/pricing" } });
    if (!values.length) throw new Error("Unexpected provider call.");
    const value = values.shift();
    return value instanceof Response ? value : Response.json(value);
  }) as unknown as typeof fetch;
  return { calls, token, model: new GeminiModelClient(config, transport, token) };
}

describe("Google Cloud Gemini adapter", () => {
  it("routes conversation to the fast model while retaining the research model and its receipts", async () => {
    const { model, calls, token } = fixture([
      native([{ text: '{"reply":"conversation"}' }]),
      native([{ text: '{"reply":"research"}' }]),
    ]);
    const conversation = model.forConversation();
    const chatRequest = { ...request(), model: geminiConversationModel };
    await expect(conversation.responses.create(chatRequest)).resolves.toMatchObject({
      output_text: '{"reply":"conversation"}',
    });
    await model.responses.create(request());
    expect(calls[0]!.url).toContain(`/models/${geminiConversationModel}:`);
    expect(calls[0]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(calls[1]!.url).toContain(`/models/${geminiModel}:`);
    expect(calls[1]!.body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: "LOW" });
    expect(token).toHaveBeenCalledTimes(2);
    const version = { model: "original", fingerprint: "original" };
    expect(modelVersion(version, conversation)).toMatchObject({
      model: geminiConversationModel,
      reasoning: "thinking.minimal",
    });
    expect(modelVersion(version, conversation).fingerprint).not.toBe(
      modelVersion(version, model).fingerprint,
    );
    expect(() => boundedJudgeRequest(chatRequest, model)).toThrow(/not available/);
    expect(() => boundedJudgeRequest(request(), conversation)).toThrow(/not available/);
    expect(boundedJudgeRequest(chatRequest, conversation).reserveMicros).toBeLessThan(
      boundedJudgeRequest(request(), model).reserveMicros,
    );
  });

  it("settles the actual conversation model's token rates without repricing research or assuming free searches", () => {
    for (const date of ["2026-11-12T00:00:00Z", "2027-01-01T00:00:00Z"]) {
      const at = new Date(date);
      expect(modelCostMicros(1000, 100, 0, "google", 0, at, geminiConversationModel)).toBe(400);
      expect(modelCostMicros(1000, 100, 0, "google", 500, at, geminiConversationModel)).toBe(288);
      expect(modelCostMicros(1000, 100, 1, "google", 0, at, geminiConversationModel)).toBe(14400);
      expect(modelCostMicros(1000, 100, 0, "google", 1001, at, geminiConversationModel)).toBe(400);
      expect(modelCostMicros(1000, 100, 0, "google", 0, at, geminiModel)).toBe(
        modelCostMicros(1000, 100, 0, "google", 0, at),
      );
    }
  });

  it("recovers credential initialization on the next request after a transient failure", async () => {
    const auth = vi
      .spyOn(GoogleAuth.prototype, "getClient")
      .mockRejectedValueOnce(new Error("Temporary credential discovery failure"))
      .mockResolvedValue({ getAccessToken: async () => ({ token: "test-token" }) } as any);
    const transport = vi.fn(async () => Response.json(native([{ text: '{"reply":"ready"}' }])));
    const model = new GeminiModelClient(config, transport);
    try {
      await expect(model.responses.create(request())).rejects.toMatchObject({ status: 401 });
      await expect(model.responses.create(request())).resolves.toMatchObject({
        status: "completed",
        output_text: '{"reply":"ready"}',
      });
      expect(auth).toHaveBeenCalledTimes(2);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      auth.mockRestore();
    }
  });

  it("retains successful page receipts and exact usage when a separate citation redirect fails", async () => {
    const transport = vi.fn(async (_url: any, init?: RequestInit) => {
      if (init?.method === "HEAD") throw new TypeError("Citation service unavailable");
      return Response.json(
        native([], {
          candidates: [
            {
              content: { role: "model", parts: [{ text: '{"reply":"Retrieved monthly price"}' }] },
              finishReason: "STOP",
              groundingMetadata: {
                webSearchQueries: ["provider UK pricing"],
                groundingChunks: [
                  {
                    web: {
                      uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/unavailable",
                    },
                  },
                ],
              },
              urlContextMetadata: {
                urlMetadata: [
                  {
                    retrievedUrl: "https://provider.com/pricing",
                    urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
                  },
                ],
              },
            },
          ],
        }),
      );
    });
    const model = new GeminiModelClient(config, transport, async () => "test-token");
    const response = await model.responses.create({ ...request(), tools: [{ type: "web_search" }] });
    expect(response.status).toBe("completed");
    expect(responseSources(response).sources).toEqual(new Set(["https://provider.com/pricing"]));
    expect(response.usage).toMatchObject({ input_tokens: 140, output_tokens: 50 });
    expect(model.hasSearchContext(response)).toBe(true);
    expect(model.searchQueryCount(response)).toBe(1);
  });
  it("returns grounded structured evidence in one native call, preserving retrieval receipts and exact usage", async () => {
    const { model, calls } = fixture([
      native([], {
        candidates: [
          {
            content: { role: "model", parts: [{ text: '{"reply":"Retrieved monthly price"}' }] },
            finishReason: "STOP",
            urlContextMetadata: {
              urlMetadata: [
                {
                  retrievedUrl: "https://provider.com/pricing",
                  urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
                },
              ],
            },
          },
        ],
      }),
    ]);
    const checkpoint = vi.fn();
    const result = await model.responses.create(
      { ...request(), tools: [{ type: "web_search" }] },
      { onUsageCheckpoint: checkpoint },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body.generationConfig.responseMimeType).toBeUndefined();
    expect(calls[0]!.body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(result.output_text).toBe('{"reply":"Retrieved monthly price"}');
    expect(result.usage).toMatchObject({ input_tokens: 140, output_tokens: 50 });
    expect(responseSources(result).sources).toEqual(new Set(["https://provider.com/pricing"]));
    expect(model.hasSearchContext(result)).toBe(true);
    expect(model.searchQueryCount(result)).toBe(0);
    expect(checkpoint).not.toHaveBeenCalled();
  });
  it("retrieves source-backed notes without a JSON constraint, then formats them without another search", async () => {
    const { model, calls } = fixture([
      native([], {
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                {
                  text: "The provider bills its individual plan monthly. Source: https://provider.com/pricing",
                },
              ],
            },
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["provider individual billing"],
              groundingChunks: [{ web: { uri: "https://provider.com/pricing" } }],
            },
          },
        ],
      }),
      native([{ text: '{"reply":"Monthly individual plan"}' }]),
    ]);
    const checkpoint = vi.fn();
    const response = await model.responses.create(
      { ...request(), tools: [{ type: "web_search" }] },
      { onUsageCheckpoint: checkpoint },
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(calls[1]!.body.tools).toBeUndefined();
    expect(calls[1]!.body.generationConfig.responseJsonSchema).toEqual(schema);
    expect(response.output_text).toBe('{"reply":"Monthly individual plan"}');
    expect(responseSources(response).sources).toEqual(new Set(["https://provider.com/pricing"]));
    expect(model.searchQueryCount(response)).toBe(1);
    expect(response.usage).toMatchObject({ input_tokens: 280, output_tokens: 100 });
    expect(checkpoint).toHaveBeenCalledTimes(1);
  });
  it.each(["dispatch", "response body"])(
    "reports a lost %s connection as uncertain provider availability without replaying it",
    async (stage) => {
      const failure = new TypeError("fetch failed with private request details");
      const transport = vi.fn(async () => {
        if (stage === "dispatch") throw failure;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.error(failure);
            },
          }),
        );
      });
      const model = new GeminiModelClient(config, transport as typeof fetch, async () => "test-token");
      const error = await model.responses.create(request()).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(ModelServiceError);
      expect(error).toMatchObject({ status: 503, possiblyBilled: true });
      expect(String(error)).not.toContain("private request details");
      expect(transientModelRetryDelay(error)).toBeNull();
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );
  it("preserves caller cancellation instead of relabelling it as a provider failure", async () => {
    const controller = new AbortController();
    const failure = new Error("cancelled by the caller");
    const transport = vi.fn(async () => {
      controller.abort(failure);
      throw failure;
    });
    const model = new GeminiModelClient(config, transport as typeof fetch, async () => "test-token");
    await expect(model.responses.create(request(), { signal: controller.signal })).rejects.toBe(failure);
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("formats schema-invalid research JSON instead of discarding its retrieved evidence", async () => {
    const { model, calls } = fixture([
      native([], {
        candidates: [
          {
            content: { role: "model", parts: [{ text: '{"answer":"Monthly individual plan"}' }] },
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["provider billing"],
              groundingChunks: [{ web: { uri: "https://provider.com/pricing" } }],
            },
          },
        ],
      }),
      native([{ text: '{"reply":"Monthly individual plan"}' }]),
    ]);
    const response = await model.responses.create({ ...request(), tools: [{ type: "web_search" }] });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.body.tools).toBeUndefined();
    expect(calls[1]!.body.generationConfig.responseJsonSchema).toEqual(schema);
    expect(response.output_text).toBe('{"reply":"Monthly individual plan"}');
    expect(responseSources(response).sources).toEqual(new Set(["https://provider.com/pricing"]));
  });

  it("retries a rate-limited extraction without repeating its successful paid search", async () => {
    const grounded = native([{ text: "Retrieved pricing notes." }], {
      candidates: [
        {
          content: { role: "model", parts: [{ text: "Retrieved pricing notes." }] },
          finishReason: "STOP",
          groundingMetadata: {
            webSearchQueries: ["provider pricing"],
            groundingChunks: [{ web: { uri: "https://provider.com/pricing" } }],
          },
        },
      ],
    });
    const { model, calls } = fixture([
      grounded,
      new Response(null, { status: 429, headers: { "retry-after": "0" } }),
      native([{ text: '{"reply":"ready"}' }]),
    ]);
    const checkpoint = vi.fn(async (completed: any, remaining: any) => {
      expect(calls).toHaveLength(1);
      expect(completed.usage).toMatchObject({ input_tokens: 140, output_tokens: 50 });
      expect(remaining.tools).toEqual([]);
      expect(model.searchQueryCount(completed)).toBe(1);
    });
    const response = await model.responses.create(
      { ...request(), tools: [{ type: "web_search" }] },
      { onUsageCheckpoint: checkpoint },
    );
    expect(checkpoint).toHaveBeenCalledTimes(1);
    expect(response.status).toBe("completed");
    expect(calls).toHaveLength(3);
    expect(calls.filter((call) => call.body.tools?.some((tool: any) => tool.googleSearch))).toHaveLength(1);
    expect(calls[0]!.body.toolConfig.retrievalConfig.latLng).toEqual({
      latitude: 51.5074,
      longitude: -0.1278,
    });
    expect(calls[1]!.body.toolConfig).toBeUndefined();
    expect(calls[1]!.body).toEqual(calls[2]!.body);
    expect(response.usage).toMatchObject({ input_tokens: 280, output_tokens: 100 });
    expect(model.searchQueryCount(response)).toBe(1);
  });
  it("stops after one retry when capacity remains unavailable", async () => {
    const { model, calls } = fixture([
      new Response(null, { status: 429 }),
      new Response(null, { status: 429 }),
    ]);
    await expect(model.responses.create(request())).rejects.toMatchObject({
      status: 429,
      possiblyBilled: false,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body).toEqual(calls[1]!.body);
  });
  it("does not dispatch the retry after cancellation", async () => {
    const { model, calls } = fixture([new Response(null, { status: 429 })]);
    const controller = new AbortController();
    const pending = model.responses.create(request(), { signal: controller.signal });
    const abort = setTimeout(() => controller.abort(), 20);
    try {
      await expect(pending).rejects.toMatchObject({ status: 429 });
    } finally {
      clearTimeout(abort);
    }
    expect(calls).toHaveLength(1);
  });
  it("leaves long retry delays to the caller instead of exceeding the task deadline", async () => {
    const { model, calls } = fixture([new Response(null, { status: 429, headers: { "retry-after": "60" } })]);
    await expect(model.responses.create(request())).rejects.toMatchObject({ status: 429 });
    expect(calls).toHaveLength(1);
  });
  it("uses plain-text mode for a forced native read, then restores structured JSON after the read", async () => {
    const { model, calls } = fixture([
      native([{ functionCall: { name: "read_needs", args: {} }, thoughtSignature: "native-signature" }]),
      native([{ text: '{"reply":"ready"}' }]),
    ]);
    let read = false;
    const tool = {
      type: "function" as const,
      name: "read_needs",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      strict: true,
    };
    const result = await runModelTask(model, {
      instructions: "Read needs before answering.",
      input: "Begin",
      tools: [tool],
      availableTools: () => (read ? [] : [tool]),
      toolChoice: () => (read ? "none" : "required"),
      executeTool: async () => {
        read = true;
        return { purpose: "offline music" };
      },
      output: {
        name: "Answer",
        schema,
        accept: (value: any): value is { reply: string } => typeof value?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(calls[0]!.body.toolConfig.functionCallingConfig.mode).toBe("ANY");
    expect(calls[0]!.body.generationConfig.responseMimeType).toBe("text/plain");
    expect(calls[0]!.body.generationConfig.responseJsonSchema).toBeUndefined();
    expect(calls[1]!.body.generationConfig).toMatchObject({
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    });
    expect(result.trace).toHaveLength(1);
  });
  it("returns optional chat replies from one structured decision without native AUTO tool selection", async () => {
    const { model, calls } = fixture([
      native([{ text: JSON.stringify({ reply: { reply: "ready" }, call: null }) }]),
    ]);
    const response = await model.responses.create({
      ...request(),
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "lookup_product",
          parameters: {
            type: "object",
            properties: { label: { type: "string" } },
            required: ["label"],
            additionalProperties: false,
          },
          strict: true,
        },
      ],
    });
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe('{"reply":"ready"}');
    expect(calls[0]!.body.tools).toBeUndefined();
    expect(calls[0]!.body.toolConfig).toBeUndefined();
    const branches = calls[0]!.body.generationConfig.responseJsonSchema.anyOf;
    expect(branches[0].properties).toEqual({ reply: schema, call: { type: "null" } });
    expect(branches[1].properties.reply).toEqual({ type: "null" });
    expect(branches[1].properties.call.properties.name.enum).toEqual(["lookup_product"]);
    expect(branches.every((branch: any) => branch.additionalProperties === false)).toBe(true);
    expect(response.usage).toMatchObject({ input_tokens: 140, output_tokens: 50 });
  });

  it("executes a model-selected optional read and continues without inventing a native function signature", async () => {
    const { model, calls } = fixture([
      native([
        {
          text: JSON.stringify({
            reply: null,
            call: { name: "lookup_product", arguments: { label: "Unlisted Mapper" } },
          }),
        },
      ]),
      native([{ text: '{"reply":"A relevant product question"}' }]),
    ]);
    let read = false;
    const tools = [
      {
        type: "function" as const,
        name: "lookup_product",
        parameters: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
        strict: true,
      },
    ];
    const result = await runModelTask(model, {
      instructions: "Use the current context or request a relevant product lookup.",
      input: "What can I use this mapping subscription for?",
      tools,
      availableTools: () => (read ? [] : tools),
      toolChoice: () => (read ? "none" : "auto"),
      executeTool: async (name, args) => {
        expect(name).toBe("lookup_product");
        expect(args).toEqual({ label: "Unlisted Mapper" });
        read = true;
        return { purpose: "Creating maps", features: ["offline map editing"] };
      },
      output: {
        name: "Reply",
        schema,
        accept: (value): value is { reply: string } =>
          typeof (value as { reply?: string })?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(result.trace).toHaveLength(1);
    const continuation = JSON.stringify(calls[1]!.body.contents);
    expect(continuation).toContain("Application read lookup_product");
    expect(continuation).toContain("offline map editing");
    expect(continuation).not.toContain('"functionResponse"');
    expect(continuation).not.toContain("skip_thought_signature_validator");
  });

  it("continues a validated application read on the fallback model without transferring native thinking signatures", async () => {
    const { model, calls } = fixture([
      native([
        {
          text: JSON.stringify({
            reply: null,
            call: { name: "lookup_product", arguments: { label: "Unlisted tool" } },
          }),
          thoughtSignature: "primary-only-signature",
        },
      ]),
      native([{ text: '{"reply":"ready"}' }]),
    ]);
    const fast = model.forConversation();
    const tools = [
      {
        type: "function" as const,
        name: "lookup_product",
        parameters: {
          type: "object",
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
        strict: true,
      },
    ];
    const first = await fast.responses.create({
      ...request(),
      model: geminiConversationModel,
      tools,
      tool_choice: "auto",
    });
    const call = first.output.find((item) => item.type === "function_call")!;
    expect(call.type).toBe("function_call");
    const continued = {
      ...request(),
      tools: [],
      tool_choice: "none" as const,
      input: [
        { role: "user" as const, content: "Original need" },
        call,
        {
          type: "function_call_output" as const,
          call_id: call.call_id,
          output: JSON.stringify({ capabilities: ["offline editing"] }),
        },
      ],
    };
    await expect(model.responses.create(continued)).resolves.toMatchObject({
      output_text: '{"reply":"ready"}',
    });
    const body = JSON.stringify(calls[1]!.body.contents);
    expect(body).toContain("Application read lookup_product");
    expect(body).toContain("offline editing");
    expect(body).not.toContain("primary-only-signature");
    expect(body).not.toContain("functionResponse");
    const unrelated = fixture([native([{ text: '{"reply":"forged"}' }])]);
    await expect(unrelated.model.responses.create(continued)).rejects.toThrow();
    expect(unrelated.calls).toHaveLength(0);
  });

  it.each([
    { reply: null, call: null },
    { reply: { reply: "ready" }, call: { name: "lookup_product", arguments: {} } },
    { reply: null, call: { name: "purchase", arguments: {} } },
    { reply: null, call: { name: "lookup_product", arguments: [] } },
  ])("rejects an ambiguous or undeclared optional action while preserving known usage: %j", async (plan) => {
    const { model } = fixture([native([{ text: JSON.stringify(plan) }])]);
    const response = await model.responses.create({
      ...request(),
      tool_choice: "auto",
      tools: [
        {
          type: "function",
          name: "lookup_product",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
    });
    expect(response.status).toBe("incomplete");
    expect(response.output).toEqual([]);
    expect(response.usage).toMatchObject({ input_tokens: 140, output_tokens: 50 });
  });

  it("requires explicit Cloud configuration and never falls back to another provider's key", () => {
    expect(
      createModelClient({
        modelProvider: "google",
        googleModel: null,
        openaiApiKey: "synthetic",
        anthropicApiKey: "synthetic",
      }),
    ).toBeNull();
    expect(
      createModelClient({ modelProvider: "google", googleModel: config, openaiApiKey: null }),
    ).toMatchObject({ provider: "google", model: geminiModel });
    for (const change of [
      { project: "https://untrusted.example" },
      { location: "untrusted.example" },
      { impersonateServiceAccount: "https://untrusted.example" },
    ])
      expect(() => new GeminiModelClient({ ...config, ...change })).toThrow(/configuration/);
  });
  it("uses the project-billed Google endpoint and accounts for thoughts, tool inputs and cached input", async () => {
    const { model, calls } = fixture([native([{ text: '{"reply":"ready"}' }])]);
    const response = await model.responses.create(request());
    expect(calls[0]).toMatchObject({
      url: `https://aiplatform.googleapis.com/v1/projects/${config.project}/locations/global/publishers/google/models/${geminiModel}:generateContent`,
      redirect: "error",
      headers: { Authorization: "Bearer synthetic-test-token", "x-goog-user-project": config.project },
    });
    expect(calls[0]!.body.generationConfig).toMatchObject({
      thinkingConfig: { thinkingLevel: "LOW" },
      responseJsonSchema: schema,
    });
    expect(response.usage).toMatchObject({
      input_tokens: 140,
      output_tokens: 50,
      input_tokens_details: { cached_tokens: 50 },
      output_tokens_details: { reasoning_tokens: 30 },
    });
    expect(response.output_text).toBe('{"reply":"ready"}');
    expect(modelVersion({ model: "old", fingerprint: "old" }, model)).toMatchObject({
      model: geminiModel,
      reasoning: "thinking.low",
    });
  });
  it("preserves genuine signed tool calls and pairs results without exposing signatures in saved output", async () => {
    const { model, calls } = fixture([
      native([
        {
          functionCall: { id: "call1", name: "read_needs", args: {} },
          thoughtSignature: "opaque-test-signature",
        },
      ]),
      native([{ text: '{"reply":"offline music"}' }]),
    ]);
    const execute = vi.fn(async () => ({ purpose: "offline music" }));
    const result = await runModelTask(model, {
      instructions: "Read actual needs.",
      input: "Please check.",
      tools: [
        {
          type: "function",
          name: "read_needs",
          description: "Read private saved needs.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          strict: true,
        },
      ],
      executeTool: execute,
      output: {
        name: "Answer",
        schema,
        accept: (value: any): value is { reply: string } => typeof value?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(calls[1]!.body)).toContain("opaque-test-signature");
    expect(
      calls[1]!.body.contents.flatMap((row: any) => row.parts).find((part: any) => part.functionResponse),
    ).toMatchObject({
      functionResponse: {
        id: "call1",
        name: "read_needs",
        response: { result: { purpose: "offline music" } },
      },
    });
    expect(JSON.stringify(result)).not.toContain("opaque-test-signature");
  });
  it("preserves signed native calls that omit an id instead of modifying the signed block", async () => {
    const { model, calls } = fixture([
      native([{ functionCall: { name: "read_needs", args: {} }, thoughtSignature: "original-signature" }]),
      native([{ text: '{"reply":"ready"}' }]),
    ]);
    const result = await runModelTask(model, {
      instructions: "Read needs.",
      input: "Begin",
      tools: [
        {
          type: "function",
          name: "read_needs",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
      executeTool: async () => ({ purpose: "offline music" }),
      output: {
        name: "Answer",
        schema,
        accept: (value: any): value is { reply: string } => typeof value?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    const parts = calls[1]!.body.contents.flatMap((item: any) => item.parts);
    expect(parts.find((part: any) => part.functionCall).functionCall.id).toBeUndefined();
    expect(parts.find((part: any) => part.functionResponse).functionResponse.id).toBeUndefined();
    expect(parts.find((part: any) => part.functionResponse).functionResponse.name).toBe("read_needs");
  });
  it("accepts only successful native URL-context receipts, not failed or model-authored source claims", async () => {
    const { model, calls } = fixture([
      native([], {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Retrieved source notes." }] },
            finishReason: "STOP",
            urlContextMetadata: {
              urlMetadata: [
                {
                  retrievedUrl: "https://provider.com/features",
                  urlRetrievalStatus: "URL_RETRIEVAL_STATUS_SUCCESS",
                },
                {
                  retrievedUrl: "https://unread.com/price",
                  urlRetrievalStatus: "URL_RETRIEVAL_STATUS_ERROR",
                },
              ],
            },
          },
        ],
      }),
      native([{ text: '{"reply":"ready"}' }]),
    ]);
    const result = await model.responses.create({
      ...request(),
      tools: [{ type: "web_search", filters: { allowed_domains: ["provider.com"] } }],
    });
    expect(JSON.stringify(calls[0]!.body.systemInstruction)).toContain("site:domain");
    expect(JSON.stringify(calls[0]!.body.systemInstruction)).toContain("unverifiedProviderUrls");
    expect(responseSources(result).sources).toEqual(new Set(["https://provider.com/features"]));
    expect(result.usage).toMatchObject({ input_tokens: 280, output_tokens: 100 });
    expect(model.hasSearchContext(result)).toBe(true);
  });
  it("supplies mandatory application reads without fabricating signed Gemini calls", async () => {
    const { model, calls } = fixture([native([{ text: '{"reply":"ready"}' }])]);
    const result = await runModelTask(model, {
      instructions: "Use the application read.",
      input: "Begin",
      initialReads: [{ name: "read_needs", arguments: {} }],
      tools: [
        {
          type: "function",
          name: "read_needs",
          parameters: { type: "object", properties: {} },
          strict: true,
        },
      ],
      executeTool: async () => ({ purpose: "offline music" }),
      output: {
        name: "Answer",
        schema,
        accept: (value: any): value is { reply: string } => typeof value?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(JSON.stringify(calls[0]!.body.contents)).toContain("offline music");
    expect(JSON.stringify(calls[0]!.body.contents)).not.toContain("functionCall");
    expect(JSON.stringify(calls[0]!.body)).not.toContain("skip_thought_signature_validator");
  });
  it("resolves only Google's citation redirect without sending credentials or fetching the destination", async () => {
    const content = { role: "model", parts: [{ text: '{"reply":"verified"}' }] };
    const { model, calls } = fixture([
      native([], {
        candidates: [
          {
            content,
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["provider pricing"],
              groundingChunks: [
                { web: { uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/test" } },
              ],
              searchEntryPoint: {
                renderedContent: '<a href="https://www.google.com/search?q=provider">provider</a>',
              },
            },
          },
        ],
      }),
      native([{ text: '{"reply":"verified"}' }]),
    ]);
    const response = await model.responses.create({
      ...request(),
      tools: [{ type: "web_search", filters: { allowed_domains: ["provider.com"] } }],
    });
    expect(responseSources(response)).toMatchObject({
      searches: 1,
      sources: new Set(["https://provider.com/pricing"]),
    });
    expect(calls[1]).toMatchObject({ method: "HEAD", redirect: "manual", headers: undefined });
    expect(calls.some((call) => call.url === "https://provider.com/pricing")).toBe(false);
    expect(model.hasSearchContext(response)).toBe(true);
    expect(model.hasSearchContext(JSON.parse(JSON.stringify(response)))).toBe(false);
    expect(fixture([]).model.hasSearchContext(response)).toBe(false);
    expect(searchAttributions([response])).toHaveLength(1);
    await model.responses
      .create({
        ...request(),
        input: [...(response.output as any), { role: "user", content: "Now inspect renewal terms." }],
        tools: [{ type: "web_search" }],
      })
      .catch(() => {});
    expect(JSON.stringify(calls.at(-1)?.body.contents)).toContain("https://provider.com/pricing");
  });
  it("does not treat ungrounded generated links as retrieved evidence", async () => {
    const { model } = fixture([native([{ text: '{"reply":"https://invented.example/price"}' }])]);
    const response = await model.responses.create({ ...request(), tools: [{ type: "web_search" }] });
    expect(responseSources(response).sources.size).toBe(0);
    expect(model.hasSearchContext(response)).toBe(false);
    expect(searchAttributions([response])).toEqual([]);
  });
  it("counts one grounded operation separately from every billable query it contains", async () => {
    const { model } = fixture([
      native([], {
        candidates: [
          {
            content: { role: "model", parts: [{ text: "Official provider research notes." }] },
            finishReason: "STOP",
            groundingMetadata: {
              webSearchQueries: ["provider UK price", "provider renewal", "provider downloads"],
              groundingChunks: [{ web: { uri: "https://provider.com/pricing" } }],
            },
          },
        ],
      }),
      native([{ text: '{"reply":"verified"}' }]),
    ]);
    const response = await model.responses.create({
      ...request(),
      tools: [{ type: "web_search" }],
      max_tool_calls: 2,
    } as any);
    expect(response.status).toBe("completed");
    expect(responseSources(response).searches).toBe(1);
    expect(model.searchQueryCount(response)).toBe(3);
    expect(model.searchQueryCount(JSON.parse(JSON.stringify(response)))).toBeNaN();
    const reserve = boundedJudgeRequest(
      { ...request(), tools: [{ type: "web_search" }], max_tool_calls: 2 } as any,
      model,
    );
    expect(reserve.reserveMicros).toBeGreaterThan(modelCostMicros(2_097_152, 10000, 100, "google"));
  });
  it("moves array bounds out of Google's schema compiler without changing the original contract", async () => {
    const { model, calls } = fixture([native([{ text: '{"offers":[],"uncertainties":[]}' }])]);
    const original = {
      type: "object",
      additionalProperties: false,
      required: ["offers", "uncertainties"],
      properties: {
        offers: { type: "array", maxItems: 6, items: { type: "string" } },
        uncertainties: { type: "array", minItems: 0, maxItems: 6, items: { type: "string" } },
      },
    };
    await model.responses.create({
      ...request(),
      text: { format: { type: "json_schema", name: "Offers", schema: original, strict: true } },
    });
    const sent = calls[0]!.body.generationConfig.responseJsonSchema;
    expect(sent.properties.offers.maxItems).toBeUndefined();
    expect(sent.properties.offers.description).toContain("at most 6");
    expect(sent.properties.uncertainties.description).toMatch(/at least 0.*at most 6/);
    expect(sent.required).toEqual(original.required);
    expect(sent.additionalProperties).toBe(false);
    expect(original.properties.offers.maxItems).toBe(6);
  });
  it("refuses mixed account/search tools and malformed continuations before dispatch", async () => {
    const { model, calls } = fixture([]);
    await expect(
      model.responses.create({
        ...request(),
        tools: [{ type: "web_search" }, { type: "function", name: "act", parameters: {}, strict: true }],
      }),
    ).rejects.toThrow(/separately/);
    await expect(
      model.responses.create({
        ...request(),
        input: [{ type: "function_call", call_id: "reconstructed", name: "act", arguments: "{}" }],
      }),
    ).rejects.toThrow(/signature/);
    expect(calls).toHaveLength(0);
  });
  it("keeps blocked or truncated output incomplete and refuses invalid usage discounts", async () => {
    const { model } = fixture([
      native([{ text: '{"reply":"partial"}' }], {
        candidates: [
          { content: { role: "model", parts: [{ text: "partial" }] }, finishReason: "MAX_TOKENS" },
        ],
        usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, cachedContentTokenCount: 99 },
      }),
    ]);
    const response = await model.responses.create(request());
    expect(response.status).toBe("incomplete");
    expect(response.usage).toMatchObject({
      input_tokens: 1,
      output_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
    });
  });
  it("preserves budget bounds and distinguishes definitive rejection from uncertain server failures", async () => {
    const { model } = fixture([]);
    const bound = boundedJudgeRequest(
      { ...request(), tools: [{ type: "web_search" }], max_tool_calls: 2 } as any,
      model,
    );
    expect(bound.reserveMicros).toBeGreaterThan(modelCostMicros(2_097_152, 10000, 2, "google"));
    expect(modelCostMicros(1000, 100, 1, "google", 0, new Date("2026-11-09T00:00:00Z"))).toBe(15125);
    expect(modelCostMicros(1000, 100, 1, "google", 0, new Date("2027-01-01T00:00:00Z"))).toBe(16250);
    expect(modelCostMicros(1000, 100, 0, "google", 500, new Date("2026-11-09T00:00:00Z"))).toBe(788);
    expect(modelCostMicros(1000, 100, 1, "google", 9999)).toBe(modelCostMicros(1000, 100, 1, "google"));
    expect(modelAvailabilityError(new ModelServiceError(403))?.code).toBe("model_access_unavailable");
    expect(modelAvailabilityError(new ModelServiceError(400))?.code).toBe("model_request_rejected");
    expect(modelAvailabilityError(new ModelServiceError(503))).toBeNull();
    expect(modelAvailabilityError(new ModelServiceError(400, new Headers(), true))).toBeNull();
    expect(transientModelRetryDelay(new ModelServiceError(503, new Headers(), true))).toBeNull();
    expect(transientModelRetryDelay(new ModelServiceError(503))).toBe(1000);
    const errorModel = new GeminiModelClient(
      config,
      (async () => new Response("private provider error", { status: 403 })) as typeof fetch,
      async () => "synthetic",
    );
    await expect(errorModel.responses.create(request())).rejects.toThrow("HTTP 403");
    const abort = new AbortController();
    abort.abort();
    await expect(model.responses.create(request(), { signal: abort.signal })).rejects.toThrow();
  });
  it("omits provider suggestion HTML without treating prose as native search metadata", () => {
    const html = renderToStaticMarkup(
      createElement(SearchAttributions, {
        items: ['<script>malicious()</script><a href="https://www.google.com/search?q=music">music</a>'],
      }),
    );
    expect(html).toBe("");
    expect(
      searchAttributions([{ output: [{ type: "message", googleSearchSuggestions: "unsafe" } as any] }]),
    ).toEqual([]);
  });
});
