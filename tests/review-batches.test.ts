import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestApp, type TestApp } from "./helpers";
import { runReviewBatch } from "../src/server/review-batches";
import { subscriptionAdviceService } from "../src/server/subscription-advice";
import * as adviceModule from "../src/server/subscription-advice";
import { HttpError } from "../src/server/http";
import type { SubscriptionAdvice } from "../src/shared/subscriptions";
import {
  judgeDemoRequests,
  ownerReviewBatches,
  ownerSubscriptions,
  ownerSubscriptionReviews,
} from "../src/server/db/schema";
import type { CatalogueResponse } from "../src/shared/contracts.types";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await app.ctx.db.delete(ownerReviewBatches);
  app.model.script = () => ({
    answer: { summary: "No suitable lower-cost match was established.", options: [], uncertainties: [] },
  });
});
async function setup() {
  const browser = app.browser();
  await browser.login();
  const ownerId = (await browser.get("/api/session")).body.ownerId;
  const rows = ["spotify", "netflix"].map((serviceId) => ({
    serviceId,
    amountMinor: 1299,
    cycle: "month",
    purpose: "Offline listening and family viewing",
  }));
  expect(
    (await browser.request("PUT", "/api/subscriptions", { expectedRevision: 0, subscriptions: rows })).status,
  ).toBe(200);
  const catalogue = (await browser.get("/api/catalogue")).body.catalogue as CatalogueResponse["catalogue"];
  return { browser, ownerId, catalogue };
}
it("persists the initial batch, completes without browser requests, and does not rerun on reopen", async () => {
  const { browser, catalogue } = await setup();
  const before = app.model.requests.length;
  const first = await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  expect(first.status).toBe(200);
  expect(first.body.status).toBe("queued");
  expect(app.model.requests).toHaveLength(before);
  expect((await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 })).body).toEqual(
    first.body,
  );
  // New contexts model server-local caches being lost. No client calls drive the work.
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
  const completed = await browser.get("/api/subscriptions/review-batch?revision=1");
  expect(completed.body).toMatchObject({ status: "complete", failed: [] });
  expect(completed.body.completed).toHaveLength(2);
  const calls = app.model.requests.length;
  expect((await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 })).body.status).toBe(
    "complete",
  );
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(false);
  expect(app.model.requests).toHaveLength(calls);
  expect((await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews).toHaveLength(
    2,
  );
});

it.each(["complete", "failed"] as const)(
  "retries incomplete saved results from a %s batch, preserving conclusive results",
  async (status) => {
    const { browser, ownerId } = await setup();
    await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
    await app.ctx.db
      .update(ownerReviewBatches)
      .set({ status, completed: ["spotify", "netflix"], failed: [] })
      .where(eq(ownerReviewBatches.ownerId, ownerId));
    const catalogue = (await browser.get("/api/catalogue")).body.catalogue;
    const original = subscriptionAdviceService(app.ctx, catalogue);
    const checkedAt = new Date(Date.now() - 1000).toISOString();
    const review = vi.fn(async (): Promise<SubscriptionAdvice> => ({
      summary: "New comparison",
      options: [],
      uncertainties: [],
      discovery: {
        status: "live",
        checkedAt: new Date().toISOString(),
        providerOnly: true,
        uncertainties: [],
      },
    }));
    const spy = vi.spyOn(adviceModule, "subscriptionAdviceService").mockReturnValue({
      ...original,
      review,
      savedAdvice: async () =>
        new Map([
          [
            "spotify",
            {
              advice: { summary: "More evidence needed", options: [], uncertainties: [] },
              checkedAt,
              historical: false,
            },
          ],
          [
            "netflix",
            {
              advice: {
                summary: "No suitable match",
                options: [],
                uncertainties: [],
                discovery: {
                  status: "live",
                  checkedAt: new Date().toISOString(),
                  providerOnly: true,
                  uncertainties: [],
                },
              },
              checkedAt: new Date().toISOString(),
              historical: false,
            },
          ],
        ]),
    });
    try {
      const response = await browser.post("/api/subscriptions/review-batch", {
        expectedRevision: 1,
        retry: true,
      });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "queued", completed: ["netflix"], failed: [] });
      expect(response.body.serviceIds).toEqual(expect.arrayContaining(["spotify", "netflix"]));
      await runReviewBatch(app.ctx, catalogue);
      expect(review).toHaveBeenCalledTimes(1);
      expect(review).toHaveBeenCalledWith(
        ownerId,
        { serviceId: "spotify", expectedRevision: 1, fresh: true },
        undefined,
        true,
      );
    } finally {
      spy.mockRestore();
    }
  },
);

