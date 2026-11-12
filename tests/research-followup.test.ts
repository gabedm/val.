import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import { ValueComparison } from "../src/client/ValConversation";
import { agentModel } from "../src/server/agent-contract";
import { startTestApp, type TestApp } from "./helpers";
import type { LiveOffer } from "../src/server/live-discovery";
import { ownerSubscriptions } from "../src/server/db/schema";
import { recognitionVersion, rememberRecognizedService } from "../src/server/subscription-recognition";
let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
const url = "https://freshprivacy.co.uk/pricing";
const offer: LiveOffer = {
  name: "Fresh Privacy",
  plan: "Monthly VPN",
  providerUrl: url,
  currency: "GBP",
  market: "GB",
  priceMinor: 422,
  renewalMinor: 422,
  billingUnit: "month",
  billingEvidence: { quote: "We bill you every calendar month.", source: url },
  introductoryCycles: 0,
  minimumTermMonths: 0,
  upfrontMinor: null,
  features: ["Mobile privacy VPN"],
  conditions: ["Payment conversion fees are not established."],
  sources: [url],
  priceEvidence: { kind: "currency_equivalent", quote: "€5 is equivalent to £4.22", source: url },
};
const web = (answer: unknown, urls = [url]): Response =>
  ({
    id: "offline-search",
    model: agentModel,
    status: "completed",
    output: [
      {
        id: "search",
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
    usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
  }) as Response;
async function owner() {
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      { serviceId: "nordvpn", amountMinor: 1331, cycle: "month", purpose: "Privacy mostly on mobile" },
      {
        serviceId: "three",
        amountMinor: 1800,
        cycle: "month",
        purpose: "Mostly YouTube; 50GB total mobile data.",
      },
    ],
  });
  return browser;
}

it.each(["fresh-provider", "customer", "expired", "old-version", "different-label"])(
  "uses only fresh provider identity evidence as a current-provider research lead (%s)",
  async (variant) => {
    const browser = app.browser();
    await browser.login();
    const ownerId = String((await browser.open()).body.ownerId);
    const serviceId = "pp_unlisted_reader";
    await app.ctx.db.insert(ownerSubscriptions).values({
      ownerId,
      revision: 1,
      subscriptions: [
        {
          serviceId,
          name: "Harbour Reader",
          amountMinor: 1299,
          cycle: "month",
          source: "paypal",
          purpose: "Read seventeen RSS feeds in a browser",
        },
      ],
    });
    await rememberRecognizedService(
      app.ctx,
      ownerId,
      serviceId,
      variant === "different-label" ? "Another Product" : "Harbour Reader",
      {
        identification: "matched",
        displayName: "Harbour Reader",
        category: "reading",
        servicePurpose: "Read RSS",
        capabilities: ["RSS feeds"],
        constraints: [],
        possibleProducts: [],
        origin: variant === "customer" ? "customer" : "provider",
        sources: [{ url: "https://harbour-reader.co.uk/product", quote: "Read RSS" }],
        checkedAt: new Date(Date.now() - (variant === "expired" ? 8 * 86400_000 : 1000)).toISOString(),
        recognitionVersion: variant === "old-version" ? "retired-version" : recognitionVersion,
      },
    );
    // rememberRecognizedService stamps the current version; simulate a retained
    // old record explicitly rather than changing the normal writer's contract.
    if (variant === "old-version")
      await app.ctx.db.$client.query(
        "UPDATE owner_recognized_services SET profile=jsonb_set(profile,'{recognitionVersion}','\"retired-version\"') WHERE owner_id=$1 AND service_id=$2",
        [ownerId, serviceId],
      );
    app.ctx.config.liveDiscovery = true;
    let sawDiscovery = false;
    const priorModel = app.ctx.model;
    app.ctx.model = {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders") {
            sawDiscovery = true;
            const input = JSON.parse((request.input as any[])[0].content);
            expect(input.currentProviderDomains).toEqual(
              variant === "fresh-provider" ? ["harbour-reader.co.uk"] : undefined,
            );
            return web({
              providers: [{ name: "Fresh Privacy", website: url }],
              searchPurpose: "Read seventeen RSS feeds",
              namedApps: [],
              uncertainties: [],
            });
          }
          if (stage === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
          if (stage === "SubscriptionAdvice") {
            const response = web({
              summary: "No complete current provider price was established.",
              options: [],
              uncertainties: [],
            });
            return { ...response, output: response.output.filter((item) => item.type === "message") };
          }
          return web({ offers: [], uncertainties: [] });
        },
      },
    };
    try {
      const result = await browser.post("/api/subscriptions/review", { serviceId, expectedRevision: 1 });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expect(sawDiscovery).toBe(true);
    } finally {
      app.ctx.model = priorModel;
    }
  },
);

