import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { startTestApp, type TestApp } from "./helpers";
import { nextPriceCheck, validCadence } from "../src/shared/price-checks";
import { judgeDemoOwners, ownerPriceChecks, ownerSubscriptions } from "../src/server/db/schema";
import { runDuePriceCheck } from "../src/server/price-checks";
import type { CatalogueResponse } from "../src/shared/contracts.types";
import type { Response as ModelResponse } from "openai/resources/responses/responses";
import { agentModel } from "../src/server/agent-contract";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { consistencyCheckOutput } from "./model-standin";
import type { LiveOffer } from "../src/server/live-discovery";
import { rememberRecognizedService, customerProduct } from "../src/server/subscription-recognition";

let app: TestApp;
beforeAll(async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!),
    database = `val_schedule_test_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  app = await startTestApp({ databaseUrl: new URL(`/${database}`, base).href });
});
afterAll(() => app.close());
beforeEach(async () => {
  await app.ctx.db.delete(ownerPriceChecks);
  app.ctx.config.aiBudgetMicros = 5_000_000;
  app.ctx.config.liveDiscovery = true;
  app.ctx.config.judgeDemo = null;
});
async function owner() {
  const browser = app.browser(),
    login = await browser.login();
  const ownerId = login.body.session.ownerId;
  await app.ctx.db.insert(ownerSubscriptions).values({
    ownerId,
    revision: 1,
    subscriptions: [
      {
        serviceId: "netflix",
        name: "Netflix",
        source: "paypal",
        amountMinor: 1399,
        cycle: "month",
        purpose: "Watch named series",
      },
      {
        serviceId: "three",
        name: "Three",
        source: "paypal",
        amountMinor: 1800,
        cycle: "month",
        purpose: "Maps and calls, around 2GB data",
      },
    ],
  });
  return {
    browser,
    ownerId,
    catalogue: (await browser.get("/api/catalogue")).body.catalogue as CatalogueResponse["catalogue"],
  };
}
const command = (
  serviceIds = ["three"],
  cadence: unknown = { every: 1, unit: "week" },
  revisions?: Record<string, number>,
) => ({
  serviceIds,
  cadence,
  expectedRevision: 1,
  expectedRevisions: revisions ?? Object.fromEntries(serviceIds.map((id) => [id, 0])),
});
async function makeDue(ownerId: string, serviceId = "three") {
  await app.ctx.db
    .update(ownerPriceChecks)
    .set({ nextCheckAt: new Date(Date.now() - 60_000) })
    .where(and(eq(ownerPriceChecks.ownerId, ownerId), eq(ownerPriceChecks.serviceId, serviceId)));
}

it("stops monitoring a provider-confirmed cancelled subscription without another model request", async () => {
  const { browser, ownerId, catalogue } = await owner();
  expect((await browser.request("PUT", "/api/subscriptions/price-checks", command())).status).toBe(200);
  const [portfolio] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      subscriptions: portfolio!.subscriptions.map((row) =>
        row.serviceId === "three"
          ? {
              ...row,
              providerState: {
                switchId: "completed-switch",
                status: "cancelled" as const,
                verifiedAt: new Date().toISOString(),
              },
            }
          : row,
      ),
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await makeDue(ownerId);
  const requests = app.model.requests.length;
  await runDuePriceCheck(app.ctx, catalogue);
  const [schedule] = await app.ctx.db
    .select()
    .from(ownerPriceChecks)
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(schedule).toMatchObject({ status: "paused", nextCheckAt: null, retryAt: null });
  expect(app.model.requests).toHaveLength(requests);
});
const source = "https://provider.co.uk/plans";
function web(answer: unknown) {
  return {
    id: "web-schedule-test",
    model: agentModel,
    status: "completed",
    output: [
      {
        type: "web_search_call",
        id: "search",
        status: "completed",
        action: { type: "search", query: "provider plans", sources: [{ type: "url", url: source }] },
      },
      {
        type: "message",
        id: "answer",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }],
      },
    ],
    usage: { input_tokens: 100, output_tokens: 100, total_tokens: 200 },
  } as unknown as ModelResponse;
}
function liveModel(block?: () => Promise<void>) {
  let calls = 0;
  app.ctx.model = {
    responses: {
      create: async (request) => {
        calls++;
        if (block) await block();
        const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
        if (name === "AdviceConsistency") {
          const response = web(
            consistencyCheckOutput(
              [],
              JSON.parse((request.input as { content: string }[])[0]!.content).proposal.options,
            ),
          );
          return { ...response, output: response.output.filter((item) => item.type === "message") };
        }
        if (name === "OfficialProviders")
          return web({
            providers: [{ name: "Fresh Mobile", website: source }],
            searchPurpose: "Maps, calls and 2GB data",
            namedApps: [],
            uncertainties: [],
          });
        if (name === "ProviderOffers")
          return web({
            offers: [
              {
                name: "Fresh Mobile",
                plan: "5GB rolling",
                providerUrl: source,
                currency: "GBP",
                market: "GB",
                priceMinor: 700,
                renewalMinor: 700,
                billingUnit: "month",
                billingEvidence: { quote: "We bill you every calendar month.", source },
                introductoryCycles: 0,
                minimumTermMonths: 1,
                upfrontMinor: 0,
                features: ["5GB general data, UK calls"],
                conditions: [],
                sources: [source],
                priceEvidence: { kind: "direct_gbp", quote: "£7.00 per month", source },
                scheduledChanges: [],
                appCoverage: [],
              },
            ],
            uncertainties: [],
          });
        const input = JSON.parse((request.input as { content: string }[])[0]!.content);
        return web({
          summary: "A lower-cost plan plausibly fits the saved need.",
          options: [
            {
              serviceId: input.candidates[0].id,
              reason: "Enough general data for the saved maps and calling use.",
              replacement: "supported",
              condition: null,
            },
          ],
          uncertainties: [],
        });
      },
    },
  };
  return () => calls;
}

it("validates intervals and retains month-end anchors", () => {
  expect(validCadence({ every: 0, unit: "hour" })).toBe(false);
  expect(validCadence({ every: 1, unit: "minute" })).toBe(false);
  expect(validCadence({ every: 1000, unit: "day" })).toBe(false);
  expect(validCadence({ every: 2, unit: "week" })).toBe(true);
  const february = nextPriceCheck(new Date("2027-01-31T09:00:00Z"), { every: 1, unit: "month" });
  expect(february.toISOString()).toBe("2027-02-28T09:00:00.000Z");
  expect(nextPriceCheck(february, { every: 1, unit: "month" }, 31).toISOString()).toBe(
    "2027-03-31T09:00:00.000Z",
  );
});
it("changes only the confirmed owned selection; per-sub overrides and pause preserve needs and bills", async () => {
  const { browser } = await owner();
  const all = await browser.request(
    "PUT",
    "/api/subscriptions/price-checks",
    command(["netflix", "three"], { every: 1, unit: "month" }),
  );
  expect(all.status).toBe(200);
  expect(all.body.schedules).toHaveLength(2);
  const single = await browser.request(
    "PUT",
    "/api/subscriptions/price-checks",
    command(["three"], { every: 2, unit: "week" }, { three: 1 }),
  );
  expect(single.status).toBe(200);
  expect(single.body.schedules.find((row: any) => row.serviceId === "netflix").cadence).toEqual({
    every: 1,
    unit: "month",
  });
  expect(single.body.schedules.find((row: any) => row.serviceId === "three")).toMatchObject({
    cadence: { every: 2, unit: "week" },
    revision: 2,
    status: "scheduled",
  });
  expect(
    (await browser.request("PUT", "/api/subscriptions/price-checks", command(["three"], null, { three: 2 })))
      .status,
  ).toBe(200);
  const persisted = (await browser.get("/api/subscriptions/price-checks")).body.schedules;
  expect(persisted.find((row: any) => row.serviceId === "three")).toMatchObject({
    cadence: null,
    nextCheckAt: null,
    status: "paused",
  });
  expect((await browser.get("/api/subscriptions")).body).toMatchObject({
    revision: 1,
    subscriptions: [
      { amountMinor: 1399, purpose: "Watch named series" },
      { amountMinor: 1800, purpose: "Maps and calls, around 2GB data" },
    ],
  });
});
it("does no paid research for stale billing evidence and keeps the schedule for a restored bill", async () => {
  const { browser, ownerId, catalogue } = await owner();
  expect((await browser.request("PUT", "/api/subscriptions/price-checks", command())).status).toBe(200);
  const calls = liveModel();
  const [stored] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const subscriptions = stored!.subscriptions.map((row) =>
    row.serviceId === "three"
      ? {
          ...row,
          paypalEvidence: {
            key: "test-stale",
            merchant: "Three",
            paymentCount: 3,
            lastPaidOn: "2026-07-01",
            checkedAt: "2026-11-06",
            agreementStatus: "active" as const,
            recurrenceStale: true,
          },
        }
      : row,
  );
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({ subscriptions })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await makeDue(ownerId);
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(true);
  expect(calls()).toBe(0);
  const [waiting] = await app.ctx.db
    .select()
    .from(ownerPriceChecks)
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(waiting).toMatchObject({ status: "needs_details", cadence: { every: 1, unit: "week" } });
  expect(waiting!.retryAt).not.toBeNull();
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({ subscriptions: stored!.subscriptions })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await app.ctx.db
    .update(ownerPriceChecks)
    .set({ retryAt: null })
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(true);
  expect(calls()).toBeGreaterThan(0);
  const [restored] = await app.ctx.db
    .select()
    .from(ownerPriceChecks)
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(restored!.status).toBe("scheduled");
  expect(restored!.lastCheckedAt).not.toBeNull();
});

it("rejects unauthenticated, cross-owner, CSRF, malformed, stale and caller-chosen runtime state", async () => {
  const { browser } = await owner();
  const other = await owner();
  expect((await app.browser().get("/api/subscriptions/price-checks")).status).toBe(401);
  expect(
    (await browser.request("PUT", "/api/subscriptions/price-checks", command(), { csrf: null })).status,
  ).toBe(403);
  for (const invalid of [
    command([], null),
    command(["foreign"], null),
    command(["three", "three"], null),
    command(["three"], { every: 1, unit: "minute" }),
    { ...command(), ownerId: other.ownerId },
    { ...command(), nextCheckAt: "2020-01-01" },
  ]) {
    expect([400, 404]).toContain(
      (await browser.request("PUT", "/api/subscriptions/price-checks", invalid)).status,
    );
  }
  expect(
    (await browser.request("PUT", "/api/subscriptions/price-checks", { ...command(), expectedRevision: 0 }))
      .status,
  ).toBe(409);
  expect((await browser.request("PUT", "/api/subscriptions/price-checks", command())).status).toBe(200);
  expect((await browser.request("PUT", "/api/subscriptions/price-checks", command())).status).toBe(409);
  expect((await other.browser.get("/api/subscriptions/price-checks")).body.schedules).toEqual([]);
});
it("only proposes a chat schedule, maps owned refs and reads current cadence without mutating memory", async () => {
  const { browser } = await owner();
  app.ctx.model = app.model;
  app.model.script = (_request, index) => {
    if (index === 0) return { call: "read_subscriptions" };
    return {
      answer: {
        message: "Check Three every two weeks?",
        draft: null,
        compareRef: null,
        compareRefs: [],
        discussingRef: "saved:1",
        scheduleDraft: { serviceRefs: ["saved:1"], cadence: { every: 2, unit: "week" } },
      },
    };
  };
  const reply = await browser.post("/api/subscriptions/chat", {
    message: "Keep an eye on Three fortnightly. Leave Netflix alone.",
    history: [],
    expectedRevision: 1,
  });
  expect(reply.status).toBe(200);
  expect(reply.body.scheduleDraft).toEqual({
    serviceIds: ["three"],
    cadence: { every: 2, unit: "week" },
    expectedRevisions: { three: 0 },
  });
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules).toEqual([]);
  const bad = {
    message: "Schedule it",
    draft: null,
    compareRef: null,
    compareRefs: [],
    scheduleDraft: { serviceRefs: ["saved:99"], cadence: { every: 1, unit: "day" } },
  };
  app.model.script = (_request, index) => (index === 0 ? { call: "read_subscriptions" } : { answer: bad });
  expect(
    (await browser.post("/api/subscriptions/chat", { message: "Daily", history: [], expectedRevision: 1 }))
      .status,
  ).toBe(503);
});
it("runs fresh research automatically with saved needs, persists the result and prevents simultaneous duplicate claims", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  expect(
    (await Promise.all([runDuePriceCheck(app.ctx, catalogue), runDuePriceCheck(app.ctx, catalogue)])).sort(),
  ).toEqual([false, true]);
  expect(calls()).toBe(4);
  const saved = (await browser.get("/api/subscriptions/price-checks")).body.schedules[0];
  expect(saved).toMatchObject({
    status: "scheduled",
    advice: { comparisons: [{ annualMinor: 8400, savingAnnualMinor: 13200 }] },
  });
  expect(Date.parse(saved.nextCheckAt)).toBeGreaterThan(Date.now());
  expect(saved.lastCheckedAt).not.toBeNull();
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(false);
  const [portfolio] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const unrelatedEdit = portfolio!.subscriptions.map((row) =>
    row.serviceId === "netflix" ? { ...row, purpose: "Watch documentaries without adverts" } : row,
  );
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({ revision: 2, subscriptions: unrelatedEdit })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].advice).toEqual(
    saved.advice,
  );
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      revision: 3,
      subscriptions: unrelatedEdit.map((row) =>
        row.serviceId === "three" ? { ...row, purpose: "100GB monthly for work tethering" } : row,
      ),
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].advice).toBeNull();
  expect(calls()).toBe(4);
});
it("does not bypass the shared spending cap or spend on an incomplete purpose", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  app.ctx.config.aiBudgetMicros = 1;
  await runDuePriceCheck(app.ctx, catalogue);
  expect(calls()).toBe(0);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "budget_reached",
    nextCheckAt: null,
    advice: null,
  });
  app.ctx.config.aiBudgetMicros = 5_000_000;
  await browser.request(
    "PUT",
    "/api/subscriptions/price-checks",
    command(["three"], { every: 1, unit: "hour" }, { three: 1 }),
  );
  await makeDue(ownerId);
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      subscriptions: [
        {
          serviceId: "three",
          name: "Three",
          source: "manual",
          amountMinor: null,
          cycle: "month",
          purpose: "",
        },
      ],
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await runDuePriceCheck(app.ctx, catalogue);
  expect(calls()).toBe(0);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].status).toBe(
    "needs_details",
  );
});

it("does not show a scheduled result under a subsequently corrected product identity", async () => {
  const { browser, ownerId, catalogue } = await owner();
  liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  await runDuePriceCheck(app.ctx, catalogue);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].advice).not.toBeNull();
  await rememberRecognizedService(
    app.ctx,
    ownerId,
    "three",
    "Three",
    customerProduct("Three", "productivity", "A work subscription with corrected product context"),
  );
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].advice).toBeNull();
});

it("resumes a confirmed schedule when its shared allowance is restored, without requiring new consent", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  app.ctx.config.aiBudgetMicros = 1;
  await runDuePriceCheck(app.ctx, catalogue);
  expect(calls()).toBe(0);
  app.ctx.config.aiBudgetMicros = 5_000_000;
  expect(await runDuePriceCheck(app.ctx, catalogue, new Date(Date.now() + 61_000))).toBe(true);
  expect(calls()).toBeGreaterThan(0);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "scheduled",
    revision: 1,
    cadence: { every: 1, unit: "week" },
  });
});

it("retries an undispatched busy check promptly and preserves an explicit pause", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  const connection = await app.ctx.db.$client.connect();
  const now = new Date();
  try {
    await connection.query("select pg_advisory_lock(hashtextextended($1, 0))", [`val-advice:${ownerId}`]);
    await runDuePriceCheck(app.ctx, catalogue, now);
    expect(calls()).toBe(0);
    const [waiting] = await app.ctx.db
      .select()
      .from(ownerPriceChecks)
      .where(eq(ownerPriceChecks.ownerId, ownerId));
    expect(waiting!.status).toBe("retrying");
    expect(waiting!.retryAt!.getTime() - now.getTime()).toBeLessThanOrEqual(60_000);
  } finally {
    await connection.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`val-advice:${ownerId}`]);
    connection.release();
  }
  expect(await runDuePriceCheck(app.ctx, catalogue, new Date(now.getTime() + 61_000))).toBe(true);
  await browser.request("PUT", "/api/subscriptions/price-checks", command(["three"], null, { three: 1 }));
  const before = calls();
  expect(await runDuePriceCheck(app.ctx, catalogue, new Date(now.getTime() + 8 * 86400_000))).toBe(false);
  expect(calls()).toBe(before);
});

it("pauses a due check without model calls when the person excludes its payment from subscriptions", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  const [record] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      subscriptions: record!.subscriptions.map((row) =>
        row.serviceId === "three"
          ? {
              ...row,
              paypalEvidence: {
                key: "a".repeat(64),
                merchant: "Three",
                paymentCount: 1,
                lastPaidOn: "2026-10-21",
                checkedAt: new Date().toISOString(),
                agreementStatus: "active" as const,
                cycleBasis: "owner_confirmation" as const,
                excludedByOwner: true,
              },
            }
          : row,
      ),
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(true);
  expect(calls()).toBe(0);
  expect((await browser.request("PUT", "/api/subscriptions/price-checks", command())).status).toBe(404);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "paused",
    nextCheckAt: null,
  });
});
it("does not replace a scheduled check while its full research window is still active", async () => {
  const { browser, ownerId, catalogue } = await owner();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  liveModel(async () => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
  });
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  const now = new Date();
  const running = runDuePriceCheck(app.ctx, catalogue, now);
  try {
    await started;
    expect(await runDuePriceCheck({ ...app.ctx }, catalogue, new Date(now.getTime() + 301_000))).toBe(false);
    expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0].status).toBe("checking");
  } finally {
    release();
    await running;
  }
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "scheduled",
  });
});

it("does not publish or re-enable an old scheduled run after the owner pauses it", async () => {
  const { browser, ownerId, catalogue } = await owner();
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => (release = resolve)),
    started = new Promise<void>((resolve) => (entered = resolve));
  let first = true;
  liveModel(async () => {
    if (first) {
      first = false;
      entered();
      await blocked;
    }
  });
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  const running = runDuePriceCheck(app.ctx, catalogue);
  await started;
  await browser.request("PUT", "/api/subscriptions/price-checks", command(["three"], null, { three: 1 }));
  release();
  await running;
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "paused",
    cadence: null,
    nextCheckAt: null,
    advice: null,
  });
});
it("continues confirmed checks after browser access expires and recovers a crashed worker without replaying missed intervals", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const calls = liveModel();
  await browser.request("PUT", "/api/subscriptions/price-checks", command());
  await makeDue(ownerId);
  app.ctx.config.judgeDemo = {
    budgetMicros: 5_000_000,
    username: "test",
    passwordHash: "not-used-in-this-test",
  };
  await app.ctx.db
    .insert(judgeDemoOwners)
    .values({ ownerId, expiresAt: new Date(Date.now() - 1000) })
    .onConflictDoUpdate({ target: judgeDemoOwners.ownerId, set: { expiresAt: new Date(Date.now() - 1000) } });
  // An older deployment already paused this confirmed schedule when the browser grant expired.
  await app.ctx.db
    .update(ownerPriceChecks)
    .set({ status: "access_needed", nextCheckAt: null })
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  await runDuePriceCheck(app.ctx, catalogue);
  const firstCheckCalls = calls();
  expect(firstCheckCalls).toBeGreaterThan(0);
  const [denied] = await app.ctx.db
    .select()
    .from(ownerPriceChecks)
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(denied).toMatchObject({ status: "scheduled" });
  expect(denied!.nextCheckAt!.getTime()).toBeGreaterThan(Date.now());
  app.ctx.config.judgeDemo = null;
  const resumed = await browser.request(
    "PUT",
    "/api/subscriptions/price-checks",
    command(["three"], { every: 1, unit: "hour" }, { three: 1 }),
  );
  expect(resumed.status, resumed.body).toBe(200);
  await app.ctx.db
    .update(ownerPriceChecks)
    .set({
      nextCheckAt: new Date(Date.now() - 30 * 86400_000),
      leaseToken: "crashed",
      leaseUntil: new Date(Date.now() - 1000),
      status: "checking",
    })
    .where(eq(ownerPriceChecks.ownerId, ownerId));
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(true);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules[0]).toMatchObject({
    status: "scheduled",
  });
  expect(calls()).toBeGreaterThan(firstCheckCalls);
  expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(false);
});

it.each(["GBP", "USD"] as const)(
  "preserves prepaid %s terms through the worker and stops older views from reading or changing its result",
  async (currency) => {
    const { browser, ownerId, catalogue } = await owner();
    const serviceId = "pp_privacy_schedule";
    const purpose =
      "Public Wi-Fi privacy on a phone and tablet, without streaming or a specific server country.";
    const portfolio = (await browser.get("/api/subscriptions")).body;
    await app.ctx.db
      .update(ownerSubscriptions)
      .set({
        subscriptions: [
          ...portfolio.subscriptions,
          {
            serviceId,
            name: "Personal VPN",
            source: "paypal",
            amountMinor: 1400,
            cycle: "month",
            purpose,
          },
        ],
      })
      .where(eq(ownerSubscriptions.ownerId, ownerId));
    const savedPortfolio = (await browser.get("/api/subscriptions")).body;
    const offer: LiveOffer = {
      name: "Fixture Privacy",
      plan: "Basic",
      providerUrl: source,
      currency,
      market: "GB",
      priceMinor: 9600,
      renewalMinor: 12000,
      billingUnit: "prepaid",
      prepaid: { initialMonths: 27, renewalMonths: 12 },
      introductoryCycles: 0,
      minimumTermMonths: 27,
      upfrontMinor: 500,
      features: ["Privacy on phones and tablets, supporting five devices at once."],
      conditions: [],
      sources: [source],
      priceEvidence: {
        kind: currency === "GBP" ? "direct_gbp" : "native_currency",
        quote: `${currency} 96 for the first 27 months. Then renews at ${currency} 120 per year. Additional setup fee ${currency} 5.`,
        source,
      },
      appCoverage: [],
      scheduledChanges: [],
    };
    let calls = 0;
    const previous = app.ctx.model;
    app.ctx.model = {
      responses: {
        create: async (request) => {
          calls++;
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return web({
              providers: [{ name: offer.name, website: source }],
              searchPurpose: purpose,
              namedApps: [],
              uncertainties: [],
            });
          if (stage === "ProviderOffers") return web({ offers: [offer], uncertainties: [] });
          if (stage === "AdviceConsistency")
            return web(
              consistencyCheckOutput(
                [],
                JSON.parse((request.input as { content: string }[])[0]!.content).proposal.options,
              ),
            );
          const input = JSON.parse((request.input as { content: string }[])[0]!.content);
          expect(input.subscription.purpose).toBe(purpose);
          expect(input.candidates[0]).toMatchObject({ annualMinor: 10100, priceUnit: "prepaid" });
          return web({
            summary: "A possible alternative for the saved privacy need.",
            options: [
              {
                serviceId: input.candidates[0].id,
                reason: "Protects both devices.",
                replacement: currency === "GBP" ? "supported" : "conditional",
                condition: currency === "GBP" ? null : "GBP conversion and payment fees are unverified.",
              },
            ],
            uncertainties: currency === "GBP" ? [] : ["GBP conversion and payment fees are unverified."],
          });
        },
      },
    };
    try {
      expect(
        (
          await browser.request(
            "PUT",
            "/api/subscriptions/price-checks",
            command([serviceId], { every: 1, unit: "month" }),
          )
        ).status,
      ).toBe(200);
      await makeDue(ownerId, serviceId); // Fixture due time; this exercises the worker, not a deployed scheduler.
      expect(
        (
          await Promise.all([runDuePriceCheck(app.ctx, catalogue), runDuePriceCheck(app.ctx, catalogue)])
        ).sort(),
      ).toEqual([false, true]);
      expect(calls).toBe(4);
      const completed = (await browser.get("/api/subscriptions/price-checks")).body.schedules;
      expect(completed).toHaveLength(1);
      expect(completed[0]).toMatchObject({
        serviceId,
        revision: 1,
        status: "scheduled",
        advice: {
          comparisons: [
            {
              currency,
              priceUnit: "prepaid",
              prepaid: { initialMonths: 27, renewalMonths: 12 },
              priceMinor: 9600,
              renewalMinor: 12000,
              upfrontMinor: 500,
              annualMinor: 10100,
              savingAnnualMinor: currency === "GBP" ? 6700 : null,
            },
          ],
        },
      });
      expect(Date.parse(completed[0].nextCheckAt)).toBeGreaterThan(Date.now());
      expect(await runDuePriceCheck(app.ctx, catalogue)).toBe(false);
      for (const method of ["GET", "PUT"]) {
        const legacy = await browser.request(
          method,
          "/api/subscriptions/price-checks",
          method === "PUT" ? command([serviceId], { every: 2, unit: "week" }, { [serviceId]: 1 }) : undefined,
          { adviceFormat: null },
        );
        expect(legacy.status).toBe(426);
        expect(legacy.body.error).toBe("client_update_required");
        expect(legacy.body.schedules).toBeUndefined();
      }
      expect((await browser.get("/api/subscriptions/price-checks")).body.schedules).toEqual(completed);
      expect((await browser.get("/api/subscriptions")).body).toEqual(savedPortfolio);
      expect(calls).toBe(4);
    } finally {
      app.ctx.model = previous;
    }
  },
);
