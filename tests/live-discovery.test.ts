import { afterAll, beforeAll, expect, it, vi } from "vitest";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import {
  acceptedOffers,
  currencyAmounts,
  discoverLiveOffers,
  offerBudget,
  providerUrl,
  researchNeed,
  regionalPricingLeads,
  responseSources,
  validatedProviderCache,
  type LiveOffer,
} from "../src/server/live-discovery";
import { agentModel } from "../src/server/agent-contract";
import { isProviderPriceSource, matchesMobileProduct } from "../src/server/subscription-advice";
import { startTestApp, type TestApp } from "./helpers";
import { ukResearchDate } from "../src/shared/research-date";
import { HttpError } from "../src/server/http";
import { eq } from "drizzle-orm";
import { ownerSubscriptions } from "../src/server/db/schema";

const offer: LiveOffer = {
  name: "Fresh Mobile",
  plan: "20GB rolling",
  providerUrl: "https://freshmobile.co.uk/plans",
  currency: "GBP",
  market: "GB",
  priceMinor: 800,
  billingUnit: "month",
  billingEvidence: { quote: "We bill you monthly.", source: "https://freshmobile.co.uk/plans" },
  introductoryCycles: 0,
  renewalMinor: 800,
  minimumTermMonths: 0,
  upfrontMinor: 0,
  features: ["20GB UK data"],
  conditions: ["Check coverage and current contract exit fees"],
  sources: ["https://freshmobile.co.uk/plans"],
  priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source: "https://freshmobile.co.uk/plans" },
};
it("derives bounded regional pricing hints without granting them source authority", () => {
  expect(
    regionalPricingLeads(["https://samplemail.com/pricing/?utm_source=search"], "samplemail.com"),
  ).toEqual(["https://samplemail.com/pricing/gb/", "https://samplemail.com/en-gb/pricing/"]);
  expect(regionalPricingLeads(["https://samplemail.com/en-us/plans/"], "samplemail.com")).toEqual([
    "https://samplemail.com/plans/gb/",
    "https://samplemail.com/en-gb/plans/",
  ]);
  for (const source of [
    "https://other-provider.com/pricing/",
    "https://samplemail.com/account/1234",
    "https://samplemail.com/pricing/gb/",
    "http://samplemail.com/pricing/",
    "https://samplemail.com:4430/pricing/",
    "https://login:password@samplemail.com/pricing/",
  ])
    expect(regionalPricingLeads([source], "samplemail.com")).toEqual([]);
  const hint = regionalPricingLeads(["https://freshmobile.com/pricing/"], "freshmobile.com")[0]!;
  const candidate: LiveOffer = {
    ...offer,
    providerUrl: hint,
    sources: [hint],
    priceEvidence: { ...offer.priceEvidence!, source: hint },
    billingEvidence: { ...offer.billingEvidence!, source: hint },
  };
  expect(
    acceptedOffers(
      { offers: [candidate] },
      new Set(["https://freshmobile.com/pricing/"]),
      ["freshmobile.com"],
      [],
      true,
    ),
  ).toEqual([]);
});
it("requires renewal evidence rather than assuming a monthly marketing price means a calendar month", () => {
  const candidate: LiveOffer = {
    ...offer,
    priceMinor: 1500,
    renewalMinor: 1500,
    plan: "50GB Monthly Plan",
    priceEvidence: { kind: "direct_gbp", quote: "50GB for £15 a month", source: offer.providerUrl },
    billingEvidence: null,
  };
  const sources = new Set(offer.sources);
  expect(acceptedOffers({ offers: [candidate] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([]);
  const renewal = { quote: "Your plan automatically renews every 30 days.", source: offer.providerUrl };
  expect(
    acceptedOffers(
      { offers: [{ ...candidate, billingEvidence: renewal }] },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
  const valid = { ...candidate, billingUnit: "30_days" as const, billingEvidence: renewal };
  expect(acceptedOffers({ offers: [valid] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([valid]);
  expect(offerBudget(valid).annualMinor).toBe(19500);
});
it("accepts a monthly charge backed by a no-commitment payment-period contract", () => {
  const candidate: LiveOffer = {
    ...offer,
    billingEvidence: {
      quote:
        "There are no commitments and you can cancel at any time, effective at the end of your current payment period.",
      source: offer.providerUrl,
    },
  };
  const accept = (value: LiveOffer) =>
    acceptedOffers({ offers: [value] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true);
  expect(accept(candidate)).toEqual([candidate]);
  const table = {
    ...candidate,
    billingEvidence: { quote: "Standard plan. Monthly: £8", source: offer.providerUrl },
  };
  expect(accept(table)).toEqual([table]);
  expect(accept({ ...table, conditions: ["Billed annually in advance"] })).toEqual([]);
  expect(
    accept({
      ...candidate,
      billingEvidence: {
        ...candidate.billingEvidence!,
        quote: "Cancel at any time, effective at the end of your current payment period.",
      },
    }),
  ).toEqual([]);
  expect(accept({ ...candidate, conditions: ["Charged annually in advance"] })).toEqual([]);
  expect(accept({ ...candidate, conditions: ["Your plan renews every 30 days"] })).toEqual([]);
});

it("joins retrieved monthly pricing and renewal clauses without trusting unverified or conflicting terms", () => {
  const terms = "https://freshmobile.co.uk/terms";
  const candidate: LiveOffer = {
    ...offer,
    billingEvidence: {
      quote: "An individual monthly subscription costs £8 per month.",
      source: offer.providerUrl,
    },
    priceEvidence: {
      kind: "direct_gbp",
      quote: "£8/month. Plan automatically renews until cancelled.",
      source: terms,
    },
    sources: [...offer.sources, terms],
  };
  const accept = (value: LiveOffer, sources = new Set(candidate.sources)) =>
    acceptedOffers({ offers: [value] }, sources, ["freshmobile.co.uk"], [], true);
  expect(accept(candidate)).toEqual([candidate]);
  expect(accept(candidate, new Set(offer.sources))).toEqual([]);
  expect(
    accept({
      ...candidate,
      priceEvidence: { ...candidate.priceEvidence!, source: "https://other.example/terms" },
    }),
  ).toEqual([]);
  expect(
    accept({
      ...candidate,
      priceEvidence: { ...candidate.priceEvidence!, quote: "£8/month. No automatic renewal." },
    }),
  ).toEqual([]);
  expect(accept({ ...candidate, conditions: ["Billed annually in advance"] })).toEqual([]);
  expect(accept({ ...candidate, conditions: ["Renews every 30 days"] })).toEqual([]);
});

it("keeps an unqualified monthly choice separate from its term-discount alternative", () => {
  const candidate: LiveOffer = {
    ...offer,
    minimumTermMonths: 0,
    billingEvidence: {
      quote:
        "There are no commitments and you can cancel at any time, effective at the end of your current payment period.",
      source: offer.providerUrl,
    },
    priceEvidence: {
      kind: "direct_gbp",
      quote: "Standard (£8/month or £5/month with a 6-month saver plan): HD video",
      source: offer.providerUrl,
    },
  };
  const original = JSON.stringify(candidate);
  const accept = (value: LiveOffer) =>
    acceptedOffers({ offers: [value] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true);
  expect(accept(candidate)).toEqual([candidate]);
  expect(offerBudget(accept(candidate)[0]!).annualMinor).toBe(9600);
  expect(JSON.stringify(candidate)).toBe(original);
  for (const quote of [
    "Student (£8/month or £5/month with a 6-month saver plan)",
    "Annual (£8/month or £5/month with a 6-month saver plan)",
    "Standard (£8/month or £5/month with a 6-month saver plan plus £25 activation)",
    "Standard (£8/month or £5/month for students)",
  ])
    expect(accept({ ...candidate, priceEvidence: { ...candidate.priceEvidence!, quote } })).toEqual([]);
  expect(accept({ ...candidate, priceMinor: 500, renewalMinor: 500 })).toEqual([]);
  expect(accept({ ...candidate, introductoryCycles: 6, minimumTermMonths: 6, priceMinor: 500 })).toEqual([]);
  expect(accept({ ...candidate, minimumTermMonths: null })).toEqual([]);
  expect(accept({ ...candidate, upfrontMinor: 2500 })).toEqual([]);
});

it("keeps calendar-month renewal distinct from a separate thirty-day refund promise", () => {
  const candidate = {
    ...offer,
    billingEvidence: {
      quote: "We bill you monthly. A 30-day money-back guarantee applies.",
      source: offer.providerUrl,
    },
  };
  expect(
    acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([candidate]);
  const sameClause = {
    ...candidate,
    conditions: ["We bill you monthly with a 30-day money-back guarantee."],
    billingEvidence: {
      ...candidate.billingEvidence,
      quote: "We bill you monthly with a 30-day money-back guarantee.",
    },
  };
  expect(
    acceptedOffers({ offers: [sameClause] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([sameClause]);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...candidate,
            billingEvidence: { ...candidate.billingEvidence, source: "https://other.example/billing" },
          },
        ],
      },
      new Set([...offer.sources, "https://other.example/billing"]),
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
});
it("accepts an explicit monthly pricing-table entry with the provider's cancellable billing-period contract", () => {
  const candidate: LiveOffer = {
    ...offer,
    priceEvidence: { kind: "direct_gbp", quote: "Standard plan. Monthly: £8", source: offer.providerUrl },
    billingEvidence: {
      quote: "You can cancel at any time, effective at the end of your current payment period.",
      source: offer.providerUrl,
    },
  };
  const sources = new Set(offer.sources);
  expect(acceptedOffers({ offers: [candidate] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([
    candidate,
  ]);
  for (const quote of [
    "From £8 per month",
    "£8/month",
    "Monthly: £8, paid annually",
    "Monthly: £8, billed yearly",
    "Monthly: £8, renews every 30 days",
  ])
    expect(
      acceptedOffers(
        { offers: [{ ...candidate, priceEvidence: { ...candidate.priceEvidence!, quote } }] },
        sources,
        ["freshmobile.co.uk"],
        [],
        true,
      ),
    ).toEqual([]);
  expect(
    acceptedOffers(
      {
        offers: [
          { ...candidate, billingEvidence: { ...candidate.billingEvidence!, quote: "No commitment." } },
        ],
      },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...candidate,
            priceEvidence: { ...candidate.priceEvidence!, source: "https://freshmobile.co.uk/unretrieved" },
          },
        ],
      },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
});

it.each([
  "£11.99/monthper month after free trial. Plan automatically renews until cancelled.",
  "Subscription auto-renews at £11.99 per month until cancelled.",
  "Plan automatically renews until cancelled.",
  "Recurring billing.",
  "£11.99 per month unless you opt out at least 48 hours before the date of automatic renewal. This offer is non-binding. You may cancel your subscription at any time.",
  "Auto-renewal continues until cancelled.",
  "£11.99 per month. Billed monthly, not annually.",
])(
  "accepts an explicit auto-renewing monthly fee without requiring billing wording in a fixed order: %s",
  (quote) => {
    const candidate = {
      ...offer,
      priceMinor: 1199,
      renewalMinor: 1199,
      priceEvidence: { kind: "direct_gbp" as const, quote: "£11.99 per month", source: offer.providerUrl },
      billingEvidence: { quote, source: offer.providerUrl },
    };
    expect(
      acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
    ).toEqual([candidate]);
    expect(offerBudget(candidate).annualMinor).toBe(14388);
  },
);

it.each([
  "£11.99/month after free trial. Check the renewal terms.",
  "£11.99/month. The subscription does not automatically renew.",
  "£9.99/month. Plan automatically renews until cancelled.",
  "£11.99/month. Billed annually at £143.88. Plan automatically renews until cancelled.",
  "£11.99/month. Plan automatically renews every 30 days until cancelled.",
  "Plan automatically renews at £11.99 per month; billed annually at £143.88.",
  "Your plan does not automatically renew at £11.99 per month.",
  "£11.99 per month. No automatic renewal.",
  "£11.99 per month without automatic renewal.",
  "£11.99 per month. Renewal is not automatic.",
  "Plan automatically renews at £9.99 per month.",
  "£11.99/month for the introductory period. Plan auto-renews at £143.88/year.",
])("does not infer a monthly bill from incomplete or contradictory renewal wording: %s", (quote) => {
  const candidate = {
    ...offer,
    priceMinor: 1199,
    renewalMinor: 1199,
    priceEvidence: { kind: "direct_gbp" as const, quote: "£11.99 per month", source: offer.providerUrl },
    billingEvidence: { quote, source: offer.providerUrl },
  };
  expect(
    acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([]);
});
it("preserves thirty-day renewal and whole charges when the contract puts a decimal price before the cycle", () => {
  const candidate = {
    ...offer,
    priceMinor: 1199,
    renewalMinor: 1199,
    billingUnit: "30_days" as const,
    priceEvidence: { kind: "direct_gbp" as const, quote: "£11.99 per 30 days", source: offer.providerUrl },
    billingEvidence: { quote: "Your plan renews at £11.99 every 30 days.", source: offer.providerUrl },
  };
  expect(
    acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([candidate]);
  expect(offerBudget(candidate).annualMinor).toBe(15587);
});
it.each(["One-time purchase", "Perpetual licence", "Lifetime license"])(
  "does not admit a paid %s as a yearly subscription",
  (plan) => {
    const candidate = {
      ...offer,
      plan,
      billingUnit: "year",
      priceMinor: 9900,
      renewalMinor: 9900,
      priceEvidence: { kind: "direct_gbp", quote: "£99", source: offer.providerUrl },
    };
    const rejected: unknown[] = [];
    expect(
      acceptedOffers(
        { offers: [candidate] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
        (failure) => rejected.push(failure),
      ),
    ).toEqual([]);
    expect(rejected).toEqual([{ offerIndex: 0, code: "billing_period" }]);
  },
);
it("keeps an actual yearly charge and an ongoing free licence distinct from paid one-time purchases", () => {
  const yearly = {
    ...offer,
    plan: "Annual subscription",
    billingUnit: "year",
    priceMinor: 9900,
    renewalMinor: 9900,
    priceEvidence: { kind: "direct_gbp", quote: "£99 per year", source: offer.providerUrl },
  };
  const free = {
    ...offer,
    plan: "Free perpetual licence",
    priceMinor: 0,
    renewalMinor: 0,
    priceEvidence: { kind: "free", quote: "Free ongoing plan", source: offer.providerUrl },
  };
  expect(
    acceptedOffers({ offers: [yearly, free] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([yearly, free]);
});
it("does not join a bill comparison to a separate free-trial note as a thirty-day renewal", () => {
  const annual: LiveOffer = {
    ...offer,
    plan: "Annual membership",
    billingUnit: "year",
    priceMinor: 11900,
    renewalMinor: 11900,
    priceEvidence: { kind: "direct_gbp", quote: "£119 per year", source: offer.providerUrl },
    conditions: ["The monthly plan matches the current bill", "The 30-day free trial is excluded from cost"],
  };
  expect(
    acceptedOffers({ offers: [annual] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([annual]);
  expect(
    acceptedOffers(
      { offers: [{ ...annual, conditions: ["Renews every 30 days"] }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
});

it("binds foreign prices to explicit native currency evidence without inventing GBP", () => {
  const native: LiveOffer = {
    ...offer,
    currency: "USD",
    priceMinor: 2000,
    renewalMinor: 2000,
    billingUnit: "year",
    priceEvidence: { kind: "native_currency", quote: "USD 20 per year", source: offer.providerUrl },
  };
  const sources = new Set(offer.sources),
    hosts = ["freshmobile.co.uk"];
  expect(acceptedOffers({ offers: [native] }, sources, hosts, [], true)).toEqual([native]);
  for (const invalid of [
    { ...native, currency: "GBP" },
    { ...native, priceEvidence: { ...native.priceEvidence, kind: "direct_gbp" } },
    { ...native, priceEvidence: { ...native.priceEvidence, quote: "$20 per year" } },
    { ...native, priceMinor: 1800, renewalMinor: 1800 },
  ])
    expect(acceptedOffers({ offers: [invalid] }, sources, hosts, [], true)).toEqual([]);
  expect(currencyAmounts("USD 20; GBP 18; €5", "USD")).toEqual([2000]);
  expect(currencyAmounts("USD 20; GBP 18; €5", "GBP")).toEqual([1800]);
  expect(currencyAmounts("USD 20; GBP 18; €5", "EUR")).toEqual([500]);
  expect(currencyAmounts("€5,00 a month; EUR 1.200,50 annually.", "EUR")).toEqual([500, 120050]);
  expect(currencyAmounts("£1,0.00", "GBP")).toEqual([]);
  expect(currencyAmounts("USD 1,200.50.", "USD")).toEqual([120050]);
});
it("reads spaced provider currency symbols without accepting ambiguous dollars or fabricated totals", () => {
  expect(currencyAmounts("£ 8; GBP\u00a012.50", "GBP")).toEqual([800, 1250]);
  expect(currencyAmounts("€ 36; EUR\u202f1.200,50", "EUR")).toEqual([3600, 120050]);
  expect(currencyAmounts("US$ 20; USD 30; $ 40", "USD")).toEqual([2000, 3000]);
  const native: LiveOffer = {
    ...offer,
    currency: "EUR",
    priceMinor: 3600,
    renewalMinor: 3600,
    billingUnit: "year",
    priceEvidence: { kind: "native_currency", quote: "€ 36 per year", source: offer.providerUrl },
  };
  const accept = (value: LiveOffer) =>
    acceptedOffers({ offers: [value] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true);
  expect(accept(native)).toEqual([native]);
  expect(accept({ ...native, priceMinor: 7200, renewalMinor: 7200 })).toEqual([]);
  expect(
    accept({
      ...native,
      currency: "USD",
      priceEvidence: { ...native.priceEvidence!, quote: "$ 36 per year" },
    }),
  ).toEqual([]);
});
it("does not turn the current product label or invented apps into requirements or discard valid provider research", async () => {
  for (const mobile of [false, true]) {
    let stages = 0;
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            stages++;
            if (stages === 1)
              return webResponse(
                {
                  searchPurpose: mobile
                    ? "TikTok and ordinary mobile data"
                    : "Offline podcasts and queue sync",
                  namedApps: mobile ? ["Current Plan", "TikTok", "Invented App"] : ["Harbour Audio Premium"],
                  providers: [{ name: "Fresh Provider", website: offer.providerUrl }],
                  uncertainties: [],
                },
                offer.sources,
              );
            const input = JSON.parse((request.input as { content: string }[])[0]!.content);
            expect(input.namedApps).toEqual(mobile ? ["TikTok"] : []);
            return webResponse(
              {
                offers: [
                  {
                    ...offer,
                    appCoverage: mobile
                      ? [
                          {
                            app: "TikTok",
                            status: "general_data",
                            evidence: "Ordinary data allowance, no explicit zero-rating",
                            source: offer.providerUrl,
                          },
                        ]
                      : [],
                  },
                ],
                uncertainties: [],
              },
              offer.sources,
            );
          },
        },
      },
      {
        serviceId: "authored:unknown",
        name: mobile ? "Current Plan" : "Harbour Audio Premium",
        purpose: mobile
          ? "TikTok and 2GB for maps"
          : "Download podcasts before flights and sync the queue between Android and laptop",
        amountMinor: 1200,
        cycle: "month",
        source: "manual",
      },
    );
    expect(stages).toBe(2);
    expect(result.status).toBe("live");
    expect(result.offers).toHaveLength(1);
    expect(result.namedApps).toEqual(mobile ? ["TikTok"] : []);
  }
});
it("uses the same UK research day across summer midnight and winter dates", () => {
  expect(ukResearchDate("2026-10-17T23:30:00Z")).toBe("2026-10-18");
  expect(ukResearchDate("2026-12-17T23:30:00Z")).toBe("2026-12-17");
  expect(ukResearchDate("2026-12-18T00:30:00Z")).toBe("2026-12-18");
});
it("does not treat a data-only annual pool as a replacement for an ordinary phone tariff", () => {
  const annual = {
    ...offer,
    plan: "120GB Data Only SIM lasting 12 months",
    billingUnit: "year" as const,
    priceMinor: 4000,
    renewalMinor: 4000,
  };
  expect(matchesMobileProduct("mobile", "TikTok and YouTube; under 10GB for everything else", annual)).toBe(
    false,
  );
  expect(matchesMobileProduct("mobile", "I want data-only for my tablet", annual)).toBe(true);
  expect(matchesMobileProduct("mobile", "Not a data-only plan", annual)).toBe(false);
  expect(matchesMobileProduct("mobile", "TikTok and YouTube", offer)).toBe(true);
});
it("targets billing repair when validation finds missing renewal evidence despite the model's false flag", async () => {
  const help = "https://freshmobile.co.uk/help/billing";
  const incomplete = { ...offer, billingEvidence: { quote: "£8 per month", source: offer.providerUrl } };
  const renewed = {
    ...offer,
    billingEvidence: { quote: "Your subscription is billed monthly until you cancel.", source: help },
    sources: [...offer.sources, help],
  };
  let repaired = false;
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [{ name: offer.name, website: offer.providerUrl }],
                searchPurpose: "20GB mobile data",
                namedApps: [],
                uncertainties: [],
              },
              offer.sources,
            );
          if (stage === "ProviderOffers")
            return webResponse(
              { offers: [incomplete], uncertainties: [], billingResearchNeeded: false },
              offer.sources,
            );
          expect(stage).toBe("ProviderOffersRepair");
          const input = JSON.parse((request.input as { content: string }[]).at(-1)!.content);
          expect(input.missingBillingEvidence).toBe(true);
          expect(input.validationFailures).toContainEqual({ offerIndex: 0, code: "billing_period" });
          repaired = true;
          return webResponse({ offers: [renewed], uncertainties: [], billingResearchNeeded: false }, [help]);
        },
      },
    },
    {
      serviceId: "unlisted-plan",
      name: "Current mobile plan",
      amountMinor: 1500,
      cycle: "month",
      source: "paypal",
      purpose: "20GB mobile data",
    },
  );
  expect(repaired).toBe(true);
  expect(result.offers).toEqual([renewed]);
});

it.each([
  [true, true],
  [true, false],
  [false, true],
  [false, false],
])(
  "follows an empty provider result into missing price or renewal evidence (resolved=%s, billing-only=%s)",
  async (resolved, billingOnly) => {
    const stages: string[] = [];
    const help = "https://freshmobile.co.uk/help/renewals";
    const pricedPlan = billingOnly
      ? "The 50GB Monthly Plan costs £15 a month; its renewal period was not retrieved."
      : "Official provider prices and renewal terms were not confirmed from the retrieved pages.";
    const renewed: LiveOffer = {
      ...offer,
      plan: "50GB rolling plan",
      priceMinor: 1500,
      renewalMinor: 1500,
      billingUnit: "30_days",
      billingEvidence: { quote: "Our rolling plans renew automatically every 30 days.", source: help },
      priceEvidence: { kind: "direct_gbp", quote: "50GB for £15 a month", source: offer.providerUrl },
      sources: [...offer.sources, help],
    };
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            stages.push(stage);
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [{ name: offer.name, website: offer.providerUrl }],
                  searchPurpose: "42GB general mobile data",
                  namedApps: [],
                  uncertainties: [],
                },
                offer.sources,
              );
            if (stage === "ProviderOffers")
              return webResponse(
                { offers: [], uncertainties: [pricedPlan], billingResearchNeeded: billingOnly },
                offer.sources,
              );
            expect(stage).toBe("ProviderOffersRepair");
            const history = request.input as { type?: string; content: any }[];
            const input = JSON.parse(history.at(-1)!.content);
            expect(input.missingBillingEvidence).toBe(billingOnly);
            expect(history.some((item) => item.type === "web_search_call")).toBe(true);
            expect(
              history.some(
                (item) =>
                  item.type === "message" && JSON.stringify(item.content).includes("billingResearchNeeded"),
              ),
            ).toBe(true);
            expect(input.previousOffers).toEqual([]);
            expect(input.previousUncertainties).toContain(pricedPlan);
            expect(input.retrievedSources).toEqual(offer.sources);
            const tool = request.tools?.find((value) => value.type === "web_search");
            expect(tool?.type === "web_search" && tool.filters?.allowed_domains).toEqual([
              "freshmobile.co.uk",
            ]);
            // A quote without retrieval remains insufficient, even after the targeted follow-up.
            return webResponse(
              { offers: [renewed], uncertainties: [], billingResearchNeeded: !resolved },
              resolved ? [help] : offer.sources,
            );
          },
        },
      },
      {
        serviceId: "unfamiliar-mobile",
        name: "Other phone plan",
        amountMinor: 1800,
        cycle: "month",
        source: "paypal",
        purpose: "42GB general mobile data",
      },
    );
    expect(stages).toEqual(["OfficialProviders", "ProviderOffers", "ProviderOffersRepair"]);
    expect(result.offers).toEqual(resolved ? [renewed] : []);
    if (resolved) {
      expect(offerBudget(result.offers[0]!).annualMinor).toBe(19500);
      expect(
        validatedProviderCache(result, {
          serviceId: "unfamiliar-mobile",
          name: "Other phone plan",
          amountMinor: 1800,
          cycle: "month",
          source: "paypal",
          purpose: "42GB general mobile data",
        })?.offers,
      ).toEqual([renewed]);
    }
  },
);

it.each([
  { retained: true, newSearch: true },
  { retained: true, newSearch: false },
  { retained: false, newSearch: true },
  { retained: false, newSearch: false },
])(
  "uses actual retained verification content for pricing without promoting URL-only leads (retained=$retained,newSearch=$newSearch)",
  async ({ retained, newSearch }) => {
    const home = "https://newraw.example.org/";
    const features = "https://newraw.example.org/features";
    const free: LiveOffer = {
      ...offer,
      name: "NewRaw",
      plan: "Free desktop software",
      providerUrl: home,
      priceMinor: 0,
      renewalMinor: 0,
      billingEvidence: null,
      features: ["Windows RAW photo editing and library management"],
      conditions: ["Check support for your camera model"],
      sources: newSearch ? [home, features] : [home],
      priceEvidence: { kind: "free", quote: "Use it free of charge.", source: home },
    };
    const result = await discoverLiveOffers(
      {
        ...(retained ? { hasSearchContext: (response: Response) => response.id === "verified-source" } : {}),
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            const provider = {
              providers: [{ name: free.name, website: home }],
              searchPurpose: "Local Windows RAW photography",
              namedApps: [],
              uncertainties: ["The provider says: Use it free of charge."],
            };
            if (stage === "OfficialProviders")
              return {
                ...webResponse(provider, retained ? [home] : ["https://reviews.example.net/newraw"]),
                id: "verified-source",
              };
            if (stage === "OfficialProvidersVerification")
              return { ...webResponse(provider, [home]), id: "verified-source" };
            if (stage === "ProviderOffers") {
              const history = request.input as { type?: string; id?: string }[];
              expect(history.some((item) => item.id === "web-check")).toBe(retained);
              const priced = {
                ...webResponse({ offers: [free], uncertainties: [] }, newSearch ? [features] : []),
                id: "priced-source",
              };
              if (!newSearch) priced.output = priced.output.filter((item) => item.type !== "web_search_call");
              return priced;
            }
            return { ...webResponse({ offers: [], uncertainties: [] }, [features]), id: "repair-source" };
          },
        },
      },
      {
        serviceId: "unfamiliar-photo-tool",
        name: "Other editor",
        amountMinor: 1997,
        cycle: "month",
        source: "paypal",
        purpose: "Local Windows RAW photography",
      },
    );
    expect(result.offers).toEqual(retained ? [free] : []);
    if (retained) {
      const entry = {
        serviceId: "unfamiliar-photo-tool",
        name: "Other editor",
        amountMinor: 1997,
        cycle: "month" as const,
        source: "paypal" as const,
        purpose: "Local Windows RAW photography",
      };
      expect(result.evidence.at(-1)?.retainedResponseIds).toEqual(["verified-source"]);
      expect(validatedProviderCache(result, entry)?.offers).toEqual([free]);
      const forged = structuredClone(result);
      forged.evidence.at(-1)!.retainedResponseIds = ["missing-source"];
      expect(validatedProviderCache(forged, entry)).toBeNull();
      forged.evidence.at(-1)!.retainedResponseIds = ["priced-source"];
      expect(validatedProviderCache(forged, entry)).toBeNull();
    }
  },
);

function webResponse(answer: unknown, urls: string[]): Response {
  return {
    id: "authored-web-check",
    model: agentModel,
    status: "completed",
    output: [
      {
        id: "web-check",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", sources: urls.map((url) => ({ type: "url", url })) },
      },
      {
        id: "answer",
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(answer), annotations: [] }],
      },
    ],
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
  } as Response;
}

it("delivers a grounded lower-priced first comparison without waiting on optional providers", async () => {
  const checked: string[] = [];
  const result = await discoverLiveOffers(
    {
      provider: "google",
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [
                  { website: "https://existingmobile.co.uk/" },
                  { website: offer.providerUrl },
                  { website: "https://slowmobile.co.uk/" },
                ],
                searchPurpose: "20GB mobile data",
                namedApps: [],
              },
              offer.sources,
            );
          const host = (request.tools?.find((tool) => tool.type === "web_search") as any)?.filters
            .allowed_domains[0];
          checked.push(host);
          if (host === "slowmobile.co.uk")
            throw new Error("Optional site should wait for a later comparison");
          return webResponse(
            { offers: host === "freshmobile.co.uk" ? [offer] : [], uncertainties: [] },
            host === "freshmobile.co.uk" ? offer.sources : ["https://existingmobile.co.uk/"],
          );
        },
      },
    },
    {
      serviceId: "new-mobile",
      name: "Existing mobile",
      source: "manual",
      amountMinor: 1800,
      cycle: "month",
      purpose: "20GB mobile data",
    },
    undefined,
    ["https://existingmobile.co.uk/"],
    { firstResult: true },
  );
  expect(result.offers).toEqual([offer]);
  expect(checked).toEqual(expect.arrayContaining(["existingmobile.co.uk", "freshmobile.co.uk"]));
  expect(checked).not.toContain("slowmobile.co.uk");
  expect(result.coverage?.incomplete).toContain("slowmobile.co.uk");
});
it("resumes a saved provider checkpoint without repeating discovery or completed pricing", async () => {
  const otherUrl = "https://backupmobile.co.uk/plans";
  const entry = {
    serviceId: "unfamiliar-phone",
    name: "Existing phone plan",
    source: "paypal" as const,
    amountMinor: 1800,
    cycle: "month" as const,
    purpose: "20GB rolling phone data",
  };
  const snapshots: Awaited<ReturnType<typeof discoverLiveOffers>>[] = [];
  const first = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [
                  { name: offer.name, website: offer.providerUrl },
                  { name: "Backup Mobile", website: otherUrl },
                ],
                searchPurpose: entry.purpose,
                namedApps: [],
                uncertainties: [],
              },
              [...offer.sources, otherUrl],
            );
          const search = request.tools?.find((tool) => tool.type === "web_search");
          const host = search?.type === "web_search" ? search.filters?.allowed_domains?.[0] : null;
          if (host === "backupmobile.co.uk") throw new Error("Provider temporarily unavailable");
          return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
        },
      },
    },
    entry,
    undefined,
    [],
    {
      save: async (value) => {
        snapshots.push(JSON.parse(JSON.stringify(value)));
      },
    },
  );
  expect(first.status).toBe("live");
  const checkpoint = snapshots.at(-1)!;
  expect(checkpoint.pendingProviders).toEqual(["backupmobile.co.uk"]);
  expect(validatedProviderCache(checkpoint, entry)).not.toBeNull();
  const called: string[] = [];
  const resumed = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          const search = request.tools?.find((tool) => tool.type === "web_search");
          const host = search?.type === "web_search" ? search.filters?.allowed_domains?.[0] : null;
          called.push(`${stage}:${host}`);
          expect(stage).toBe("ProviderOffers");
          expect(host).toBe("backupmobile.co.uk");
          const next = {
            ...offer,
            name: "Backup Mobile",
            providerUrl: otherUrl,
            sources: [otherUrl],
            billingEvidence: { quote: "We bill you monthly.", source: otherUrl },
            priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source: otherUrl },
          };
          return webResponse({ offers: [next], uncertainties: [] }, [otherUrl]);
        },
      },
    },
    entry,
    undefined,
    [],
    { resume: checkpoint },
  );
  expect(called).toEqual(["ProviderOffers:backupmobile.co.uk"]);
  expect(resumed.pendingProviders).toEqual([]);
  expect(resumed.offers).toHaveLength(2);
  expect(resumed.coverage?.checked).toEqual(["freshmobile.co.uk", "backupmobile.co.uk"]);
});