it("keeps native-currency alternatives conditional and withholds GBP savings in the API and UI", async () => {
  for (const currency of ["USD", "EUR"] as const) {
    const browser = await owner();
    app.ctx.config.liveDiscovery = true;
    const native: LiveOffer = {
      ...offer,
      currency,
      priceMinor: 500,
      renewalMinor: 500,
      priceEvidence: { kind: "native_currency", quote: `${currency} 5 per month`, source: url },
    };
    app.ctx.model = {
      responses: {
        create: async (request, options) => {
          const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (name === "OfficialProviders")
            return web({
              providers: [{ name: native.name, website: url }],
              searchPurpose: "Mobile privacy",
              namedApps: [],
              uncertainties: [],
            });
          if (name === "ProviderOffers")
            return web({
              offers: [native],
              uncertainties: ["Another provider was outside this individual check's scope."],
            });
          if (name === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
          return app.model.responses.create(request, options);
        },
      },
    };
    let turns = 0;
    app.model.script = (request) => {
      const input = JSON.parse((request.input as { content: string }[])[0]!.content);
      turns++;
      expect(input.candidates[0].price.currency).toBe(currency);
      return {
        answer: {
          summary: "A privacy option to consider, with currency conversion unresolved.",
          options: [
            {
              serviceId: input.candidates[0].id,
              reason: "Supports mobile privacy.",
              replacement: turns === 1 ? "supported" : "conditional",
              condition: turns === 1 ? null : "GBP conversion and payment fees are unverified.",
            },
          ],
          uncertainties: turns === 1 ? [] : ["Check the payment conversion and fees before deciding."],
        },
      };
    };
    const result = await browser.post("/api/subscriptions/review", {
      serviceId: "nordvpn",
      expectedRevision: 1,
    });
    expect(result.status).toBe(200);
    expect(turns).toBe(2);
    expect(result.body.comparisons[0]).toMatchObject({
      currency,
      fit: "conditional",
      fitCondition: "GBP conversion and payment fees are unverified.",
      priceMinor: 500,
      annualMinor: 6000,
      savingMonthlyMinor: null,
      savingAnnualMinor: null,
      priceQuote: `${currency} 5 per month`,
    });
    expect(result.body.discovery.uncertainties).not.toContain(
      "Another provider was outside this individual check's scope.",
    );
    expect(result.body.comparisons[0].conditions).toContain("Payment conversion fees are not established.");
    const html = renderToStaticMarkup(
      createElement(ValueComparison, {
        advice: result.body,
        data: {
          portfolio: (await browser.get("/api/subscriptions")).body,
          catalogue: (await browser.get("/api/catalogue")).body,
        },
        onRefresh: () => {},
        pending: false,
      }),
    );
    expect(html).toContain(`${currency} 5.00`);
    expect(html).toContain("GBP cost and savings unverified");
    expect(html).toContain("Conditional fit");
    expect(html.indexOf("GBP conversion and payment fees are unverified.")).toBeLessThan(
      html.indexOf("GBP cost and savings unverified"),
    );
    expect(html).not.toContain("less over");
    expect(html).not.toContain("£5");
    const ownerId = (await browser.get("/api/session")).body.ownerId;
    const legacy = result.body.comparisons.map((row: any) => {
      const saved = { ...row };
      delete saved.fit;
      delete saved.fitCondition;
      return saved;
    });
    await app.ctx.db.$client.query(
      "UPDATE owner_subscription_reviews SET result=jsonb_set(result,'{advice,comparisons}',$1::jsonb) WHERE owner_id=$2 AND service_id='nordvpn' AND result ? 'advice'",
      [JSON.stringify(legacy), ownerId],
    );
    const modelCalls = app.model.requests.length;
    const cached = await browser.get("/api/subscriptions/reviews?revision=1");
    expect(cached.body.reviews[0].advice.comparisons[0]).toMatchObject({
      fit: "conditional",
      fitCondition: "GBP conversion and payment fees are unverified.",
    });
    expect(app.model.requests).toHaveLength(modelCalls);
  }
});

it("requests both owned comparisons for a multi-subscription challenge without rewriting saved needs", async () => {
  const browser = await owner();
  const before = (await browser.get("/api/subscriptions")).body;
  app.model.script = (_request, index) =>
    index === 0
      ? { call: "read_subscriptions" }
      : {
          answer: {
            message: "I’ll check both against your saved needs.",
            draft: null,
            compareRef: null,
            compareRefs: ["saved:0", "saved:1"],
            discussingRef: null,
            costStatement: null,
          },
        };
  const result = await browser.post("/api/subscriptions/chat", {
    expectedRevision: 1,
    history: [],
    message: "Is Mullvad cheaper for my VPN and VOXI for Three?",
  });
  expect(result.status).toBe(200);
  expect(result.body.compareServiceIds).toEqual(["nordvpn", "three"]);
  expect(result.body.draft).toBeNull();
  expect((await browser.get("/api/subscriptions")).body).toEqual(before);
  app.model.script = (_request, index) =>
    index === 0
      ? { call: "read_subscriptions" }
      : {
          answer: {
            message: "Check",
            draft: null,
            compareRef: null,
            compareRefs: ["saved:0", "foreign:1"],
            discussingRef: null,
            costStatement: null,
          },
        };
  expect(
    (
      await browser.post("/api/subscriptions/chat", {
        expectedRevision: 1,
        history: [],
        message: "Check both",
      })
    ).status,
  ).toBe(503);
});

it("recovers a misdirected alternative lookup without creating an invented subscription or losing the comparison request", async () => {
  const browser = await owner();
  app.model.script = (_request, index) =>
    index === 0
      ? { call: "read_subscriptions" }
      : index === 1
        ? { call: "search_subscriptions", arguments: { query: "cheaper private VPN alternatives" } }
        : {
            answer: {
              message: "I’ll check providers against your saved privacy needs.",
              draft: null,
              compareRef: "saved:0",
              compareRefs: [],
              discussingRef: "saved:0",
              costStatement: null,
            },
          };
  const result = await browser.post("/api/subscriptions/chat", {
    expectedRevision: 1,
    history: [],
    message: "Find better value for my NordVPN subscription using my saved needs.",
    activeServiceId: "nordvpn",
  });
  expect(result.status).toBe(200);
  expect(result.body.compareServiceId).toBe("nordvpn");
  expect(result.body.portfolio.subscriptions).toHaveLength(2);
  expect(result.body.portfolio.revision).toBe(1);
  expect(result.body.draft).toBeNull();
});

it("researches a named follow-up afresh instead of returning cached empty advice, with explicit GBP-estimate presentation", async () => {
  const browser = await owner();
  app.ctx.config.liveDiscovery = true;
  let requests = 0;
  const queries: unknown[] = [];
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
        const input = JSON.parse((request.input as { content: string }[])[0]!.content);
        if (name === "OfficialProviders") {
          requests++;
          queries.push(input.researchQuery);
          return web({
            searchPurpose: "Mobile privacy",
            namedApps: [],
            providers: [{ name: "Fresh Privacy", website: url }],
            uncertainties: ["Check the low-cost monthly tier"],
          });
        }
        if (name === "ProviderOffers") {
          expect(input.providerFindings).toEqual(["Check the low-cost monthly tier"]);
          expect(input.providerSources).toContain(url);
          return web({ offers: input.researchQuery ? [offer] : [], uncertainties: [] });
        }
        if (name === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = (request) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    return {
      answer: {
        summary: "A provider-published GBP estimate may offer lower cost.",
        options: input.candidates.map((candidate: any) => ({
          serviceId: candidate.id,
          reason: "Mobile privacy, conditional on payment conversion.",
          replacement: "conditional",
          condition: "Confirm actual conversion and payment fees.",
        })),
        uncertainties: ["What conversion fees would your payment method charge?"],
      },
    };
  };
  const first = await browser.post("/api/subscriptions/review", {
    serviceId: "nordvpn",
    expectedRevision: 1,
  });
  expect(first.status).toBe(200);
  expect(first.body.options).toEqual([]);
  const cached = await browser.post("/api/subscriptions/review", {
    serviceId: "nordvpn",
    expectedRevision: 1,
  });
  expect(cached.status).toBe(200);
  expect(requests).toBe(1);
  const refreshed = await browser.post("/api/subscriptions/review", {
    serviceId: "nordvpn",
    expectedRevision: 1,
    researchQuery: "What about Mullvad?",
  });
  expect(refreshed.status).toBe(200);
  expect(requests).toBe(2);
  expect(queries).toEqual([undefined, "What about Mullvad?"]);
  expect(refreshed.body.comparisons[0]).toMatchObject({
    priceMinor: 422,
    priceEstimated: true,
    priceQuote: offer.priceEvidence!.quote,
    savingAnnualMinor: 10908,
    feesKnown: false,
  });
  const catalogue = (await browser.get("/api/catalogue")).body;
  const html = renderToStaticMarkup(
    createElement(ValueComparison, {
      advice: refreshed.body,
      data: { portfolio: (await browser.get("/api/subscriptions")).body, catalogue },
      onRefresh: () => {},
      pending: false,
    }),
  );
  expect(html).toContain("≈ ");
  expect(html).toContain("£4.22");
  expect(html).toContain("Estimated £109.08");
  expect(html).toContain("€5 is equivalent to £4.22");
  expect((await browser.get("/api/subscriptions")).body.revision).toBe(1);
});

it("renders calendar changes using the exact annual budget, corrects unsupported monetary prose once and retains exact yearly bills", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-18T12:00:00Z"));
  try {
    const browser = await owner();
    await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: 1,
      subscriptions: [
        {
          serviceId: "three",
          amountMinor: 1200,
          cycle: "month",
          purpose: "2GB ordinary data, no tethering needed",
        },
      ],
    });
    app.ctx.config.liveDiscovery = true;
    const priced: LiveOffer = {
      ...offer,
      name: "Fresh Mobile",
      plan: "2GB rolling",
      priceMinor: 750,
      renewalMinor: 750,
      features: ["2GB data"],
      conditions: ["Price rises on 1 April 2027"],
      priceEvidence: { kind: "direct_gbp", quote: "£7.50 a month; £7.95 from 1 April 2027", source: url },
      scheduledChanges: [
        { on: "2027-04-01", priceMinor: 795, quote: "£7.95 from 1 April 2027", source: url },
      ],
    };
    app.ctx.model = {
      responses: {
        create: async (request, options) => {
          const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (name === "OfficialProviders")
            return web({
              providers: [{ name: "Fresh Mobile", website: url }],
              searchPurpose: "2GB data",
              namedApps: [],
              uncertainties: [],
            });
          if (name === "ProviderOffers") return web({ offers: [priced], uncertainties: [] });
          if (name === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
          return app.model.responses.create(request, options);
        },
      },
    };
    let replies = 0;
    app.model.script = (request) => {
      const input = JSON.parse((request.input as { content: string }[])[0]!.content);
      expect(input.candidates[0].annualMinor).toBe(9270);
      return {
        answer: {
          summary:
            ++replies === 1
              ? "Save £54 over twelve months."
              : "The plan plausibly fits the saved data need, with a source-backed price change.",
          options: [
            {
              serviceId: input.candidates[0].id,
              reason: "Ordinary data fits the saved need.",
              replacement: "supported",
              condition: null,
            },
          ],
          uncertainties: [],
        },
      };
    };
    const result = await browser.post("/api/subscriptions/review", {
      serviceId: "three",
      expectedRevision: 2,
    });
    expect(result.status).toBe(200);
    expect(replies).toBe(2);
    expect(result.body.comparisons[0]).toMatchObject({
      annualMinor: 9270,
      savingAnnualMinor: 5130,
      scheduledChanges: [{ on: "2027-04-01", priceMinor: 795 }],
    });
    const catalogue = (await browser.get("/api/catalogue")).body;
    const html = renderToStaticMarkup(
      createElement(ValueComparison, {
        advice: result.body,
        data: { portfolio: (await browser.get("/api/subscriptions")).body, catalogue },
        onRefresh: () => {},
        pending: false,
      }),
    );
    expect(html).toContain("1 Apr 2027");
    expect(html).toContain("£7.95");
    expect(html).toContain("£51.30");
    expect(html).not.toContain("£54");
    await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: 2,
      subscriptions: [
        {
          serviceId: "three",
          amountMinor: 14999,
          cycle: "year",
          purpose: "2GB ordinary data, no tethering needed",
        },
      ],
    });
    const annual = await browser.post("/api/subscriptions/review", {
      serviceId: "three",
      expectedRevision: 3,
    });
    expect(annual.status).toBe(200);
    expect(annual.body.comparisons[0].savingAnnualMinor).toBe(5729);
  } finally {
    vi.useRealTimers();
  }
});

