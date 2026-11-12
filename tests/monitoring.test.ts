import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { PriceCheckSchedule } from "../src/shared/price-checks";
import type { SubscriptionEntry, SubscriptionPortfolio } from "../src/shared/subscriptions";
import { MonitoringPanel } from "../src/client/MonitoringPanel";
import {
  monitoringStatus,
  newPayPalSubscriptions,
  newestPortfolio,
  paymentImportOnly,
} from "../src/client/monitoring";
import { paypalSubscriptionLinks } from "../src/server/db/schema";
import { startTestApp, type TestApp } from "./helpers";

const subscription = (serviceId: string, extra: Partial<SubscriptionEntry> = {}): SubscriptionEntry => ({
  serviceId,
  name: serviceId,
  amountMinor: 900,
  cycle: "month",
  purpose: "My own requirements",
  source: "paypal",
  ...extra,
});
const portfolio: SubscriptionPortfolio = {
  revision: 3,
  subscriptions: [subscription("first"), subscription("second")],
};
const schedule = (serviceId = "first", extra: Partial<PriceCheckSchedule> = {}): PriceCheckSchedule => ({
  serviceId,
  revision: 1,
  cadence: { every: 1, unit: "week" },
  nextCheckAt: "2026-12-01T18:00:00.000Z",
  lastCheckedAt: null,
  status: "scheduled",
  advice: null,
  ...extra,
});

it("shows actual saved coverage and the earliest next check, excluding foreign and inactive records", () => {
  const status = monitoringStatus(
    {
      ...portfolio,
      subscriptions: [...portfolio.subscriptions, subscription("cancelled", { paypalStatus: "CANCELLED" })],
    },
    [
      schedule(),
      schedule("second", { nextCheckAt: "2026-11-25T18:00:00.000Z" }),
      schedule("foreign"),
      schedule("cancelled"),
    ],
  );
  expect(status).toMatchObject({
    phase: "scheduled",
    count: 2,
    next: { name: "second", at: "2026-11-25T18:00:00.000Z" },
  });
  expect(
    monitoringStatus(portfolio, [schedule("first", { status: "checking", nextCheckAt: null })]).phase,
  ).toBe("checking");
});

it.each(["paused", "budget_reached", "access_needed", "retrying", "needs_details"] as const)(
  "never pulses for %s checks",
  (status) => {
    const state = monitoringStatus(portfolio, [schedule("first", { status })]);
    expect(state.phase).toBe(status === "paused" ? "paused" : "attention");
    const html = renderToStaticMarkup(
      createElement(MonitoringPanel, { shown: true, status: state, onOpen() {} }),
    );
    expect(html).toContain('data-pulsing="false"');
  },
);

it("does not imply monitoring before a schedule exists or when the schedule cannot be confirmed", () => {
  expect(monitoringStatus(portfolio, []).phase).toBe("unset");
  expect(monitoringStatus(portfolio, [schedule("first", { cadence: null })]).count).toBe(0);
  expect(monitoringStatus(portfolio, [schedule("first", { nextCheckAt: "invalid" })]).count).toBe(0);
  expect(monitoringStatus(portfolio, [schedule()], true).phase).toBe("attention");
  expect(
    monitoringStatus(portfolio, [schedule(), schedule("second", { status: "budget_reached" })]).phase,
  ).toBe("attention");
});

it("offers a real schedule from the existing quiet view without pretending checks are active", () => {
  const html = renderToStaticMarkup(
    createElement(MonitoringPanel, {
      shown: true,
      status: monitoringStatus(portfolio, []),
      onOpen() {},
      onStart() {},
    }),
  );
  expect(html).toContain("Start weekly checks");
  expect(html).toContain('data-pulsing="false"');
  expect(html).not.toContain("I’ll keep checking while you’re away");
});

it("keeps the monitoring caption concise while showing the actual next check and provider", () => {
  const status = monitoringStatus(portfolio, [schedule(), schedule("second")]);
  const html = renderToStaticMarkup(createElement(MonitoringPanel, { shown: true, status, onOpen() {} }));
  expect(html).toContain("I’m on it.");
  expect(html).toContain("2 subscriptions monitored");
  expect(html).toContain("Next check");
  expect(html).toContain('dateTime="2026-12-01T18:00:00.000Z"');
  expect(html).toContain("first");
  expect(html).not.toContain("while you’re away");
  expect(html).toContain('data-pulsing="true"');
});

