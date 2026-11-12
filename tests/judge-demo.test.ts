import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import { agentModel } from "../src/server/agent-contract";
import { hashPassword } from "../src/server/auth";
import {
  cases,
  judgeDemoAccess,
  judgeDemoCounters,
  judgeDemoOwners,
  judgeDemoRequests,
  ownerPriceChecks,
} from "../src/server/db/schema";
import {
  boundedJudgeRequest,
  judgeBudgetStatus,
  judgeLimits,
  modelForOwner,
  modelCostMicros,
} from "../src/server/judge-budget";
import { runInvestigation } from "../src/server/investigation";
import type { ModelClient } from "../src/server/responses-loop";
import { runModelTask } from "../src/server/responses-loop";
import { startTestApp, type TestApp } from "./helpers";
import { claudeModel } from "../src/server/model-settings";
import { geminiModel } from "../src/server/gemini-model";
import { ModelServiceError } from "../src/server/model-service-error";

let app: TestApp;
const credentials = { username: "panel", password: "isolated-judge-password" };
const request = {
  model: agentModel,
  input: [{ role: "user" as const, content: "An authored test request" }],
};
const response = (input = 100, output = 20) =>
  ({
    id: "test-response",
    model: agentModel,
    status: "completed",
    output: [],
    usage: { input_tokens: input, output_tokens: output },
  }) as unknown as Response;
beforeAll(async () => {
  app = await startTestApp();
  app.ctx.config.judgeDemo = {
    username: credentials.username,
    passwordHash: await hashPassword(credentials.password),
  };
});
afterAll(() => app.close());
beforeEach(async () => {
  app.ctx.config.judgeAccessPaused = false;
  app.ctx.config.ownerAccess = null;
  app.ctx.config.privateShareLink = null;
  await app.ctx.db.delete(judgeDemoRequests);
  await app.ctx.db.delete(judgeDemoCounters);
  await app.ctx.db.delete(judgeDemoOwners);
  await app.ctx.db.delete(judgeDemoAccess);
  app.model.requests.splice(0);
  app.model.script = () => ({ text: "An offline answer" });
});
async function invited() {
  const browser = app.browser();
  const login = await browser.login();
  expect((await browser.post("/api/judge/access", credentials)).status).toBe(200);
  expect((await browser.get("/api/catalogue")).status).toBe(200);
  return { browser, ownerId: login.body.session.ownerId as string };
}

it("expires invitation grants when the session key rotates without changing the saved owner", async () => {
  const { browser, ownerId } = await invited();
  const previous = app.ctx.config.sessionSecret;
  try {
    app.ctx.config.sessionSecret = "synthetic-rotated-judge-session-key-0123456789";
    expect((await browser.open()).body.authenticated).toBe(false);
    expect((await browser.get("/api/judge/access")).body.allowed).toBe(false);
    expect((await browser.login()).body.session.ownerId).toBe(ownerId);
    expect((await browser.post("/api/judge/access", credentials)).status).toBe(200);
    expect((await browser.get("/api/catalogue")).status).toBe(200);
  } finally {
    app.ctx.config.sessionSecret = previous;
  }
});
async function fund(ownerId: string, model: ModelClient = app.model) {
  return modelForOwner({ ...app.ctx, model }, ownerId).responses.create(request);
}

it("waits for its own parallel research reservation to settle when only one search fits", async () => {
  const { ownerId } = await invited();
  let entered = 0,
    release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const model: ModelClient = {
    provider: "google",
    model: geminiModel,
    inputTokenBound: () => 200_000,
    outputTokenBound: (command) => (command.max_output_tokens ?? 5000) * 2,
    searchQueryBound: 100,
    searchQueryCount: () => 0,
    responses: {
      create: async () => {
        entered++;
        if (entered === 1) await blocked;
        return { ...response(), model: geminiModel };
      },
    },
  };
  const command = {
    ...request,
    model: geminiModel,
    tools: [{ type: "web_search" as const }],
    max_tool_calls: 1,
  };
  const reserve = boundedJudgeRequest(command, model).reserveMicros;
  const ctx = { ...app.ctx, config: { ...app.ctx.config, aiBudgetMicros: reserve + 100_000 }, model };
  const funded = modelForOwner(ctx, ownerId, { concurrentRequests: 2 });
  const first = funded.responses.create(command);
  await vi.waitFor(() => expect(entered).toBe(1));
  const second = funded.responses.create(command);
  void second.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(entered).toBe(1);
  release();
  const result = await Promise.allSettled([first, second]);
  expect(result.map((item) => item.status)).toEqual(["fulfilled", "fulfilled"]);
  expect(entered).toBe(2);
  expect((await judgeBudgetStatus(ctx)).requests).toBe(2);
  expect((await judgeBudgetStatus(ctx)).usedUsd).toBeLessThan((reserve + 100_000) / 1_000_000);
});
it.each(["cancelled", "uncertain"] as const)(
  "does not dispatch a waiting research request when its outcome is %s",
  async (outcome) => {
    const { ownerId } = await invited();
    let entered = 0,
      release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model: ModelClient = {
      provider: "google",
      model: geminiModel,
      inputTokenBound: () => 200_000,
      outputTokenBound: (command) => (command.max_output_tokens ?? 5000) * 2,
      searchQueryBound: 100,
      searchQueryCount: () => 0,
      responses: {
        create: async () => {
          entered++;
          await blocked;
          if (outcome === "uncertain") throw new Error("Connection lost after dispatch");
          return { ...response(), model: geminiModel };
        },
      },
    };
    const command = {
      ...request,
      model: geminiModel,
      tools: [{ type: "web_search" as const }],
      max_tool_calls: 1,
    };
    const reserve = boundedJudgeRequest(command, model).reserveMicros;
    const ctx = { ...app.ctx, config: { ...app.ctx.config, aiBudgetMicros: reserve + 100_000 }, model };
    const funded = modelForOwner(ctx, ownerId, { concurrentRequests: 2 });
    const first = funded.responses.create(command);
    void first.catch(() => {});
    const cancellation = new AbortController();
    try {
      await vi.waitFor(() => expect(entered).toBe(1));
      const second = funded.responses.create(command, { signal: cancellation.signal });
      void second.catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(entered).toBe(1);
      if (outcome === "cancelled") {
        cancellation.abort(new Error("Research cancelled"));
        await expect(second).rejects.toThrow("Research cancelled");
      }
      release();
      const result = await Promise.allSettled([first, second]);
      expect(result.map((item) => item.status)).toEqual([
        outcome === "uncertain" ? "rejected" : "fulfilled",
        "rejected",
      ]);
      expect(entered).toBe(1);
      expect((await judgeBudgetStatus(ctx)).requests).toBe(1);
      const [record] = await app.ctx.db.select().from(judgeDemoRequests);
      if (!record) throw new Error("The dispatched request must retain its accounting record");
      expect(record.state).toBe(outcome === "uncertain" ? "uncertain" : "settled");
      expect(record.chargedMicros).toBe(
        outcome === "uncertain" ? reserve : modelCostMicros(100, 20, 0, "google"),
      );
    } finally {
      cancellation.abort();
      release();
      await first.catch(() => {});
    }
  },
);

