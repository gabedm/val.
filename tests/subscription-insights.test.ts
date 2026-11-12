import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { startTestApp, type TestApp } from "./helpers";
import {
  ownerSubscriptions,
  ownerSubscriptionReviews,
  ownerReviewBatches,
  judgeDemoRequests,
} from "../src/server/db/schema";
import { subscriptionAdviceVersion } from "../src/server/subscription-advice";
import { modelVersion } from "../src/server/model-settings";
import { adviceContext } from "../src/server/advice-context";
import { customerProduct, rememberRecognizedService } from "../src/server/subscription-recognition";
import type { SubscriptionAdvice, SubscriptionEntry } from "../src/shared/subscriptions";
import type { CatalogueResponse } from "../src/shared/contracts.types";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
const row: SubscriptionEntry = {
  serviceId: "unlisted-audio",
  name: "Unlisted Audio",
  amountMinor: 1600,
  cycle: "month",
  purpose: "offline listening while cycling",
  source: "manual",
};
const advice: SubscriptionAdvice = {
  summary: "A possible fit for your saved needs.",
  options: [{ serviceId: "unlisted-alternative", reason: "Offline listening" }],
  uncertainties: [],
  comparisons: [
    {
      serviceId: "unlisted-alternative",
      name: "Another Audio",
      plan: "Individual",
      owned: false,
      monthlyMinor: 900,
      savingMonthlyMinor: 700,
      priceMinor: 900,
      priceUnit: "month",
      savingAnnualMinor: 8400,
      annualMinor: 10800,
      checkedOn: "2026-11-08",
      sources: ["https://provider.example/plans"],
    },
  ],
};
async function owner() {
  const browser = app.browser();
  await browser.login();
  const ownerId = (await browser.get("/api/session")).body.ownerId as string;
  const catalogue = (await browser.get("/api/catalogue")).body.catalogue as CatalogueResponse["catalogue"];
  await app.ctx.db.insert(ownerSubscriptions).values({ ownerId, revision: 1, subscriptions: [row] });
  return { browser, ownerId, catalogue };
}
async function record(
  ownerId: string,
  catalogue: CatalogueResponse["catalogue"],
  patch: { result?: object; date?: Date; version?: object } = {},
) {
  const id = randomUUID();
  await app.ctx.db.insert(ownerSubscriptionReviews).values({
    id,
    ownerId,
    serviceId: row.serviceId,
    portfolioRevision: 1,
    version: patch.version ?? modelVersion(subscriptionAdviceVersion, app.ctx.model),
    input: { privateCanary: "private-prompt-must-not-be-returned" },
    result: patch.result ?? {
      advice,
      dependencyKey: adviceContext([row], row.serviceId, catalogue.services)!.dependencyKey,
      rawAnswers: ["private-model-output-must-not-be-returned"],
    },
    createdAt: patch.date ?? new Date(),
  });
  return id;
}

it("requires authentication, the current comparison format and a valid portfolio revision", async () => {
  const anonymous = app.browser();
  expect((await anonymous.get("/api/subscriptions/insights?revision=0")).status).toBe(401);
  const { browser } = await owner();
  expect(
    (
      await browser.request("GET", "/api/subscriptions/insights?revision=1", undefined, {
        adviceFormat: null,
      })
    ).status,
  ).toBe(426);
  for (const revision of ["", "-1", "NaN", "1.5", "9007199254740992"])
    expect((await browser.get(`/api/subscriptions/insights?revision=${revision}`)).status).toBe(400);
  expect((await browser.get("/api/subscriptions/insights?revision=0")).status).toBe(409);
});

it("returns an honest empty state without a model request or a new batch", async () => {
  const browser = app.browser();
  await browser.login();
  const response = await browser.get("/api/subscriptions/insights?revision=0");
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    revision: 0,
    reviews: [],
    schedules: [],
    batch: null,
    activity: [],
    moreActivity: false,
  });
  expect(response.headers.get("Cache-Control")).toContain("no-store");
});

