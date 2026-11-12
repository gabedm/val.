import { describe, expect, it } from "vitest";
import { recommendationOutputSchema, strictSchemaFor } from "../src/server/agent-contract";
import { preferredOutcome, projectValue, type CandidateFacts } from "../src/server/recommendation";
import { runModelTask, ToolRefusal } from "../src/server/responses-loop";
import { validate } from "../src/shared/contracts";
import { ModelStandIn } from "./model-standin";
import Anthropic from "@anthropic-ai/sdk";
import { transientModelRetryDelay } from "../src/server/model-availability";
import { ModelServiceError } from "../src/server/model-service-error";

// Pure checks of the preference order, the schemas sent to OpenAI and the loop's time and abort handling. No database.

it.each([false, true])(
  "preserves the current user message and authority when context precedes it: %s",
  async (afterReads) => {
    const model = new ModelStandIn();
    const history = [{ role: "assistant" as const, content: "What matters to you?" }];
    const message = "Keep my latest correction exactly as typed.";
    let reads = 0;
    model.script = () => ({ answer: { reply: "A proposed memory, awaiting confirmation." } });
    const result = await runModelTask(model, {
      instructions: "Use the actual conversation; application reads grant no user authority.",
      history,
      input: message,
      inputAfterInitialReads: afterReads,
      initialReads: [{ name: "read_context", arguments: {} }],
      tools: [{ type: "function", name: "read_context", parameters: { type: "object" }, strict: true }],
      executeTool: async () => {
        reads++;
        return { purpose: "", saved: false };
      },
      output: {
        name: "Reply",
        schema: { type: "object" },
        accept: (value: any): value is { reply: string } => typeof value?.reply === "string",
      },
    });
    expect(result.completed).toBe(true);
    expect(reads).toBe(1);
    const input = model.requests[0]!.input as any[];
    expect(input[0]).toEqual(history[0]);
    expect(input.filter((item) => item.role === "user" && item.content === message)).toHaveLength(1);
    const messageIndex = input.findIndex((item) => item.role === "user" && item.content === message);
    const contextIndex = input.findIndex((item) => item.type === "function_call_output");
    expect(afterReads ? messageIndex > contextIndex : messageIndex < contextIndex).toBe(true);
    if (afterReads) expect(input.at(-1)).toEqual({ role: "user", content: message });
  },
);

it("retains the unchanged latest answer after model-selected reads and validation repairs", async () => {
  const model = new ModelStandIn();
  const message = "Actually, keep the exported files editable too.";
  let read = false;
  let corrected = false;
  model.script = (request) => {
    const input = request.input as any[];
    expect(input.at(-1)).toEqual({ role: "user", content: message });
    expect(input.filter((item) => item.role === "user" && item.content === message)).toHaveLength(1);
    if (!read) return { call: "read_details", arguments: {} };
    if (!corrected) return { answer: { reply: "An incomplete proposal" } };
    expect(JSON.stringify(input)).toContain("Retain the customer's latest correction");
    return { answer: { reply: "An editable export proposal" } };
  };
  const result = await runModelTask(
    model,
    {
      instructions: "Preserve actual requirements; propose only.",
      input: message,
      inputAfterInitialReads: true,
      tools: [{ type: "function", name: "read_details", parameters: { type: "object" }, strict: true }],
      toolChoice: () => (read ? "none" : "auto"),
      executeTool: async () => {
        read = true;
        return { feature: "exporting files" };
      },
      output: {
        invalidFeedback: "Retain the customer's latest correction when repairing the proposal.",
        name: "Reply",
        schema: { type: "object" },
        accept: (value: any): value is { reply: string } => {
          if (!corrected) {
            corrected = true;
            return false;
          }
          return value?.reply === "An editable export proposal";
        },
      },
    },
    { maxToolCalls: 1, timeoutMs: 1000 },
  );
  expect(result.completed).toBe(true);
  expect(model.requests).toHaveLength(3);
});

it("keeps the original provider error classified when both bounded read-only attempts fail", async () => {
  let attempts = 0;
  const model = {
    responses: {
      create: async () => {
        attempts++;
        await new Promise((resolve) => setTimeout(resolve, 30));
        throw new ModelServiceError(503);
      },
    },
  };
  const result = await runModelTask(
    model,
    {
      instructions: "A read-only reply",
      input: {},
      tools: [],
      retryTransientErrors: true,
      output: {
        name: "reply",
        schema: { type: "object" },
        accept: (value): value is object => !!value && typeof value === "object",
      },
    },
    { maxToolCalls: 0, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 10 },
  );
  expect(result).toMatchObject({ completed: false, reason: "model_error" });
  expect(attempts).toBe(2);
});