it.each(["settled", "uncertain", "invalid-usage"] as const)(
  "accounts for a completed Google search separately when extraction is %s",
  async (outcome) => {
    const { ownerId } = await invited();
    const completed = { ...response(1000, 100), model: geminiModel };
    const extraction = { ...request, model: geminiModel, tools: [], max_output_tokens: 5000 };
    const model: ModelClient = {
      provider: "google",
      model: geminiModel,
      inputTokenBound: () => 20_000,
      outputTokenBound: (body) => (body.max_output_tokens ?? 5000) * (body.tools?.length ? 2 : 1),
      searchQueryBound: 100,
      searchQueryCount: () => 1,
      responses: {
        create: async (_, options) => {
          await options?.onUsageCheckpoint?.(
            outcome === "invalid-usage" ? ({ ...completed, usage: undefined } as any) : completed,
            extraction,
          );
          if (outcome !== "settled") throw new Error("Connection lost during extraction");
          return { ...response(2000, 200), model: geminiModel };
        },
      },
    };
    const command = {
      ...request,
      model: geminiModel,
      tools: [{ type: "web_search" as const }],
      max_tool_calls: 1,
    };
    const original = boundedJudgeRequest(command, model).reserveMicros;
    const ctx = { ...app.ctx, config: { ...app.ctx.config, aiBudgetMicros: original + 100_000 }, model };
    const result = modelForOwner(ctx, ownerId).responses.create(command);
    if (outcome === "settled") await result;
    else await expect(result).rejects.toThrow("Connection lost during extraction");
    const [record] = await app.ctx.db.select().from(judgeDemoRequests);
    if (!record) throw new Error("Missing usage record");
    const expected =
      outcome === "invalid-usage"
        ? original
        : outcome === "settled"
          ? modelCostMicros(2000, 200, 1, "google")
          : modelCostMicros(1000, 100, 1, "google") + boundedJudgeRequest(extraction, model).reserveMicros;
    expect(record.reservedMicros).toBe(original);
    expect(record.chargedMicros).toBe(expected);
    expect(record.state).toBe(outcome === "settled" ? "settled" : "uncertain");
    expect((await judgeBudgetStatus(ctx)).usedUsd).toBe(expected / 1_000_000);
    if (outcome === "uncertain") expect(expected).toBeLessThan(original / 5);
  },
);

function shareLink() {
  const token = "s".repeat(43);
  app.ctx.config.privateShareLink = {
    sha256: createHash("sha256").update(token).digest("hex"),
    expiresAt: new Date(Date.now() + 86400_000),
  };
  return token;
}

it("redeems a private link into a separate HttpOnly grant without changing identity or funding AI", async () => {
  const token = shareLink(),
    browser = app.browser();
  await browser.open();
  expect((await browser.get("/api/judge/access")).body).toMatchObject({ privateLink: true, allowed: false });
  const before = await judgeBudgetStatus(app.ctx);
  const reply = await browser.post("/api/judge/access-link", { access: token });
  expect(reply.status).toBe(200);
  expect(reply.headers.get("set-cookie")).toContain("HttpOnly");
  expect(reply.headers.get("set-cookie")).toContain("SameSite=Lax");
  expect(reply.headers.get("set-cookie")).not.toContain(token);
  expect((await browser.get("/api/session")).body.authenticated).toBe(false);
  expect((await browser.get("/api/judge/access")).body.allowed).toBe(true);
  expect(await judgeBudgetStatus(app.ctx)).toEqual(before);
  expect(app.model.requests).toHaveLength(0);
});

it.each(["rotate", "expire"] as const)("revokes private-link cookies when the link is %s", async (kind) => {
  const token = shareLink(),
    browser = app.browser();
  await browser.open();
  expect((await browser.post("/api/judge/access-link", { access: token })).status).toBe(200);
  if (kind === "rotate")
    app.ctx.config.privateShareLink!.sha256 = createHash("sha256")
      .update("another private link")
      .digest("hex");
  else app.ctx.config.privateShareLink!.expiresAt = new Date(0);
  expect((await browser.get("/api/judge/access")).body.allowed).toBe(false);
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
  expect((await browser.post("/api/judge/access-link", { access: token })).status).toBe(403);
  expect(app.model.requests).toHaveLength(0);
});

it("rejects missing, forged and cross-origin link redemption without revealing the secret", async () => {
  const token = shareLink(),
    browser = app.browser();
  await browser.open();
  for (const body of [{}, { access: 42 }, { access: token, extra: true }, { access: "z".repeat(43) }]) {
    const reply = await browser.post("/api/judge/access-link", body);
    expect(reply.status).toBe(403);
    expect(JSON.stringify(reply.body)).not.toContain(token);
  }
  expect((await browser.post("/api/judge/access-link", { access: token }, { csrf: null })).status).toBe(403);
  expect(
    (await browser.post("/api/judge/access-link", { access: token }, { origin: "https://elsewhere.example" }))
      .status,
  ).toBe(403);
  expect((await browser.get("/api/judge/access")).body.allowed).toBe(false);
  expect(app.model.requests).toHaveLength(0);
});