it("recognises newly committed PayPal services without treating edits, manual entries or removals as new imports", () => {
  const known = new Set(portfolio.subscriptions.map((row) => row.serviceId));
  const next = {
    revision: 4,
    subscriptions: [
      subscription("first", { name: "Renamed" }),
      subscription("new-unlisted-product", { purpose: "" }),
      subscription("manual", { source: "manual" }),
      subscription("inactive", { paypalStatus: "SUSPENDED" }),
    ],
  };
  expect(newPayPalSubscriptions(known, next).map((row) => row.serviceId)).toEqual(["new-unlisted-product"]);
  expect(newPayPalSubscriptions(known, { revision: 4, subscriptions: [] })).toEqual([]);
  expect(portfolio.subscriptions[0]!.purpose).toBe("My own requirements");
});

it("ignores delayed reads after a newer confirmed save", () => {
  const newer = { ...portfolio, revision: 5 };
  expect(newestPortfolio(newer, portfolio)).toBe(newer);
  expect(newestPortfolio(portfolio, newer)).toBe(newer);
  expect(newestPortfolio(portfolio, { ...portfolio })).toBe(portfolio);
});

it("retains an unconfirmed proposal across a pure PayPal addition, while keeping conflicts protected", () => {
  const next = {
    revision: 4,
    subscriptions: [...portfolio.subscriptions, subscription("new", { purpose: "" })],
  };
  expect(paymentImportOnly(portfolio, next)).toBe(true);
  expect(
    paymentImportOnly(portfolio, {
      ...next,
      subscriptions: next.subscriptions.map(
        (row) => Object.fromEntries(Object.entries(row).reverse()) as unknown as SubscriptionEntry,
      ),
    }),
  ).toBe(true);
  expect(paymentImportOnly(portfolio, portfolio)).toBe(false);
  expect(paymentImportOnly(portfolio, { ...next, subscriptions: next.subscriptions.slice(1) })).toBe(false);
  expect(
    paymentImportOnly(portfolio, {
      ...next,
      subscriptions: next.subscriptions.map((row) =>
        row.serviceId === "first" ? { ...row, purpose: "Changed in another tab" } : row,
      ),
    }),
  ).toBe(false);
  expect(
    paymentImportOnly(portfolio, {
      ...next,
      subscriptions: [...portfolio.subscriptions, subscription("new", { source: "manual" })],
    }),
  ).toBe(false);
});

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

it("imports a new owner-bound PayPal product, leaves its answers blank and retains earlier confirmed memory", async () => {
  const browser = app.browser();
  await browser.login();
  const ownerId = (await browser.get("/api/session")).body.ownerId;
  const saved = (
    await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: 0,
      subscriptions: [
        {
          serviceId: "spotify",
          amountMinor: 1299,
          cycle: "month",
          purpose: "Offline music for my solo commute; no podcasts.",
        },
      ],
    })
  ).body as SubscriptionPortfolio;
  const customId = randomUUID(),
    planId = "P-MONITORING-TEST",
    productId = "PROD-MONITORING-TEST";
  app.paypal.planPriceMinor.set(planId, 999);
  app.paypal.planProducts.set(planId, productId);
  app.paypal.productNames.set(productId, "Brilliant Premium");
  const remote = await app.ctx.paypal.A!.createSubscription(
    { plan_id: planId, custom_id: customId },
    randomUUID(),
  );
  app.paypal.approve(remote.id);
  const serviceId = `paypal:A:${remote.id}`;
  await app.ctx.db.insert(paypalSubscriptionLinks).values({
    id: randomUUID(),
    ownerId,
    merchant: "A",
    subscriptionId: remote.id,
    planId,
    customId,
    serviceId,
    name: "Brilliant Premium",
  });
  const calls = app.paypal.calls.length;
  const imported = await browser.post("/api/subscriptions/import");
  expect(imported.status).toBe(200);
  const current = (await browser.get("/api/subscriptions")).body as SubscriptionPortfolio;
  const additions = newPayPalSubscriptions(new Set(saved.subscriptions.map((row) => row.serviceId)), current);
  expect(additions).toHaveLength(1);
  expect(additions[0]).toMatchObject({
    serviceId,
    name: "Brilliant Premium",
    source: "paypal",
    purpose: "",
    amountMinor: 999,
  });
  expect(current.subscriptions.find((row) => row.serviceId === "spotify")!.purpose).toBe(
    saved.subscriptions[0]!.purpose,
  );
  expect(
    app.paypal.calls.slice(calls).every((call) => call.method === "GET" || call.path === "/v1/oauth2/token"),
  ).toBe(true);
  expect((await browser.post("/api/subscriptions/import")).body.portfolio).toEqual(current);
  const other = app.browser();
  await other.login();
  expect((await other.get("/api/subscriptions")).body.subscriptions).toEqual([]);
});