it("honours a task output ceiling without weakening validation", async () => {
  const model = new ModelStandIn();
  model.script = () => ({ answer: { reply: "ready" } });
  const task = {
    instructions: "A read-only reply",
    input: {},
    tools: [],
    output: {
      name: "Reply",
      schema: { type: "object" },
      accept: (value: unknown): value is object => !!value && typeof value === "object",
    },
  };
  expect(
    (await runModelTask(model, task, { maxToolCalls: 0, timeoutMs: 1000, maxOutputTokens: 700 })).completed,
  ).toBe(true);
  expect(model.requests[0]!.max_output_tokens).toBe(700);
  for (const maxOutputTokens of [0, -1, 5001, 1.5])
    await expect(
      runModelTask(model, task, { maxToolCalls: 0, timeoutMs: 1000, maxOutputTokens }),
    ).rejects.toThrow("Invalid task output limit");
});

it("does not add a second loop retry when the model router owns bounded recovery", async () => {
  let attempts = 0;
  const client = {
    managesRecovery: true,
    responses: {
      create: async () => {
        attempts++;
        throw new ModelServiceError(503);
      },
    },
  };
  const result = await runModelTask(
    client,
    {
      instructions: "A read-only reply",
      input: {},
      tools: [],
      retryTransientErrors: true,
      output: {
        name: "Reply",
        schema: { type: "object" },
        accept: (value: unknown): value is object => !!value && typeof value === "object",
      },
    },
    { maxToolCalls: 0, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 10 },
  );
  expect(result).toMatchObject({ completed: false, reason: "model_error" });
  expect(attempts).toBe(1);
});

const plan = (
  candidateId: string,
  providerId: CandidateFacts["providerId"],
  recurringMinor: number,
  passes: boolean | null,
  dueNowMinor = recurringMinor,
): CandidateFacts => ({ candidateId, providerId, recurringMinor, dueNowMinor, passes });

describe("04's preference order", () => {
  const ceilingMinor = 1500;

  it("stays when the current output passes, whatever the current plan costs", () => {
    expect(
      preferredOutcome({
        currentProviderId: "provider_a",
        currentPasses: true,
        candidates: [plan("b_01", "provider_b", 900, true)],
        ceilingMinor: 100,
      }),
    ).toMatchObject({ action: "stay" });
  });

  it("prefers an eligible current-provider plan, as advice, over a cheaper replacement", () => {
    const outcome = preferredOutcome({
      currentProviderId: "provider_a",
      currentPasses: false,
      candidates: [plan("a_02", "provider_a", 1400, true), plan("b_01", "provider_b", 900, true)],
      ceilingMinor,
    });
    expect(outcome).toMatchObject({ action: "change_plan", candidateId: "a_02", reason: "advice_only" });
  });

  it("chooses the lowest monthly then lowest due-now replacement among those that pass within the ceiling", () => {
    const candidates = [
      plan("b_02", "provider_b", 1400, true),
      plan("b_01", "provider_b", 900, false),
      plan("b_03", "provider_b", 1400, true, 1000),
      plan("a_02", "provider_a", 1900, true),
    ];
    expect(
      preferredOutcome({ currentProviderId: "provider_a", currentPasses: false, candidates, ceilingMinor }),
    ).toMatchObject({ action: "switch", candidateId: "b_03" });
  });

  it("reports no candidate rather than relaxing the ceiling or a capability", () => {
    const candidates = [
      plan("a_02", "provider_a", 1900, true),
      plan("b_01", "provider_b", 900, false),
      plan("b_02", "provider_b", 1600, null),
    ];
    expect(
      preferredOutcome({ currentProviderId: "provider_a", currentPasses: false, candidates, ceilingMinor }),
    ).toMatchObject({ action: "investigate", reason: "no_candidate" });
  });
});

describe("dated paid-value comparison", () => {
  const facts = {
    assessedAt: "2026-10-11T00:00:00.000Z",
    oldNextBillingAt: "2026-11-11T10:00:00.000Z",
    renewalEffectiveAt: "2026-11-25T00:00:00.000Z",
    currentMinor: 1200,
    announcedMinor: 1800,
    candidateMinor: 900,
    introductoryMinor: 600,
    introductoryCycles: 3,
    feesMinor: 0,
  };

  it("counts only future Original service renewals and all three positive introductory charges before normal renewal", () => {
    const offer = projectValue(facts);
    expect(offer).toMatchObject({
      horizonMonths: 12,
      currentTotal: { amountMinor: 19200 },
      candidateTotal: { amountMinor: 9900 },
      netSavingMinor: 9300,
    });
    expect(
      projectValue({ ...facts, introductoryMinor: 900, introductoryCycles: 0 })?.candidateTotal.amountMinor,
    ).toBe(10800);
    expect(projectValue({ ...facts, feesMinor: 1400 })?.candidateTotal.amountMinor).toBe(11300);
  });

  it("can assess at month end without changing an established billing day", () => {
    expect(projectValue({ ...facts, assessedAt: "2026-10-31T00:00:00.000Z" })).toMatchObject({
      currentTotal: { amountMinor: 21000 },
      candidateTotal: { amountMinor: 9900 },
      netSavingMinor: 11100,
    });
  });

  it("withholds a value verdict when the future boundary, notice date or billing calendar is unknown", () => {
    expect(projectValue({ ...facts, oldNextBillingAt: "not reported" })).toBeNull();
    expect(projectValue({ ...facts, renewalEffectiveAt: "2026-10-10T00:00:00.000Z" })).toBeNull();
    expect(projectValue({ ...facts, oldNextBillingAt: "2026-11-30T10:00:00.000Z" })).toBeNull();
  });
});