it("starts the provider deadline after funding rather than while a request waits in the queue", async () => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((handler: any, delay: number, ...args: any[]) =>
      realTimeout(
        handler,
        delay === 45_000 ? 10 : delay === 120_000 ? 300 : delay,
        ...args,
      )) as typeof setTimeout);
  try {
    const result = await discoverLiveOffers(
      {
        managesDispatch: true,
        responses: {
          create: async (request, options) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [{ name: offer.name, website: offer.providerUrl }],
                  searchPurpose: "20GB data",
                  namedApps: [],
                  uncertainties: [],
                },
                offer.sources,
              );
            await new Promise((resolve) => realTimeout(resolve, 30));
            options?.signal?.throwIfAborted();
            options?.onDispatch?.();
            return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
          },
        },
      },
      {
        serviceId: "authored-phone",
        name: "Phone plan",
        source: "paypal",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB data",
      },
    );
    expect(result.status).toBe("live");
    expect(result.offers).toEqual([offer]);
  } finally {
    timer.mockRestore();
  }
});

it("allows a slow provider lookup to finish within the bounded research window", async () => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((handler: any, delay: number, ...args: any[]) =>
      realTimeout(
        handler,
        delay === 75_000 ? 100 : delay === 120_000 ? 1000 : delay,
        ...args,
      )) as typeof setTimeout);
  try {
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            if (
              request.text?.format?.type === "json_schema" &&
              request.text.format.name === "OfficialProviders"
            ) {
              await new Promise((resolve) => realTimeout(resolve, 200));
              return webResponse(
                {
                  providers: [{ name: "Fresh Mobile", website: offer.providerUrl }],
                  searchPurpose: "20GB mobile data",
                  namedApps: [],
                  uncertainties: [],
                },
                offer.sources,
              );
            }
            return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
          },
        },
      },
      {
        serviceId: "authored:mobile",
        name: "Current service",
        source: "manual",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB mobile data, no long commitment",
      },
    );
    expect(result.status).toBe("live");
    expect(result.offers).toContainEqual(offer);
    expect(result.coverage?.checked).toContain("freshmobile.co.uk");
  } finally {
    timer.mockRestore();
  }
});

