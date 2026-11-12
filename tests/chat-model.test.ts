import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import { startTestApp, type TestApp } from "./helpers";
import { chatModelForOwner } from "../src/server/chat-model";
import { chatModelHealth, judgeDemoRequests } from "../src/server/db/schema";
import { geminiConversationModel, geminiModel } from "../src/server/gemini-model";
import { createModelFundingGroup, modelForOwner } from "../src/server/judge-budget";
import { ModelServiceError } from "../src/server/model-service-error";
import type { ModelClient } from "../src/server/responses-loop";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(async () => {
  await app.close();
});
beforeEach(async () => {
  await app.ctx.db.delete(chatModelHealth);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const response = (model: string) =>
  ({
    id: "model-result",
    model,
    status: "completed",
    output: [],
    output_text: '{"reply":"ready"}',
    usage: {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  }) as unknown as Response;
const request: ResponseCreateParamsNonStreaming = {
  model: geminiConversationModel,
  store: false,
  input: "Keep exactly this user's wording",
  max_output_tokens: 1000,
  tools: [],
  text: {
    format: {
      type: "json_schema",
      name: "Reply",
      schema: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      },
      strict: true,
    },
  },
};
function model(name: string, create: ModelClient["responses"]["create"]): ModelClient {
  return {
    provider: "google",
    model: name,
    inputTokenBound: () => 1000,
    outputTokenBound: (body) => body.max_output_tokens ?? 1000,
    responses: { create: vi.fn(create) },
  };
}
async function owner() {
  const b = app.browser();
  await b.login();
  return (await b.get("/api/session")).body.ownerId as string;
}
function setup(primary: ModelClient, backup: ModelClient) {
  return {
    ...app.ctx,
    config: { ...app.ctx.config, aiBudgetMicros: 100_000_000 },
    model: backup,
    conversationModel: primary,
  };
}
function shortenRecovery() {
  const native = setTimeout;
  vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: any, ms?: number, ...args: any[]) =>
    native(fn, ms === 8000 ? 25 : ms && ms >= 1000 && ms < 1500 ? 5 : ms, ...args)) as typeof setTimeout);
}

it("uses one separately funded alternative for a transient error, preserving the command and schema", async () => {
  shortenRecovery();
  const ownerId = await owner();
  const primary = model(geminiConversationModel, async () => {
    throw new ModelServiceError(503, new Headers(), true);
  });
  const backup = model(geminiModel, async () => response(geminiModel));
  const ctx = setup(primary, backup);
  const routed = chatModelForOwner(ctx, ownerId, primary);
  expect(await routed.client.responses.create(request)).toMatchObject({ model: geminiModel });
  expect(primary.responses.create).toHaveBeenCalledTimes(1);
  expect(backup.responses.create).toHaveBeenCalledTimes(1);
  expect(vi.mocked(backup.responses.create).mock.calls[0]![0]).toEqual({
    ...request,
    model: geminiModel,
    service_tier: "default",
  });
  expect(routed.actualModel()).toBe(backup);
  expect(routed.usedModels()).toEqual([geminiConversationModel, geminiModel]);
  const rows = await ctx.db.select().from(judgeDemoRequests).where(eq(judgeDemoRequests.ownerId, ownerId));
  expect(rows.map((r) => r.state).sort()).toEqual(["settled", "uncertain"]);
  const held = rows.find((r) => r.state === "uncertain")!;
  expect(held.chargedMicros).toBe(held.reservedMicros);
  expect(held.chargedMicros).toBeGreaterThan(0);
});