describe("schemas submitted to OpenAI", () => {
  it("roots each named definition with only the $defs it uses", () => {
    const recommendation = strictSchemaFor("ModelRecommendation");
    expect(recommendation).toMatchObject({ type: "object", additionalProperties: false });
    expect(recommendation.$defs).toBeUndefined();
    expect(Object.keys(strictSchemaFor("PolicyDraft").$defs as object)).toEqual(["Money"]);
    expect(strictSchemaFor("GetQuoteArgs")).toEqual({
      type: "object",
      properties: { candidateId: { type: "string", minLength: 1 } },
      required: ["candidateId"],
      additionalProperties: false,
    });
  });

  it("asks for the explanation and evidence before the action, with exactly the contract's fields", () => {
    const contract = strictSchemaFor("ModelRecommendation") as {
      properties: Record<string, unknown>;
      required: string[];
    };
    const output = recommendationOutputSchema() as typeof contract;
    expect(Object.keys(output.properties)).toEqual([
      "explanation",
      "uncertainties",
      "evidenceIds",
      "action",
      "candidateId",
      "policyRevision",
    ]);
    expect(output.required).toEqual(Object.keys(output.properties));
    expect(output.properties).toEqual(contract.properties);
    expect([...output.required].sort()).toEqual([...contract.required].sort());
    expect(output).toMatchObject({ type: "object", additionalProperties: false });
  });
});