it("keeps one partial-research continuation after a transient failure instead of spending it on the error", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await app.ctx.db
    .update(ownerReviewBatches)
    .set({ serviceIds: ["spotify"] })
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const partial: SubscriptionAdvice = {
    basedOn: { serviceId: "spotify", purpose: "Offline listening and family viewing" },
    summary: "More provider checks are needed.",
    options: [],
    comparisons: [],
    uncertainties: [],
    discovery: {
      status: "live",
      checkedAt: new Date().toISOString(),
      uncertainties: ["A source is incomplete."],
      providerOnly: true,
      pendingProviders: ["provider.example.org"],
    },
  };
  const original = subscriptionAdviceService(app.ctx, catalogue);
  let calls = 0;
  const spy = vi.spyOn(adviceModule, "subscriptionAdviceService").mockReturnValue({
    ...original,
    savedAdvice: async () =>
      calls >= 2
        ? new Map([["spotify", { advice: partial, checkedAt: new Date().toISOString(), historical: false }]])
        : new Map(),
    review: async () => {
      calls++;
      if (calls === 1) throw new HttpError(503, "provider_search_unavailable", "Temporary source failure");
      return calls === 2
        ? partial
        : { ...partial, discovery: { ...partial.discovery!, uncertainties: [], pendingProviders: [] } };
    },
  });
  try {
    const start = Date.now();
    await runReviewBatch(app.ctx, catalogue, new Date(start));
    await runReviewBatch(app.ctx, catalogue, new Date(start + 31_000));
    const [waiting] = await app.ctx.db
      .select()
      .from(ownerReviewBatches)
      .where(eq(ownerReviewBatches.ownerId, ownerId));
    expect(waiting).toMatchObject({ status: "queued", completed: [], failed: [], attempts: { spotify: 1 } });
    await runReviewBatch(app.ctx, catalogue, new Date(start + 62_000));
    const [done] = await app.ctx.db
      .select()
      .from(ownerReviewBatches)
      .where(eq(ownerReviewBatches.ownerId, ownerId));
    expect(done).toMatchObject({ status: "complete", completed: ["spotify"], failed: [] });
    expect(calls).toBe(3);
  } finally {
    spy.mockRestore();
  }
});

it("reopens a completed batch when a saved result is invalidated, retaining valid comparisons", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await runReviewBatch(app.ctx, catalogue);
  await runReviewBatch(app.ctx, catalogue);
  const [record] = await app.ctx.db
    .select()
    .from(ownerSubscriptionReviews)
    .where(eq(ownerSubscriptionReviews.ownerId, ownerId));
  await app.ctx.db
    .update(ownerSubscriptionReviews)
    .set({
      version: { ...(record!.version as Record<string, unknown>), fingerprint: "retired-research-version" },
    })
    .where(eq(ownerSubscriptionReviews.id, record!.id));
  expect((await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews).toHaveLength(
    1,
  );
  const before = app.model.requests.length;
  const reopened = await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  expect(reopened.body.status).toBe("queued");
  expect(reopened.body.completed).toHaveLength(1);
  expect(reopened.body.completed).not.toContain(record!.serviceId);
  expect(app.model.requests).toHaveLength(before);
  await runReviewBatch({ ...app.ctx }, catalogue);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "complete",
    failed: [],
  });
  expect((await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews).toHaveLength(
    2,
  );
  expect(
    await app.ctx.db
      .select()
      .from(ownerSubscriptionReviews)
      .where(eq(ownerSubscriptionReviews.id, record!.id)),
  ).toHaveLength(1);
});