it("does not mistake one product for an owned sibling on the same provider domain", async () => {
  const browser = await owner();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    subscriptions: [
      { serviceId: "spotify", amountMinor: 1299, cycle: "month", purpose: "Ad-free music" },
      { serviceId: "apple-tv", amountMinor: 999, cycle: "month", purpose: "Television series" },
    ],
  });
  app.ctx.config.liveDiscovery = true;
  const apple = "https://www.apple.com/uk/apple-music/";
  const music: LiveOffer = {
    ...offer,
    name: "Apple Music",
    plan: "Individual",
    providerUrl: apple,
    billingEvidence: { quote: "We bill you every calendar month.", source: apple },
    priceMinor: 1099,
    renewalMinor: 1099,
    features: ["Ad-free music"],
    conditions: [],
    sources: [apple],
    priceEvidence: { kind: "direct_gbp", quote: "£10.99 per month", source: apple },
  };
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
        if (name === "OfficialProviders")
          return web(
            {
              providers: [{ name: "Apple Music", website: apple }],
              searchPurpose: "Ad-free music",
              namedApps: [],
              uncertainties: [],
            },
            [apple],
          );
        if (name === "ProviderOffers") return web({ offers: [music], uncertainties: [] }, [apple]);
        if (name === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = (request) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    return {
      answer: {
        summary: "A lower-priced music service.",
        options: [
          {
            serviceId: input.candidates[0].id,
            reason: "Ad-free music.",
            replacement: "supported",
            condition: null,
          },
        ],
        uncertainties: [],
      },
    };
  };
  const result = await browser.post("/api/subscriptions/review", {
    serviceId: "spotify",
    expectedRevision: 2,
  });
  expect(result.status).toBe(200);
  expect(result.body.comparisons[0]).toMatchObject({
    name: "Apple Music",
    owned: false,
    annualMinor: 13188,
    logoServiceId: "apple-music",
  });
});

