import { afterEach, expect, it, vi } from "vitest";
import { readOnboardingProgress } from "../src/client/onboarding-progress";
import type { SubscriptionPortfolio } from "../src/shared/subscriptions";

const portfolio: SubscriptionPortfolio = {
  revision: 3,
  subscriptions: [
    {
      serviceId: "first",
      name: "First",
      amountMinor: 1299,
      cycle: "month",
      source: "paypal",
      purpose: "A saved personal need",
    },
    { serviceId: "second", name: "Second", amountMinor: 14400, cycle: "year", source: "paypal", purpose: "" },
  ],
};
afterEach(() => vi.unstubAllGlobals());

it("resumes server-confirmed needs in a new tab without a browser marker", () => {
  vi.stubGlobal("sessionStorage", undefined);
  expect(readOnboardingProgress(portfolio)).toEqual({ confirmed: ["first"], complete: false });
  expect(readOnboardingProgress({ ...portfolio, subscriptions: [portfolio.subscriptions[0]!] })).toEqual({
    confirmed: ["first"],
    complete: true,
  });
});

it.each(["missing", "unavailable", "malformed", "another-owner", "old-run", "forged-complete"])(
  "does not let %s browser state erase saved memory or confirm an unanswered need",
  (state) => {
    const read = vi.fn(() => {
      if (state === "unavailable") throw new Error("unavailable");
      return state === "missing"
        ? null
        : JSON.stringify({ version: 1, run: state, confirmed: ["second", "foreign"], complete: true });
    });
    vi.stubGlobal("sessionStorage", { getItem: read, setItem: vi.fn() });
    expect(readOnboardingProgress(portfolio)).toEqual({ confirmed: ["first"], complete: false });
    expect(read).not.toHaveBeenCalled();
  },
);

it("leaves newly imported subscriptions unanswered while retaining existing confirmed needs", () => {
  const complete = { ...portfolio, subscriptions: [portfolio.subscriptions[0]!] };
  expect(readOnboardingProgress(complete).complete).toBe(true);
  expect(readOnboardingProgress(portfolio)).toEqual({ confirmed: ["first"], complete: false });
});

it("does not skip fresh empty or imported portfolios", () => {
  expect(readOnboardingProgress({ revision: 0, subscriptions: [] })).toEqual({
    confirmed: [],
    complete: false,
  });
  expect(
    readOnboardingProgress({
      ...portfolio,
      subscriptions: portfolio.subscriptions.map((row) => ({ ...row, purpose: " " })),
    }),
  ).toEqual({ confirmed: [], complete: false });
});

it("does not mutate saved needs or persist customer data to browser storage", () => {
  const write = vi.fn();
  vi.stubGlobal("sessionStorage", { setItem: write });
  const before = JSON.stringify(portfolio);
  readOnboardingProgress(portfolio).confirmed.push("second");
  expect(JSON.stringify(portfolio)).toBe(before);
  expect(write).not.toHaveBeenCalled();
});