it("keeps old but valid results historical on reopen without paying for new research", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await runReviewBatch(app.ctx, catalogue);
  await runReviewBatch(app.ctx, catalogue);
  await app.ctx.db
    .update(ownerSubscriptionReviews)
    .set({ createdAt: new Date(Date.now() - 86_400_000) })
    .where(eq(ownerSubscriptionReviews.ownerId, ownerId));
  const calls = app.model.requests.length;
  expect((await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 })).body.status).toBe(
    "complete",
  );
  expect(await runReviewBatch(app.ctx, catalogue)).toBe(false);
  expect(app.model.requests).toHaveLength(calls);
  const reviews = (await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews;
  expect(reviews).toHaveLength(2);
  expect(reviews.every((review: { historical: boolean }) => review.historical)).toBe(true);
});

it("handles concurrent reopen requests without holding pool connections for nested reads", async () => {
  const { browser, ownerId } = await setup();
  const calls = app.model.requests.length;
  const replies = await Promise.all(
    Array.from({ length: 12 }, () =>
      browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 }),
    ),
  );
  expect(replies.every((reply) => reply.status === 200 && reply.body.status === "queued")).toBe(true);
  expect(
    await app.ctx.db.select().from(ownerReviewBatches).where(eq(ownerReviewBatches.ownerId, ownerId)),
  ).toHaveLength(1);
  expect(app.model.requests).toHaveLength(calls);
});

it("does not count a retired result as completed after an interrupted batch resumes", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await runReviewBatch(app.ctx, catalogue);
  const [record] = await app.ctx.db
    .select()
    .from(ownerSubscriptionReviews)
    .where(eq(ownerSubscriptionReviews.ownerId, ownerId));
  await app.ctx.db
    .update(ownerSubscriptionReviews)
    .set({
      version: { ...(record!.version as Record<string, unknown>), fingerprint: "retired-research-version" },
    })
    .where(eq(ownerSubscriptionReviews.id, record!.id));
  await runReviewBatch({ ...app.ctx }, catalogue);
  const partial = (await browser.get("/api/subscriptions/review-batch?revision=1")).body;
  expect(partial.status).toBe("queued");
  expect(partial.completed).not.toContain(record!.serviceId);
  await runReviewBatch({ ...app.ctx }, catalogue);
  expect((await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews).toHaveLength(
    2,
  );
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.status).toBe("complete");
});

it("finishes the initial batch once a useful option is ready without blocking on optional coverage", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await app.ctx.db
    .update(ownerReviewBatches)
    .set({ serviceIds: ["spotify"] })
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const useful: SubscriptionAdvice = {
    summary: "A suitable lower-cost plan is available.",
    options: [{ serviceId: "alternative", reason: "Matches the saved needs." }],
    uncertainties: [],
    discovery: {
      status: "live",
      checkedAt: new Date().toISOString(),
      uncertainties: ["Other providers remain unchecked."],
      providerOnly: true,
      pendingProviders: ["other.example"],
    },
  };
  const original = subscriptionAdviceService(app.ctx, catalogue);
  const review = vi.fn().mockResolvedValue(useful);
  const spy = vi
    .spyOn(adviceModule, "subscriptionAdviceService")
    .mockReturnValue({ ...original, savedAdvice: async () => new Map(), review });
  try {
    await runReviewBatch(app.ctx, catalogue);
    const result = (await browser.get("/api/subscriptions/review-batch?revision=1")).body;
    expect(result).toMatchObject({ status: "complete", completed: ["spotify"], failed: [] });
    expect(review).toHaveBeenCalledTimes(1);
    expect(review).toHaveBeenCalledWith(
      ownerId,
      { serviceId: "spotify", expectedRevision: 1 },
      undefined,
      true,
    );
    expect(await runReviewBatch(app.ctx, catalogue)).toBe(false);
    expect(useful.discovery!.pendingProviders).toEqual(["other.example"]);
  } finally {
    spy.mockRestore();
  }
});