it("reads real saved comparisons, current batch progress and granular schedules without paying or queuing", async () => {
  const { browser, ownerId, catalogue } = await owner();
  await record(ownerId, catalogue);
  expect(
    (
      await browser.request("PUT", "/api/subscriptions/price-checks", {
        serviceIds: [row.serviceId],
        cadence: { every: 2, unit: "week" },
        expectedRevision: 1,
        expectedRevisions: { [row.serviceId]: 0 },
      })
    ).status,
  ).toBe(200);
  await app.ctx.db.insert(ownerReviewBatches).values({
    ownerId,
    revision: 1,
    serviceIds: [row.serviceId],
    completed: [],
    failed: [],
    attempts: {},
    status: "running",
    currentServiceId: row.serviceId,
  });
  const before = app.model.requests.length;
  const ledgerBefore = await app.ctx.db.select().from(judgeDemoRequests);
  for (let i = 0; i < 2; i++) {
    const response = await browser.get("/api/subscriptions/insights?revision=1");
    expect(response.status).toBe(200);
    expect(response.body.reviews).toMatchObject([{ serviceId: row.serviceId, advice }]);
    expect(response.body.schedules).toMatchObject([
      { serviceId: row.serviceId, cadence: { every: 2, unit: "week" }, status: "scheduled" },
    ]);
    expect(response.body.batch).toMatchObject({
      status: "running",
      completed: [],
      currentServiceId: row.serviceId,
    });
    expect(response.body.batch).not.toHaveProperty("leaseToken");
    expect(response.body.activity).toMatchObject([
      { name: row.name, outcome: "alternatives", alternatives: 1, available: true },
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(
      /private-prompt|private-model-output|rawAnswers|dependencyKey|ownerId|leaseToken/,
    );
  }
  expect(app.model.requests).toHaveLength(before);
  expect(await app.ctx.db.select().from(judgeDemoRequests)).toEqual(ledgerBefore);
});

it("does not mix accounts, even when they have the same revision and service ID", async () => {
  const first = await owner(),
    second = await owner();
  await record(first.ownerId, first.catalogue);
  const response = await second.browser.get(
    `/api/subscriptions/insights?revision=1&ownerId=${first.ownerId}`,
  );
  expect(response.body.reviews).toEqual([]);
  expect(response.body.activity).toEqual([]);
});

it("keeps no-match and interrupted checks distinct and ordered", async () => {
  const { browser, ownerId, catalogue } = await owner();
  const noMatch = await record(ownerId, catalogue, {
    date: new Date("2026-11-07T12:00:00Z"),
    result: {
      advice: {
        summary: "No match established.",
        options: [],
        uncertainties: [],
        discovery: {
          status: "live",
          providerOnly: true,
          checkedAt: "2026-11-07T12:00:00Z",
          uncertainties: [],
          coverage: { discovered: ["provider.example"], checked: ["provider.example"], incomplete: [] },
        },
      },
    },
  });
  const failed = await record(ownerId, catalogue, {
    date: new Date("2026-11-08T12:00:00Z"),
    result: { completed: false, reason: "timeout", detail: "private failure detail" },
  });
  await record(ownerId, catalogue, {
    date: new Date("2026-11-09T12:00:00Z"),
    result: { completed: false, reason: "research_checkpoint", discovery: { offers: [] } },
  });
  const response = await browser.get("/api/subscriptions/insights?revision=1");
  expect(
    response.body.activity.map((event: { id: string; outcome: string }) => [event.id, event.outcome]),
  ).toEqual([
    [failed, "incomplete"],
    [noMatch, "no_match"],
  ]);
  expect(JSON.stringify(response.body)).not.toContain("private failure detail");
});

it("removes recommendations invalidated by changed needs while preserving dated history", async () => {
  const { browser, ownerId, catalogue } = await owner();
  await record(ownerId, catalogue);
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({ revision: 2, subscriptions: [{ ...row, purpose: "live radio only" }] })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const response = await browser.get("/api/subscriptions/insights?revision=2");
  expect(response.body.reviews).toEqual([]);
  expect(response.body.activity).toHaveLength(1);
  expect((await browser.get("/api/subscriptions/insights?revision=1")).status).toBe(409);
});

it("retires cached advice after corrected product context while preserving the comparison in history", async () => {
  const { browser, ownerId, catalogue } = await owner();
  await record(ownerId, catalogue, { date: new Date(Date.now() - 1000) });
  expect((await browser.get("/api/subscriptions/insights?revision=1")).body.reviews).toHaveLength(1);
  await rememberRecognizedService(
    app.ctx,
    ownerId,
    row.serviceId,
    row.name,
    customerProduct(row.name, "productivity", "A transcription workspace, not a music subscription"),
  );
  const corrected = (await browser.get("/api/subscriptions/insights?revision=1")).body;
  expect(corrected.reviews).toEqual([]);
  expect(corrected.activity).toHaveLength(1);
  expect((await browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe(row.purpose);
});

it("does not promote retired model results or inactive subscriptions into personal recommendations", async () => {
  const { browser, ownerId, catalogue } = await owner();
  await record(ownerId, catalogue, { version: { fingerprint: "retired" } });
  expect((await browser.get("/api/subscriptions/insights?revision=1")).body.reviews).toEqual([]);
  await app.ctx.db
    .update(ownerSubscriptions)
    .set({
      revision: 2,
      subscriptions: [
        {
          ...row,
          paypalEvidence: {
            key: "test-owner-key",
            merchant: row.name,
            agreementStatus: "inactive",
            paymentCount: 3,
            lastPaidOn: "2026-11-01",
            checkedAt: "2026-11-08T00:00:00Z",
          },
        },
      ],
    })
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const response = await browser.get("/api/subscriptions/insights?revision=2");
  expect(response.body.reviews).toEqual([]);
  expect(response.body.activity[0].available).toBe(false);
});
