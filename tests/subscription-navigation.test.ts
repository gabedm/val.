import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  activeProductTab,
  chatTarget,
  mainTabs,
  productRoute,
  subscriptionChatPath,
  subscriptionPath,
  subscriptionTarget,
} from "../src/client/navigation";
import { SubscriptionDetailContent } from "../src/client/SubscriptionDetail";
import { SubscriptionsDashboard, type PortfolioData } from "../src/client/Subscriptions";
import type { SubscriptionInsights } from "../src/shared/subscription-insights";
import type { InsightState } from "../src/client/use-subscription-insights";

const serviceId = "paypal:merchant:unlisted/product";
const data: PortfolioData = {
  portfolio: {
    revision: 7,
    subscriptions: [
      {
        serviceId,
        name: "Outside Catalogue",
        source: "paypal",
        purpose: "Download lectures for a rural commute.",
        amountMinor: 1800,
        cycle: "month",
        paypalEvidence: {
          key: "private-evidence-key",
          merchant: "Outside Catalogue",
          paymentCount: 3,
          lastPaidOn: "2026-11-01",
          agreementStatus: "inferred",
          checkedAt: "2026-11-11T10:00:00Z",
          cycleBasis: "owner_confirmation",
        },
      },
      {
        serviceId: "other",
        name: "Another subscription",
        source: "manual",
        purpose: "A different private requirement",
        amountMinor: null,
        cycle: "year",
      },
    ],
  },
  catalogue: {
    catalogue: JSON.parse(
      readFileSync(new URL("../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
    ),
    logos: {},
  },
};
const value: SubscriptionInsights = {
  revision: 7,
  batch: null,
  moreActivity: false,
  reviews: [
    {
      serviceId,
      historical: false,
      checkedAt: "2026-11-11T10:00:00Z",
      advice: {
        summary: "An offline alternative for your commute.",
        options: [{ serviceId: "option", reason: "Downloads are supported." }],
        uncertainties: [],
        comparisons: [
          {
            serviceId: "option",
            name: "Alternative Library",
            plan: "Individual",
            owned: false,
            priceMinor: 900,
            priceUnit: "month",
            monthlyMinor: 900,
            savingMonthlyMinor: 900,
            annualMinor: 10800,
            savingAnnualMinor: 10800,
            sources: ["https://provider.example/plans"],
            checkedOn: "2026-11-11",
          },
        ],
      },
    },
  ],
  schedules: [
    {
      serviceId,
      revision: 2,
      cadence: { every: 2, unit: "week" },
      status: "scheduled",
      nextCheckAt: "2026-11-25T10:00:00Z",
      lastCheckedAt: "2026-11-11T10:00:00Z",
      advice: null,
    },
  ],
  activity: [
    {
      id: "one",
      serviceId,
      name: "Outside Catalogue",
      checkedAt: "2026-11-11T10:00:00Z",
      outcome: "alternatives",
      alternatives: 1,
      available: true,
    },
    {
      id: "two",
      serviceId: "other",
      name: "Another subscription",
      checkedAt: "2026-11-10T10:00:00Z",
      outcome: "incomplete",
      alternatives: 0,
      available: true,
    },
  ],
};
const ready = (insights = value): InsightState => ({ phase: "ready", value: insights });
const detail = (state: InsightState = ready(), portfolio = data, id = serviceId) =>
  renderToStaticMarkup(
    createElement(SubscriptionDetailContent, { id, data: portfolio, state, onRetry() {}, onReload() {} }),
  );

it("has exactly three stable main destinations and migrates old bookmarks", () => {
  expect(mainTabs.map(([id, label]) => [id, label])).toEqual([
    ["home", "Val"],
    ["subscriptions", "Subscriptions"],
    ["account", "Account"],
  ]);
  for (const publicBuild of [false, true]) {
    expect(productRoute("discover", null, false, publicBuild)).toBe("subscriptions");
    expect(productRoute("you", null, false, publicBuild)).toBe("account");
    expect(productRoute("account", null, false, publicBuild)).toBe("account");
  }
  for (const route of [subscriptionPath(serviceId), "browse", "service/spotify", "activity"])
    expect(activeProductTab(route)).toBe("subscriptions");
  expect(activeProductTab("account")).toBe("account");
});

it("round-trips owner service references and distinguishes chat intents without catalogue assumptions", () => {
  expect(subscriptionTarget(subscriptionPath(serviceId))).toBe(serviceId);
  for (const intent of [undefined, "needs", "monitoring"] as const) {
    const route = subscriptionChatPath(serviceId, intent);
    expect(productRoute(route, null, false, true)).toBe(route);
    expect(chatTarget(route)).toEqual({ serviceId, ...(intent ? { intent } : {}) });
    expect(activeProductTab(route)).toBe("home");
  }
  for (const route of [
    "subscription/%ZZ",
    "subscription/",
    "val/%ZZ",
    "val/short/unknown",
    "val/short/needs/extra",
  ])
    expect(productRoute(route, null, false, true)).toBe("subscriptions");
});

it("keeps the current bill, owned needs, provider evidence, alternatives and monitoring together", () => {
  const html = detail();
  for (const label of [
    "Your subscription",
    "Your needs",
    "Alternatives",
    "Monitoring",
    "Download lectures for a rural commute.",
    "Alternative Library",
    "Every 2 weeks",
    "25 Nov",
  ])
    expect(html).toContain(label);
  expect(html).toContain("£18");
  expect(html).toContain("Recurring pattern · agreement unverified");
  expect(html).toContain("Billing frequency confirmed by you");
  expect(html).toContain('href="https://provider.example/plans"');
  expect(html).not.toMatch(/A different private requirement|private-evidence-key|Another subscription/);
  expect(html.indexOf('id="subscription-alternatives"')).toBeLessThan(
    html.indexOf('id="subscription-needs"'),
  );
  expect(html.indexOf('id="subscription-alternatives"')).toBeLessThan(
    html.indexOf('id="subscription-monitoring"'),
  );
});

it("keeps historical evidence clearly dated and does not show saved alternatives before needs are confirmed", () => {
  const historical = structuredClone(value);
  historical.reviews[0]!.historical = true;
  expect(detail(ready(historical))).toContain("Previous check");
  expect(detail(ready(historical))).not.toContain("Prices may have changed");
  const unanswered = structuredClone(data);
  unanswered.portfolio.subscriptions[0]!.purpose = "";
  const html = detail(ready(), unanswered);
  expect(html).not.toContain("Alternative Library");
  expect(html).toContain("Tell Val what you need to start comparing");
});

it("separates loading, unavailable research, missing cost and a genuine incomplete check", () => {
  expect(detail({ phase: "loading" })).not.toContain("Alternative Library");
  const failed = detail({ phase: "error", needsReload: true, message: "Your subscriptions changed." });
  expect(failed).toContain("Reload subscriptions");
  expect(failed).not.toContain("No recurring price check");
  const incomplete = structuredClone(value);
  incomplete.reviews[0]!.advice = {
    summary: "Research was interrupted.",
    options: [],
    uncertainties: ["Provider terms were unavailable."],
  };
  expect(detail(ready(incomplete))).toContain("This check couldn’t finish.");
  expect(detail(ready(incomplete))).not.toContain("No suitable cheaper option found");
  const costUnknown = structuredClone(data);
  costUnknown.portfolio.subscriptions[0]!.amountMinor = null;
  expect(detail(ready({ ...value, reviews: [] }), costUnknown)).toContain("Add your cost to compare prices");
});

it.each(["paused", "checking", "needs_details", "retrying", "access_needed", "budget_reached"] as const)(
  "retains the actual %s schedule state in subscription detail",
  (status) => {
    const changed = structuredClone(value);
    changed.schedules[0]!.status = status;
    if (status === "paused") {
      changed.schedules[0]!.cadence = null;
      changed.schedules[0]!.nextCheckAt = null;
    }
    const html = detail(ready(changed));
    const labels = {
      paused: "Paused",
      checking: "Checking prices",
      needs_details: "Needs your details",
      retrying: "Waiting to retry",
      access_needed: "Access needed",
      budget_reached: "AI allowance reached",
    };
    expect(html).toContain(labels[status]);
    expect(html).toContain("Edit schedule");
  },
);

it("handles removed and foreign references without rendering another product's results", () => {
  expect(detail(ready(), data, "foreign")).toContain("Subscription unavailable");
  const archived = structuredClone(data);
  archived.portfolio.subscriptions[0]!.paypalStatus = "CANCELLED";
  expect(detail(ready(), archived)).not.toContain("Alternative Library");
  expect(detail(ready(), data, "other")).not.toContain("Alternative Library");
});

it("shows saved comparison value on the list without duplicating Account content or inventing research", () => {
  const html = renderToStaticMarkup(createElement(SubscriptionsDashboard, { data, insights: ready() }));
  expect(html).toContain("Potential £108 less over 12 months");
  expect(html).toContain("Check activity");
  expect(html).not.toContain("Browse the catalogue");
  expect(html).not.toMatch(/Privacy and data|Log out|Restore on this browser/);
  const loading = renderToStaticMarkup(
    createElement(SubscriptionsDashboard, { data, insights: { phase: "loading" } }),
  );
  expect(loading).not.toContain("Potential £108");
});