it("resumes after an actual worker process is killed without repeating completed research", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  const children: ChildProcess[] = [];
  const worker = (interrupt: boolean, now?: string) => {
    const child = fork(new URL("./fixtures/review-worker.ts", import.meta.url), [], {
      execArgv: ["--import", "tsx"],
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    children.push(child);
    const message = Promise.race([
      once(child, "message").then(([value]) => value),
      once(child, "exit").then(() => {
        throw new Error("Worker exited before reporting its result.");
      }),
    ]);
    child.send({ config: { ...app.ctx.config, aiBudgetMicros: 50_000_000 }, catalogue, interrupt, now });
    return { child, message };
  };
  try {
    const first = worker(true);
    expect(await first.message).toMatchObject({ kind: "interrupted" });
    const [interrupted] = await app.ctx.db
      .select()
      .from(ownerReviewBatches)
      .where(eq(ownerReviewBatches.ownerId, ownerId));
    expect(interrupted!.completed).toHaveLength(1);
    expect(interrupted!.status).toBe("running");
    const unsettled = (
      await app.ctx.db.select().from(judgeDemoRequests).where(eq(judgeDemoRequests.ownerId, ownerId))
    ).filter((request) => request.state === "pending");
    expect(unsettled).toHaveLength(1);
    expect(unsettled[0]!.chargedMicros).toBeGreaterThan(0);
    expect(unsettled[0]!.chargedMicros).toBe(unsettled[0]!.reservedMicros);
    const stopped = once(first.child, "exit");
    first.child.kill("SIGKILL");
    await stopped;
    const resumeAt = new Date(interrupted!.leaseUntil!.getTime() + 1);
    const calls = app.model.requests.length;
    await runReviewBatch(
      { ...app.ctx, config: { ...app.ctx.config, aiBudgetMicros: 50_000_000 } },
      catalogue,
      resumeAt,
    );
    expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
      status: "queued",
      failed: [],
      completed: interrupted!.completed,
    });
    expect(app.model.requests).toHaveLength(calls);
    // Advance only the test clock beyond the persisted lease; production uses wall time.
    const restarted = worker(false, new Date(resumeAt.getTime() + 31_000).toISOString());
    const remaining = catalogue.services.find((service) => service.id === interrupted!.currentServiceId)!;
    expect(await restarted.message).toMatchObject({ kind: "complete", researched: [remaining.service] });
    expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
      status: "complete",
      completed: expect.arrayContaining(interrupted!.serviceIds),
      failed: [],
    });
    const [preserved] = await app.ctx.db
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.id, unsettled[0]!.id));
    expect(preserved).toEqual(unsettled[0]);
  } finally {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const stopped = once(child, "exit");
      child.kill("SIGKILL");
      await stopped;
    }
  }
});

it("commits final confirmed needs and queued research atomically without a second browser request", async () => {
  const { browser, catalogue } = await setup();
  const before = (await browser.get("/api/subscriptions")).body;
  const rows = before.subscriptions.map(({ serviceId, amountMinor, cycle, purpose }: any) => ({
    serviceId,
    amountMinor,
    cycle,
    purpose,
  }));
  const invalid = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    startResearch: true,
    subscriptions: rows.map((row: any, index: number) => (index === 0 ? { ...row, purpose: "" } : row)),
  });
  expect(invalid.body.error).toBe("purpose_needed");
  expect((await browser.get("/api/subscriptions")).body).toEqual(before);
  expect((await browser.get("/api/subscriptions/review-batch?revision=2")).status).toBe(409);
  expect(
    (
      await browser.request("PUT", "/api/subscriptions", {
        expectedRevision: 1,
        startResearch: true,
        subscriptions: rows,
      })
    ).status,
  ).toBe(200);
  // No start-batch request: the page may disappear immediately after confirming memory.
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
  expect((await browser.get("/api/subscriptions/review-batch?revision=2")).body).toMatchObject({
    status: "complete",
    failed: [],
  });
});

it("retains an unsupported-currency outcome for the returning browser without a model call", async () => {
  const { browser, ownerId, catalogue } = await setup();
  const [portfolio] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      subscriptions: portfolio!.subscriptions.map((row) => ({ ...row, currency: "EUR" as const })),
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const calls = app.model.requests.length;
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await runReviewBatch(app.ctx, catalogue);
  await runReviewBatch(app.ctx, catalogue);
  const reviews = (await browser.get("/api/subscriptions/reviews?revision=1&history=true")).body.reviews;
  expect(reviews).toHaveLength(2);
  expect(
    reviews.every((review: any) => review.advice.summary.includes("EUR") && !review.advice.options.length),
  ).toBe(true);
  expect(app.model.requests).toHaveLength(calls);
});

