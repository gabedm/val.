import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CatalogueBrowser } from "../src/client/Discover";
import { SubscriptionDetailContent } from "../src/client/SubscriptionDetail";
import { SavedReviewCard } from "../src/client/SubscriptionInsights";
import { ActivityContent } from "../src/client/SubscriptionActivity";
import { SubscriptionSwitchAction, SubscriptionsDashboard } from "../src/client/Subscriptions";
import { DeploymentContext } from "../src/client/deployment";
import type { PortfolioData } from "../src/client/Subscriptions";
import type { SubscriptionInsights } from "../src/shared/subscription-insights";
import type { InsightState } from "../src/client/use-subscription-insights";

const data: PortfolioData = {
  portfolio: {
    revision: 8,
    subscriptions: [
      {
        serviceId: "unlisted-audio",
        name: "Unlisted Audio",
        source: "manual",
        amountMinor: 1600,
        cycle: "month",
        purpose: "offline listening while cycling",
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
const insights: SubscriptionInsights = {
  revision: 8,
  schedules: [],
  batch: null,
  activity: [],
  moreActivity: false,
  reviews: [
    {
      serviceId: "unlisted-audio",
      checkedAt: "2026-11-08T12:00:00Z",
      historical: false,
      advice: {
        summary: "A match for your offline listening.",
        options: [{ serviceId: "outside-option", reason: "Your offline requirement is supported." }],
        uncertainties: [],
        comparisons: [
          {
            serviceId: "outside-option",
            name: "Another Audio",
            plan: "Individual",
            owned: false,
            priceMinor: 900,
            priceUnit: "month",
            monthlyMinor: 900,
            savingMonthlyMinor: 700,
            annualMinor: 10800,
            savingAnnualMinor: 8400,
            checkedOn: "2026-11-08",
            sources: ["https://provider.example/plans"],
          },
        ],
      },
    },
  ],
};

it("excludes cancelled, suspended and stale bills from the current subscription list and total without deleting history", () => {
  const row = data.portfolio.subscriptions[0]!;
  const inactive = [
    {
      ...row,
      serviceId: "ended",
      name: "Ended provider",
      providerState: {
        switchId: "previous",
        status: "cancelled" as const,
        verifiedAt: "2026-11-12T00:00:00Z",
      },
    },
    { ...row, serviceId: "suspended", name: "Suspended bill", paypalStatus: "SUSPENDED" as const },
    {
      ...row,
      serviceId: "stale",
      name: "Stale bill",
      paypalEvidence: {
        key: "old",
        merchant: "Previous",
        paymentCount: 2,
        lastPaidOn: "2026-10-01",
        checkedAt: "2026-11-01T00:00:00Z",
        agreementStatus: "inferred" as const,
        recurrenceStale: true,
      },
    },
  ];
  const portfolio = { ...data.portfolio, subscriptions: [row, ...inactive] };
  const html = renderToStaticMarkup(createElement(SubscriptionsDashboard, { data: { ...data, portfolio } }));
  expect(html).toContain("£16");
  expect(html).not.toContain("£64");
  for (const previous of inactive) expect(html).not.toContain(previous.name);
  expect(portfolio.subscriptions).toHaveLength(4);
});
const ready = (value: SubscriptionInsights): InsightState => ({ phase: "ready", value });
const dashboard = (value: SubscriptionInsights) =>
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
      createElement(SubscriptionsDashboard, { data, insights: ready(value) }),
    ),
  );
const detail = (state: InsightState, portfolio = data) =>
  renderToStaticMarkup(
    createElement(SubscriptionDetailContent, {
      id: "unlisted-audio",
      data: portfolio,
      state,
      onRetry() {},
      onReload() {},
    }),
  );
const activity = (value: SubscriptionInsights) =>
  renderToStaticMarkup(
    createElement(ActivityContent, { data, state: ready(value), onRetry() {}, onReload() {} }),
  );

it("leads with alternatives, keeps saved needs and payment facts in a disclosure and starts switching from older results", () => {
  const value = structuredClone(insights);
  value.reviews[0]!.historical = true;
  const html = renderToStaticMarkup(
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
      createElement(SubscriptionDetailContent, {
        id: "unlisted-audio",
        data,
        state: ready(value),
        onRetry() {},
        onReload() {},
      }),
    ),
  );
  expect(html.indexOf('id="subscription-alternatives"')).toBeLessThan(
    html.indexOf('id="subscription-needs"'),
  );
  expect(html).toContain('<details class="subscription-context detail-section">');
  expect(html).toContain('aria-label="Switch to Another Audio"');
  expect(html).toContain("Provider details");
  expect(html).toContain("offline listening while cycling");
});

it("names a provider once while retaining its separate monthly and annual plans", () => {
  const value = structuredClone(insights);
  const advice = value.reviews[0]!.advice;
  advice.comparisons![0]!.plan = "Monthly";
  advice.comparisons!.push({ ...advice.comparisons![0]!, serviceId: "annual-option", plan: "Annual" });
  advice.options.push({ serviceId: "annual-option", reason: "A different billing commitment." });
  const html = renderToStaticMarkup(createElement(SavedReviewCard, { review: value.reviews[0]!, data }));
  expect(html.match(/class="insight-summary">([^<]+)/)?.[1]).toBe("Another Audio");
  expect(html).toContain("Monthly");
  expect(html).toContain("Annual");
});

it("keeps personalised results in the subscription and the dated catalogue in a secondary view", () => {
  const html = detail(ready(insights));
  expect(html).toContain("Another Audio");
  expect(html).toContain("Your offline requirement is supported.");
  expect(html).toContain("Your needs");
  expect(html).toContain("Monitoring");
  expect(html).not.toContain("Explore other subscriptions");
  const catalogue = renderToStaticMarkup(createElement(CatalogueBrowser, { data: data.catalogue }));
  expect(catalogue).toContain("Reference catalogue");
  expect(catalogue).toContain("Researched 2026-10-09");
  expect(catalogue).toContain("Not personalised");
  expect(catalogue).toContain("prices may have changed");
  expect(html).toContain('href="https://provider.example/plans"');
  expect(html).toContain("£9");
});

it("keeps old checks visibly historical without presenting recorded prices as new research", () => {
  const html = detail(
    ready({ ...insights, reviews: insights.reviews.map((review) => ({ ...review, historical: true })) }),
  );
  expect(html).toContain("Previous check");
  expect(html).toContain("Recorded price");
  expect(html).not.toContain("Prices may have changed");
});

it("does not fabricate personalised alternatives during loading, unanswered onboarding or a no-match result", () => {
  expect(detail({ phase: "loading" })).not.toContain("Another Audio");
  const unanswered = {
    ...data,
    portfolio: {
      ...data.portfolio,
      subscriptions: data.portfolio.subscriptions.map((row) => ({ ...row, purpose: "" })),
    },
  };
  expect(detail(ready(insights), unanswered)).not.toContain("Another Audio");
  expect(detail(ready(insights), unanswered)).toContain("Tell Val what you need to start comparing");
  const html = detail(
    ready({
      ...insights,
      reviews: [
        {
          ...insights.reviews[0]!,
          advice: { summary: "No cheaper match established.", options: [], uncertainties: [] },
        },
      ],
    }),
  );
  expect(html).toContain("This check couldn’t finish");
  expect(html).toContain("Try again");
  expect(html).not.toContain("Another Audio");
});

it("puts the switch action directly on its subscription without opening details or inventing automation", () => {
  const html = dashboard(insights);
  expect(html).toContain('class="portfolio-subscription"');
  expect(html).toContain("Another Audio");
  expect(html).toContain("£84");
  expect(html).not.toContain('href="https://provider.example/plans"');
  expect(html).toContain("Switch to Another Audio");
  expect(html).toContain('aria-label="Switch to Another Audio"');
  expect(html).toContain(">Switch</button>");
  expect(html).not.toContain("Prepare my switch");
  expect(html).not.toContain("Switch with Val");
  expect(html).not.toContain("<details");
  expect(html).not.toContain("Compare details");
  expect(html.indexOf("Switch to Another Audio")).toBeLessThan(html.indexOf("Check activity"));
  const offer = html.indexOf('class="subscription-row-offer"');
  expect(html.lastIndexOf("</button>", offer)).toBeGreaterThan(
    html.lastIndexOf('<button class="portfolio-row"', offer),
  );
});

it("starts the same switching flow for older offers instead of returning to chat", () => {
  const old = { ...insights, reviews: insights.reviews.map((review) => ({ ...review, historical: true })) };
  const html = dashboard(old);
  expect(html).toContain(">Switch</button>");
  expect(html).not.toContain("Refresh to switch");
  expect(html).toContain("Previous price");
  expect(html).toContain("Another Audio");
  expect(html).toContain('aria-label="Switch to Another Audio"');
  expect(html).not.toContain('href="https://provider.example/plans"');
});

it("never offers a switch for unanswered, inactive, foreign-revision or already-owned comparisons", () => {
  const row = data.portfolio.subscriptions[0]!;
  const render = (entry = row, state: InsightState = ready(insights)) =>
    renderToStaticMarkup(
      createElement(SubscriptionSwitchAction, {
        row: entry,
        revision: data.portfolio.revision,
        insights: state,
      }),
    );
  expect(render({ ...row, purpose: "" })).toBe("");
  expect(render({ ...row, paypalStatus: "CANCELLED" })).toBe("");
  expect(render(row, { phase: "loading" })).toBe("");
  expect(render(row, ready({ ...insights, revision: 1 }))).toBe("");
  const owned = structuredClone(insights);
  owned.reviews[0]!.advice.comparisons![0]!.owned = true;
  expect(render(row, ready(owned))).toBe("");
});

it("keeps the material fit condition beside the visible switch action", () => {
  const conditional = structuredClone(insights);
  conditional.reviews[0]!.advice.comparisons![0]!.fit = "conditional";
  conditional.reviews[0]!.advice.comparisons![0]!.fitCondition =
    "Only if you can transfer your saved library.";
  const html = dashboard(conditional);
  expect(html).toContain("Only if you can transfer your saved library.");
  expect(html).toContain("Switch to Another Audio");
});

it("renders current batch progress without marking an unfinished check complete", () => {
  const pending = {
    ...insights,
    reviews: [],
    batch: {
      revision: 8,
      serviceIds: ["unlisted-audio", "a", "c"],
      completed: ["a"],
      failed: [],
      currentServiceId: "unlisted-audio",
      status: "running" as const,
    },
  };
  expect(activity(pending)).toContain("1 of 3 checked");
  expect(detail(ready(pending))).toContain("Checking offers…");
  expect(activity(pending)).not.toContain("No checks yet");
});

it("shows actual check outcomes, repeated history and next scheduled checks without legacy setup placeholders", () => {
  const html = activity({
    ...insights,
    activity: [
      {
        id: "failed",
        serviceId: "unlisted-audio",
        name: "Unlisted Audio",
        checkedAt: "2026-11-08T13:00:00Z",
        outcome: "incomplete",
        alternatives: 0,
        available: true,
      },
      {
        id: "success",
        serviceId: "unlisted-audio",
        name: "Unlisted Audio",
        checkedAt: "2026-11-08T12:00:00Z",
        outcome: "alternatives",
        alternatives: 1,
        available: true,
      },
      {
        id: "none",
        serviceId: "unlisted-audio",
        name: "Unlisted Audio",
        checkedAt: "2026-11-08T11:00:00Z",
        outcome: "no_match",
        alternatives: 0,
        available: true,
      },
    ],
    schedules: [
      {
        serviceId: "unlisted-audio",
        revision: 1,
        cadence: { every: 2, unit: "week" },
        status: "scheduled",
        nextCheckAt: "2026-11-22T12:00:00Z",
        lastCheckedAt: "2026-11-08T12:00:00Z",
        advice: null,
      },
    ],
  });
  expect(html).toContain("This check couldn’t finish");
  expect(html).toContain("1 alternative found");
  expect(html).toContain("Checked · no cheaper match established");
  expect(html).toContain("Every 2 weeks");
  expect(html).toContain("Next check");
  expect(html).toContain("22 Nov");
  expect(html).not.toMatch(/Original service|Previous payment workflows/);
});

it("offers honest empty and failure states with actionable recovery", () => {
  expect(activity({ ...insights, reviews: [] })).toContain("No checks yet");
  const html = detail({ phase: "error", message: "Your subscriptions changed.", needsReload: true });
  expect(html).toContain('role="alert"');
  expect(html).toContain("Reload subscriptions");
  expect(html).not.toContain("Another Audio");
});
