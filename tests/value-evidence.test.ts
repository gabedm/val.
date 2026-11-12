import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { ValueComparison } from "../src/client/ValConversation";
import type { PortfolioData } from "../src/client/Subscriptions";
import type { SubscriptionAdvice } from "../src/shared/subscriptions";
import { SearchAttributions } from "../src/client/SearchAttributions";

it("omits new and saved Google suggestion HTML under the eligible display option", () => {
  const widget = '<div class="native-widget">A native provider widget</div>';
  const html = renderToStaticMarkup(createElement(SearchAttributions, { items: [widget, widget] }));
  expect(html).toBe("");
  const details = renderToStaticMarkup(
    createElement(SearchAttributions, { items: [widget], children: "Known charges and fees" }),
  );
  expect(details).toContain("Known charges and fees");
  expect(details).not.toContain("iframe");
  expect(details).not.toContain("native-widget");
});

it("shows selected decision details and provider links without the full feature inventory", () => {
  const advice: SubscriptionAdvice = {
    summary: "Fits your saved use.",
    options: [{ serviceId: "provider:notes", reason: "Works in the browser you use." }],
    uncertainties: [],
    comparisons: [
      {
        serviceId: "provider:notes",
        name: "Notes provider",
        plan: "Free",
        owned: false,
        monthlyMinor: 0,
        savingMonthlyMinor: 500,
        priceMinor: 0,
        priceUnit: "month",
        annualMinor: 0,
        savingAnnualMinor: 600,
        checkedOn: "2026-11-08",
        sources: ["https://example.com/pricing"],
        conditions: ["No enterprise administration", "Saved copies are kept for thirty days"],
        highlights: ["Saved copies are kept for thirty days"],
      },
    ],
  };
  const data = {
    portfolio: { revision: 1, subscriptions: [] },
    catalogue: { catalogue: { services: [] }, logos: {} },
  } as unknown as PortfolioData;
  const html = renderToStaticMarkup(
    createElement(ValueComparison, { advice, data, pending: false, onRefresh: () => {} }),
  );
  expect(html).toContain("Saved copies are kept for thirty days");
  expect(html).not.toContain("No enterprise administration");
  expect(html).not.toContain("12-month cost: £0");
  expect(html).toContain("Provider details");
  expect(html).toContain('href="https://example.com/pricing"');
});

it.each(["live", "cached"] as const)(
  "discloses %s extraction limits even when no quotation is supplied",
  (status) => {
    const advice: SubscriptionAdvice = {
      summary: "An alternative for the saved need.",
      options: [{ serviceId: "provider:music", reason: "Offline listening on Android." }],
      uncertainties: [],
      discovery: { status, checkedAt: new Date().toISOString(), providerOnly: true, uncertainties: [] },
      comparisons: [
        {
          serviceId: "provider:music",
          name: "Music provider",
          plan: "Individual",
          currency: "GBP",
          owned: false,
          monthlyMinor: 1199,
          priceMinor: 1199,
          priceUnit: "month",
          annualMinor: 14388,
          savingAnnualMinor: 1200,
          savingMonthlyMinor: 100,
          checkedOn: "2026-11-06",
          sources: ["https://example.com/pricing"],
        },
      ],
    };
    const data = {
      portfolio: { revision: 1, subscriptions: [] },
      catalogue: { catalogue: { services: [] }, logos: {} },
    } as unknown as PortfolioData;
    const html = renderToStaticMarkup(
      createElement(ValueComparison, { advice, data, pending: false, onRefresh: () => {} }),
    );
    expect(html).toContain("not independently verified");
    expect(html).toContain("Confirm provider terms before switching");
    expect(html).toContain('href="https://example.com/pricing"');
    expect(html).not.toContain("Price passage returned by research");
  },
);