it("bounds private-link guesses durably without removing the normal API gate", async () => {
  shareLink();
  const browser = app.browser();
  await browser.open();
  for (let index = 0; index < 20; index++)
    expect((await browser.post("/api/judge/access-link", { access: "z".repeat(43) })).status).toBe(403);
  expect((await browser.post("/api/judge/access-link", { access: "z".repeat(43) })).status).toBe(429);
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
  expect(app.model.requests).toHaveLength(0);
});
async function claimedCheck(ownerId: string) {
  const claim = { serviceId: "unlisted-service", revision: 1, leaseToken: crypto.randomUUID() };
  await app.ctx.db.insert(ownerPriceChecks).values({
    ownerId,
    serviceId: claim.serviceId,
    revision: claim.revision,
    cadence: { every: 1, unit: "week" },
    anchorAt: new Date(),
    nextCheckAt: new Date(),
    status: "checking",
    leaseToken: claim.leaseToken,
    leaseUntil: new Date(Date.now() + 300_000),
  });
  return claim;
}

it("funds only the confirmed background check after browser access expires, preserving interactive expiry and spending limits", async () => {
  const { ownerId } = await invited();
  const backgroundCheck = await claimedCheck(ownerId);
  await app.ctx.db
    .update(judgeDemoOwners)
    .set({ expiresAt: new Date(0) })
    .where(eq(judgeDemoOwners.ownerId, ownerId));
  await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_access_required" });
  const model = { responses: { create: vi.fn(async () => response()) } };
  const scheduled = modelForOwner({ ...app.ctx, model }, ownerId, { backgroundCheck });
  await scheduled.responses.create(request);
  expect(model.responses.create).toHaveBeenCalledTimes(1);
  expect((await judgeBudgetStatus(app.ctx)).requests).toBe(1);
  await setBudget(judgeLimits.budgetMicros);
  await expect(scheduled.responses.create(request)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  expect(model.responses.create).toHaveBeenCalledTimes(1);
});

it.each([
  ["paused", { cadence: null }],
  ["changed", { revision: 2 }],
  ["expired lease", { leaseUntil: new Date(0) }],
  ["replaced worker", { leaseToken: "another-worker" }],
  ["unclaimed", { status: "scheduled" as const }],
] as const)("stops a %s scheduled capability before another model request", async (_label, change) => {
  const { ownerId } = await invited();
  const backgroundCheck = await claimedCheck(ownerId);
  await app.ctx.db.update(ownerPriceChecks).set(change).where(eq(ownerPriceChecks.ownerId, ownerId));
  const model = { responses: { create: vi.fn(async () => response()) } };
  await expect(
    modelForOwner({ ...app.ctx, model }, ownerId, { backgroundCheck }).responses.create(request),
  ).rejects.toMatchObject({ code: "scheduled_check_changed" });
  expect(model.responses.create).not.toHaveBeenCalled();
});

it("rejects cross-owner background claims and revoked owner grants", async () => {
  const { ownerId } = await invited();
  const backgroundCheck = await claimedCheck(ownerId);
  const other = await invited();
  const model = { responses: { create: vi.fn(async () => response()) } };
  await expect(
    modelForOwner({ ...app.ctx, model }, other.ownerId, { backgroundCheck }).responses.create(request),
  ).rejects.toMatchObject({ code: "scheduled_check_changed" });
  await app.ctx.db.delete(judgeDemoOwners).where(eq(judgeDemoOwners.ownerId, ownerId));
  await expect(
    modelForOwner({ ...app.ctx, model }, ownerId, { backgroundCheck }).responses.create(request),
  ).rejects.toMatchObject({ code: "judge_access_required" });
  expect(model.responses.create).not.toHaveBeenCalled();
});
async function setBudget(usedMicros: number) {
  await app.ctx.db
    .insert(judgeDemoCounters)
    .values({ key: "judge-demo-budget-v1", usedMicros })
    .onConflictDoUpdate({ target: judgeDemoCounters.key, set: { usedMicros } });
}

it("adds Gemini usage without resetting previous spend and retains a paid-search hold if extraction is rejected", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  const model: ModelClient = {
    provider: "google",
    model: geminiModel,
    inputTokenBound: () => 1000,
    outputTokenBound: () => 10000,
    responses: { create: async () => ({ ...response(), model: geminiModel }) },
  };
  const ctx = { ...app.ctx, model };
  await modelForOwner(ctx, ownerId).responses.create({ ...request, model: geminiModel, store: false });
  const settled = await judgeBudgetStatus(ctx);
  expect(settled.usedUsd).toBe((1_000_000 + modelCostMicros(100, 20, 0, "google")) / 1_000_000);
  model.responses.create = async () => {
    throw new ModelServiceError(400, new Headers(), true);
  };
  await expect(
    modelForOwner(ctx, ownerId).responses.create({ ...request, model: geminiModel, store: false }),
  ).rejects.toThrow("HTTP 400");
  const held = await judgeBudgetStatus(ctx);
  expect(held.unresolvedRequests).toBe(1);
  expect(held.usedUsd).toBeGreaterThan(settled.usedUsd);
});

it("does not reserve or dispatch an already cancelled request", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  const stopped = new AbortController();
  stopped.abort();
  await expect(
    modelForOwner(app.ctx, ownerId).responses.create(request, { signal: stopped.signal }),
  ).rejects.toThrow();
  expect(app.model.requests).toHaveLength(0);
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBe(1);
  expect(await app.ctx.db.select().from(judgeDemoRequests)).toHaveLength(0);
});

it("rejects cancellation after reservation without dispatch or a money hold", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  const stopped = new AbortController();
  const transaction = app.ctx.db.transaction.bind(app.ctx.db);
  const hook = vi.spyOn(app.ctx.db, "transaction").mockImplementation(async (work, config) => {
    const result = await transaction(work, config);
    stopped.abort();
    return result;
  });
  try {
    await expect(
      modelForOwner(app.ctx, ownerId).responses.create(request, { signal: stopped.signal }),
    ).rejects.toThrow();
    expect(app.model.requests).toHaveLength(0);
    expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBe(1);
    expect(await app.ctx.db.select().from(judgeDemoRequests)).toMatchObject([
      { state: "rejected", chargedMicros: 0 },
    ]);
  } finally {
    hook.mockRestore();
  }
});