it("requires retrieved provider pricing rather than trusting plausible leads from reviews", async () => {
  for (const verified of [true, false]) {
    const stages: string[] = [];
    const entry = {
      serviceId: "authored:unfamiliar",
      name: "Unfamiliar service",
      purpose: "20GB rolling phone data",
      amountMinor: 1800,
      cycle: "month" as const,
      source: "manual" as const,
    };
    const providers = {
      providers: [{ name: offer.name, website: offer.providerUrl }],
      searchPurpose: entry.purpose,
      namedApps: [],
      uncertainties: [],
    };
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            if (request.text?.format?.type !== "json_schema")
              throw new Error("Expected a structured research stage");
            const stage = request.text.format.name;
            stages.push(stage);
            if (stage === "OfficialProviders")
              return webResponse(providers, ["https://reviews.example.net/article"]);
            if (stage === "OfficialProvidersVerification") {
              const search = request.tools?.find((tool) => tool.type === "web_search");
              expect(search?.type === "web_search" && search.filters?.allowed_domains).toEqual([
                "freshmobile.co.uk",
              ]);
              return webResponse(
                providers,
                verified ? offer.sources : ["https://reviews.example.net/article"],
              );
            }
            return webResponse(
              { offers: [offer], uncertainties: [] },
              verified ? offer.sources : ["https://reviews.example.net/article"],
            );
          },
        },
      },
      entry,
    );
    expect(stages).toEqual([
      "OfficialProviders",
      "ProviderOffers",
      ...(!verified ? ["ProviderOffersRepair"] : []),
    ]);
    expect(result.status).toBe("live");
    expect(result.offers).toEqual(verified ? [offer] : []);
    if (verified) expect(validatedProviderCache(result, entry)?.offers).toEqual([offer]);
    else expect(result.pendingProviders).toContain("freshmobile.co.uk");
  }
});
it("gives each unverified provider its own retrieval so a better-indexed site cannot hide another", async () => {
  const domains = ["first-provider.co.uk", "second-provider.co.uk"];
  const verified: string[] = [];
  const priced: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: domains.map((host) => ({ name: host, website: `https://${host}/plans` })),
                searchPurpose: "20GB rolling mobile data",
                namedApps: [],
                uncertainties: [],
              },
              ["https://independent-review.example.org/guide"],
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected provider retrieval");
          const hosts = tool.filters!.allowed_domains!;
          expect(hosts).toHaveLength(1);
          const host = hosts[0]!;
          if (stage === "OfficialProvidersVerification") {
            verified.push(host);
            return webResponse(
              {
                providers: [{ name: host, website: `https://${host}/plans` }],
                uncertainties: [`Check ${host} help for tethering terms.`],
              },
              [`https://${host}/plans`, `https://${host}/help/tethering`],
            );
          }
          priced.push(host);
          const input = JSON.parse((request.input as any[])[0].content);
          expect(input.providerSources).toEqual([]);
          expect(input.providerFindings).toEqual([]);
          expect(input.providerFindings).not.toContain(
            `Check ${domains.find((value) => value !== host)} help for tethering terms.`,
          );
          const source = `https://${host}/plans`;
          return webResponse(
            {
              offers: [
                {
                  ...offer,
                  name: host,
                  providerUrl: source,
                  sources: [source],
                  priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source },
                  billingEvidence: { quote: "We bill you every calendar month.", source },
                },
              ],
              uncertainties: [],
            },
            [source],
          );
        },
      },
    },
    {
      serviceId: "unfamiliar",
      name: "Current service",
      amountMinor: 1800,
      cycle: "month",
      source: "paypal",
      purpose: "20GB rolling mobile data",
    },
  );
  expect(verified).toEqual([]);
  expect(priced).toEqual(domains);
  expect(result.offers).toHaveLength(2);
  expect(result.coverage?.checked).toEqual(domains);
});