it("does not reset a running claim on repeated starts or allow another worker to duplicate it", async () => {
  const { browser, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  app.model.script = async () => {
    started();
    await gate;
    return { answer: { summary: "No suitable lower-cost match.", options: [], uncertainties: [] } };
  };
  const first = runReviewBatch({ ...app.ctx }, catalogue);
  try {
    await entered;
    const calls = app.model.requests.length;
    const repeated = await browser.post("/api/subscriptions/review-batch", {
      expectedRevision: 1,
      retry: true,
    });
    expect(repeated.body.status).toBe("running");
    expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(false);
    expect(app.model.requests).toHaveLength(calls);
  } finally {
    release();
    await first;
  }
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.completed).toHaveLength(1);
});

it("checks untouched subscriptions before retrying a temporarily failed one", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  let calls = 0;
  app.model.script = () => {
    if (calls++ === 0) throw new Error("Temporary research failure");
    return {
      answer: { summary: "No suitable lower-cost match was established.", options: [], uncertainties: [] },
    };
  };
  const now = new Date();
  await runReviewBatch(app.ctx, catalogue, now);
  const [pending] = await app.ctx.db
    .select()
    .from(ownerReviewBatches)
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const retried = Object.keys(pending!.attempts)[0];
  await runReviewBatch({ ...app.ctx }, catalogue, new Date(now.getTime() + 31_000));
  const mid = (await browser.get("/api/subscriptions/review-batch?revision=1")).body;
  expect(mid.completed).toHaveLength(1);
  expect(mid.completed).not.toContain(retried);
  expect(mid.failed).toEqual([]);
  await runReviewBatch({ ...app.ctx }, catalogue, new Date(now.getTime() + 32_000));
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "complete",
    failed: [],
  });
});

it("pauses without failing untouched subscriptions and resumes automatically when funds are available", async () => {
  const { browser, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  const ctx = { ...app.ctx, config: { ...app.ctx.config, aiBudgetMicros: 1 } };
  const now = new Date();
  await runReviewBatch(ctx, catalogue, now);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "paused",
    pauseReason: "budget",
    completed: [],
    failed: [],
  });
  ctx.config.aiBudgetMicros = 100_000_000;
  await runReviewBatch(ctx, catalogue, new Date(now.getTime() + 61_000));
  await runReviewBatch(ctx, catalogue, new Date(now.getTime() + 62_000));
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "complete",
    pauseReason: null,
    failed: [],
  });
});

it("does not mark unresolved provider research complete after its bounded continuation", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await app.ctx.db
    .update(ownerReviewBatches)
    .set({ serviceIds: ["spotify"] })
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const partial: SubscriptionAdvice = {
    basedOn: { serviceId: "spotify", purpose: "Offline listening and family viewing" },
    summary: "Provider evidence is still incomplete.",
    options: [],
    comparisons: [],
    uncertainties: [],
    discovery: {
      status: "live",
      checkedAt: new Date().toISOString(),
      uncertainties: [],
      providerOnly: true,
      pendingProviders: ["unavailable.example"],
    },
  };
  let calls = 0;
  const original = subscriptionAdviceService(app.ctx, catalogue);
  const spy = vi.spyOn(adviceModule, "subscriptionAdviceService").mockReturnValue({
    ...original,
    savedAdvice: async () =>
      calls
        ? new Map([["spotify", { advice: partial, checkedAt: new Date().toISOString(), historical: false }]])
        : new Map(),
    review: async () => {
      calls++;
      return partial;
    },
  });
  try {
    const now = Date.now();
    await runReviewBatch(app.ctx, catalogue, new Date(now));
    await runReviewBatch(app.ctx, catalogue, new Date(now + 1000));
    expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
      status: "failed",
      completed: [],
      failed: ["spotify"],
    });
    expect(calls).toBe(2);
    expect(await runReviewBatch(app.ctx, catalogue, new Date(now + 120000))).toBe(false);
  } finally {
    spy.mockRestore();
  }
});

