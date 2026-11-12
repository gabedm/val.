import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { comparisonOutcome } from "../src/shared/subscription-insights";
import type { SubscriptionAdvice } from "../src/shared/subscriptions";
import type { PortfolioData } from "../src/client/Subscriptions";
import { SavedReviewCard } from "../src/client/SubscriptionInsights";
import { ValueComparison } from "../src/client/ValConversation";

const base: SubscriptionAdvice = {
  summary: "No cheaper match established.",
  options: [],
  uncertainties: [],
  basedOn: { serviceId: "unlisted", purpose: "Offline map access on my old phone; no annual commitment." },
  discovery: {
    status: "live",
    providerOnly: true,
    checkedAt: new Date().toISOString(),
    uncertainties: [],
    coverage: { discovered: ["provider.example"], checked: ["provider.example"], incomplete: [] },
  },
};
const data = {
  portfolio: {
    revision: 1,
    subscriptions: [{ serviceId: "unlisted", name: "Unlisted maps", purpose: base.basedOn!.purpose }],
  },
  catalogue: { catalogue: { services: [] }, logos: {} },
} as unknown as PortfolioData;
const render = (advice: SubscriptionAdvice) =>
  renderToStaticMarkup(createElement(ValueComparison, { advice, data, pending: false, onRefresh() {} }));

it.each([
  "No complete current provider price was established for this need.",
  "Some candidate provider websites could not be read.",
  "The local-currency recurring price remains unverified.",
])(
  "retains incomplete research confidence even when all visited domains are marked checked: %s",
  (warning) => {
    const advice = { ...base, discovery: { ...base.discovery!, uncertainties: [warning] } };
    expect(comparisonOutcome(advice)).toBe("incomplete");
    expect(render(advice)).toContain("This check is incomplete.");
    expect(render(advice)).not.toContain(base.summary);
  },
);

it("separates a completed no-match check from a partial, failed or unestablished check", () => {
  expect(comparisonOutcome(base)).toBe("no_match");
  for (const discovery of [
    undefined,
    { ...base.discovery!, pendingProviders: ["provider.example"] },
    { ...base.discovery!, status: "fallback" as const },
    {
      ...base.discovery!,
      coverage: { discovered: ["provider.example"], checked: [], incomplete: ["provider.example"] },
    },
  ]) {
    const advice = { ...base, discovery };
    expect(comparisonOutcome(advice)).toBe("incomplete");
    const html = render(advice);
    expect(html).toContain("This check is incomplete.");
    expect(html).not.toContain("No cheaper match established.");
    const card = renderToStaticMarkup(
      createElement(SavedReviewCard, {
        review: { serviceId: "unlisted", advice, checkedAt: new Date().toISOString(), historical: false },
        data,
      }),
    );
    expect(card).toContain("This check couldn’t finish");
    expect(card).not.toContain("No suitable cheaper option found in this check");
  }
});

it("brings the saved need, potential whole-year saving and real fit condition ahead of expanded details", () => {
  const advice: SubscriptionAdvice = {
    ...base,
    summary: "An option for your saved use.",
    options: [{ serviceId: "provider:maps", reason: "Offline maps on older phones." }],
    comparisons: [
      {
        serviceId: "provider:maps",
        name: "Another maps provider",
        plan: "Monthly",
        owned: false,
        currency: "GBP",
        priceMinor: 500,
        priceUnit: "month",
        monthlyMinor: 500,
        annualMinor: 6000,
        savingAnnualMinor: 3600,
        savingMonthlyMinor: 300,
        checkedOn: "2026-11-09",
        sources: ["https://provider.example/pricing"],
        fit: "conditional",
        fitCondition: "Confirm your phone runs the supported operating-system version.",
      },
    ],
  };
  const html = render(advice);
  expect(html).toContain(base.basedOn!.purpose);
  expect(html.indexOf("Potential £36 less over 12 months")).toBeLessThan(
    html.indexOf("Offline maps on older phones."),
  );
  expect(html).toContain("not independently verified");
  const card = renderToStaticMarkup(
    createElement(SavedReviewCard, {
      review: { serviceId: "unlisted", advice, checkedAt: new Date().toISOString(), historical: false },
      data,
    }),
  );
  expect(card.indexOf("Potential £36 less over 12 months")).toBeLessThan(card.indexOf("<summary>"));
  expect(card.indexOf("Conditional fit:")).toBeLessThan(card.indexOf("<summary>"));
  expect(card.indexOf(base.basedOn!.purpose)).toBeLessThan(card.indexOf("<summary>"));
  expect(
    render({
      ...advice,
      comparisons: [
        { ...advice.comparisons![0]!, currency: "USD", savingAnnualMinor: null, savingMonthlyMinor: null },
      ],
    }),
  ).not.toContain("Potential £36");
});
