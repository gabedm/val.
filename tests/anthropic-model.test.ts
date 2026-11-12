import { describe, expect, it, vi } from "vitest";
import type { ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { ClaudeModelClient } from "../src/server/anthropic-model";
import { claudeModel, modelVersion } from "../src/server/model-settings";
import { createModelClient } from "../src/server/model-client";
import { boundedJudgeRequest, modelCostMicros } from "../src/server/judge-budget";
import { runModelTask } from "../src/server/responses-loop";
import { responseSources } from "../src/server/live-discovery";
import { modelAvailabilityError, transientModelRetryDelay } from "../src/server/model-availability";
import { checkAdviceConsistency } from "../src/server/advice-consistency";
import { consistencyCheckOutput } from "./model-standin";

const schema = {
  type: "object",
  additionalProperties: false,
  properties: { reply: { type: "string", maxLength: 100 } },
  required: ["reply"],
};
const request = (): ResponseCreateParamsNonStreaming => ({
  model: claudeModel,
  store: false,
  instructions: "Help with the supplied subscription needs.",
  input: [{ role: "user", content: "I use it to annotate technical papers." }],
  text: { format: { type: "json_schema", name: "Answer", schema, strict: true } },
});
function message(content: unknown[], stop = "end_turn", overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_synthetic",
    type: "message",
    role: "assistant",
    model: claudeModel,
    content,
    stop_reason: stop,
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      server_tool_use: { web_search_requests: 0 },
    },
    ...overrides,
  };
}
function streamedMessage(value: any) {
  const events: object[] = [
    {
      type: "message_start",
      message: { ...value, content: [], stop_reason: null, usage: { ...value.usage, output_tokens: 0 } },
    },
  ];
  value.content.forEach((block: any, index: number) => {
    const text = block.type === "text";
    const tool = ["tool_use", "server_tool_use"].includes(block.type);
    events.push({
      type: "content_block_start",
      index,
      content_block: text ? { ...block, text: "" } : tool ? { ...block, input: {} } : block,
    });
    if (text || tool) {
      const content = text ? block.text : JSON.stringify(block.input);
      const split = Math.floor(content.length / 2);
      for (const part of [content.slice(0, split), content.slice(split)])
        events.push({
          type: "content_block_delta",
          index,
          delta: text ? { type: "text_delta", text: part } : { type: "input_json_delta", partial_json: part },
        });
    }
    events.push({ type: "content_block_stop", index });
  });
  events.push(
    {
      type: "message_delta",
      delta: { stop_reason: value.stop_reason, stop_sequence: value.stop_sequence },
      usage: value.usage,
    },
    { type: "message_stop" },
  );
  return events.map((event: any) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}
function fixture(responses: unknown[]) {
  const calls: { url: string; body: any }[] = [];
  const transport = vi.fn(async (url: any, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    if (!responses.length) throw new Error("Unexpected model request.");
    return new Response(streamedMessage(responses.shift()), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as unknown as typeof fetch;
  return { calls, model: new ClaudeModelClient("synthetic-test-key", transport) };
}

describe("Claude native API adapter", () => {
  it("retains the native type of an HTTP-200 stream error without accepting partial output", async () => {
    const prefix = streamedMessage(message([{ type: "text", text: '{"reply":"partial"}' }])).split(
      "event: message_delta",
    )[0];
    const model = new ClaudeModelClient(
      "synthetic-key",
      (async () =>
        new Response(
          prefix +
            'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Private diagnostic"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        )) as typeof fetch,
    );
    const failure = await model.responses.create(request()).then(
      () => null,
      (error) => error,
    );
    expect(failure).toMatchObject({ status: undefined, type: "overloaded_error" });
    expect(transientModelRetryDelay(failure)).toBe(1000);
  });
  it("carries application-issued mandatory reads into the first Claude request without a negotiation call", async () => {
    const { model, calls } = fixture([message([{ type: "text", text: '{"reply":"ready"}' }])]);
    const execute = vi.fn(async () => ({ purpose: "offline music" }));
    const result = await runModelTask(model, {
      instructions: "Use the read result as data.",
      input: "My listening needs",
      initialReads: [{ name: "read_needs", arguments: {} }],
      tools: [
        {
          type: "function",
          name: "read_needs",
          parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
          strict: true,
        },
      ],
      executeTool: execute,
      output: {
        name: "Answer",
        schema,
        accept: (value): value is { reply: string } =>
          !!value && typeof (value as { reply: string }).reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(execute).toHaveBeenCalledOnce();
    const assistant = calls[0]!.body.messages.find((item: any) => item.role === "assistant");
    expect(assistant.content[0]).toMatchObject({ type: "tool_use", name: "read_needs", input: {} });
    expect(calls[0]!.body.messages.at(-1).content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: assistant.content[0].id,
      content: '{"purpose":"offline music"}',
    });
    expect(result.trace[0]).toMatchObject({ tool: "read_needs", origin: "server" });
  });
  it("does not publish or replay a truncated stream, even if its text looks complete", async () => {
    let calls = 0;
    const text = streamedMessage(message([{ type: "text", text: '{"reply":"ready"}' }]));
    const model = new ClaudeModelClient("synthetic-key", (async () => {
      calls++;
      return new Response(text.slice(0, text.lastIndexOf("event: message_stop")), {
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch);
    await expect(model.responses.create(request())).rejects.toThrow();
    expect(calls).toBe(1);
  });
  it("sends the reviewer decision and explanation as matching branches in the native schema", async () => {
    const { model, calls } = fixture([
      message([{ type: "text", text: JSON.stringify(consistencyCheckOutput([], [])) }]),
    ]);
    const result = await checkAdviceConsistency(
      model,
      { subscription: { name: "Example", purpose: "Reading" } },
      { summary: "A possible fit", options: [], uncertainties: [] },
      AbortSignal.timeout(1000),
    );
    expect(result.completed).toBe(true);
    const check = calls[0]!.body.output_config.format.schema.properties.checks.properties.answered_question;
    expect(check.anyOf).toHaveLength(2);
    expect(check.anyOf[0].properties).toMatchObject({
      conflict: { enum: [false] },
      explanation: { type: "null" },
    });
    expect(check.anyOf[1].properties).toMatchObject({
      conflict: { enum: [true] },
      explanation: { type: "string" },
    });
    expect(calls[0]!.body.thinking).toEqual({ type: "between_tools" });
  });
  it("rejects a reply that skips a required read, after one bounded correction", async () => {
    const { model, calls } = fixture([
      message([{ type: "text", text: '{"reply":"An answer without reading."}' }]),
      message([{ type: "text", text: '{"reply":"Still no read."}' }]),
    ]);
    const execute = vi.fn();
    const result = await runModelTask(model, {
      instructions: "Read the saved needs before answering.",
      input: "Help with my subscription.",
      tools: [
        {
          type: "function",
          name: "read_needs",
          parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
          strict: true,
        },
      ],
      toolChoice: () => "required",
      executeTool: execute,
      output: {
        name: "Answer",
        schema,
        accept: (value): value is { reply: string } =>
          typeof (value as { reply: string })?.reply === "string",
      },
    });
    expect(result).toMatchObject({ completed: false, reason: "invalid_output" });
    expect(execute).not.toHaveBeenCalled();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.body.tool_choice.type).toBe("auto");
  });

  it("recovers a missed tool at each required stage without accepting announcements as evidence", async () => {
    const { model, calls } = fixture([
      message([{ type: "text", text: '{"reply":"I will read the saved needs."}' }]),
      message([{ type: "tool_use", id: "toolu_needs", name: "read_needs", input: {} }], "tool_use"),
      message([{ type: "text", text: '{"reply":"I will identify the product."}' }]),
      message([{ type: "tool_use", id: "toolu_product", name: "identify_product", input: {} }], "tool_use"),
      message([{ type: "text", text: '{"reply":"The saved needs and product evidence are ready."}' }]),
    ]);
    const tools = ["read_needs", "identify_product"].map((name) => ({
      type: "function" as const,
      name,
      parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
      strict: true,
    }));
    let phase = 0;
    const executed: string[] = [];
    const result = await runModelTask(
      model,
      {
        instructions: "Read needs, identify the product, then answer using both results.",
        input: "Compare my subscription.",
        tools,
        availableTools: () => (phase < tools.length ? [tools[phase]!] : []),
        toolChoice: () => (phase < tools.length ? "required" : "none"),
        executeTool: async (name) => {
          expect(name).toBe(tools[phase]!.name);
          executed.push(name);
          phase++;
          return { verified: true };
        },
        output: {
          name: "Answer",
          schema,
          accept: (value): value is { reply: string } =>
            typeof (value as { reply: string })?.reply === "string",
        },
      },
      { maxToolCalls: 2, timeoutMs: 1000 },
    );
    expect(result.completed).toBe(true);
    expect(executed).toEqual(["read_needs", "identify_product"]);
    expect(result.trace.map((step) => step.tool)).toEqual(executed);
    expect(calls).toHaveLength(5);
    expect(calls.slice(0, 4).every((call) => call.body.tool_choice.type === "auto")).toBe(true);
  });

  it("removes incompatible progress blocks when Val narrows tools, without losing the tool history", async () => {
    const progress = {
      type: "thinking",
      thinking: "Synthetic progress text",
      signature: "synthetic-signature",
    };
    const nativeTool = { type: "tool_use", id: "toolu_read", name: "read_needs", input: {} };
    const { model, calls } = fixture([
      message([progress, nativeTool], "tool_use"),
      message([{ type: "text", text: '{"reply":"Saved needs read."}' }]),
    ]);
    let read = false;
    const tools = [
      {
        type: "function" as const,
        name: "read_needs",
        parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
        strict: true,
      },
    ];
    const result = await runModelTask(model, {
      instructions: "Read the saved needs.",
      input: "Help.",
      tools,
      availableTools: () => (read ? [] : tools),
      executeTool: async () => {
        read = true;
        return { purpose: "Technical papers" };
      },
      output: {
        name: "Answer",
        schema,
        accept: (value): value is { reply: string } =>
          typeof (value as { reply: string })?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(calls[1]!.body.tools).toBeUndefined();
    expect(calls[1]!.body.messages.at(-2).content).toEqual([nativeTool]);
    expect(JSON.stringify(result)).not.toContain("Synthetic progress text");
  });
  it("keeps tool results and native assistant blocks in order, with the original schema checked locally", async () => {
    const nativeTool = { type: "tool_use", id: "toolu_read", name: "read_needs", input: {} };
    const { model, calls } = fixture([
      message([nativeTool], "tool_use"),
      message([{ type: "text", text: '{"reply":"Which annotations do you need to export?"}' }]),
    ]);
    const execute = vi.fn(async () => ({ name: "Paperpile", purpose: "" }));
    const result = await runModelTask(model, {
      instructions: "Read the current needs before asking one relevant question.",
      input: "Mostly technical papers, no collaboration needed.",
      tools: [
        {
          type: "function",
          name: "read_needs",
          parameters: { type: "object", properties: {}, additionalProperties: false, required: [] },
          strict: true,
        },
      ],
      output: {
        name: "Answer",
        schema,
        accept: (value): value is { reply: string } =>
          !!value && typeof (value as { reply: string }).reply === "string",
      },
      executeTool: execute,
    });
    expect(result.completed).toBe(true);
    expect(execute).toHaveBeenCalledOnce();
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url === "https://api.anthropic.com/v1/messages")).toBe(true);
    expect(calls[0]!.body).toMatchObject({
      model: claudeModel,
      stream: true,
      thinking: { type: "between_tools" },
      service_tier: "standard_only",
      tools: [{ name: "read_needs", strict: true }],
    });
    expect(calls[0]!.body.output_config.format.schema.properties.reply.maxLength).toBeUndefined();
    expect(schema.properties.reply.maxLength).toBe(100);
    expect(calls[1]!.body.messages.slice(-2)).toEqual([
      { role: "assistant", content: [nativeTool] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_read", content: '{"name":"Paperpile","purpose":""}' },
        ],
      },
    ]);
    expect(modelVersion({ model: "old", fingerprint: "old-version" }, model).model).toBe(claudeModel);
  });

  it("returns only real native search sources and carries a strict research result without JSON/citation conflicts", async () => {
    const { model, calls } = fixture([
      message(
        [
          {
            type: "server_tool_use",
            id: "search_1",
            name: "web_search",
            input: { query: "official paper annotation plans" },
          },
          {
            type: "web_search_tool_result",
            tool_use_id: "search_1",
            content: [
              {
                type: "web_search_result",
                url: "https://paperpile.com/pricing",
                title: "Plans",
                encrypted_content: "synthetic-opaque-content",
                page_age: null,
              },
            ],
          },
          {
            type: "tool_use",
            id: "final",
            name: "val_return_research",
            input: { reply: "A verified provider result." },
          },
        ],
        "tool_use",
        {
          usage: {
            input_tokens: 300,
            output_tokens: 80,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 10,
            server_tool_use: { web_search_requests: 1 },
          },
        },
      ),
    ]);
    const response = await model.responses.create({
      ...request(),
      tools: [{ type: "web_search", filters: { allowed_domains: ["provider.example"] } }],
      max_tool_calls: 1,
    } as ResponseCreateParamsNonStreaming);
    expect(calls[0]!.body.output_config.format).toBeUndefined();
    expect(calls[0]!.body.tools[0]).toMatchObject({
      type: "web_search_20250305",
      max_uses: 1,
      allowed_domains: ["provider.example"],
    });
    expect(calls[0]!.body.tools[1]).toMatchObject({ name: "val_return_research", strict: true });
    expect(response.status).toBe("completed");
    expect(response.output_text).toBe('{"reply":"A verified provider result."}');
    expect(responseSources(response).sources).toEqual(new Set(["https://paperpile.com/pricing"]));
    expect(response.usage?.input_tokens).toBe(330);
    expect(response.usage?.total_tokens).toBe(410);
    expect(response.usage?.input_tokens_details.cached_tokens).toBe(20);
    expect(JSON.stringify(response)).not.toContain("synthetic-opaque-content");
  });

  it("retains native pricing sources and pairs the completed research tool when following up on renewal terms", async () => {
    const nativeBlocks = [
      {
        type: "server_tool_use",
        id: "pricing_search",
        name: "web_search",
        input: { query: "provider official plan price" },
      },
      {
        type: "web_search_tool_result",
        tool_use_id: "pricing_search",
        content: [
          {
            type: "web_search_result",
            url: "https://provider.example/pricing",
            title: "Pricing",
            encrypted_content: "synthetic-private-search-context",
            page_age: null,
          },
        ],
      },
      { type: "tool_use", id: "pricing_result", name: "val_return_research", input: { reply: "£15" } },
    ];
    const { model, calls } = fixture([
      message(nativeBlocks, "tool_use", {
        usage: { input_tokens: 100, output_tokens: 20, server_tool_use: { web_search_requests: 1 } },
      }),
      message(
        [
          {
            type: "tool_use",
            id: "renewal_result",
            name: "val_return_research",
            input: { reply: "30 days" },
          },
        ],
        "tool_use",
      ),
    ]);
    const first = {
      ...request(),
      tools: [{ type: "web_search", filters: { allowed_domains: ["provider.example"] } }],
      max_tool_calls: 2,
    } as ResponseCreateParamsNonStreaming;
    const pricing = await model.responses.create(first);
    expect(model.hasSearchContext(pricing)).toBe(true);
    expect(model.hasSearchContext(structuredClone(pricing))).toBe(false);
    expect(new ClaudeModelClient("synthetic-other-client").hasSearchContext(pricing)).toBe(false);
    const followup = {
      ...first,
      instructions: "Establish the missing official renewal period for the previously priced plan.",
      input: [
        ...(first.input as any[]),
        ...pricing.output,
        { role: "user", content: "Find the provider's renewal terms using the earlier pricing evidence." },
      ],
    } as ResponseCreateParamsNonStreaming;
    const bound = model.inputTokenBound(followup);
    await model.responses.create(followup);
    const body = calls[1]!.body;
    expect(body.messages[1]).toEqual({ role: "assistant", content: nativeBlocks });
    expect(body.messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "pricing_result",
          content: "Research result received. Continue with the next research request.",
        },
        { type: "text", text: "Find the provider's renewal terms using the earlier pricing evidence." },
      ],
    });
    expect(JSON.stringify(body).match(/synthetic-private-search-context/g)).toHaveLength(1);
    expect(bound).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify(body), "utf8") + 8192);
    expect(bound).toBeGreaterThan(model.inputTokenBound({ ...followup, input: first.input }));
    expect(JSON.stringify(pricing)).not.toContain("synthetic-private-search-context");
  });

  it("does not turn a failed search or an unstructured research reply into verified sources", async () => {
    const { model } = fixture([
      message([
        { type: "server_tool_use", id: "search_1", name: "web_search", input: { query: "plans" } },
        {
          type: "web_search_tool_result",
          tool_use_id: "search_1",
          content: { type: "web_search_tool_result_error", error_code: "unavailable" },
        },
        { type: "text", text: "I found something: https://invented.example" },
      ]),
    ]);
    const response = await model.responses.create({ ...request(), tools: [{ type: "web_search" }] });
    expect(response.status).toBe("incomplete");
    expect(responseSources(response).sources.size).toBe(0);
    expect(response.output_text).toBe("");
  });

  it("keeps malformed usage uncertain, handles refusals and respects cancellation before dispatch", async () => {
    const { model, calls } = fixture([
      message([], "refusal", { usage: { input_tokens: null, output_tokens: 0 } }),
    ]);
    const response = await model.responses.create(request());
    expect(response.usage).toBeUndefined();
    expect(response.output[0]).toMatchObject({ type: "message", content: [{ type: "refusal" }] });
    const controller = new AbortController();
    controller.abort();
    await expect(model.responses.create(request(), { signal: controller.signal })).rejects.toThrow();
    expect(calls).toHaveLength(1);
    await expect(model.responses.create({ ...request(), model: "other-model" })).rejects.toThrow();
  });

  it("uses provider-specific reservations, preserves strict model selection and never falls back to another key", () => {
    const { model } = fixture([]);
    const bound = boundedJudgeRequest(request(), model);
    expect(bound.reserveMicros).toBeGreaterThan(modelCostMicros(8000, 5000, 0, "anthropic"));
    expect(modelCostMicros(1000, 100, 1, "anthropic")).toBe(16250);
    expect(() => boundedJudgeRequest({ ...request(), model: "gpt-6-luna" }, model)).toThrow();
    expect(
      createModelClient({
        modelProvider: "anthropic",
        anthropicApiKey: null,
        openaiApiKey: "synthetic-other-key",
      }),
    ).toBeNull();
    expect(
      createModelClient({
        modelProvider: "anthropic",
        anthropicApiKey: "synthetic-claude",
        openaiApiKey: "synthetic-other-key",
      })?.model,
    ).toBe(claudeModel);
  });

  it("sanitizes Anthropic account failures without echoing provider bodies or retrying", async () => {
    let calls = 0;
    const model = new ClaudeModelClient("synthetic-key", (async () => {
      calls++;
      return new Response(
        JSON.stringify({
          type: "error",
          error: { type: "authentication_error", message: "private provider detail" },
        }),
        { status: 401, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch);
    try {
      await model.responses.create(request());
      throw new Error("Expected a provider rejection.");
    } catch (error) {
      expect(modelAvailabilityError(error)?.code).toBe("model_access_unavailable");
      expect(modelAvailabilityError(error)?.message).not.toContain("private provider detail");
    }
    expect(calls).toBe(1);
  });

  it("caches only static instructions and carries a rejected request's bounded retry time", async () => {
    const { model, calls } = fixture([message([{ type: "text", text: '{"reply":"ready"}' }])]);
    await model.responses.create(request());
    expect(calls[0]!.body.system).toEqual([
      { type: "text", text: request().instructions, cache_control: { type: "ephemeral", ttl: "5m" } },
    ]);
    expect(JSON.stringify(calls[0]!.body.messages)).not.toContain("cache_control");
    const limited = new ClaudeModelClient(
      "synthetic-key",
      (async () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "private limit detail" },
          }),
          { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } },
        )) as typeof fetch,
    );
    const error = await limited.responses.create(request()).catch((error) => error);
    expect(modelAvailabilityError(error)).toMatchObject({ code: "model_rate_limited", retryAfterSeconds: 2 });
    expect(modelAvailabilityError(error)?.message).not.toContain("private limit detail");
  });
});