describe("the bounded loop", () => {
  const replyOutput = {
    name: "Reply",
    schema: {},
    accept: (value: unknown): value is { reply: string } =>
      typeof (value as { reply?: unknown })?.reply === "string",
  };
  const readTool = { type: "function" as const, name: "read_needs", parameters: {}, strict: true };
  const overloaded = () =>
    new Anthropic.APIError(
      undefined,
      { type: "error", error: { type: "overloaded_error", message: "Private provider diagnostic" } },
      undefined,
      new Headers(),
      "overloaded_error",
    );
  it("retries one transient inference without repeating completed reads or exposing partial output", async () => {
    const model = new ModelStandIn();
    let attempts = 0,
      reads = 0;
    model.script = () => {
      if (++attempts === 1) throw overloaded();
      return { answer: { reply: "ready" } };
    };
    const result = await runModelTask(model, {
      instructions: "x",
      input: {},
      tools: [readTool],
      initialReads: [{ name: "read_needs", arguments: {} }],
      retryTransientErrors: true,
      executeTool: async () => {
        reads++;
        return { purpose: "offline music" };
      },
      output: replyOutput,
    });
    expect(result).toMatchObject({
      completed: true,
      output: { reply: "ready" },
      usage: { modelCalls: 1, retryAttempts: 1 },
    });
    expect(attempts).toBe(2);
    expect(reads).toBe(1);
  });
  it("keeps transient retries opt-in, bounded and inside the original deadline", async () => {
    const model = new ModelStandIn();
    let attempts = 0;
    model.script = () => {
      attempts++;
      throw overloaded();
    };
    const task = { instructions: "x", input: {}, tools: [], output: replyOutput };
    expect(await runModelTask(model, task)).toMatchObject({ completed: false, reason: "model_error" });
    expect(attempts).toBe(1);
    attempts = 0;
    expect(await runModelTask(model, { ...task, retryTransientErrors: true })).toMatchObject({
      completed: false,
      reason: "model_error",
      usage: { retryAttempts: 1 },
    });
    expect(attempts).toBe(2);
    attempts = 0;
    expect(
      await runModelTask(model, { ...task, retryTransientErrors: true }, { maxToolCalls: 1, timeoutMs: 30 }),
    ).toMatchObject({ completed: false, reason: "timeout" });
    expect(attempts).toBe(1);
  });
  it("recovers from one stalled read-only inference without repeating completed tools", async () => {
    const model = new ModelStandIn();
    let attempts = 0,
      reads = 0;
    model.script = () => {
      if (++attempts === 1) return new Promise(() => {});
      return { answer: { reply: "ready" } };
    };
    const result = await runModelTask(
      model,
      {
        instructions: "Read-only reply",
        input: {},
        tools: [readTool],
        initialReads: [{ name: "read_needs", arguments: {} }],
        retryTransientErrors: true,
        executeTool: async () => {
          reads++;
          return { purpose: "saved customer needs" };
        },
        output: replyOutput,
      },
      { maxToolCalls: 2, timeoutMs: 3000, inferenceTimeoutMs: 30 },
    );
    expect(result).toMatchObject({ completed: true, usage: { retryAttempts: 1 } });
    expect(attempts).toBe(2);
    expect(reads).toBe(1);
    expect(model.requests[1]?.input).toEqual(model.requests[0]?.input);
  });
  it("stops after two stalled inferences and never extends the task or caller deadline", async () => {
    for (const cancel of [false, true]) {
      const model = new ModelStandIn();
      model.script = () => new Promise(() => {});
      const signal = cancel ? AbortSignal.timeout(60) : undefined;
      const result = await runModelTask(
        model,
        { instructions: "x", input: {}, tools: [], output: replyOutput, retryTransientErrors: true, signal },
        { maxToolCalls: 1, timeoutMs: 3000, inferenceTimeoutMs: 30 },
      );
      expect(result).toMatchObject({ completed: false, reason: "timeout" });
      expect(model.requests).toHaveLength(cancel ? 1 : 2);
    }
    const model = new ModelStandIn();
    model.script = () => new Promise(() => {});
    expect(
      await runModelTask(
        model,
        { instructions: "x", input: {}, tools: [], output: replyOutput, retryTransientErrors: true },
        { maxToolCalls: 1, timeoutMs: 60, inferenceTimeoutMs: 30 },
      ),
    ).toMatchObject({ completed: false, reason: "timeout" });
    expect(model.requests).toHaveLength(1);
  });
  it("recovers a stalled conversation from the same context without replaying account reads", async () => {
    const model = new ModelStandIn();
    let reads = 0;
    model.script = async (request, index, signal) => {
      if (model.requests.length === 1)
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      expect(request.tools).toEqual([]);
      expect(request.tool_choice).toBe("none");
      expect(request.text).toEqual(model.requests[0]!.text);
      expect(request.input).toEqual(model.requests[0]!.input);
      expect(JSON.stringify(request.input)).toContain("ofline on the tain");
      return { answer: { reply: "A readable proposal for confirmation" } };
    };
    const result = await runModelTask(
      model,
      {
        instructions: "Interpret the person's current answer; confirmation is required.",
        input: "ofline on the tain",
        tools: [{ type: "function", name: "read_account", parameters: {}, strict: true }],
        initialReads: [{ name: "read_account", arguments: {} }],
        executeTool: async () => {
          reads++;
          return { monthlyMinor: 1200, purpose: "Listening while travelling" };
        },
        retryTransientErrors: true,
        contextOnlyRecovery: true,
        output: replyOutput,
      },
      { maxToolCalls: 3, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 10 },
    );
    expect(result).toMatchObject({ completed: true, usage: { retryAttempts: 1 } });
    expect(reads).toBe(1);
    expect(model.requests).toHaveLength(2);
  });

  it("does not use context-only recovery to skip a required account read", async () => {
    const model = new ModelStandIn();
    let read = false;
    model.script = async (request, index, signal) => {
      if (model.requests.length === 1)
        return new Promise((_resolve, reject) =>
          signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
        );
      if (!read) {
        expect(request.tool_choice).toBe("required");
        expect(request.tools?.length).toBe(1);
        return { call: "read_account" };
      }
      return { answer: { reply: "The required read is complete" } };
    };
    const tools = [{ type: "function" as const, name: "read_account", parameters: {}, strict: true }];
    const result = await runModelTask(
      model,
      {
        instructions: "Read before replying.",
        input: "An informal answer",
        tools,
        availableTools: () => (read ? [] : tools),
        toolChoice: () => (read ? "none" : "required"),
        executeTool: async () => {
          read = true;
          return { owned: true };
        },
        retryTransientErrors: true,
        contextOnlyRecovery: true,
        output: replyOutput,
      },
      { maxToolCalls: 3, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 10 },
    );
    expect(result.completed).toBe(true);
    expect(result.trace).toHaveLength(1);
    expect(model.requests).toHaveLength(3);
  });

  it("never executes a tool hallucinated by a context-only recovery", async () => {
    const model = new ModelStandIn();
    let reads = 0;
    model.script = async (_request, index, signal) =>
      model.requests.length === 1
        ? new Promise((_resolve, reject) =>
            signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
          )
        : { call: "read_account" };
    const result = await runModelTask(
      model,
      {
        instructions: "Reply from available context.",
        input: "An informal answer",
        tools: [{ type: "function", name: "read_account", parameters: {}, strict: true }],
        executeTool: async () => {
          reads++;
          return {};
        },
        retryTransientErrors: true,
        contextOnlyRecovery: true,
        output: replyOutput,
      },
      { maxToolCalls: 3, timeoutMs: 1000, inferenceTimeoutMs: 100, inferenceHedgeMs: 10 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(model.requests).toHaveLength(2);
    expect(reads).toBe(0);
  });

  it("requires read-only retry authorization before enabling context recovery", async () => {
    const model = new ModelStandIn();
    await expect(
      runModelTask(model, {
        instructions: "Reply.",
        input: {},
        tools: [],
        contextOnlyRecovery: true,
        output: replyOutput,
      }),
    ).rejects.toThrow("Context recovery requires a read-only task");
    expect(model.requests).toHaveLength(0);
  });

  it("keeps a valid slow original reply when its read-only backup stalls", async () => {
    const model = new ModelStandIn();
    let attempts = 0;
    const signals: AbortSignal[] = [];
    model.script = async (_request, _index, signal) => {
      if (signal) signals.push(signal);
      if (++attempts > 1) return new Promise(() => {});
      await new Promise((resolve) => setTimeout(resolve, 60));
      return { answer: { reply: "original completed" } };
    };
    const result = await runModelTask(
      model,
      {
        instructions: "Read-only reply",
        input: {},
        tools: [],
        output: replyOutput,
        retryTransientErrors: true,
      },
      { maxToolCalls: 1, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 20 },
    );
    expect(result).toMatchObject({
      completed: true,
      output: { reply: "original completed" },
      usage: { retryAttempts: 1 },
    });
    expect(model.requests).toHaveLength(2);
    expect(model.requests[1]!.input).toEqual(model.requests[0]!.input);
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
  it("does not dispatch a backup for a quick read-only reply", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ answer: { reply: "ready" } });
    expect(
      await runModelTask(
        model,
        {
          instructions: "Read-only reply",
          input: {},
          tools: [],
          output: replyOutput,
          retryTransientErrors: true,
        },
        { maxToolCalls: 1, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: 20 },
      ),
    ).toMatchObject({ completed: true });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(model.requests).toHaveLength(1);
  });
  it("rejects an unbounded or unacknowledged read-only hedge", async () => {
    const model = new ModelStandIn();
    const task = { instructions: "x", input: {}, tools: [], output: replyOutput, retryTransientErrors: true };
    for (const limits of [
      { maxToolCalls: 1, timeoutMs: 1000, inferenceHedgeMs: 20 },
      { maxToolCalls: 1, timeoutMs: 1000, inferenceTimeoutMs: 20, inferenceHedgeMs: 20 },
      { maxToolCalls: 1, timeoutMs: 1000, inferenceTimeoutMs: 500, inferenceHedgeMs: -1 },
    ])
      await expect(runModelTask(model, task, limits)).rejects.toThrow("Invalid read-only recovery deadline");
    await expect(
      runModelTask(
        model,
        { ...task, retryTransientErrors: false },
        {
          maxToolCalls: 1,
          timeoutMs: 1000,
          inferenceTimeoutMs: 500,
          inferenceHedgeMs: 20,
        },
      ),
    ).rejects.toThrow("Invalid read-only inference deadline");
    expect(model.requests).toHaveLength(0);
  });
  it("does not replay a timed-out web search or enable inference retries implicitly", async () => {
    const model = new ModelStandIn();
    model.script = () => new Promise(() => {});
    expect(
      await runModelTask(
        model,
        {
          instructions: "x",
          input: {},
          tools: [{ type: "web_search" } as any],
          output: replyOutput,
          retryTransientErrors: true,
        },
        { maxToolCalls: 1, timeoutMs: 3000, inferenceTimeoutMs: 30, inferenceHedgeMs: 10 },
      ),
    ).toMatchObject({ completed: false, reason: "timeout" });
    expect(model.requests).toHaveLength(1);
    await expect(
      runModelTask(
        model,
        { instructions: "x", input: {}, tools: [], output: replyOutput },
        { maxToolCalls: 1, timeoutMs: 3000, inferenceTimeoutMs: 30 },
      ),
    ).rejects.toThrow("Invalid read-only inference deadline");
  });
  it("does not retry access failures, invalid requests, timeouts, unknown errors or long provider waits", () => {
    for (const failure of [
      new Error("connection lost"),
      new Anthropic.APIUserAbortError(),
      new Anthropic.APIConnectionTimeoutError(),
      new Anthropic.APIError(400, {}, "Private diagnostic", new Headers(), "invalid_request_error"),
      new Anthropic.APIError(401, {}, "Private diagnostic", new Headers(), "api_error"),
      new Anthropic.APIError(
        undefined,
        {},
        "Private diagnostic",
        new Headers({ "retry-after": "60" }),
        "overloaded_error",
      ),
    ])
      expect(transientModelRetryDelay(failure)).toBeNull();
    expect(transientModelRetryDelay(overloaded())).toBe(1000);
  });
  it("executes mandatory reads before the first model request and records their real results", async () => {
    const model = new ModelStandIn();
    const executed: string[] = [];
    model.script = (_request, index) =>
      index === 0 ? { call: "read_needs" } : { answer: { reply: "ready" } };
    const result = await runModelTask(model, {
      instructions: "Use the actual owner-scoped read.",
      input: "What do I use it for?",
      tools: [readTool],
      initialReads: [{ name: "read_needs", arguments: {} }],
      output: replyOutput,
      executeTool: async (name) => {
        executed.push(name);
        return { purpose: "offline music" };
      },
    });
    expect(result).toMatchObject({
      completed: true,
      usage: { modelCalls: 1 },
      trace: [{ tool: "read_needs", origin: "server", result: { purpose: "offline music" } }],
    });
    expect(executed).toEqual(["read_needs"]);
    expect(model.requests).toHaveLength(1);
  });
  it("keeps mandatory reads inside the tool allowance and refuses unavailable tools before any model request", async () => {
    const model = new ModelStandIn();
    let executed = 0;
    const task = {
      instructions: "x",
      input: {},
      tools: [readTool],
      initialReads: [{ name: "read_needs", arguments: {} }],
      output: replyOutput,
      executeTool: async () => {
        executed++;
        return {};
      },
    };
    expect(await runModelTask(model, task, { maxToolCalls: 0, timeoutMs: 1000 })).toMatchObject({
      completed: false,
      reason: "tool_budget",
    });
    expect(await runModelTask(model, { ...task, availableTools: () => [] })).toMatchObject({
      completed: false,
      reason: "unknown_tool",
    });
    expect(model.requests).toHaveLength(0);
    expect(executed).toBe(0);
  });
  it("applies the original deadline to mandatory reads without dispatching a model request", async () => {
    const model = new ModelStandIn();
    const result = await runModelTask(
      model,
      {
        instructions: "x",
        input: {},
        tools: [readTool],
        initialReads: [{ name: "read_needs", arguments: {} }],
        output: replyOutput,
        executeTool: async () => new Promise(() => undefined),
      },
      { maxToolCalls: 1, timeoutMs: 30 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(model.requests).toHaveLength(0);
  });
  it("rejects a model replay of an application-issued read identifier", async () => {
    const model = new ModelStandIn();
    let executed = 0;
    model.script = (request) => ({
      call: "read_needs",
      callId: (request.input as any[]).find((item) => item.type === "function_call")?.call_id,
    });
    const result = await runModelTask(
      model,
      {
        instructions: "x",
        input: {},
        tools: [readTool],
        initialReads: [{ name: "read_needs", arguments: {} }],
        output: replyOutput,
        executeTool: async () => {
          executed++;
          return {};
        },
      },
      { maxToolCalls: 2, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({ completed: false, reason: "invalid_call" });
    expect(executed).toBe(1);
  });
  it("repairs an opted-in invalid format once before applying normal answer validation", async () => {
    const model = new ModelStandIn();
    let calls = 0;
    model.script = () => ({ answer: ++calls === 1 ? { unexpected: "data" } : { reply: "valid" } });
    const result = await runModelTask(model, {
      instructions: "Return the supplied facts.",
      input: { known: "fact" },
      tools: [],
      output: { ...replyOutput, invalidFeedback: "Return exactly the required reply field." },
    });
    expect(result).toMatchObject({ completed: true, output: { reply: "valid" }, usage: { modelCalls: 2 } });
    expect(model.requests[1]!.input).toContainEqual({
      role: "developer",
      content: "Return exactly the required reply field.",
    });
  });
  it("stops after one unsuccessful format repair", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ answer: { wrong: "still invalid" } });
    const result = await runModelTask(model, {
      instructions: "Return a reply.",
      input: {},
      tools: [],
      output: { ...replyOutput, invalidFeedback: "Use the required reply field." },
    });
    expect(result).toMatchObject({ completed: false, reason: "invalid_output", usage: { modelCalls: 2 } });
  });
  it("does not retry invalid formats for tasks that did not opt in", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ answer: { wrong: "invalid" } });
    const result = await runModelTask(model, {
      instructions: "Return a reply.",
      input: {},
      tools: [],
      output: replyOutput,
    });
    expect(result).toMatchObject({ completed: false, reason: "invalid_output", usage: { modelCalls: 1 } });
  });
  it("does not turn a refusal into a format retry", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ refusal: "Declined" });
    const result = await runModelTask(model, {
      instructions: "Return a reply.",
      input: {},
      tools: [],
      output: { ...replyOutput, invalidFeedback: "Use the required reply field." },
    });
    expect(result).toMatchObject({ completed: false, reason: "refusal", usage: { modelCalls: 1 } });
  });
  it("keeps a format repair inside its original deadline and aborts a stalled second request", async () => {
    const model = new ModelStandIn();
    let calls = 0,
      secondSignal: AbortSignal | undefined;
    model.script = (_request, _index, signal) => {
      if (++calls === 1) return { answer: { wrong: "invalid" } };
      secondSignal = signal;
      return new Promise(() => {});
    };
    const result = await runModelTask(
      model,
      {
        instructions: "Return a reply.",
        input: {},
        tools: [],
        output: { ...replyOutput, invalidFeedback: "Use the required reply field." },
      },
      { timeoutMs: 30, maxToolCalls: 0 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(calls).toBe(2);
    expect(secondSignal?.aborted).toBe(true);
  });
  it("awaits async feedback and permits one bounded correction before returning the accepted reply", async () => {
    const model = new ModelStandIn();
    let writes = 0,
      checks = 0;
    model.script = () => ({ answer: { reply: ++writes === 1 ? "unreviewed" : "corrected" } });
    const result = await runModelTask(model, {
      instructions: "Propose a reply.",
      input: {},
      tools: [],
      output: {
        ...replyOutput,
        feedback: async (value, signal) => {
          checks++;
          await Promise.resolve();
          expect(signal.aborted).toBe(false);
          return value.reply === "unreviewed" ? "Correct the conflict." : null;
        },
      },
    });
    expect(result).toMatchObject({ completed: true, output: { reply: "corrected" } });
    expect(writes).toBe(2);
    expect(checks).toBe(2);
  });
  it("propagates parent cancellation into an asynchronous consistency check without publishing the reply", async () => {
    const model = new ModelStandIn(),
      parent = new AbortController();
    let checkSignal: AbortSignal | undefined;
    model.script = () => ({ answer: { reply: "unreviewed" } });
    const result = await runModelTask(model, {
      instructions: "Propose a reply.",
      signal: parent.signal,
      input: {},
      tools: [],
      output: {
        ...replyOutput,
        feedback: (_value, signal) => {
          checkSignal = signal;
          parent.abort();
          return new Promise<null>(() => {});
        },
      },
    });
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(checkSignal?.aborted).toBe(true);
    expect(model.requests).toHaveLength(1);
  });
  it.each([undefined, 2] as const)(
    "keeps the default repair bound and checks an opted-in second revision (%s)",
    async (maxCorrections) => {
      const model = new ModelStandIn();
      let writes = 0,
        checks = 0;
      model.script = () => ({ answer: { reply: ++writes === 3 ? "valid" : "still invalid" } });
      const result = await runModelTask(
        model,
        {
          instructions: "Propose a checked reply.",
          input: {},
          tools: [],
          output: {
            ...replyOutput,
            feedback: (value) => {
              checks++;
              return value.reply === "valid"
                ? null
                : "Correct the reported conflict without changing the task.";
            },
          },
        },
        { timeoutMs: 1000, maxToolCalls: 0, ...(maxCorrections ? { maxCorrections } : {}) },
      );
      expect(writes).toBe(maxCorrections === 2 ? 3 : 2);
      expect(checks).toBe(writes);
      expect(result.completed).toBe(maxCorrections === 2);
      expect(result.trace).toEqual([]);
      if (result.completed) expect(result.output.reply).toBe("valid");
      else expect(result.reason).toBe("invalid_output");
    },
  );
  it("rejects an unbounded repair setting before dispatching a model request", async () => {
    const model = new ModelStandIn();
    await expect(
      runModelTask(
        model,
        { instructions: "Reply.", input: {}, tools: [], output: replyOutput },
        { timeoutMs: 1000, maxToolCalls: 0, maxCorrections: 3 as any },
      ),
    ).rejects.toThrow("Invalid model correction limit");
    expect(model.requests).toEqual([]);
  });
  it("counts asynchronous review time against the original deadline even if the checker ignores cancellation", async () => {
    const model = new ModelStandIn();
    let checkSignal: AbortSignal | undefined;
    model.script = () => ({ answer: { reply: "unreviewed" } });
    const result = await runModelTask(
      model,
      {
        instructions: "Propose a reply.",
        input: {},
        tools: [],
        output: {
          ...replyOutput,
          feedback: (_value, signal) => {
            checkSignal = signal;
            return new Promise<null>(() => {});
          },
        },
      },
      { maxToolCalls: 0, timeoutMs: 30 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(checkSignal?.aborted).toBe(true);
    expect(model.requests).toHaveLength(1);
  });
  it("finishes from collected evidence when optional reads reach their limit", async () => {
    const model = new ModelStandIn();
    model.script = (request) =>
      request.tools?.length
        ? { call: "read_needs" }
        : { answer: { reply: "Your saved workflow is ready to confirm." } };
    let reads = 0;
    const result = await runModelTask(
      model,
      {
        instructions: "Read the saved needs and propose a reply.",
        input: "Music and offline podcasts.",
        tools: [{ type: "function", name: "read_needs", parameters: {}, strict: true }],
        executeTool: async () => {
          reads++;
          return { purpose: "Music and offline podcasts" };
        },
        output: {
          name: "Reply",
          schema: {
            type: "object",
            properties: { reply: { type: "string" } },
            required: ["reply"],
            additionalProperties: false,
          },
          accept: (value): value is { reply: string } =>
            typeof (value as { reply?: unknown })?.reply === "string",
        },
      },
      { maxToolCalls: 1, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({
      completed: true,
      output: { reply: "Your saved workflow is ready to confirm." },
    });
    expect(reads).toBe(1);
    expect(model.requests[1]).toMatchObject({ tool_choice: "none" });
    expect(model.requests[1]!.tools).toBeUndefined();
    expect(JSON.stringify(model.requests[1]!.input)).toContain("Music and offline podcasts");
  });

  it("never forces a final answer while required evidence is still missing", async () => {
    const model = new ModelStandIn();
    const result = await runModelTask(
      model,
      {
        instructions: "A required read is missing.",
        input: {},
        tools: [{ type: "function", name: "read_account", parameters: {}, strict: true }],
        toolChoice: () => "required",
        output: { name: "Reply", schema: {}, accept: (value): value is object => !!value },
      },
      { maxToolCalls: 0, timeoutMs: 1000 },
    );
    expect(result).toMatchObject({ completed: false, reason: "tool_budget", trace: [] });
    expect(model.requests).toHaveLength(0);
  });

  const output = {
    name: "ModelRecommendation",
    schema: strictSchemaFor("ModelRecommendation"),
    accept: validate.modelRecommendation,
  };

  it("aborts an overdue model request and ends in timeout review", async () => {
    const model = new ModelStandIn();
    let aborted = false;
    model.script = (_request, _index, signal) =>
      new Promise((_resolve, reject) => {
        signal!.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    const result = await runModelTask(
      model,
      { instructions: "x", input: {}, tools: [], output },
      { maxToolCalls: 12, timeoutMs: 50 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout" });
    expect(aborted).toBe(true);
  });

  it("counts tool time against the same deadline and stops before the next call", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ call: "slow_read" });
    const tools = [
      {
        type: "function" as const,
        name: "slow_read",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
      },
    ];
    const executeTool = (_name: string, _args: unknown, signal: AbortSignal) =>
      new Promise<unknown>((resolve) => setTimeout(() => resolve(signal.aborted ? "late" : "ok"), 80));
    const result = await runModelTask(
      model,
      { instructions: "x", input: {}, tools, output, executeTool },
      { maxToolCalls: 12, timeoutMs: 50 },
    );
    expect(result).toMatchObject({ completed: false, reason: "timeout", trace: [] });
    expect(model.requests).toHaveLength(1);
  });

  const neverSettles = () => new Promise<never>(() => {});
  const pendingAfter = (ms: number) =>
    new Promise((resolve) => setTimeout(() => resolve("still pending"), ms));

  it("ends on time in timeout review even when a tool never settles, and tells the tool to stop", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ call: "stuck_read" });
    const tools = [
      {
        type: "function" as const,
        name: "stuck_read",
        parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        strict: true,
      },
    ];
    let toolSignal: AbortSignal | undefined;
    const executeTool = (_name: string, _args: unknown, signal: AbortSignal) => {
      toolSignal = signal;
      return neverSettles();
    };
    const result = await Promise.race([
      runModelTask(
        model,
        { instructions: "x", input: {}, tools, output, executeTool },
        { maxToolCalls: 12, timeoutMs: 20 },
      ),
      pendingAfter(500),
    ]);
    expect(result).toMatchObject({ completed: false, reason: "timeout", trace: [] });
    expect(toolSignal?.aborted).toBe(true);
  });

  it("ends on time in timeout review even when a model request ignores the abort signal", async () => {
    const model = new ModelStandIn();
    model.script = () => neverSettles();
    const result = await Promise.race([
      runModelTask(
        model,
        { instructions: "x", input: {}, tools: [], output },
        { maxToolCalls: 12, timeoutMs: 20 },
      ),
      pendingAfter(500),
    ]);
    expect(result).toMatchObject({ completed: false, reason: "timeout", usage: { modelCalls: 0 } });
  });

  it("turns a tool refusal into review and adds up token usage", async () => {
    const model = new ModelStandIn();
    model.script = () => ({ call: "read_account" });
    const tools = [{ type: "function" as const, name: "read_account", parameters: {}, strict: true }];
    const result = await runModelTask(model, {
      instructions: "x",
      input: {},
      tools,
      output,
      executeTool: async () => {
        throw new ToolRefusal("No.");
      },
    });
    expect(result).toMatchObject({
      completed: false,
      reason: "tool_refused",
      detail: "No.",
      usage: { modelCalls: 1, inputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
    });
  });
});