it("adds Claude charges to the existing shared ledger and retains uncertain usage without resetting previous spend", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  const model: ModelClient = {
    provider: "anthropic",
    model: claudeModel,
    inputTokenBound: () => 1000,
    responses: { create: async () => ({ ...response(), model: claudeModel }) },
  };
  const ctx = { ...app.ctx, model };
  await modelForOwner(ctx, ownerId).responses.create({ ...request, model: claudeModel, store: false });
  expect((await judgeBudgetStatus(ctx)).usedUsd).toBe(
    (1_000_000 + modelCostMicros(100, 20, 0, "anthropic")) / 1_000_000,
  );
  model.responses.create = async () => ({ ...response(), model: claudeModel, usage: undefined });
  await modelForOwner(ctx, ownerId).responses.create({ ...request, model: claudeModel, store: false });
  const status = await judgeBudgetStatus(ctx);
  expect(status.unresolvedRequests).toBe(1);
  expect(status.usedUsd).toBeGreaterThan(1);
});

it("settles all native Google query fees, not just the number of grounded operations", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  const model: ModelClient = {
    provider: "google",
    model: geminiModel,
    inputTokenBound: () => 1000,
    outputTokenBound: () => 10000,
    searchQueryBound: 100,
    searchQueryCount: () => 3,
    responses: {
      create: async () => ({
        ...response(),
        model: geminiModel,
        output: [{ type: "web_search_call", status: "completed", id: "one-native-operation" } as any],
      }),
    },
  };
  const ctx = { ...app.ctx, model };
  const funded = modelForOwner(ctx, ownerId);
  const result = await funded.responses.create({
    ...request,
    model: geminiModel,
    store: false,
    tools: [{ type: "web_search" }],
  });
  expect(funded.searchQueryCount?.(result)).toBe(3);
  expect((await judgeBudgetStatus(ctx)).usedUsd).toBe(
    (1_000_000 + modelCostMicros(100, 20, 3, "google")) / 1_000_000,
  );
  model.searchQueryCount = () => NaN;
  await funded.responses.create({ ...request, model: geminiModel, store: false });
  expect((await judgeBudgetStatus(ctx)).unresolvedRequests).toBe(1);
});

it("settles only future Claude cache hits at their reported rate while preserving historical charges and holds", async () => {
  const { ownerId } = await invited();
  const oldCharge = {
    id: crypto.randomUUID(),
    ownerId,
    reservedMicros: 25_000,
    chargedMicros: 500,
    state: "settled" as const,
  };
  const oldHold = {
    id: crypto.randomUUID(),
    ownerId,
    reservedMicros: 200_000,
    chargedMicros: 200_000,
    state: "uncertain" as const,
  };
  await app.ctx.db.insert(judgeDemoRequests).values([oldCharge, oldHold]);
  await setBudget(200_500);
  const before = await app.ctx.db.select().from(judgeDemoRequests);
  const model: ModelClient = {
    provider: "anthropic",
    model: claudeModel,
    inputTokenBound: () => 1000,
    responses: {
      create: async () => ({
        ...response(1000, 20),
        model: claudeModel,
        usage: {
          ...response(1000, 20).usage!,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
        },
      }),
    },
  };
  const command = { ...request, model: claudeModel, store: false };
  const reserve = boundedJudgeRequest(command, model).reserveMicros;
  expect(reserve).toBe(modelCostMicros(1000, 5000, 0, "anthropic"));
  await modelForOwner({ ...app.ctx, model }, ownerId).responses.create(command);
  const rows = await app.ctx.db.select().from(judgeDemoRequests);
  for (const previous of before) expect(rows.find((row) => row.id === previous.id)).toEqual(previous);
  const added = rows.find((row) => !before.some((previous) => previous.id === row.id))!;
  expect(added).toMatchObject({ reservedMicros: reserve, chargedMicros: 613, state: "settled" });
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBe(0.201113);
});

it("does not discount malformed cache counts or change OpenAI accounting", () => {
  expect(modelCostMicros(1000, 20, 0, "anthropic", 900)).toBe(613);
  for (const cached of [-1, 1001, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(modelCostMicros(1000, 20, 0, "anthropic", cached)).toBe(modelCostMicros(1000, 20, 0, "anthropic"));
  expect(modelCostMicros(1000, 20, 0, "openai", 900)).toBe(modelCostMicros(1000, 20, 0, "openai"));
});

it("reserves a chat retry separately and retains the original uncertain charge", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  let attempts = 0;
  const model: ModelClient = {
    provider: "anthropic",
    model: claudeModel,
    inputTokenBound: () => 1000,
    responses: {
      create: async () => {
        if (++attempts === 1)
          throw new Anthropic.APIError(
            undefined,
            { type: "error", error: { type: "overloaded_error", message: "Private diagnostic" } },
            undefined,
            new Headers(),
            "overloaded_error",
          );
        return {
          ...response(),
          model: claudeModel,
          output: [
            {
              id: "synthetic-message",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: '{"reply":"ready"}', annotations: [] }],
            },
          ],
        };
      },
    },
  };
  const result = await runModelTask(modelForOwner({ ...app.ctx, model }, ownerId), {
    instructions: "Read-only reply",
    input: {},
    tools: [],
    retryTransientErrors: true,
    output: {
      name: "Answer",
      schema: {
        type: "object",
        properties: { reply: { type: "string" } },
        required: ["reply"],
        additionalProperties: false,
      },
      accept: (value): value is { reply: string } =>
        !!value && typeof (value as { reply?: unknown }).reply === "string",
    },
  });
  expect(result).toMatchObject({ completed: true, usage: { modelCalls: 1, retryAttempts: 1 } });
  expect(attempts).toBe(2);
  const rows = await app.ctx.db.select().from(judgeDemoRequests);
  const held = rows.find((row) => row.state === "uncertain")!;
  expect(held.chargedMicros).toBe(held.reservedMicros);
  expect(held.chargedMicros).toBe(65_000);
  expect(rows.find((row) => row.state === "settled")?.chargedMicros).toBe(500);
  expect(await judgeBudgetStatus(app.ctx)).toMatchObject({
    usedUsd: 1.0655,
    requests: 2,
    unresolvedRequests: 1,
  });
});