it("prices already-ranked candidates before spending the deadline on unselected provider verification", async () => {
  const ranked = [
    "first-choice.co.uk",
    "second-choice.co.uk",
    "slow-extra.co.uk",
    "another-extra.co.uk",
    "current-provider.co.uk",
  ];
  const verified: string[] = [],
    priced: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: ranked.map((host) => ({ name: host, website: `https://${host}/plans` })),
                searchPurpose: "20GB rolling mobile data",
                namedApps: [],
                uncertainties: [],
              },
              ranked.slice(0, 2).map((host) => `https://${host}/plans`),
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected scoped research.");
          const host = tool.filters!.allowed_domains![0]!,
            source = `https://${host}/plans`;
          if (stage === "OfficialProvidersVerification") {
            verified.push(host);
            if (host === "slow-extra.co.uk" || host === "another-extra.co.uk")
              throw new Error("An unselected provider consumed the research deadline.");
            return webResponse({ providers: [{ name: host, website: source }], uncertainties: [] }, [source]);
          }
          priced.push(host);
          return webResponse(
            {
              offers: [
                {
                  ...offer,
                  name: host,
                  providerUrl: source,
                  sources: [source],
                  priceEvidence: { ...offer.priceEvidence!, source },
                  billingEvidence: { quote: "We bill you every calendar month.", source },
                },
              ],
              uncertainties: [],
            },
            [source],
          );
        },
      },
    },
    {
      serviceId: "unfamiliar-mobile",
      name: "Current mobile plan",
      amountMinor: 1800,
      cycle: "month",
      source: "paypal",
      purpose: "20GB rolling mobile data",
    },
    undefined,
    ["https://current-provider.co.uk/account"],
  );
  expect(result.status).toBe("live");
  expect(verified).toEqual([]);
  expect(priced).toEqual(["current-provider.co.uk", "first-choice.co.uk", "second-choice.co.uk"]);
  expect(result.offers).toHaveLength(3);
  expect(result.coverage?.checked).toEqual(priced);
  expect(result.uncertainties.join(" ")).toMatch(/incomplete/);
});

it("preserves fit-ranked provider leads after verification instead of favouring the first indexed website", async () => {
  const ranked = [
    "first-choice.co.uk",
    "second-choice.co.uk",
    "current-provider.co.uk",
    "indexed-provider.co.uk",
  ];
  const priced: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: ranked.map((host) => ({ name: host, website: `https://${host}/plans` })),
                searchPurpose: "Local photo organisation and RAW editing",
                namedApps: [],
                uncertainties: [],
              },
              ["https://indexed-provider.co.uk/plans"],
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected provider retrieval");
          const host = tool.filters!.allowed_domains![0]!;
          const source = `https://${host}/plans`;
          if (stage === "OfficialProvidersVerification")
            return webResponse({ providers: [{ name: host, website: source }], uncertainties: [] }, [source]);
          priced.push(host);
          return webResponse(
            {
              offers: [
                {
                  ...offer,
                  name: host,
                  providerUrl: source,
                  sources: [source],
                  priceEvidence: { ...offer.priceEvidence!, source },
                  billingEvidence: { quote: "We bill you every calendar month.", source },
                },
              ],
              uncertainties: [],
            },
            [source],
          );
        },
      },
    },
    {
      serviceId: "unfamiliar-photo-service",
      name: "Current provider",
      amountMinor: 1800,
      cycle: "month",
      source: "paypal",
      purpose: "Local photo organisation and RAW editing",
    },
    undefined,
    ["https://current-provider.co.uk/product"],
  );
  expect(priced).toEqual(["current-provider.co.uk", "first-choice.co.uk", "second-choice.co.uk"]);
  expect(result.coverage?.checked).toEqual(priced);
  expect(result.coverage?.incomplete).toContain("indexed-provider.co.uk");
});

it("keeps verified discovery URLs as leads, not substitute price evidence", async () => {
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          const providers = {
            providers: [{ name: offer.name, website: offer.providerUrl }],
            searchPurpose: "20GB rolling phone data",
            namedApps: [],
            uncertainties: [],
          };
          if (stage === "OfficialProviders") return webResponse(providers, offer.sources);
          if (stage === "OfficialProvidersVerification") return webResponse(providers, offer.sources);
          const input = JSON.parse((request.input as any[])[0].content);
          expect(input.providerSources).toEqual(offer.sources);
          return webResponse({ offers: [offer], uncertainties: [] }, ["https://freshmobile.co.uk/help"]);
        },
      },
    },
    {
      serviceId: "unfamiliar",
      name: "Current service",
      amountMinor: 1800,
      cycle: "month",
      source: "paypal",
      purpose: "20GB rolling phone data",
    },
  );
  expect(result.offers).toEqual([]);
  expect(result.validation).toHaveLength(2);
  expect(result.validation?.every((row) => row.accepted === 0)).toBe(true);
});

it("checks discovered providers independently when the first provider has no usable price", async () => {
  const sources = ["https://first-provider.co.uk/plans", offer.providerUrl];
  const searched: string[][] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          if (
            request.text?.format?.type === "json_schema" &&
            request.text.format.name === "OfficialProviders"
          )
            return webResponse(
              {
                providers: sources.map((website) => ({ name: "Provider", website })),
                searchPurpose: "20GB rolling mobile service",
                namedApps: [],
                uncertainties: [],
              },
              sources,
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected bounded provider research.");
          const hosts = tool.filters?.allowed_domains ?? [];
          searched.push(hosts);
          expect((request as { max_tool_calls?: number }).max_tool_calls).toBe(2);
          return hosts.includes("freshmobile.co.uk")
            ? webResponse({ offers: [offer], uncertainties: [] }, offer.sources)
            : webResponse({ offers: [], uncertainties: ["No provider-published price was found."] }, [
                sources[0]!,
              ]);
        },
      },
    },
    {
      serviceId: "authored:mobile",
      name: "Current service",
      amountMinor: 1800,
      cycle: "month",
      purpose: "20GB mobile data and no long commitment",
      source: "manual",
    },
  );
  expect(searched).toEqual([["first-provider.co.uk"], ["freshmobile.co.uk"], ["first-provider.co.uk"]]);
  expect(result.validation?.filter((stage) => stage.stage === "ProviderOffersRepair")).toHaveLength(1);
  expect(result.status).toBe("live");
  expect(result.offers).toEqual([offer]);
  expect(result.coverage).toEqual({
    discovered: ["first-provider.co.uk", "freshmobile.co.uk"],
    checked: ["first-provider.co.uk", "freshmobile.co.uk"],
    incomplete: [],
  });
});

it("checks alternatives while the current provider is slow and prioritises priced repairs after initial coverage", async () => {
  const currentUrl = "https://current-provider.co.uk/plans";
  const thirdUrl = "https://third-provider.co.uk/plans";
  const initial: string[] = [];
  let active = 0,
    maximumActive = 0,
    repairCalls = 0;
  let releaseCurrent!: () => void;
  const currentWaiting = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const escape = setTimeout(() => releaseCurrent(), 1000);
  try {
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [currentUrl, offer.providerUrl, thirdUrl].map((website) => ({
                    name: "Provider",
                    website,
                  })),
                  searchPurpose: "20GB mobile data",
                  namedApps: [],
                  uncertainties: [],
                },
                [currentUrl, offer.providerUrl, thirdUrl],
              );
            const tool = request.tools?.find((item) => item.type === "web_search");
            if (tool?.type !== "web_search") throw new Error("Expected provider research.");
            const host = tool.filters!.allowed_domains![0]!;
            if (stage === "ProviderOffersRepair") {
              repairCalls++;
              expect(initial).toEqual([
                "current-provider.co.uk",
                "freshmobile.co.uk",
                "third-provider.co.uk",
              ]);
              expect(active).toBe(0);
              expect(host).toBe("third-provider.co.uk");
              return webResponse({ offers: [], uncertainties: [] }, [thirdUrl]);
            }
            expect(stage).toBe("ProviderOffers");
            initial.push(host);
            active++;
            maximumActive = Math.max(maximumActive, active);
            try {
              if (host === "current-provider.co.uk") {
                await currentWaiting;
                return webResponse(
                  { offers: [], uncertainties: ["Current provider prices could not be verified."] },
                  [currentUrl],
                );
              }
              if (host === "freshmobile.co.uk") {
                releaseCurrent();
                await new Promise((resolve) => setTimeout(resolve, 10));
                return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
              }
              return webResponse(
                {
                  offers: [
                    {
                      ...offer,
                      providerUrl: thirdUrl,
                      sources: [thirdUrl],
                      billingEvidence: null,
                      priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source: thirdUrl },
                    },
                  ],
                  uncertainties: [],
                },
                [thirdUrl],
              );
            } finally {
              active--;
            }
          },
        },
      },
      {
        serviceId: "other-mobile",
        name: "Current Provider",
        source: "paypal",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB mobile data",
      },
      undefined,
      [currentUrl],
    );
    expect(maximumActive).toBe(2);
    expect(repairCalls).toBe(1);
    expect(result.offers).toEqual([offer]);
    expect(result.coverage?.checked).toEqual([
      "current-provider.co.uk",
      "freshmobile.co.uk",
      "third-provider.co.uk",
    ]);
  } finally {
    clearTimeout(escape);
    releaseCurrent();
  }
});

it("uses the researcher's fit ranking for an unpriced repair instead of always repairing the current provider", async () => {
  const currentUrl = "https://current-provider.co.uk/plans";
  const repairs: string[] = [];
  const checked: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [offer.providerUrl, currentUrl].map((website) => ({ name: "Provider", website })),
                searchPurpose: "20GB mobile data",
                namedApps: [],
                uncertainties: [],
              },
              [offer.providerUrl, currentUrl],
            );
          const tool = request.tools?.find((value) => value.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected provider research.");
          const host = tool.filters!.allowed_domains![0]!;
          if (stage === "ProviderOffersRepair") {
            repairs.push(host);
            return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
          }
          expect(stage).toBe("ProviderOffers");
          checked.push(host);
          return webResponse(
            { offers: [], uncertainties: ["Official provider prices could not be confirmed."] },
            [host === "freshmobile.co.uk" ? offer.providerUrl : currentUrl],
          );
        },
      },
    },
    {
      serviceId: "another-mobile",
      name: "Current Provider",
      source: "paypal",
      amountMinor: 1800,
      cycle: "month",
      purpose: "20GB mobile data",
    },
    undefined,
    [currentUrl],
  );
  expect(checked).toEqual(["current-provider.co.uk", "freshmobile.co.uk"]);
  expect(repairs).toEqual(["freshmobile.co.uk"]);
  expect(result.offers).toEqual([offer]);
});

it.each(["validated", "unpriced", "unretrieved", "access-denied"])(
  "preserves only validated offers when a later research request is stopped (%s)",
  async (scenario) => {
    const later = "https://later-provider.co.uk/plans";
    const domains: string[][] = [];
    const stopped = new HttpError(
      scenario === "access-denied" ? 403 : 429,
      scenario === "access-denied" ? "judge_access_required" : "judge_budget_exhausted",
      "Stopped by the funded request guard.",
    );
    const pending = discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            if (
              request.text?.format?.type === "json_schema" &&
              request.text.format.name === "OfficialProviders"
            )
              return webResponse(
                {
                  providers: [offer.providerUrl, later].map((website) => ({ name: "Provider", website })),
                  searchPurpose: "20GB rolling data",
                  namedApps: [],
                  uncertainties: [],
                },
                [...offer.sources, later],
              );
            const tool = request.tools?.find((tool) => tool.type === "web_search");
            if (tool?.type !== "web_search") throw new Error("Expected bounded provider search");
            const hosts = tool.filters?.allowed_domains ?? [];
            domains.push(hosts);
            if (hosts.includes("later-provider.co.uk")) throw stopped;
            return webResponse(
              { offers: scenario === "unpriced" ? [] : [offer], uncertainties: [] },
              scenario === "unretrieved" ? ["https://unrelated-source.co.uk/"] : offer.sources,
            );
          },
        },
      },
      {
        serviceId: "authored:mobile",
        name: "Current service",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB rolling data",
        source: "manual",
      },
    );
    if (scenario === "validated") {
      const result = await pending;
      expect(result.status).toBe("live");
      expect(result.offers).toEqual([offer]);
      expect(result.coverage).toEqual({
        discovered: ["freshmobile.co.uk", "later-provider.co.uk"],
        checked: ["freshmobile.co.uk"],
        incomplete: ["later-provider.co.uk"],
      });
      expect(result.sourceGaps).toContain(
        "The research allowance was reached before all provider checks finished.",
      );
    } else {
      await expect(pending).rejects.toBe(stopped);
    }
    expect(domains.at(-1)).toEqual(["later-provider.co.uk"]);
  },
);