it("repairs rejected source references by actually retrieving the page, never silently dropping query or store parameters", async () => {
  const browser = await owner();
  app.ctx.config.liveDiscovery = true;
  const stages: string[] = [];
  app.ctx.model = {
    responses: {
      create: async (request, options) => {
        const name = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
        stages.push(name);
        if (name === "OfficialProviders")
          return web({
            searchPurpose: "Mobile privacy",
            namedApps: [],
            providers: [{ name: "Fresh Privacy", website: url }],
            uncertainties: [],
          });
        if (name === "ProviderOffers") return web({ offers: [offer], uncertainties: [] }, [`${url}?tab=0`]);
        if (name === "ProviderOffersRepair") return web({ offers: [offer], uncertainties: [] });
        if (name === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
        return app.model.responses.create(request, options);
      },
    },
  };
  app.model.script = (request) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    return {
      answer: {
        summary: "A possible lower-cost fit.",
        options: [
          {
            serviceId: input.candidates[0].id,
            reason: "Mobile privacy with an approximate GBP cost.",
            replacement: "conditional",
            condition: "Confirm actual conversion and payment fees.",
          },
        ],
        uncertainties: ["What conversion fees would your payment method charge?"],
      },
    };
  };
  const result = await browser.post("/api/subscriptions/review", {
    serviceId: "nordvpn",
    expectedRevision: 1,
  });
  expect(result.status).toBe(200);
  expect(stages).toEqual([
    "OfficialProviders",
    "ProviderOffers",
    "ProviderOffers",
    "ProviderOffersRepair",
    "SubscriptionAdvice",
    "AdviceConsistency",
  ]);
  expect(result.body.comparisons[0].sources).toContain(url);
});