it("funds a stalled chat recovery separately without releasing the first request's hold", async () => {
  const { ownerId } = await invited();
  await setBudget(1_000_000);
  let attempts = 0;
  const model: ModelClient = {
    provider: "google",
    model: geminiModel,
    inputTokenBound: () => 1000,
    searchQueryCount: () => 0,
    responses: {
      create: async (_request, options) => {
        if (++attempts === 1)
          return new Promise((_resolve, reject) => {
            const abort = () => reject(new DOMException("Aborted", "AbortError"));
            if (options?.signal?.aborted) abort();
            else options?.signal?.addEventListener("abort", abort, { once: true });
          });
        return {
          ...response(),
          model: geminiModel,
          output: [
            {
              id: "synthetic-recovered-message",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: '{"reply":"ready"}', annotations: [] }],
            },
          ],
        };
      },
    },
  };
  const result = await runModelTask(
    modelForOwner({ ...app.ctx, model }, ownerId),
    {
      instructions: "Read-only reply",
      input: {},
      tools: [],
      retryTransientErrors: true,
      output: {
        name: "Answer",
        schema: {},
        accept: (value): value is { reply: string } =>
          typeof (value as { reply?: unknown })?.reply === "string",
      },
    },
    { maxToolCalls: 1, timeoutMs: 5000, inferenceTimeoutMs: 200 },
  );
  expect(result).toMatchObject({ completed: true, usage: { retryAttempts: 1 } });
  expect(attempts).toBe(2);
  const rows = await app.ctx.db.select().from(judgeDemoRequests);
  expect(rows).toHaveLength(2);
  const held = rows.find((row) => row.state === "uncertain")!;
  const settled = rows.find((row) => row.state === "settled")!;
  expect(held.chargedMicros).toBe(held.reservedMicros);
  expect(settled.chargedMicros).toBe(modelCostMicros(100, 20, 0, "google"));
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBe(
    (1_000_000 + held.chargedMicros + settled.chargedMicros) / 1_000_000,
  );
});

it("uses independent owner credentials and a scoped cookie while preserving identity, role and the shared budget", async () => {
  const owner = { username: "owner", password: "isolated-owner-password" };
  app.ctx.config.ownerAccess = { username: owner.username, passwordHash: await hashPassword(owner.password) };
  const browser = app.browser();
  const login = await browser.login();
  expect((await browser.get("/api/owner/access")).body).toEqual({ required: true, allowed: false });
  expect((await browser.post("/api/owner/access", credentials)).status).toBe(401);
  expect((await browser.post("/api/judge/access", owner)).status).toBe(401);
  expect((await browser.post("/api/owner/access", owner, { csrf: "wrong" })).status).toBe(403);
  const entered = await browser.post("/api/owner/access", owner);
  expect(entered.status).toBe(200);
  expect(entered.headers.getSetCookie().join(";")).toMatch(/val_owner_access=.*HttpOnly.*SameSite=Lax/i);
  expect(browser.cookie("val_judge_access")).toBeUndefined();
  expect((await browser.get("/api/owner/access")).body.allowed).toBe(true);
  expect((await browser.get("/api/judge/access")).body.allowed).toBe(true);
  expect((await browser.get("/api/session")).body).toMatchObject({
    ownerId: login.body.session.ownerId,
    role: "reviewer",
  });
  expect((await browser.get("/api/subscriptions")).status).toBe(200);
  expect((await browser.get("/api/judge/usage")).status).toBe(403);
  await fund(login.body.session.ownerId);
  expect((await judgeBudgetStatus(app.ctx)).requests).toBe(1);
  await setBudget(judgeLimits.budgetMicros);
  await expect(fund(login.body.session.ownerId)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
});

it("pauses only the invitation step for local testing, preserves ownership and the budget, and restores the gate when resumed", async () => {
  app.ctx.config.judgeAccessPaused = true;
  app.ctx.config.ownerAccess = {
    username: "owner",
    passwordHash: await hashPassword("isolated-owner-password"),
  };
  const browser = app.browser();
  expect((await browser.get("/api/judge/access")).body).toEqual({ required: false, allowed: true });
  expect((await browser.get("/api/owner/access")).body).toEqual({ required: false, allowed: true });
  expect((await browser.get("/api/subscriptions")).status).toBe(401);
  const login = await browser.login();
  const ownerId = login.body.session.ownerId;
  expect((await browser.get("/api/subscriptions")).status).toBe(200);
  expect(browser.cookie("val_judge_access")).toBeUndefined();
  expect((await browser.get("/api/session")).body).toMatchObject({ ownerId, role: "reviewer" });
  expect((await browser.get("/api/judge/usage")).status).toBe(403);
  const saved = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      { serviceId: "spotify", amountMinor: 1299, cycle: "month", purpose: "Offline listening" },
    ],
  });
  expect(saved.status).toBe(200);
  const other = app.browser();
  await other.login();
  expect((await other.get("/api/subscriptions")).body.subscriptions).toEqual([]);
  await fund(ownerId);
  expect((await judgeBudgetStatus(app.ctx)).requests).toBe(1);
  await setBudget(judgeLimits.budgetMicros);
  await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  app.ctx.config.judgeAccessPaused = false;
  expect((await browser.get("/api/judge/access")).body).toEqual({ required: true, allowed: false });
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
});

it("does not treat a judge cookie as owner access, and blocks expired or unconfigured owner access", async () => {
  expect((await app.browser().get("/api/owner/access")).status).toBe(404);
  const owner = { username: "owner", password: "isolated-owner-password" };
  app.ctx.config.ownerAccess = { username: owner.username, passwordHash: await hashPassword(owner.password) };
  const { browser } = await invited();
  browser.setCookie("val_owner_access", browser.cookie("val_judge_access"));
  expect((await browser.get("/api/owner/access")).body.allowed).toBe(false);
  expect((await browser.post("/api/owner/access", owner)).status).toBe(200);
  browser.setCookie("val_judge_access", undefined);
  await app.ctx.db.update(judgeDemoAccess).set({ expiresAt: new Date(0) });
  expect((await browser.get("/api/owner/access")).body.allowed).toBe(false);
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
  expect(app.model.requests).toHaveLength(0);
});

