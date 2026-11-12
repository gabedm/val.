import { expect, it } from "vitest";
import { subscriptionReadiness } from "../src/shared/subscription-workflow";
import { readOnboardingProgress } from "../src/client/onboarding-progress";
import { setupComplete } from "../src/client/onboarding-review";
import type { SubscriptionEntry, SubscriptionPortfolio } from "../src/shared/subscriptions";

const entry = (serviceId: string, patch: Partial<SubscriptionEntry> = {}): SubscriptionEntry => ({
  serviceId,
  name: serviceId,
  amountMinor: 1200,
  cycle: "month",
  purpose: "",
  source: "manual",
  ...patch,
});
const portfolio = (subscriptions: SubscriptionEntry[]): SubscriptionPortfolio => ({
  revision: 17,
  subscriptions,
});

it("uses the same saved-memory readiness for restoration and the onboarding handoff", () => {
  for (const rows of [
    [],
    [entry("new")],
    [entry("saved", { purpose: "my own use" })],
    [entry("saved", { purpose: "my own use" }), entry("new")],
  ]) {
    const saved = portfolio(rows);
    const result = subscriptionReadiness(saved);
    expect(readOnboardingProgress(saved)).toEqual({
      confirmed: result.confirmedServiceIds,
      complete: result.phase === "ready",
    });
    expect(setupComplete(saved, [])).toBe(result.phase === "ready");
  }
});

it("retains confirmed needs when a new subscription arrives without confirming the new one", () => {
  const confirmed = entry("unlisted-a", { purpose: "listening while commuting, offline" });
  const before = portfolio([confirmed]);
  expect(subscriptionReadiness(before).phase).toBe("ready");
  const next = { revision: 18, subscriptions: [confirmed, entry("unlisted-b", { purpose: " \n " })] };
  expect(subscriptionReadiness(next)).toEqual({
    revision: 18,
    phase: "collecting_needs",
    confirmedServiceIds: ["unlisted-a"],
    pendingServiceIds: ["unlisted-b"],
    researchableServiceIds: ["unlisted-a"],
    unknownCostServiceIds: [],
  });
});

it("revisits only requested current needs, without erasing the saved purpose", () => {
  const saved = portfolio([
    entry("first", { purpose: "a saved need" }),
    entry("second", { purpose: "another need" }),
  ]);
  const before = JSON.stringify(saved);
  const state = subscriptionReadiness(saved, ["first", "foreign"]);
  expect(state.phase).toBe("collecting_needs");
  expect(state.pendingServiceIds).toEqual(["first"]);
  expect(state.researchableServiceIds).toEqual(["second"]);
  expect(setupComplete(saved, ["first"])).toBe(false);
  state.confirmedServiceIds.push("foreign");
  expect(JSON.stringify(saved)).toBe(before);
});

it("completes confirmed needs with unknown and zero costs, but researches known paid bills only", () => {
  const saved = portfolio([
    entry("unknown", { purpose: "private project", amountMinor: null }),
    entry("free", { purpose: "occasional use", amountMinor: 0 }),
    entry("paid", { purpose: "daily use", amountMinor: 100 }),
  ]);
  expect(subscriptionReadiness(saved)).toEqual({
    revision: 17,
    phase: "ready",
    confirmedServiceIds: ["unknown", "free", "paid"],
    pendingServiceIds: [],
    researchableServiceIds: ["paid"],
    unknownCostServiceIds: ["unknown"],
  });
});

it.each(["inactive", "excluded", "stale"])("does not block on or research an %s PayPal record", (state) => {
  const hidden = entry("hidden", {
    paypalEvidence: {
      key: "test-key",
      merchant: "hidden",
      agreementStatus: state === "inactive" ? "inactive" : "active",
      paymentCount: 2,
      lastPaidOn: "2026-10-01",
      checkedAt: "2026-11-01T00:00:00Z",
      excludedByOwner: state === "excluded",
      recurrenceStale: state === "stale",
    },
  });
  const saved = portfolio([hidden, entry("current", { purpose: "current needs" })]);
  expect(subscriptionReadiness(saved, ["hidden"]).confirmedServiceIds).toEqual(["current"]);
  expect(subscriptionReadiness(saved, ["hidden"]).phase).toBe("ready");
  expect(subscriptionReadiness(portfolio([hidden])).phase).toBe("empty");
});