it("bounds failed research attempts while preserving the completed services", async () => {
  const { browser, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  await runReviewBatch(app.ctx, catalogue);
  const saved = (await browser.get("/api/subscriptions/review-batch?revision=1")).body.completed;
  app.model.script = () => {
    throw new Error("synthetic failed model request");
  };
  const now = new Date();
  expect(await runReviewBatch(app.ctx, catalogue, now)).toBe(true);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.status).toBe("queued");
  expect(await runReviewBatch(app.ctx, catalogue, new Date(now.getTime() + 31_000))).toBe(true);
  const failed = (await browser.get("/api/subscriptions/review-batch?revision=1")).body;
  expect(failed).toMatchObject({ status: "failed", completed: saved });
  expect(failed.failed).toHaveLength(1);
  const calls = app.model.requests.length;
  expect(await runReviewBatch(app.ctx, catalogue, new Date(now.getTime() + 120_000))).toBe(false);
  expect(app.model.requests).toHaveLength(calls);
});
it("recovers the gap between saving advice and completing the batch without another model call", async () => {
  const { browser, ownerId, catalogue } = await setup();
  const started = await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  const serviceId = started.body.serviceIds[0];
  await subscriptionAdviceService(app.ctx, catalogue).review(ownerId, { serviceId, expectedRevision: 1 });
  await app.ctx.db
    .update(ownerReviewBatches)
    .set({
      status: "running",
      currentServiceId: serviceId,
      leaseToken: "expired-test-claim",
      leaseUntil: new Date(Date.now() - 1000),
    })
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const calls = app.model.requests.length;
  expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
  expect(app.model.requests).toHaveLength(calls);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.completed).toContain(
    serviceId,
  );
});
it("keeps busy work queued across contexts and serialises the account without consuming model calls", async () => {
  const { browser, ownerId, catalogue } = await setup();
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  const connection = await app.ctx.db.$client.connect();
  try {
    await connection.query("select pg_advisory_lock(hashtextextended($1,0))", [`val-advice:${ownerId}`]);
    const before = app.model.requests.length;
    expect(await runReviewBatch({ ...app.ctx }, catalogue)).toBe(true);
    expect(app.model.requests).toHaveLength(before);
    await expect(
      subscriptionAdviceService({ ...app.ctx }, catalogue).review(ownerId, {
        serviceId: "spotify",
        expectedRevision: 1,
      }),
    ).rejects.toMatchObject({ code: "review_running" });
    expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
      status: "queued",
      completed: [],
      failed: [],
    });
  } finally {
    await connection.query("select pg_advisory_unlock(hashtextextended($1,0))", [`val-advice:${ownerId}`]);
    connection.release();
  }
  expect(await runReviewBatch({ ...app.ctx }, catalogue, new Date(Date.now() + 31_000))).toBe(true);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.completed).toHaveLength(1);
});
it("refuses unfinished needs, caller-selected work, other owners and stale revisions", async () => {
  const { browser, ownerId, catalogue } = await setup();
  expect((await app.browser().post("/api/subscriptions/review-batch", { expectedRevision: 1 })).status).toBe(
    403,
  );
  expect(
    (await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1, serviceIds: ["foreign"] }))
      .status,
  ).toBe(400);
  expect((await browser.post("/api/subscriptions/review-batch", { expectedRevision: 0 })).status).toBe(409);
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  const other = app.browser();
  await other.login();
  expect((await other.get("/api/subscriptions/review-batch?revision=1")).status).toBe(409);
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({ revision: 2 })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const calls = app.model.requests.length;
  expect(await runReviewBatch(app.ctx, catalogue)).toBe(true);
  expect(app.model.requests).toHaveLength(calls);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body.status).toBe("superseded");
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      subscriptions: [
        {
          serviceId: "spotify",
          name: "Spotify",
          source: "manual",
          amountMinor: 1299,
          cycle: "month",
          purpose: "",
        },
      ],
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  expect((await browser.post("/api/subscriptions/review-batch", { expectedRevision: 2 })).body.error).toBe(
    "purpose_needed",
  );
});