it("shares failed-login throttling across owner and judge access instead of allowing route switching to bypass it", async () => {
  app.ctx.config.ownerAccess = {
    username: "owner",
    passwordHash: await hashPassword("isolated-owner-password"),
  };
  const browser = app.browser();
  await browser.open();
  for (let index = 0; index < 5; index++)
    expect(
      (
        await browser.post(index % 2 ? "/api/owner/access" : "/api/judge/access", {
          username: "wrong",
          password: "wrong",
        })
      ).status,
    ).toBe(401);
  expect((await browser.post("/api/judge/access", credentials)).status).toBe(429);
  expect(
    (await browser.post("/api/owner/access", { username: "owner", password: "isolated-owner-password" }))
      .status,
  ).toBe(429);
});

it("requires the separate invitation even for an authenticated Val owner, and retains that owner", async () => {
  const browser = app.browser();
  const login = await browser.login();
  expect((await browser.get("/api/judge/access")).body).toEqual({ required: true, allowed: false });
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
  expect((await browser.post("/api/auth/paypal")).status).toBe(403);
  expect(
    (await browser.post("/api/subscriptions/chat", { message: "Hello", history: [], expectedRevision: 0 }))
      .status,
  ).toBe(403);
  await expect(fund(login.body.session.ownerId)).rejects.toMatchObject({ code: "judge_access_required" });
  expect(app.model.requests).toHaveLength(0);
  expect((await browser.post("/api/judge/access", credentials, { csrf: "wrong" })).status).toBe(403);
  const entered = await browser.post("/api/judge/access", credentials);
  expect(entered.status).toBe(200);
  expect(entered.headers.getSetCookie().join(";")).toMatch(/judge_access=.*HttpOnly.*SameSite=Lax/i);
  expect((await browser.get("/api/session")).body.ownerId).toBe(login.body.session.ownerId);
  expect((await browser.get("/api/subscriptions")).status).toBe(200);
  expect((await browser.get("/api/judge/usage")).status).toBe(403);
});

it("allows separate successful visitors behind one address without spending their failed-login allowance", async () => {
  for (let index = 0; index < 8; index++) {
    const browser = app.browser();
    await browser.open();
    expect((await browser.post("/api/judge/access", credentials)).status).toBe(200);
    expect((await browser.get("/api/judge/access")).body.allowed).toBe(true);
  }
  const browser = app.browser();
  await browser.open();
  for (let index = 0; index < 5; index++)
    expect((await browser.post("/api/judge/access", { ...credentials, password: "incorrect" })).status).toBe(
      401,
    );
  expect((await browser.post("/api/judge/access", credentials)).status).toBe(429);
});

it("reserves failed-login slots before verifying concurrent guesses", async () => {
  const browser = app.browser();
  await browser.open();
  const attempts = await Promise.all(
    Array.from({ length: 8 }, () =>
      browser.post("/api/judge/access", { ...credentials, password: "incorrect" }),
    ),
  );
  expect(attempts.filter((reply) => reply.status === 401)).toHaveLength(5);
  expect(attempts.filter((reply) => reply.status === 429)).toHaveLength(3);
  expect((await browser.post("/api/judge/access", credentials)).status).toBe(429);
});

it("persists failed-login throttling and rejects a forged or expired invitation cookie", async () => {
  const browser = app.browser();
  await browser.open();
  for (let index = 0; index < 5; index++)
    expect((await browser.post("/api/judge/access", { ...credentials, password: "incorrect" })).status).toBe(
      401,
    );
  const freshBrowser = app.browser();
  await freshBrowser.open();
  expect((await freshBrowser.post("/api/judge/access", credentials)).status).toBe(429);
  freshBrowser.setCookie("val_judge_access", "forged");
  expect((await freshBrowser.get("/api/catalogue")).status).toBe(403);
});

it("rejects expired access and owner grants without making a paid request", async () => {
  const { browser, ownerId } = await invited();
  await app.ctx.db.update(judgeDemoAccess).set({ expiresAt: new Date(0) });
  expect((await browser.get("/api/subscriptions")).status).toBe(403);
  await app.ctx.db
    .update(judgeDemoOwners)
    .set({ expiresAt: new Date(0) })
    .where(eq(judgeDemoOwners.ownerId, ownerId));
  await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_access_required" });
  expect(app.model.requests).toHaveLength(0);
});

it("accounts for each model request and disables SDK retries before forwarding", async () => {
  const { ownerId } = await invited();
  let calls = 0;
  const model: ModelClient = {
    responses: {
      create: async (body, options) => {
        calls++;
        expect(options?.maxRetries).toBe(0);
        expect(body.max_output_tokens).toBe(5000);
        expect(body.service_tier).toBe("default");
        return response();
      },
    },
  };
  await fund(ownerId, model);
  expect(calls).toBe(1);
  const status = await judgeBudgetStatus(app.ctx);
  expect(status).toMatchObject({ budgetUsd: 5, requests: 1, unresolvedRequests: 0 });
  expect(status.usedUsd).toBe(0.000029);
  const reconstructed = modelForOwner({ ...app.ctx, model }, ownerId);
  await reconstructed.responses.create(request);
  expect((await judgeBudgetStatus(app.ctx)).requests).toBe(2);
});

it("accounts for long context, cache writes, hidden search steps and provider search fees", () => {
  expect(modelCostMicros(272_000, 1000, 0)).toBe(43_125);
  expect(modelCostMicros(272_001, 1000, 0)).toBe(85_938);
  expect(modelCostMicros(100, 20, 1)).toBe(12_529);
  expect(
    boundedJudgeRequest({ ...request, tools: [{ type: "web_search" }], max_tool_calls: 5 } as any)
      .reserveMicros,
  ).toBe(2_035_938);
});