it("escapes a hung provider even when its SDK ignores cancellation and retains its uncertain cost", async () => {
  shortenRecovery();
  const ownerId = await owner();
  let release!: (value: Response) => void;
  const primary = model(
    geminiConversationModel,
    () =>
      new Promise((r) => {
        release = r;
      }),
  );
  const backup = model(geminiModel, async () => response(geminiModel));
  const ctx = setup(primary, backup);
  const routed = chatModelForOwner(ctx, ownerId, primary);
  const started = Date.now();
  expect(await routed.client.responses.create(request)).toMatchObject({ model: geminiModel });
  expect(Date.now() - started).toBeLessThan(1500);
  const [held] = await ctx.db
    .select()
    .from(judgeDemoRequests)
    .where(and(eq(judgeDemoRequests.ownerId, ownerId), eq(judgeDemoRequests.state, "uncertain")));
  expect(held!.chargedMicros).toBeGreaterThan(0);
  release(response(geminiConversationModel));
  await new Promise((r) => setTimeout(r, 15));
  const [after] = await ctx.db.select().from(judgeDemoRequests).where(eq(judgeDemoRequests.id, held!.id));
  expect(after).toMatchObject({ state: "uncertain", chargedMicros: held!.chargedMicros });
});

it("opens a shared cooldown after repeated failures and routes the next task directly to the healthy model", async () => {
  shortenRecovery();
  const ownerId = await owner();
  const primary = model(geminiConversationModel, async () => {
    throw new ModelServiceError(503);
  });
  const backup = model(geminiModel, async () => response(geminiModel));
  const ctx = setup(primary, backup);
  for (let i = 0; i < 3; i++) await chatModelForOwner(ctx, ownerId, primary).client.responses.create(request);
  expect(primary.responses.create).toHaveBeenCalledTimes(2);
  expect(backup.responses.create).toHaveBeenCalledTimes(3);
  const [health] = await ctx.db
    .select()
    .from(chatModelHealth)
    .where(eq(chatModelHealth.model, geminiConversationModel));
  expect(health!.openUntil!.getTime()).toBeGreaterThan(Date.now());
});

it.each([400, 401, 403])(
  "does not bypass authentication or invalid requests with a fallback: %s",
  async (status) => {
    const ownerId = await owner();
    const primary = model(geminiConversationModel, async () => {
      throw new ModelServiceError(status);
    });
    const backup = model(geminiModel, async () => response(geminiModel));
    await expect(
      chatModelForOwner(setup(primary, backup), ownerId, primary).client.responses.create(request),
    ).rejects.toMatchObject({ status });
    expect(backup.responses.create).not.toHaveBeenCalled();
  },
);

it("does not call either provider when the existing installation budget cannot fund it", async () => {
  const ownerId = await owner();
  const primary = model(geminiConversationModel, async () => response(geminiConversationModel));
  const backup = model(geminiModel, async () => response(geminiModel));
  const ctx = setup(primary, backup);
  ctx.config.aiBudgetMicros = 1;
  await expect(
    chatModelForOwner(ctx, ownerId, primary).client.responses.create(request),
  ).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  expect(primary.responses.create).not.toHaveBeenCalled();
  expect(backup.responses.create).not.toHaveBeenCalled();
});

it("rejects forged or foreign-owner funding groups", async () => {
  const first = await owner(),
    second = await owner();
  const primary = model(geminiConversationModel, async () => response(geminiConversationModel));
  const ctx = setup(primary, primary);
  expect(() => modelForOwner(ctx, first, { concurrentRequests: 2, fundingGroup: {} })).toThrow();
  expect(() =>
    modelForOwner(ctx, second, { concurrentRequests: 2, fundingGroup: createModelFundingGroup(ctx, first) }),
  ).toThrow();
});

it("bounds direct funded calls when an SDK ignores an externally cancelled request", async () => {
  const ownerId = await owner();
  let entered!: () => void;
  const dispatched = new Promise<void>((r) => {
    entered = r;
  });
  const primary = model(geminiConversationModel, async () => {
    entered();
    return new Promise(() => {});
  });
  const ctx = setup(primary, primary);
  const stop = new AbortController();
  const task = modelForOwner(ctx, ownerId).responses.create(request, { signal: stop.signal });
  const rejected = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await dispatched;
  stop.abort();
  await rejected;
  expect(
    await ctx.db.select().from(judgeDemoRequests).where(eq(judgeDemoRequests.ownerId, ownerId)),
  ).toMatchObject([{ state: "uncertain" }]);
});
