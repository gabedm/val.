import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { WalletPaymentReview } from "../src/client/WalletPaymentReview";
import { SubscriptionsDashboard, type PortfolioData } from "../src/client/Subscriptions";
import { portfolioSummary } from "../src/client/portfolio-progress";
import type { SubscriptionPortfolio } from "../src/shared/subscriptions";

const saved: SubscriptionPortfolio = {
  revision: 12,
  subscriptions: [
    {
      serviceId: "outside-catalogue",
      name: "Outside Catalogue",
      source: "paypal",
      amountMinor: 1900,
      cycle: "month",
      purpose: "An earlier saved purpose",
    },
    {
      serviceId: "second",
      name: "Second Service",
      source: "manual",
      amountMinor: 12000,
      cycle: "year",
      purpose: "Earlier needs for second",
    },
    {
      serviceId: "unknown-cost",
      name: "Unknown Cost",
      source: "manual",
      amountMinor: null,
      cycle: "month",
      purpose: "",
    },
  ],
};
const data = (portfolio: SubscriptionPortfolio) =>
  ({ portfolio, catalogue: { catalogue: { services: [] }, logos: {} } }) as unknown as PortfolioData;

it("asks about sparse evidence without preselecting a period, naming the service manually or claiming a recurring bill", () => {
  const html = renderToStaticMarkup(
    createElement(WalletPaymentReview, {
      candidate: {
        key: "private-owner-key",
        merchant: "An unfamiliar service",
        currency: "GBP",
        lastPaymentMinor: 1299,
        reviewRevision: 0,
        paymentCount: 1,
        lastPaidOn: "2026-10-21",
      },
      onChoose: () => {},
    }),
  );
  expect(html).toContain("An unfamiliar service");
  expect(html).toContain("Last PayPal payment:");
  expect(html).toContain("£12.99");
  expect(html).toContain("Every 30 days");
  expect(html).toContain("Not a subscription");
  expect(html).toContain("Skip for now");
  expect(html).not.toContain('aria-pressed="true"');
  expect(html).not.toContain("private-owner-key");
  expect(html).not.toContain("£12.99 / month");
});

it("uses current pattern evidence when revisiting a previously excluded sparse payment", () => {
  const html = renderToStaticMarkup(
    createElement(WalletPaymentReview, {
      candidate: {
        key: "private-owner-key",
        merchant: "An unfamiliar service",
        currency: "GBP",
        lastPaymentMinor: 1499,
        reviewRevision: 1,
        paymentCount: 4,
        lastPaidOn: "2026-10-21",
        choice: "not_recurring",
        historyCycle: "month",
      },
      onChoose: () => {},
    }),
  );
  expect(html).toContain("History suggests payments every month");
  expect(html).toContain("£14.99");
  expect(html).not.toContain("Not enough payment history");
});

it("does not show old totals or remembered needs before the current ingestion supplies records", () => {
  const before = JSON.stringify(saved);
  const summary = portfolioSummary(saved, { phase: "finding", subscriptions: [] }, true, []);
  const dashboard = renderToStaticMarkup(
    createElement(SubscriptionsDashboard, { data: data(summary), finding: true }),
  );
  expect(summary.subscriptions).toEqual([]);
  expect(dashboard).not.toMatch(/£29|£78.26|An earlier saved purpose|Let’s get your subscriptions together/);
  expect(dashboard).toContain("Finding subscriptions…");
  expect(JSON.stringify(saved)).toBe(before);
});

it("updates subscription details from actual received bills and confirmed saves, including yearly and unknown costs", () => {
  const first = portfolioSummary(
    saved,
    { phase: "finding", subscriptions: [saved.subscriptions[0]!] },
    true,
    [],
  );
  expect(first.subscriptions.map((row) => row.name)).toEqual(["Outside Catalogue"]);
  expect(first.subscriptions[0]!.purpose).toBe("");
  expect(
    renderToStaticMarkup(createElement(SubscriptionsDashboard, { data: data(first), finding: true })),
  ).toContain("£19");
  const complete = portfolioSummary(saved, { phase: "ready", subscriptions: [] }, true, [
    "outside-catalogue",
  ]);
  expect(complete.subscriptions.map((row) => !!row.purpose)).toEqual([true, false, false]);
  const dashboard = renderToStaticMarkup(createElement(SubscriptionsDashboard, { data: data(complete) }));
  expect(dashboard.match(/class="portfolio-row"/g)).toHaveLength(3);
  expect(dashboard).toContain("£29");
  expect(dashboard).toContain("Known costs");
  expect(dashboard).toContain("Yearly plans spread over 12 months");
  expect(dashboard).not.toContain("Earlier needs for second");
  expect(saved.subscriptions[1]!.purpose).toBe("Earlier needs for second");
});

it("never promotes a partial failed import to all previously saved records and preserves normal returning memory", () => {
  const failed = portfolioSummary(
    saved,
    { phase: "failed", subscriptions: [saved.subscriptions[0]!] },
    true,
    [],
  );
  expect(failed.subscriptions).toHaveLength(1);
  expect(failed.subscriptions[0]!.purpose).toBe("");
  const dashboard = renderToStaticMarkup(
    createElement(SubscriptionsDashboard, { data: data(failed), ingestionFailed: true }),
  );
  expect(dashboard).toContain("subscriptions found so far");
  expect(dashboard).not.toContain("£29");
  expect(portfolioSummary(saved, null, false, []).subscriptions).toEqual(saved.subscriptions);
  expect(portfolioSummary(saved, { phase: "ready", subscriptions: [] }, false, []).subscriptions).toEqual(
    saved.subscriptions,
  );
});

it("distinguishes inferred recurring payments from active agreements without changing amounts or remembered needs", () => {
  const portfolio: SubscriptionPortfolio = {
    revision: 3,
    subscriptions: ["inferred", "active"].map((status, index) => ({
      ...saved.subscriptions[0]!,
      serviceId: `payment-${index}`,
      paypalEvidence: {
        key: `private-payment-key-${index}`,
        merchant: "Outside Catalogue",
        paymentCount: 3,
        lastPaidOn: "2026-10-08",
        checkedAt: "2026-10-31T19:00:00.000Z",
        agreementStatus: status as "inferred" | "active",
      },
    })),
  };
  const before = JSON.stringify(portfolio);
  const html = renderToStaticMarkup(createElement(SubscriptionsDashboard, { data: data(portfolio) }));
  expect(html).toContain("Recurrence inferred");
  expect(html).not.toContain("private-payment-key");
  expect(html).toContain("future charges may differ");
  expect(html).toContain("£38");
  expect(html).not.toContain("private-payment-key");
  expect(JSON.stringify(portfolio)).toBe(before);
});

it("shows the real thirty-day charge separately from the thirteen-payment yearly budget", () => {
  const portfolio: SubscriptionPortfolio = {
    revision: 1,
    subscriptions: [{ ...saved.subscriptions[0]!, amountMinor: 1000, cycle: "30_days" }],
  };
  const before = JSON.stringify(portfolio);
  const html = renderToStaticMarkup(createElement(SubscriptionsDashboard, { data: data(portfolio) }));
  expect(html).toContain("Average monthly cost");
  expect(html).toContain("£10.83");
  expect(html).toContain("£10 / 30 days");
  expect(html).toContain("thirteen payments over 365 days");
  expect(html).not.toContain("30_days");
  expect(JSON.stringify(portfolio)).toBe(before);
});