it("preserves historical usage and uncertain holds when charging the lower-cost model", async () => {
  const { ownerId } = await invited();
  await setBudget(2_340_625);
  await app.ctx.db.insert(judgeDemoRequests).values({
    id: crypto.randomUUID(),
    ownerId,
    reservedMicros: 2_340_625,
    chargedMicros: 2_340_625,
    state: "uncertain",
  });
  await fund(ownerId);
  const rows = await app.ctx.db
    .select()
    .from(judgeDemoRequests)
    .where(eq(judgeDemoRequests.ownerId, ownerId));
  expect(rows.find((row) => row.state === "uncertain")).toMatchObject({
    reservedMicros: 2_340_625,
    chargedMicros: 2_340_625,
  });
  expect(await judgeBudgetStatus(app.ctx)).toMatchObject({ usedUsd: 2.340654, unresolvedRequests: 1 });
});

it("reduces search depth before dispatch when the full reservation cannot fit, without increasing the cap", async () => {
  const { ownerId } = await invited();
  await setBudget(3_000_000);
  let calls = 0;
  let forwarded: any;
  const model: ModelClient = {
    responses: {
      create: async (body) => {
        calls++;
        forwarded = body;
        return response();
      },
    },
  };
  await modelForOwner({ ...app.ctx, model }, ownerId).responses.create({
    ...request,
    tools: [{ type: "web_search" }],
    max_tool_calls: 5,
  } as any);
  expect(calls).toBe(1);
  expect(forwarded.max_tool_calls).toBe(4);
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBeLessThan(3.01);
  expect((await judgeBudgetStatus(app.ctx)).budgetUsd).toBe(5);
  await setBudget(judgeLimits.budgetMicros);
  await expect(
    modelForOwner({ ...app.ctx, model }, ownerId).responses.create({
      ...request,
      tools: [{ type: "web_search" }],
      max_tool_calls: 5,
    } as any),
  ).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  expect(calls).toBe(1);
});

it("uses an explicitly configured cap without resetting prior usage or weakening the default", async () => {
  const { ownerId } = await invited();
  const configured = {
    ...app.ctx,
    config: { ...app.ctx.config, judgeDemo: { ...app.ctx.config.judgeDemo!, budgetMicros: 8_000_000 } },
  };
  await setBudget(5_000_000);
  await modelForOwner(configured, ownerId).responses.create(request);
  expect(await judgeBudgetStatus(configured)).toMatchObject({ budgetUsd: 8, requests: 1 });
  expect((await judgeBudgetStatus(configured)).usedUsd).toBeGreaterThan(5);
  await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  await setBudget(8_000_000);
  await expect(modelForOwner(configured, ownerId).responses.create(request)).rejects.toMatchObject({
    code: "judge_budget_exhausted",
  });
});
it("keeps full reservations for unknown outcomes and missing usage, without retrying", async () => {
  const { ownerId } = await invited();
  const reserve = boundedJudgeRequest(request).reserveMicros;
  let calls = 0;
  const failed: ModelClient = {
    responses: {
      create: async () => {
        calls++;
        throw new Error("connection lost");
      },
    },
  };
  await expect(fund(ownerId, failed)).rejects.toThrow("connection lost");
  expect(calls).toBe(1);
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBe(reserve / 1_000_000);
  const noUsage: ModelClient = {
    responses: { create: async () => ({ ...response(), usage: undefined }) as Response },
  };
  await fund(ownerId, noUsage);
  expect(await judgeBudgetStatus(app.ctx)).toMatchObject({
    usedUsd: (reserve * 2) / 1_000_000,
    unresolvedRequests: 2,
  });
});

it.each(["account", "excluded-source"])(
  "releases definitive rejections (%s), retaining request counts, the cap and unknown holds",
  async (kind) => {
    const { ownerId } = await invited();
    const rejected =
      kind === "excluded-source"
        ? Anthropic.APIError.generate(
            400,
            {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: "The following domains are not accessible to our user agent: ['example.org'].",
              },
            },
            "The following domains are not accessible to our user agent: ['example.org'].",
            new Headers(),
          )
        : new OpenAI.RateLimitError(
            429,
            { code: "credit_balance_exhausted", type: "insufficient_quota" },
            "Private SDK text",
            new Headers(),
          );
    const before = boundedJudgeRequest(request).reserveMicros;
    const uncertain: ModelClient = {
      responses: {
        create: async () => {
          throw new Error("connection lost");
        },
      },
    };
    await expect(fund(ownerId, uncertain)).rejects.toThrow("connection lost");
    const denied: ModelClient = {
      responses: {
        create: async () => {
          throw rejected;
        },
      },
    };
    await expect(fund(ownerId, denied)).rejects.toBe(rejected);
    expect(await judgeBudgetStatus(app.ctx)).toMatchObject({
      budgetUsd: 5,
      usedUsd: before / 1_000_000,
      requests: 2,
      unresolvedRequests: 1,
    });
    const rows = await app.ctx.db
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.ownerId, ownerId));
    expect(rows.find((row) => row.state === "rejected")).toMatchObject({
      chargedMicros: 0,
      reservedMicros: before,
    });
    await fund(ownerId);
    expect((await judgeBudgetStatus(app.ctx)).requests).toBe(3);
  },
);

it("caps hidden search work, output and request size, and rejects other billable tools/models", () => {
  const bounded = boundedJudgeRequest({
    ...request,
    max_output_tokens: 99_999,
    max_tool_calls: 100,
    tools: [{ type: "web_search" }],
  });
  expect(bounded.body).toMatchObject({ max_output_tokens: 5000, max_tool_calls: 5 });
  expect(bounded.reserveMicros).toBeGreaterThan(2_000_000);
  expect(() => boundedJudgeRequest({ ...request, model: "other-model" })).toThrow();
  expect(() => boundedJudgeRequest({ ...request, input: "x".repeat(200_001) })).toThrow();
  expect(() => boundedJudgeRequest({ ...request, tools: [{ type: "image_generation" }] })).toThrow();
});