it("checks the current provider's cheaper tiers without losing alternative-provider coverage", async () => {
  const sites = [
    "one-provider.co.uk",
    "two-provider.co.uk",
    "three-provider.co.uk",
    "current-provider.co.uk",
  ];
  const checked: string[] = [];
  await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          if (
            request.text?.format?.type === "json_schema" &&
            request.text.format.name === "OfficialProviders"
          )
            return webResponse(
              {
                providers: sites.map((host, index) => ({
                  name: index === 3 ? "Harbour Audio" : `Alternative ${index}`,
                  website: `https://${host}/plans`,
                })),
                searchPurpose: "Offline music on Android",
                namedApps: [],
                uncertainties: [],
              },
              sites.map((host) => `https://${host}/plans`),
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected official-domain search");
          checked.push(...tool.filters!.allowed_domains!);
          return webResponse({ offers: [], uncertainties: [] }, [`https://${checked.at(-1)}/plans`]);
        },
      },
    },
    {
      serviceId: "authored:harbour",
      name: "Harbour Audio Premium",
      amountMinor: 1500,
      cycle: "month",
      source: "manual",
      purpose: "Offline music on Android",
    },
  );
  expect(checked).toEqual(["current-provider.co.uk", "one-provider.co.uk", "two-provider.co.uk"]);
});
it("independently verifies the current product's identity domain even when broad discovery found three alternatives", async () => {
  const alternatives = ["one-provider.co.uk", "two-provider.co.uk", "three-provider.co.uk"];
  const currentUrl = "https://current-provider.co.uk/pricing";
  const checked: string[] = [];
  const entry = {
    serviceId: "paypal:uncatalogued",
    name: "Harbour Reader",
    amountMinor: 1500,
    cycle: "month" as const,
    source: "paypal" as const,
    purpose: "Reading ordinary RSS feeds in a browser",
  };
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const input = JSON.parse((request.input as any[])[0].content);
          expect(input.currentProviderDomains).toEqual(["current-provider.co.uk"]);
          expect(JSON.stringify(input)).not.toContain("private-payment-token");
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: alternatives.map((host) => ({ name: host, website: `https://${host}/` })),
                searchPurpose: entry.purpose,
                namedApps: [],
                uncertainties: [],
              },
              alternatives.map((host) => `https://${host}/`),
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected scoped provider research");
          if (stage === "OfficialProvidersVerification") {
            expect(tool.filters?.allowed_domains).toEqual(["current-provider.co.uk"]);
            return webResponse(
              {
                providers: [{ name: "Harbour Software Ltd", website: currentUrl }],
                searchPurpose: entry.purpose,
                namedApps: [],
                uncertainties: [],
              },
              [currentUrl],
            );
          }
          checked.push(...tool.filters!.allowed_domains!);
          return webResponse(
            {
              offers:
                checked.at(-1) === "current-provider.co.uk"
                  ? [
                      {
                        ...offer,
                        name: "Harbour Reader",
                        plan: "Basic",
                        providerUrl: currentUrl,
                        features: ["Read RSS in a browser"],
                        sources: [currentUrl],
                        priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source: currentUrl },
                        billingEvidence: { quote: "We bill you every calendar month.", source: currentUrl },
                      },
                    ]
                  : [],
              uncertainties: [],
            },
            [`https://${checked.at(-1)}/pricing`],
          );
        },
      },
    },
    entry,
    undefined,
    ["https://current-provider.co.uk/product?payment=private-payment-token"],
  );
  expect(checked).toEqual(["current-provider.co.uk", "one-provider.co.uk", "two-provider.co.uk"]);
  expect(result.offers).toHaveLength(1);
  expect(validatedProviderCache(result, entry)?.offers).toHaveLength(1);
});
it("keeps the current provider first when a support subdomain is replaced by its discovered parent", async () => {
  const domains = ["one-provider.co.uk", "two-provider.co.uk", "three-provider.co.uk", "harbour.co.uk"];
  const verified: string[] = [],
    priced: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: domains.map((host) => ({ name: host, website: `https://${host}/plans` })),
                searchPurpose: "Offline listening",
                namedApps: [],
                uncertainties: [],
              },
              ["https://independent-review.example.org/guide"],
            );
          const tool = request.tools?.find((t) => t.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected bounded research");
          const host = tool.filters!.allowed_domains![0]!;
          if (stage === "OfficialProvidersVerification") {
            verified.push(host);
            expect(request.instructions).toContain("narrow provider-identity check");
            return webResponse(
              { providers: [{ name: host, website: `https://${host}/plans` }], uncertainties: [] },
              [`https://${host}/plans`],
            );
          }
          priced.push(host);
          return webResponse({ offers: [], uncertainties: [] }, [`https://${host}/plans`]);
        },
      },
    },
    {
      serviceId: "opaque:harbour",
      name: "Harbour Audio Premium",
      amountMinor: 1500,
      cycle: "month",
      source: "paypal",
      purpose: "Offline listening",
    },
    undefined,
    ["https://support.harbour.co.uk/help"],
  );
  expect(verified).toEqual([]);
  expect(priced).toEqual(["harbour.co.uk", "one-provider.co.uk", "two-provider.co.uk"]);
  expect(result.sourceGaps).not.toContain(
    "The current provider's cheaper plans could not be independently checked.",
  );
});

it.each([
  { support: "help.harbour.co.uk", provider: "harbour.co.uk", alternative: "another.co.uk" },
  { support: "help.harbour.github.io", provider: "harbour.github.io", alternative: "another.github.io" },
])(
  "finds regional pricing outside $support without crossing provider boundaries",
  async ({ support, provider, alternative }) => {
    const checked: string[] = [];
    const priceUrl = `https://${provider}/gb/plans`;
    const entry: import("../src/shared/subscriptions").SubscriptionEntry = {
      serviceId: "opaque:harbour",
      name: "Harbour Audio",
      source: "paypal",
      amountMinor: 1500,
      cycle: "month",
      purpose: "Offline music for one listener",
    };
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [
                    { name: "Harbour Audio", website: `https://${support}/plans` },
                    { name: "Another", website: `https://${alternative}/plans` },
                  ],
                  searchPurpose: "Offline music for one listener",
                  namedApps: [],
                  uncertainties: [],
                },
                [`https://${support}/plans`, `https://${alternative}/plans`],
              );
            const tool = request.tools?.find((item) => item.type === "web_search");
            if (tool?.type !== "web_search") throw new Error("Expected provider research");
            expect(stage).toBe("ProviderOffers");
            const host = tool.filters!.allowed_domains![0]!;
            checked.push(host);
            return webResponse(
              {
                offers:
                  host === provider
                    ? [
                        {
                          ...offer,
                          name: "Harbour Audio",
                          plan: "Solo",
                          providerUrl: priceUrl,
                          features: ["Offline ad-free music for one listener"],
                          sources: [priceUrl],
                          priceEvidence: { kind: "direct_gbp", quote: "£8 per month", source: priceUrl },
                          billingEvidence: { quote: "We bill you every calendar month.", source: priceUrl },
                        },
                      ]
                    : [],
                uncertainties: [],
              },
              [host === provider ? priceUrl : `https://${host}/plans`],
            );
          },
        },
      },
      entry,
      undefined,
      [`https://${support}/help?account=never-send-this`],
    );
    expect(checked).toEqual([provider, alternative]);
    expect(result.offers).toHaveLength(1);
    expect(result.offers[0]!.providerUrl).toBe(priceUrl);
    expect(result.coverage?.checked).toEqual([provider, alternative]);
    expect(validatedProviderCache(result, entry)?.offers).toHaveLength(1);
  },
);

it("keeps alternative coverage when an earlier product-identity domain cannot be freshly verified", async () => {
  const alternatives = ["one-provider.co.uk", "two-provider.co.uk", "three-provider.co.uk"];
  const checked: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: alternatives.map((host) => ({ name: host, website: `https://${host}/` })),
                searchPurpose: "Reading feeds",
                namedApps: [],
                uncertainties: [],
              },
              alternatives.map((host) => `https://${host}/`),
            );
          if (stage === "OfficialProvidersVerification")
            return webResponse(
              {
                providers: [{ name: "Harbour Reader", website: "https://unverified-current.co.uk/" }],
                searchPurpose: "Reading feeds",
                namedApps: [],
                uncertainties: [],
              },
              ["https://unrelated-provider.co.uk/"],
            );
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          if (tool?.type !== "web_search") throw new Error("Expected scoped search");
          checked.push(...tool.filters!.allowed_domains!);
          return webResponse({ offers: [], uncertainties: [] }, [`https://${checked.at(-1)}/`]);
        },
      },
    },
    {
      serviceId: "paypal:unknown",
      name: "Harbour Reader",
      amountMinor: 1500,
      cycle: "month",
      source: "paypal",
      purpose: "Reading feeds",
    },
    undefined,
    ["https://unverified-current.co.uk/product"],
  );
  expect(checked).toEqual(["unverified-current.co.uk", ...alternatives.slice(0, 2)]);
  expect(result.coverage?.discovered).toContain("unverified-current.co.uk");
  expect(result.uncertainties).toContain(
    "The current provider's cheaper plans could not be priced from the checked sources.",
  );
});
it.each(["timeout", "excluded-source"])(
  "keeps verified offers when another provider fails (%s) and discloses incomplete coverage",
  async (failure) => {
    let prices = 0;
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            if (
              request.text?.format?.type === "json_schema" &&
              request.text.format.name === "OfficialProviders"
            )
              return webResponse(
                {
                  providers: [
                    { website: offer.providerUrl },
                    { website: "https://other-provider.co.uk/plans" },
                  ],
                  searchPurpose: "20GB mobile data",
                  namedApps: [],
                },
                [...offer.sources, "https://other-provider.co.uk/plans"],
              );
            if (++prices === 1) return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
            if (failure === "excluded-source")
              throw Anthropic.APIError.generate(
                400,
                {
                  type: "error",
                  error: {
                    type: "invalid_request_error",
                    message:
                      "The following domains are not accessible to our user agent: ['other-provider.co.uk'].",
                  },
                },
                "The following domains are not accessible to our user agent: ['other-provider.co.uk'].",
                new Headers(),
              );
            throw new Error("Synthetic provider timeout");
          },
        },
      },
      {
        serviceId: "authored:mobile",
        name: "Current service",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB mobile data",
        source: "manual",
      },
    );
    expect(result.status).toBe("live");
    expect(prices).toBe(2);
    expect(result.offers).toEqual([offer]);
    expect(result.coverage?.incomplete).toEqual(["other-provider.co.uk"]);
    expect(result.uncertainties.join(" ")).toMatch(/incomplete/);
  },
);
it.each([true, false])(
  "treats uncited discovery as leads and still requires provider retrieval receipts (retrieved=%s)",
  async (retrieved) => {
    const stages: string[] = [];
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            stages.push(stage);
            if (stage === "OfficialProviders")
              return {
                ...webResponse(
                  {
                    providers: [{ website: offer.providerUrl }],
                    searchPurpose: "20GB mobile data",
                    namedApps: [],
                  },
                  [],
                ),
                status: "incomplete",
              };
            return webResponse({ offers: [offer], uncertainties: [] }, retrieved ? offer.sources : []);
          },
        },
      },
      {
        serviceId: "authored:new",
        name: "An unfamiliar mobile service",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB mobile data",
        source: "manual",
      },
    );
    expect(stages).toContain("ProviderOffers");
    expect(result.offers).toEqual(retrieved ? [offer] : []);
    if (!retrieved) expect(result.uncertainties.length).toBeGreaterThan(0);
  },
);

