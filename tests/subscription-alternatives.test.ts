import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { SubscriptionAdvice } from "../src/shared/subscriptions";
import type { PortfolioData } from "../src/client/Subscriptions";
import { SubscriptionAlternatives } from "../src/client/SubscriptionAlternatives";
import { DeploymentContext } from "../src/client/deployment";

const data = {
  portfolio: { revision: 7, subscriptions: [] },
  catalogue: { catalogue: { services: [] }, logos: {} },
} as unknown as PortfolioData;
const offer: NonNullable<SubscriptionAdvice["comparisons"]>[number] = {
  serviceId: "unlisted-offer",
  name: "Unlisted provider",
  plan: "Individual",
  owned: false,
  priceMinor: 900,
  priceUnit: "month",
  monthlyMinor: 900,
  annualMinor: 10800,
  savingMonthlyMinor: 700,
  savingAnnualMinor: 8400,
  checkedOn: "2026-11-12",
  fit: "conditional",
  fitCondition: "Only two devices can download at once.",
  sources: ["https://provider.example/plans", "https://provider.example/terms"],
};
const advice: SubscriptionAdvice = {
  summary: "Long general explanation.",
  options: [{ serviceId: offer.serviceId, reason: "Full supporting explanation." }],
  uncertainties: ["Some providers were unavailable."],
  comparisons: [offer],
};
const render = (value = advice, historical = false) =>
  renderToStaticMarkup(
    createElement(
      DeploymentContext,
      {
        value: {
          passwordAccess: false,
          financialTools: false,
          paypalIdentityEnvironment: "sandbox",
          kernelSwitching: { environment: "live", testOrigins: [], preparationOnly: true },
        },
      },
      createElement(SubscriptionAlternatives, {
        advice: value,
        serviceId: "owner-subscription",
        data,
        historical,
        onRetry() {},
      }),
    ),
  );
const withOffer = (patch: Partial<typeof offer>) => ({ ...advice, comparisons: [{ ...offer, ...patch }] });

it("keeps the real price, saving and material condition beside Switch without the removed boilerplate", () => {
  const html = render();
  expect(html).toContain("£9");
  expect(html).toContain("£84 less over 12 months");
  expect(html).toContain('aria-label="Switch to Unlisted provider"');
  const disclosure = html.indexOf('<details class="alternative-details">');
  expect(html.indexOf(offer.fitCondition!)).toBeLessThan(disclosure);
  expect(html.indexOf("Full supporting explanation.")).toBeGreaterThan(disclosure);
  expect(html).toContain('href="https://provider.example/terms"');
  expect(html).not.toMatch(
    /What to check|Prices may have changed|Based on the providers|Refresh prices|AI-read prices|Long general explanation/,
  );
});

it("keeps annual and prepaid charges whole, with their renewal and upfront fees visible before the disclosure", () => {
  const prepaid = render(
    withOffer({
      priceUnit: "prepaid",
      priceMinor: 4800,
      prepaid: { initialMonths: 24, renewalMonths: 12 },
      renewalMinor: 6000,
      upfrontMinor: 1500,
      minimumTermMonths: 24,
    }),
  );
  const visible = prepaid.split('<details class="alternative-details">')[0]!;
  expect(visible).toContain("£48");
  expect(visible).toContain("first 24 months");
  expect(visible).toContain("then £60 every 12 months");
  expect(visible).toContain("£15 setup fee");
  expect(visible).toContain("24-month minimum");
  const yearly = render(withOffer({ priceUnit: "year", priceMinor: 10800 }));
  expect(yearly).toContain("£108");
  expect(yearly).toContain("/ year");
});

it("keeps introductory, scheduled and thirty-day billing changes distinct", () => {
  const html = render(
    withOffer({
      priceUnit: "30_days",
      introductoryCycles: 3,
      renewalMinor: 1100,
      scheduledChanges: [{ on: "2027-04-01", priceMinor: 1200 }],
    }),
  );
  expect(html).toContain("/ 30 days");
  expect(html).toContain("First 3 payments · then £11 / 30 days");
  expect(html).toContain("1 Apr 2027");
  expect(html).toContain("£12 / 30 days");
  expect(html).toContain("13 payments");
});

it("does not manufacture pound savings or hide an estimated source quote", () => {
  const html = render(
    withOffer({
      currency: "EUR",
      priceMinor: 500,
      savingAnnualMinor: null,
      savingMonthlyMinor: null,
      priceEstimated: true,
      priceQuote: "Five euros billed each month.",
    }),
  );
  expect(html).toContain("€5");
  expect(html).toContain("GBP cost and savings unverified");
  expect(html).toContain("Five euros billed each month.");
  expect(html).not.toContain("£84");
});

it("keeps already-owned services distinct from a new purchase, including free offers", () => {
  const owned = render(withOffer({ owned: true }));
  expect(owned).toContain("Already yours");
  expect(owned).toContain("Existing bill continues");
  expect(owned).not.toContain('aria-label="Switch');
  const free = render(withOffer({ priceMinor: 0, annualMinor: 0 }));
  expect(free).toContain("£0");
  expect(free).toContain("12-month cost");
});

it("preserves incomplete and no-match outcomes instead of presenting missing research as success", () => {
  const incomplete = render({ summary: "No match", options: [], uncertainties: [] });
  expect(incomplete).toContain("This check couldn’t finish");
  expect(incomplete).toContain("Try again");
  expect(incomplete).not.toContain("No cheaper match found");
  const complete = render({
    summary: "No match",
    options: [],
    uncertainties: [],
    discovery: {
      checkedAt: "2026-11-12T12:00:00Z",
      status: "live",
      providerOnly: true,
      uncertainties: [],
      coverage: { discovered: ["provider"], checked: ["provider"], incomplete: [] },
    },
  });
  expect(complete).toContain("No cheaper match found");
  expect(complete).not.toContain("Try again");
});