it("serializes shared-budget reservations across owners so concurrent calls cannot overspend", async () => {
  const a = await invited();
  const b = await invited();
  const reserve = boundedJudgeRequest(request).reserveMicros;
  await setBudget(judgeLimits.budgetMicros - reserve);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let rejected!: () => void;
  const rejection = new Promise<void>((resolve) => {
    rejected = resolve;
  });
  let calls = 0;
  const model: ModelClient = {
    responses: {
      create: async () => {
        calls++;
        await gate;
        return response();
      },
    },
  };
  const attempts = [a, b].map(({ ownerId }) =>
    fund(ownerId, model).catch((error) => {
      rejected();
      throw error;
    }),
  );
  const completed = Promise.allSettled(attempts);
  try {
    await rejection;
  } finally {
    release();
  }
  const results = await completed;
  expect(calls).toBe(1);
  expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  expect((await judgeBudgetStatus(app.ctx)).usedUsd).toBeLessThanOrEqual(5);
});

it("allows two calls only within the same server-created comparison and accounts for both", async () => {
  const { ownerId } = await invited();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = 0;
  const model: ModelClient = {
    responses: {
      create: async () => {
        entered++;
        if (entered <= 2) await gate;
        return response();
      },
    },
  };
  const ctx = { ...app.ctx, model };
  const funded = modelForOwner(ctx, ownerId, { concurrentRequests: 2 });
  const pending = [funded.responses.create(request), funded.responses.create(request)];
  for (const promise of pending) void promise.catch(() => {});
  try {
    await vi.waitFor(() => expect(entered).toBe(2), { timeout: 2000 });
    await expect(funded.responses.create(request)).rejects.toMatchObject({ code: "judge_request_running" });
    await expect(
      modelForOwner(ctx, ownerId, { concurrentRequests: 2 }).responses.create(request),
    ).rejects.toMatchObject({ code: "judge_request_running" });
    await expect(modelForOwner(ctx, ownerId).responses.create(request)).rejects.toMatchObject({
      code: "judge_request_running",
    });
    expect(entered).toBe(2);
    expect((await judgeBudgetStatus(ctx)).requests).toBe(2);
  } finally {
    release();
    await Promise.all(pending);
  }
  const settled = await judgeBudgetStatus(ctx);
  expect(settled.unresolvedRequests).toBe(0);
  expect(settled.usedUsd).toBe((2 * modelCostMicros(100, 20, 0)) / 1_000_000);
  await modelForOwner(ctx, ownerId).responses.create(request);
  expect((await judgeBudgetStatus(ctx)).requests).toBe(3);
});

it("enforces one in-flight call, a durable per-minute rate and an owner lifetime allowance", async () => {
  const { ownerId, browser } = await invited();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const entering = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const model: ModelClient = {
    responses: {
      create: async () => {
        entered();
        await gate;
        return response();
      },
    },
  };
  const pending = fund(ownerId, model);
  await entering;
  try {
    await expect(fund(ownerId, model)).rejects.toMatchObject({ code: "judge_request_running" });
  } finally {
    release();
  }
  await pending;
  for (let count = 1; count < judgeLimits.callsPerMinute; count++) await fund(ownerId);
  await expect(fund(ownerId)).rejects.toMatchObject({
    code: "judge_rate_limited",
    retryAfterSeconds: expect.any(Number),
  });
  const calls = await app.ctx.db
    .select()
    .from(judgeDemoRequests)
    .where(eq(judgeDemoRequests.ownerId, ownerId));
  await app.ctx.db
    .update(judgeDemoRequests)
    .set({ createdAt: new Date() })
    .where(eq(judgeDemoRequests.ownerId, ownerId));
  await app.ctx.db
    .update(judgeDemoRequests)
    .set({ createdAt: new Date(Date.now() - 55000) })
    .where(eq(judgeDemoRequests.id, calls[0]!.id));
  const limited = await browser.post("/api/subscriptions/chat", {
    message: "Hello",
    history: [],
    expectedRevision: 0,
  });
  expect(limited.status).toBe(429);
  expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(50);
  expect(Number(limited.headers.get("Retry-After"))).toBeLessThanOrEqual(60);
  const old = new Date(Date.now() - 180_000);
  await app.ctx.db
    .update(judgeDemoRequests)
    .set({ createdAt: old })
    .where(eq(judgeDemoRequests.ownerId, ownerId));
  await app.ctx.db.insert(judgeDemoRequests).values(
    Array.from({ length: judgeLimits.ownerCalls - judgeLimits.callsPerMinute }, (_, index) => ({
      id: `limit-${ownerId}-${index}`,
      ownerId,
      reservedMicros: 0,
      chargedMicros: 0,
      state: "settled" as const,
      createdAt: old,
    })),
  );
  await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_owner_limit" });
  app.ctx.config.judgeAccessPaused = true;
  try {
    await expect(fund(ownerId)).resolves.toBeDefined();
    await setBudget(judgeLimits.budgetMicros);
    await expect(fund(ownerId)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  } finally {
    app.ctx.config.judgeAccessPaused = false;
  }
});

it("blocks chat, live research, drafts and background investigation at the shared ceiling, even for a new owner", async () => {
  const { browser } = await invited();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      { serviceId: "netflix", amountMinor: 1399, cycle: "month", purpose: "Grey's Anatomy Season 20" },
    ],
  });
  const created = await browser.post("/api/cases", { scenario: "feature_removed" });
  const [caseRow] = await app.ctx.db.select().from(cases).where(eq(cases.id, created.body.case.id));
  await setBudget(judgeLimits.budgetMicros);
  expect(
    (await browser.post("/api/subscriptions/chat", { message: "Hello", history: [], expectedRevision: 1 }))
      .status,
  ).toBe(429);
  app.ctx.config.liveDiscovery = true;
  expect(
    (await browser.post("/api/subscriptions/review", { serviceId: "netflix", expectedRevision: 1 })).status,
  ).toBe(429);
  expect(
    (await browser.post(`/api/cases/${caseRow!.id}/policy-draft`, { purpose: "Editable notes" })).status,
  ).toBe(429);
  await expect(
    runInvestigation(app.ctx, caseRow!, {
      revision: 1,
      purpose: "Editable notes",
      requiredCapabilities: [],
      recurringCeilingMinor: 1500,
    } as any),
  ).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  const fresh = await invited();
  await expect(fund(fresh.ownerId)).rejects.toMatchObject({ code: "judge_budget_exhausted" });
  expect(app.model.requests).toHaveLength(0);
});