it("continues with independently verified providers when an unverified candidate excludes the crawler", async () => {
  const stages: string[] = [];
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          stages.push(stage);
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [{ website: offer.providerUrl }, { website: "https://other-provider.co.uk/" }],
                searchPurpose: "20GB mobile data",
                namedApps: [],
              },
              offer.sources,
            );
          if (
            (request.tools?.find((tool) => tool.type === "web_search") as any)?.filters
              ?.allowed_domains?.[0] === "other-provider.co.uk"
          )
            throw Anthropic.APIError.generate(
              400,
              {
                type: "error",
                error: {
                  type: "invalid_request_error",
                  message:
                    "The following domains are not accessible to our user agent: ['other-provider.co.uk'].",
                },
              },
              "The following domains are not accessible to our user agent: ['other-provider.co.uk'].",
              new Headers(),
            );
          expect(request.tools).toMatchObject([
            { type: "web_search", filters: { allowed_domains: ["freshmobile.co.uk"] } },
          ]);
          return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
        },
      },
    },
    {
      serviceId: "authored:mobile",
      name: "Current service",
      amountMinor: 1800,
      cycle: "month",
      purpose: "20GB mobile data",
      source: "manual",
    },
  );
  expect(stages).toEqual(["OfficialProviders", "ProviderOffers", "ProviderOffers"]);
  expect(result.status).toBe("live");
  expect(result.offers).toEqual([offer]);
  expect(result.uncertainties.join(" ")).toMatch(/could not be read or independently verified/);
});

it.each(["missing_sources", "invalid_json"])(
  "keeps independently retrieved alternatives when current-provider verification returns %s",
  async (failure) => {
    const priced: string[] = [];
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [{ website: offer.providerUrl }],
                  searchPurpose: "20GB rolling mobile data",
                  namedApps: [],
                },
                offer.sources,
              );
            if (
              (request.tools?.find((tool) => tool.type === "web_search") as any)?.filters
                ?.allowed_domains?.[0] === "current-provider.co.uk"
            ) {
              if (failure === "invalid_json") throw new SyntaxError("Malformed provider response.");
              const response = webResponse({ providers: [], uncertainties: [] }, []);
              response.status = "incomplete";
              const search = response.output.find((item) => item.type === "web_search_call");
              if (search?.type === "web_search_call") search.status = "failed";
              return response;
            }
            const search = request.tools?.find((tool) => tool.type === "web_search");
            expect(search?.type === "web_search" && search.filters?.allowed_domains).toEqual([
              "freshmobile.co.uk",
            ]);
            priced.push(stage);
            return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
          },
        },
      },
      {
        serviceId: "unfamiliar-mobile",
        name: "Current mobile plan",
        amountMinor: 1800,
        cycle: "month",
        source: "paypal",
        purpose: "20GB rolling mobile data",
      },
      undefined,
      ["https://current-provider.co.uk/account"],
    );
    expect(priced).toEqual(["ProviderOffers"]);
    expect(result.status).toBe("live");
    expect(result.offers).toEqual([offer]);
    expect(result.coverage?.checked).toEqual(["freshmobile.co.uk"]);
    expect(result.coverage?.discovered).toEqual(["freshmobile.co.uk", "current-provider.co.uk"]);
    expect(result.coverage?.incomplete).toEqual(["current-provider.co.uk"]);
    expect(result.uncertainties.join(" ")).toMatch(/could not be read or independently verified/);
    expect(result.uncertainties.join(" ")).toMatch(/current provider.*could not be priced/i);
    expect(result.evidence.some((item) => item.stage === "ProviderOffers")).toBe(true);
  },
);

it("leaves time to price another provider when the first provider stops responding", async () => {
  const realTimeout = globalThis.setTimeout;
  const timer = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((handler: any, delay: number, ...args: any[]) =>
      realTimeout(
        handler,
        delay === 45_000 ? 10 : delay === 120_000 ? 150 : delay,
        ...args,
      )) as typeof setTimeout);
  const priced: string[] = [];
  try {
    const result = await discoverLiveOffers(
      {
        responses: {
          create: async (request, options) => {
            options?.signal?.throwIfAborted();
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            if (stage === "OfficialProviders")
              return webResponse(
                {
                  providers: [
                    { name: "Slow provider", website: "https://slow-provider.co.uk/plans" },
                    { name: offer.name, website: offer.providerUrl },
                  ],
                  searchPurpose: "20GB rolling mobile data",
                  namedApps: [],
                  uncertainties: [],
                },
                ["https://slow-provider.co.uk/plans", ...offer.sources],
              );
            const search = request.tools?.find((tool) => tool.type === "web_search");
            const host = search?.type === "web_search" ? search.filters?.allowed_domains?.[0] : undefined;
            priced.push(host!);
            if (host === "slow-provider.co.uk")
              return new Promise((_, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("Provider stopped responding.")),
                  { once: true },
                );
              });
            return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
          },
        },
      },
      {
        serviceId: "unfamiliar-mobile",
        name: "Current mobile service",
        source: "paypal",
        amountMinor: 1800,
        cycle: "month",
        purpose: "20GB rolling mobile data",
      },
    );
    expect(result.status).toBe("live");
    expect(result.offers).toEqual([offer]);
    expect(priced).toEqual(["slow-provider.co.uk", "freshmobile.co.uk"]);
    expect(result.coverage?.incomplete).toEqual(["slow-provider.co.uk"]);
  } finally {
    timer.mockRestore();
  }
});

it("removes refused candidates without letting them block verification of the remaining official sites", async () => {
  const filters: string[][] = [];
  let verified = false;
  const result = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return webResponse(
              {
                providers: [
                  { website: "https://blocked-one.co.uk/" },
                  { website: "https://blocked-two.co.uk/" },
                  { website: offer.providerUrl },
                ],
                searchPurpose: "20GB mobile data",
                namedApps: [],
              },
              ["https://neutral-source.co.uk/overview"],
            );
          const tool = request.tools?.find((row: any) => row.type === "web_search") as any;
          const hosts = tool.filters.allowed_domains;
          {
            filters.push(hosts);
            const blocked = hosts.find((host: string) => host.startsWith("blocked-"));
            if (blocked) {
              const message = `The following domains are not accessible to our user agent: ['${blocked}'].`;
              throw Anthropic.APIError.generate(
                400,
                { type: "error", error: { type: "invalid_request_error", message } },
                message,
                new Headers(),
              );
            }
            verified = true;
          }
          expect(verified).toBe(true);
          expect(hosts).toEqual(["freshmobile.co.uk"]);
          return webResponse({ offers: [offer], uncertainties: [] }, offer.sources);
        },
      },
    },
    {
      serviceId: "authored:mobile",
      name: "Current service",
      amountMinor: 1800,
      cycle: "month",
      purpose: "20GB mobile data",
      source: "manual",
    },
  );
  expect(filters).toEqual([["blocked-one.co.uk"], ["blocked-two.co.uk"], ["freshmobile.co.uk"]]);
  expect(result.status).toBe("live");
  expect(result.offers).toEqual([offer]);
  expect(result.coverage?.discovered).toEqual([
    "blocked-one.co.uk",
    "blocked-two.co.uk",
    "freshmobile.co.uk",
  ]);
  expect(result.pendingProviders).toEqual(["blocked-one.co.uk", "blocked-two.co.uk"]);
  expect(result.uncertainties.join(" ")).toMatch(/could not be read/);
});

it("revalidates recent durable provider evidence without reusing stale or unpriced research", () => {
  const checkedAt = new Date().toISOString();
  const evidence = [
    {
      stage: "OfficialProviders",
      output: webResponse({ providers: [{ website: offer.providerUrl }] }, offer.sources).output,
    },
    { stage: "ProviderOffers", output: webResponse({ offers: [offer] }, offer.sources).output },
  ];
  const saved = { status: "live", checkedAt, offers: [offer], namedApps: [], evidence };
  const entry = {
    serviceId: "three",
    name: "Three",
    source: "manual" as const,
    amountMinor: 1800,
    cycle: "month" as const,
    purpose: "Mobile data",
  };
  expect(validatedProviderCache(saved, entry)?.offers).toEqual([offer]);
  expect(validatedProviderCache(saved, entry, Date.parse(checkedAt) + 900_000)).toBeNull();
  expect(
    validatedProviderCache({ ...saved, offers: [{ ...offer, priceEvidence: undefined }] }, entry)?.offers,
  ).toEqual([]);
  expect(validatedProviderCache({ ...saved, namedApps: ["TikTok"] }, entry)).toBeNull();
  expect(validatedProviderCache({ ...saved, evidence: [] }, entry)).toBeNull();
});

