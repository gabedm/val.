import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type {
  SubscriptionAdvice,
  SubscriptionEntry,
  SubscriptionPortfolio,
  SubscriptionReviewBatch,
} from "../src/shared/subscriptions";
import { researchOrbs, researchSceneVisible } from "../src/client/research-scene";
import { MonitoringPanel } from "../src/client/MonitoringPanel";
import { monitoringStatus } from "../src/client/monitoring";

const row = (serviceId: string): SubscriptionEntry => ({
  serviceId,
  name: serviceId,
  source: "paypal",
  amountMinor: 1200,
  cycle: "month",
  purpose: "The requirements I confirmed.",
});
const portfolio: SubscriptionPortfolio = {
  revision: 4,
  subscriptions: [row("a completely new service"), row("other-service"), row("last-service")],
};
const batch: SubscriptionReviewBatch = {
  revision: 4,
  serviceIds: portfolio.subscriptions.map((row) => row.serviceId),
  completed: [],
  failed: [],
  status: "running",
  currentServiceId: "other-service",
};
const advice: SubscriptionAdvice = { summary: "Saved comparison", options: [], uncertainties: [] };
const ready = {
  selected: true,
  introduced: true,
  ready: true,
  specificService: false,
  pending: false,
  proposal: false,
  failure: false,
  reviewFailure: false,
};

it("enters the scene during initial research, but never before confirmed needs or while a proposal needs approval", () => {
  expect(researchSceneVisible({ ...ready, pending: true, operation: "setup" })).toBe(true);
  for (const change of [
    { ready: false },
    { introduced: false },
    { proposal: true },
    { specificService: true },
    { selected: false },
    { pending: true, operation: "chat" },
  ])
    expect(researchSceneVisible({ ...ready, ...change })).toBe(false);
});

it("returns to the full chat for a new subscription and keeps recoverable research failures in the scene", () => {
  expect(researchSceneVisible({ ...ready, ready: false })).toBe(false);
  expect(researchSceneVisible({ ...ready, failure: true, reviewFailure: true })).toBe(true);
  expect(researchSceneVisible({ ...ready, failure: true })).toBe(false);
});

it("uses current owned batch IDs for progress, without interpreting a different revision as current research", () => {
  expect(researchOrbs(portfolio, [], batch, true, false).map((orb) => orb.state)).toEqual([
    "queued",
    "checking",
    "queued",
  ]);
  expect(
    researchOrbs(portfolio, [], { ...batch, revision: 3 }, true, false).every(
      (orb) => orb.state === "queued",
    ),
  ).toBe(true);
});

it("does not mistake a partial check, failed check, or previous result for a verified cheaper offer", () => {
  const findings = [
    { row: portfolio.subscriptions[0]!, advice },
    { row: portfolio.subscriptions[1]!, advice, historicalCheckedAt: "2026-11-01" },
  ];
  const orbs = researchOrbs(
    portfolio,
    findings,
    { ...batch, status: "failed", failed: ["last-service"] },
    false,
    true,
  );
  expect(orbs.map((orb) => orb.label)).toEqual(["Partial results", "Previous check", "Check interrupted"]);
  expect(orbs.every((orb) => orb.available)).toBe(true);
});

it("keeps finished results available during a pause and does not animate queued checks as running", () => {
  const orbs = researchOrbs(
    portfolio,
    [{ row: portfolio.subscriptions[0]!, advice }],
    { ...batch, status: "paused" },
    false,
    true,
  );
  expect(orbs.map((orb) => orb.state)).toEqual(["incomplete", "paused", "paused"]);
  expect(orbs.map((orb) => orb.available)).toEqual([true, false, false]);
});

it("shows the active retry while keeping its previous result accessible", () => {
  const orbs = researchOrbs(portfolio, [{ row: portfolio.subscriptions[1]!, advice }], batch, true, false);
  expect(orbs[1]).toMatchObject({ state: "checking", available: true, label: "Checking offers" });
  const html = renderToStaticMarkup(
    createElement(MonitoringPanel, {
      shown: true,
      status: monitoringStatus(portfolio, []),
      orbs,
      researching: true,
      onOpen() {},
    }),
  );
  expect(html).toContain('aria-label="Your journey"');
  expect(html).toContain('aria-current="step"');
  expect(html).toContain("Checking other-service");
  expect(html).toContain('data-completing="false"');
  expect(html).not.toContain("Comparisons ready");
  expect(html).not.toContain("Start weekly checks");
});

it("only advertises alternatives that were actually admitted", () => {
  const value = {
    ...advice,
    options: [{ serviceId: "different-provider", reason: "Meets saved needs" }],
    comparisons: [{ serviceId: "different-provider" }],
  } as SubscriptionAdvice;
  expect(
    researchOrbs(portfolio, [{ row: portfolio.subscriptions[0]!, advice: value }], batch, true, false)[0],
  ).toMatchObject({ state: "ready", label: "See alternatives", available: true });
  expect(
    researchOrbs(
      portfolio,
      [{ row: portfolio.subscriptions[0]!, advice: { ...value, comparisons: [] } }],
      batch,
      true,
      false,
    )[0]?.state,
  ).toBe("incomplete");
});

it("renders every subscription, keeps unknown costs actionable, and excludes cancelled agreements", () => {
  const many = {
    revision: 4,
    subscriptions: [
      ...Array.from({ length: 15 }, (_, index) => row(`service-${index}`)),
      { ...row("missing-cost"), amountMinor: null },
      { ...row("cancelled"), paypalStatus: "CANCELLED" as const },
    ],
  };
  const orbs = researchOrbs(many, [], null, true, false);
  expect(orbs).toHaveLength(16);
  expect(orbs.at(-1)).toMatchObject({ state: "needs_details", available: true });
  const html = renderToStaticMarkup(
    createElement(MonitoringPanel, {
      shown: true,
      status: monitoringStatus(many, []),
      orbs,
      researching: true,
      onOpen() {},
    }),
  );
  expect(html).toContain("service-14");
  expect(html).toContain("is-dense");
  expect(html).toContain('data-pulsing="true"');
  expect(html).not.toContain("subscriptions monitored");
  expect(html).not.toContain("Start weekly checks");
});