it("admits only returned sources on the discovered provider's own domain", () => {
  const sources = new Set([
    offer.providerUrl,
    "https://uswitch.com/sim-only/",
    "https://another-provider.co.uk/plans",
  ]);
  expect(acceptedOffers({ offers: [offer] }, sources, ["freshmobile.co.uk"])).toEqual([offer]);
  for (const bad of [
    { ...offer, providerUrl: "https://uswitch.com/sim-only/" },
    { ...offer, sources: ["https://uswitch.com/sim-only/"] },
    { ...offer, sources: ["https://another-provider.co.uk/plans"] },
    { ...offer, sources: ["https://freshmobile.co.uk/not-retrieved"] },
    { ...offer, currency: "USD" },
    { ...offer, market: "US" },
    { ...offer, priceMinor: -1 },
    { ...offer, renewalMinor: 999 },
  ])
    expect(acceptedOffers({ offers: [bad] }, sources, ["freshmobile.co.uk"])).toEqual([]);
  expect(
    responseSources(webResponse({}, [offer.providerUrl, "https://uswitch.com/sim-only/"])).sources,
  ).toEqual(new Set([offer.providerUrl]));
});
it("rejects local, credential-bearing and non-HTTPS provider links", () => {
  for (const url of [
    "http://freshmobile.co.uk",
    "https://127.0.0.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://localhost/",
    "https://host.internal/",
    "https://user:pass@freshmobile.co.uk/",
    "https://freshmobile.co.uk:13216/",
    "https://community.freshmobile.co.uk/prices",
    "javascript:alert(1)",
  ])
    expect(providerUrl(url)).toBeNull();
});
it("requires an explicit sourced verdict for every named app rather than assuming all social/video apps are included", () => {
  const apps = ["TikTok", "YouTube"];
  const coverage = [
    {
      app: "TikTok",
      status: "unknown" as const,
      evidence: "Marketing and the explicit included-app list differ.",
      source: null,
    },
    {
      app: "YouTube",
      status: "included" as const,
      evidence: "The official video list explicitly includes YouTube.",
      source: offer.providerUrl,
    },
  ];
  const candidate = { ...offer, appCoverage: coverage };
  expect(acceptedOffers({ offers: [offer] }, new Set(offer.sources), ["freshmobile.co.uk"], apps)).toEqual(
    [],
  );
  expect(
    acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], apps),
  ).toEqual([candidate]);
  expect(
    acceptedOffers(
      { offers: [{ ...candidate, appCoverage: coverage.slice(1) }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
      apps,
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      { offers: [{ ...candidate, appCoverage: [{ ...coverage[0], status: "included" }, coverage[1]] }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
      apps,
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...candidate,
            appCoverage: [{ ...coverage[0], source: "https://uswitch.com/sim-only/" }, coverage[1]],
          },
        ],
      },
      new Set([...offer.sources, "https://uswitch.com/sim-only/"]),
      ["freshmobile.co.uk"],
      apps,
    ),
  ).toEqual([]);
});
it("matches retrieved pages across tracking IDs while keeping content, plan and locale distinct", () => {
  const source = "https://freshmobile.co.uk/plans?plan=100&msockid=tracking&utm_source=search";
  const { sources } = responseSources(webResponse({}, [source]));
  const candidate = {
    ...offer,
    providerUrl: "https://freshmobile.co.uk/plans?plan=100",
    sources: ["https://freshmobile.co.uk/plans?plan=100"],
  };
  expect(acceptedOffers({ offers: [candidate] }, sources, ["freshmobile.co.uk"])).toHaveLength(1);
  for (const url of [
    "https://freshmobile.co.uk/plans?plan=200",
    "https://freshmobile.co.uk/en-us/plans?plan=100",
    "https://freshmobile.co.uk/other?plan=100",
  ])
    expect(
      acceptedOffers({ offers: [{ ...candidate, providerUrl: url, sources: [url] }] }, sources, [
        "freshmobile.co.uk",
      ]),
    ).toEqual([]);
  expect(providerUrl("https://freshmobile.co.uk/plans ([site](https://freshmobile.co.uk/plans))")).toBeNull();
});
it("requires a matching provider GBP quote, keeping direct charges distinct from published currency equivalents", () => {
  const sources = new Set(offer.sources);
  expect(acceptedOffers({ offers: [offer] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([offer]);
  for (const candidate of [
    { ...offer, priceEvidence: undefined },
    { ...offer, priceEvidence: { kind: "direct_gbp", quote: "Approximately £8", source: offer.providerUrl } },
    { ...offer, priceEvidence: { kind: "direct_gbp", quote: "£10 per month", source: offer.providerUrl } },
    { ...offer, introductoryCycles: 3, renewalMinor: 1200 },
  ])
    expect(acceptedOffers({ offers: [candidate] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([]);
  const equivalent = {
    ...offer,
    priceEvidence: {
      kind: "currency_equivalent" as const,
      quote: "€5 is equivalent to £8",
      source: offer.providerUrl,
    },
  };
  expect(acceptedOffers({ offers: [equivalent] }, sources, ["freshmobile.co.uk"], [], true)).toEqual([
    equivalent,
  ]);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...equivalent,
            priceEvidence: { ...equivalent.priceEvidence, source: "https://uswitch.com/convert" },
          },
        ],
      },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      { offers: [{ ...equivalent, priceEvidence: { ...equivalent.priceEvidence, quote: "£8 per month" } }] },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...offer,
            introductoryCycles: 3,
            renewalMinor: 1200,
            priceEvidence: {
              kind: "direct_gbp",
              quote: "£8 a month for 3 months, then £12 a month",
              source: offer.providerUrl,
            },
          },
        ],
      },
      sources,
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toHaveLength(1);
});
it("does not mistake a 30-day introductory free trial for the paid monthly billing cycle", () => {
  const candidate = {
    ...offer,
    conditions: ["A free 30-day trial for new subscribers; excluded from the listed paid price."],
  };
  expect(
    acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
  ).toEqual([candidate]);
  expect(
    acceptedOffers(
      { offers: [{ ...candidate, conditions: ["Renews every 30 days."] }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
      [],
      true,
    ),
  ).toEqual([]);
});
it("rejects marketplace pricing even when the listing was retrieved and described as official", () => {
  for (const url of [
    "https://apps.apple.com/gb/app/ticktick/id626144601",
    "https://play.google.com/store/apps/details?id=example",
    "https://store.steampowered.com/app/123/",
    "https://apps.microsoft.com/detail/example",
  ]) {
    const candidate = {
      ...offer,
      providerUrl: url,
      sources: [url],
      priceEvidence: { ...offer.priceEvidence!, source: url },
    };
    expect(
      acceptedOffers({ offers: [candidate] }, new Set([url]), [new URL(url).hostname], [], true),
    ).toEqual([]);
    expect(isProviderPriceSource({ url, source_type: "provider" })).toBe(false);
  }
});
it("admits evidenced ongoing free plans without inventing zero prices for trials or paid plans", () => {
  const free = {
    ...offer,
    plan: "Free ongoing plan",
    priceMinor: 0,
    renewalMinor: 0,
    priceEvidence: { kind: "free" as const, quote: "Free forever", source: offer.providerUrl },
  };
  expect(acceptedOffers({ offers: [free] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true)).toEqual(
    [free],
  );
  expect(offerBudget(free).annualMinor).toBe(0);
  for (const candidate of [
    { ...free, priceMinor: 800, renewalMinor: 800 },
    { ...free, introductoryCycles: 1 },
    { ...free, priceEvidence: { ...free.priceEvidence, quote: "Free trial" } },
    { ...free, priceEvidence: { ...free.priceEvidence, quote: "Free for three months" } },
    { ...free, priceEvidence: { ...free.priceEvidence, quote: "Our best value plan" } },
  ])
    expect(
      acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
    ).toEqual([]);
});
it.each(["USD", "EUR"] as const)(
  "accepts an evidenced ongoing free plan displayed in %s without inventing an exchange rate",
  (currency) => {
    const free: LiveOffer = {
      ...offer,
      currency,
      priceMinor: 0,
      renewalMinor: 0,
      billingEvidence: null,
      priceEvidence: {
        kind: "free",
        quote: "Our plan is free forever. No credit card required.",
        source: offer.providerUrl,
      },
    };
    const accepted = acceptedOffers(
      { offers: [free] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
      [],
      true,
    );
    expect(accepted).toEqual([{ ...free, currency: "GBP" }]);
    expect(free.currency).toBe(currency);
    expect(offerBudget(accepted[0]!).annualMinor).toBe(0);
    for (const quote of ["Free trial", "Free for three months", "Our standard paid plan"])
      expect(
        acceptedOffers(
          { offers: [{ ...free, priceEvidence: { ...free.priceEvidence!, quote } }] },
          new Set(offer.sources),
          ["freshmobile.co.uk"],
          [],
          true,
        ),
      ).toEqual([]);
    expect(
      acceptedOffers(
        { offers: [{ ...free, priceMinor: 500, renewalMinor: 500 }] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
      ),
    ).toEqual([]);
    const feesUnknown = { ...free, upfrontMinor: null };
    expect(
      acceptedOffers({ offers: [feesUnknown] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true)[0]
        ?.currency,
    ).toBe(currency);
  },
);
it("keeps provider-only pricing in the saved fallback as well", () => {
  expect(isProviderPriceSource({ url: "https://www.spotify.com/uk/premium/", source_type: "provider" })).toBe(
    true,
  );
  for (const source of [
    { url: "https://apps.apple.com/gb/app/example", source_type: "official_store" },
    { url: "https://store.steampowered.com/app/123/", source_type: "provider" },
    { url: "https://uswitch.com/offers", source_type: "provider" },
  ])
    expect(isProviderPriceSource(source)).toBe(false);
});
it("budgets introductory rates, renewal, known upfront fees and 30-day versus annual billing", () => {
  expect(
    offerBudget({ ...offer, priceMinor: 200, introductoryCycles: 3, renewalMinor: 1000, upfrontMinor: 500 }),
  ).toMatchObject({ annualMinor: 10100, cycles: 12 });
  expect(
    offerBudget({ ...offer, priceMinor: 1000, renewalMinor: 1000, billingUnit: "30_days" }),
  ).toMatchObject({ annualMinor: 13000, cycles: 13 });
  expect(offerBudget({ ...offer, priceMinor: 9900, renewalMinor: 9900, billingUnit: "year" })).toMatchObject({
    annualMinor: 9900,
    cycles: 1,
  });
  expect(
    acceptedOffers({ offers: [{ ...offer, renewalMinor: null }] }, new Set(offer.sources), [
      "freshmobile.co.uk",
    ]),
  ).toEqual([]);
  expect(
    acceptedOffers(
      { offers: [{ ...offer, plan: "Rolling 30-day SIM", billingUnit: "month" }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
    ),
  ).toEqual([]);
  expect(
    acceptedOffers(
      { offers: [{ ...offer, plan: "Rolling 30-day SIM", billingUnit: "30_days" }] },
      new Set(offer.sources),
      ["freshmobile.co.uk"],
    ),
  ).toHaveLength(1);
});
it("refuses a flat budget when provider conditions disclose an unrepresented price rise", () => {
  const sources = new Set(offer.sources);
  expect(
    acceptedOffers(
      { offers: [{ ...offer, conditions: ["Any future price-rise details were not extractable."] }] },
      sources,
      ["freshmobile.co.uk"],
    ),
  ).toEqual([]);
  expect(
    acceptedOffers({ offers: [{ ...offer, conditions: ["No annual price increase."] }] }, sources, [
      "freshmobile.co.uk",
    ]),
  ).toHaveLength(1);
  expect(
    acceptedOffers(
      {
        offers: [
          {
            ...offer,
            priceMinor: 800,
            introductoryCycles: 5,
            renewalMinor: 1030,
            conditions: ["The monthly charge increases after five paid cycles."],
          },
        ],
      },
      sources,
      ["freshmobile.co.uk"],
    ),
  ).toHaveLength(1);
});

it("keeps an evidenced flat price when its only price-change notice is generic", () => {
  for (const notice of [
    "Prices may change.",
    "The price might increase over time.",
    "Prices could change in the future.",
    "Price may change; check that your device is compatible.",
  ])
    expect(
      acceptedOffers(
        { offers: [{ ...offer, conditions: [notice] }] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
      ),
    ).toHaveLength(1);
});

it("rejects explicitly unconfirmed historical or current recurring prices", () => {
  for (const conditions of [
    ["Price taken from a December 2024 announcement; the current GBP amount is not confirmed."],
    ["Price is from a 2023 announcement and may have changed."],
    ["The provider's current checkout price and Windows support are not verified."],
    ["Current monthly amount is unverified."],
    ["Price from a December 2024 blog; confirm current checkout price."],
    ["The current renewal price is unconfirmed."],
  ]) {
    const rejected: unknown[] = [];
    expect(
      acceptedOffers(
        { offers: [{ ...offer, conditions }] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
        (rejection) => rejected.push(rejection),
      ),
    ).toEqual([]);
    expect(rejected).toEqual([{ offerIndex: 0, code: "price_freshness" }]);
  }
});

it("keeps active prices on older evergreen pages and separates compatibility and fee uncertainty", () => {
  for (const conditions of [
    ["The help page was first published in 2022; the provider still offers this price today."],
    ["Current price is £8, but device compatibility is unverified."],
    ["Current setup charge is unknown."],
    ["Prices may change."],
    [
      "Renewal terms for the one-month plan beyond its displayed monthly price were not separately confirmed.",
    ],
  ])
    expect(
      acceptedOffers(
        { offers: [{ ...offer, conditions }] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
      ),
    ).toHaveLength(1);
});

it("preserves current native prices and published equivalents when GBP conversion is unconfirmed", () => {
  const candidates: LiveOffer[] = [
    {
      ...offer,
      currency: "USD",
      conditions: ["Current GBP price after conversion is unverified."],
      priceEvidence: { kind: "native_currency", quote: "USD 8 per month", source: offer.providerUrl },
    },
    {
      ...offer,
      currency: "EUR",
      conditions: ["The EUR price is current, but GBP conversion fees are unknown."],
      priceEvidence: { kind: "native_currency", quote: "EUR 8 per month", source: offer.providerUrl },
    },
    {
      ...offer,
      conditions: ["Current GBP charge after card conversion is unconfirmed."],
      priceEvidence: {
        kind: "currency_equivalent",
        quote: "€10 is equivalent to £8",
        source: offer.providerUrl,
      },
    },
  ];
  for (const candidate of candidates)
    expect(
      acceptedOffers({ offers: [candidate] }, new Set(offer.sources), ["freshmobile.co.uk"], [], true),
    ).toHaveLength(1);
});

it("still rejects possible increases with dates, amounts, relative terms or inflation linkage", () => {
  for (const notice of [
    "Prices may increase from £8 to £10 next month.",
    "Prices may rise from April 2027.",
    "Prices may change; the monthly charge increases after twelve months.",
    "Prices may change in line with CPI.",
    "The price might rise after twelve months.",
    "Prices may change; £10 from April 2027.",
  ])
    expect(
      acceptedOffers(
        { offers: [{ ...offer, conditions: [notice] }] },
        new Set(offer.sources),
        ["freshmobile.co.uk"],
        [],
        true,
      ),
    ).toEqual([]);
});
it("sends necessary needs to research without owner identifiers, URLs, emails, phone numbers or postcodes", () => {
  const need = researchNeed({
    serviceId: "paypal:A:private-subscription",
    name: "Three",
    source: "manual",
    amountMinor: 1800,
    cycle: "month",
    purpose:
      "120GB, 12 months, Instagram. Me@example.com +44 7700 900123 SW1A 1AA https://private.example/secret",
  });
  expect(JSON.stringify(need)).not.toMatch(/private-subscription|Me@example|7700|SW1A|private.example/);
  expect(need.purpose).toContain("120GB, 12 months, Instagram");
});

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
it.each(["active", "inactive", "excluded", "same_product", "different_product"] as const)(
  "resolves imported ownership in live comparisons without inferring entitlements: %s",
  async (state) => {
    app.ctx.config.liveDiscovery = true;
    const existing = state === "active";
    const stages: string[] = [];
    const apple: LiveOffer = {
      ...offer,
      name: "Apple Music",
      plan: "Individual",
      providerUrl: "https://www.apple.com/uk/apple-music/",
      billingEvidence: {
        quote: "We bill you every calendar month.",
        source: "https://www.apple.com/uk/apple-music/",
      },
      priceMinor: 1199,
      renewalMinor: 1199,
      features: ["Offline music for one listener"],
      conditions: [],
      sources: ["https://www.apple.com/uk/apple-music/"],
      priceEvidence: {
        kind: "direct_gbp",
        quote: "£11.99 per month",
        source: "https://www.apple.com/uk/apple-music/",
      },
    };
    app.ctx.model = {
      responses: {
        create: async (request, options) => {
          const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          stages.push(name);
          if (name === "OfficialProviders" || name === "OfficialProvidersVerification")
            return webResponse(
              {
                searchPurpose: "Offline music for one listener",
                providers: [{ name: apple.name, website: apple.providerUrl }],
                uncertainties: [],
              },
              apple.sources,
            );
          if (name === "ProviderOffers")
            return webResponse({ offers: [apple], uncertainties: [] }, apple.sources);
          return app.model.responses.create(request, options);
        },
      },
    };
    app.model.script = (request) => {
      const input = JSON.parse((request.input as { content: string }[])[0]!.content);
      const candidate = input.candidates.find((row: any) => row.service === "Apple Music");
      expect(candidate).toMatchObject({ owned: existing, monthlyMinor: existing ? 0 : 1199 });
      return {
        answer: {
          summary: "Compare the plan against your offline listening needs.",
          options: [
            {
              serviceId: candidate.id,
              reason: "Offline music for one listener.",
              replacement: "conditional",
              condition: "Confirm the required music is available on your plan.",
            },
          ],
          uncertainties: ["Your plan's catalogue access remains unconfirmed."],
        },
      };
    };
    const browser = app.browser();
    await browser.login();
    const saved = await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: 0,
      subscriptions: [
        {
          serviceId: "spotify",
          amountMinor: 1599,
          cycle: "month",
          purpose: "Offline music for one listener",
        },
        { serviceId: "apple-music", amountMinor: 1199, cycle: "month", purpose: "Music at home" },
      ],
    });
    expect(saved.status).toBe(200);
    const rows = saved.body.subscriptions.map((row: any) => ({
      ...row,
      serviceId: `pp_${row.serviceId}`,
      productServiceId: row.serviceId,
      source: "paypal",
    }));
    if (state === "same_product") rows[0].productServiceId = "apple-music";
    if (state === "different_product") rows[1].productServiceId = "icloud-plus";
    rows[1].paypalEvidence = {
      key: "test-owned-music",
      merchant: "Apple",
      paymentCount: 3,
      lastPaidOn: "2026-11-01",
      checkedAt: new Date().toISOString(),
      agreementStatus: state === "inactive" ? "inactive" : "active",
      excludedByOwner: state === "excluded",
    };
    const ownerId = (await browser.get("/api/session")).body.ownerId;
    await app.ctx.db
      .update(ownerSubscriptions)
      .set({ subscriptions: rows })
      .where(eq(ownerSubscriptions.ownerId, ownerId));
    const result = await browser.post("/api/subscriptions/review", {
      serviceId: rows[0].serviceId,
      expectedRevision: saved.body.revision,
    });
    expect(result.status, JSON.stringify({ body: result.body, stages })).toBe(200);
    expect(result.body.comparisons[0]).toMatchObject({ owned: existing, annualMinor: existing ? 0 : 14388 });
    expect(result.body.comparisons[0].serviceId.startsWith("existing:")).toBe(existing);
  },
);
it("researches beyond the catalogue, restricts price search to official domains, caches per owner and supports explicit refresh", async () => {
  app.ctx.config.liveDiscovery = true;
  const requests: ResponseCreateParamsNonStreaming[] = [];
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        requests.push(request);
        const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
        if (name === "OfficialProviders")
          return webResponse(
            {
              searchPurpose: "Under 10GB general data, no long commitment",
              providers: [
                {
                  name: "Fresh Mobile",
                  website: `${offer.providerUrl} ([freshmobile.co.uk](${offer.providerUrl}))`,
                },
                { name: "Aggregator", website: "https://uswitch.com/sim-only/" },
              ],
              uncertainties: [],
            },
            [offer.providerUrl, "https://uswitch.com/sim-only/"],
          );
        if (name === "ProviderOffers")
          return webResponse(
            {
              offers: [
                {
                  ...offer,
                  conditions: [
                    ...offer.conditions,
                    "Unverified annual calculation £97.33",
                    "Regular charge £8 per month",
                    "Requires an unlocked phone",
                  ],
                },
                {
                  ...offer,
                  plan: "120GB Data Only SIM lasting 12 months",
                  billingUnit: "year",
                  priceMinor: 4000,
                  renewalMinor: 4000,
                  priceEvidence: {
                    kind: "direct_gbp",
                    quote: "£40 for 12 months",
                    source: offer.providerUrl,
                  },
                },
                {
                  ...offer,
                  name: "Aggregator price",
                  providerUrl: "https://uswitch.com/sim-only/",
                  sources: ["https://uswitch.com/sim-only/"],
                },
              ],
              uncertainties: [],
            },
            [offer.providerUrl, "https://uswitch.com/sim-only/"],
          );
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = (request) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    expect(input.candidates).toHaveLength(1);
    expect(input.researchBrief).toBe("Under 10GB general data, no long commitment");
    expect(input.subscription.purpose).toContain("Current 120GB tariff");
    return {
      answer: {
        summary: "This plan may fit your general data use.",
        options: [
          {
            serviceId: input.candidates[0].id,
            reason: "20GB for a lower regular price.",
            replacement: "conditional",
            condition: "Confirm current contract exit fees.",
            importantConditions: [3, 1],
          },
        ],
        uncertainties: ["Check your existing exit fees."],
      },
    };
  };
  const browser = app.browser();
  await browser.login();
  const rows = [
    {
      serviceId: "three",
      amountMinor: 1800,
      cycle: "month",
      purpose: "Current 120GB tariff; under 10GB general data, no long commitment",
    },
  ];
  await browser.request("PUT", "/api/subscriptions", { expectedRevision: 0, subscriptions: rows });
  const result = await browser.post("/api/subscriptions/review", { serviceId: "three", expectedRevision: 1 });
  expect(result.status).toBe(200);
  expect(result.body.discovery.status).toBe("live");
  const callsBeforeRestore = requests.length;
  const restored = await browser.get("/api/subscriptions/reviews?revision=1");
  expect(restored.body.reviews[0].advice.discovery.status).toBe("cached");
  expect(restored.body.reviews[0].advice.comparisons).toEqual(result.body.comparisons);
  expect(requests).toHaveLength(callsBeforeRestore);
  expect(result.body.comparisons[0]).toMatchObject({
    name: "Fresh Mobile",
    priceMinor: 800,
    annualMinor: 9600,
    savingAnnualMinor: 12000,
    sources: offer.sources,
  });
  expect(result.body.options[0].serviceId).toMatch(/^live:/);
  expect(result.body.comparisons[0].conditions).toContain("Regular charge £8 per month");
  expect(result.body.comparisons[0].conditions).toContain("Requires an unlocked phone");
  expect(result.body.comparisons[0].highlights).toEqual(["Requires an unlocked phone"]);
  expect(result.body.comparisons[0].conditions.join(" ")).toContain(
    "Additional pricing conditions were not verified",
  );
  expect(result.body.comparisons[0].feesKnown).toBe(false);
  expect(JSON.stringify(result.body.comparisons)).not.toContain("97.33");
  const liveRequests = requests.filter((request) =>
    request.tools?.some((tool) => tool.type === "web_search"),
  );
  expect(liveRequests).toHaveLength(2);
  expect(JSON.parse((liveRequests[1]!.input as { content: string }[])[0]!.content).purpose).toBe(
    rows[0]!.purpose,
  );
  expect(JSON.parse((liveRequests[1]!.input as { content: string }[])[0]!.content).searchPurpose).toBe(
    "Under 10GB general data, no long commitment",
  );
  expect(liveRequests[1]!.tools).toMatchObject([
    { type: "web_search", external_web_access: true, filters: { allowed_domains: ["freshmobile.co.uk"] } },
  ]);
  expect(
    liveRequests.every(
      (request) =>
        request.tool_choice === "required" && request.include?.includes("web_search_call.action.sources"),
    ),
  ).toBe(true);
  expect(
    (await browser.post("/api/subscriptions/review", { serviceId: "three", expectedRevision: 1 })).body
      .discovery.status,
  ).toBe("cached");
  expect(requests.filter((request) => request.tools?.length)).toHaveLength(2);
  await browser.post("/api/subscriptions/review", { serviceId: "three", expectedRevision: 1, fresh: true });
  expect(requests.filter((request) => request.tools?.length)).toHaveLength(3);
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    subscriptions: [...rows, { serviceId: "netflix", amountMinor: 1399, cycle: "month", purpose: "Films" }],
  });
  const afterArrival = await browser.post("/api/subscriptions/review", {
    serviceId: "three",
    expectedRevision: 2,
  });
  expect(afterArrival.status).toBe(200);
  expect(afterArrival.body.discovery.status).toBe("cached");
  expect(requests.filter((request) => request.tools?.length)).toHaveLength(3);
  const other = app.browser();
  await other.login();
  await other.request("PUT", "/api/subscriptions", { expectedRevision: 0, subscriptions: rows });
  expect(
    (await other.post("/api/subscriptions/review", { serviceId: "three", expectedRevision: 1 })).body
      .discovery.status,
  ).toBe("live");
  expect((await browser.get("/api/subscriptions")).body.revision).toBe(2);
  expect(app.paypal.calls).toHaveLength(0);
});
it("does not replace failed live research with catalogue prices, preserves needs and refuses stale comparisons", async () => {
  app.ctx.config.liveDiscovery = true;
  let finalCalls = 0;
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        if (request.tools?.some((tool) => tool.type === "web_search"))
          throw new Error("authored search outage");
        finalCalls++;
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = () => ({
    answer: { summary: "Current provider offers could not be refreshed.", options: [], uncertainties: [] },
  });
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [{ serviceId: "spotify", amountMinor: 1299, cycle: "month", purpose: "Offline music" }],
  });
  const result = await browser.post("/api/subscriptions/review", {
    serviceId: "spotify",
    expectedRevision: 1,
  });
  expect(result.status).toBe(503);
  expect(result.body.error).toBe("provider_search_unavailable");
  expect(finalCalls).toBe(0);
  expect((await browser.get("/api/subscriptions")).body.subscriptions[0]).toMatchObject({
    amountMinor: 1299,
    purpose: "Offline music",
  });
  expect((await browser.get("/api/subscriptions/reviews?revision=1")).body.reviews).toEqual([]);
  expect(
    (await browser.post("/api/subscriptions/review", { serviceId: "spotify", expectedRevision: 0 })).status,
  ).toBe(409);
});

it("stops on provider account rejection without a catalogue fallback or another model request", async () => {
  app.ctx.config.liveDiscovery = true;
  let calls = 0;
  app.ctx.model = {
    responses: {
      create: async () => {
        calls++;
        throw new OpenAI.RateLimitError(
          429,
          { code: "credit_balance_exhausted", type: "insufficient_quota" },
          "secret diagnostic",
          new Headers(),
        );
      },
    },
  };
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      {
        serviceId: "three",
        amountMinor: 1800,
        cycle: "month",
        purpose: "TikTok and YouTube; 90GB for everything else",
      },
    ],
  });
  const result = await browser.post("/api/subscriptions/review", { serviceId: "three", expectedRevision: 1 });
  expect(result.status).toBe(503);
  expect(result.body.error).toBe("model_credit_exhausted");
  expect(result.body.message).not.toContain("secret diagnostic");
  expect(calls).toBe(1);
  app.ctx.model = app.model;
});
it("does not infer current-provider title availability from an empty research result", async () => {
  app.ctx.config.liveDiscovery = true;
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        if (request.tools?.some((tool) => tool.type === "web_search"))
          return webResponse(
            request.text?.format?.type === "json_schema" && request.text.format.name === "OfficialProviders"
              ? {
                  searchPurpose: "Grey's Anatomy season 20",
                  namedApps: [],
                  providers: [{ name: "Fresh Mobile", website: offer.providerUrl }],
                }
              : { offers: [], uncertainties: [] },
            offer.sources,
          );
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = () => ({
    answer: {
      summary: "Netflix already includes the required season.",
      options: [],
      uncertainties: ["Send me other providers' prices."],
    },
  });
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      { serviceId: "netflix", amountMinor: 1399, cycle: "month", purpose: "Grey's Anatomy season 20" },
    ],
  });
  const result = await browser.post("/api/subscriptions/review", {
    serviceId: "netflix",
    expectedRevision: 1,
  });
  expect(result.status).toBe(200);
  expect(result.body.summary).toMatch(/couldn’t complete this check/);
  expect(result.body.summary).not.toMatch(/already includes|required season|best|safest/i);
  expect(result.body.uncertainties.join(" ")).toMatch(
    /current provider.*could not|No complete current provider price/i,
  );
});
