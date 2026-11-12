import { beforeAll, afterAll, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Response } from "openai/resources/responses/responses";
import { acceptedOffers, offerBudget, type LiveOffer } from "../src/server/live-discovery";
import { ownerSubscriptions } from "../src/server/db/schema";
import { ValueComparison } from "../src/client/ValConversation";
import { startTestApp, type TestApp } from "./helpers";
import { agentModel } from "../src/server/agent-contract";

const source = "https://harbour-privacy.co.uk/plans";
const prepaid: LiveOffer = {
  name: "Harbour Privacy",
  plan: "Basic",
  providerUrl: source,
  currency: "GBP",
  market: "GB",
  priceMinor: 9600,
  renewalMinor: 12000,
  billingUnit: "prepaid",
  prepaid: { initialMonths: 27, renewalMonths: 12 },
  introductoryCycles: 0,
  minimumTermMonths: 27,
  upfrontMinor: 0,
  features: ["Privacy on two devices."],
  conditions: [],
  sources: [source],
  appCoverage: [],
  scheduledChanges: [],
  priceEvidence: {
    kind: "direct_gbp",
    quote: "£96 for the first 27 months. Then renews at £120 per year.",
    source,
  },
};
const admit = (value: LiveOffer) =>
  acceptedOffers({ offers: [value] }, new Set([source]), ["harbour-privacy.co.uk"], [], true);
it("admits a sourced initial prepaid charge and a different renewal period without inventing an annual price", () => {
  expect(admit(prepaid)).toEqual([prepaid]);
  expect(offerBudget(prepaid, "2026-11-02")).toEqual({
    annualMinor: 9600,
    monthlyMinor: 800,
    cycles: 1,
    firstChargeMinor: 9600,
  });
  expect(offerBudget({ ...prepaid, upfrontMinor: 500 }, "2026-11-02").annualMinor).toBe(10100);
  const flat = {
    ...prepaid,
    priceMinor: 9000,
    renewalMinor: 9000,
    prepaid: { initialMonths: 24, renewalMonths: 24 },
    priceEvidence: { ...prepaid.priceEvidence!, quote: "£90 every two years." },
  };
  expect(admit(flat)).toEqual([flat]);
});
it("adds every whole renewal due inside the common 365-day cash budget", () => {
  expect(
    offerBudget(
      { ...prepaid, priceMinor: 1000, renewalMinor: 2000, prepaid: { initialMonths: 3, renewalMonths: 3 } },
      "2027-01-31",
    ),
  ).toMatchObject({ annualMinor: 7000, cycles: 4, firstChargeMinor: 1000 });
  expect(
    offerBudget(
      {
        ...prepaid,
        priceMinor: 3000,
        renewalMinor: 10000,
        upfrontMinor: 300,
        prepaid: { initialMonths: 3, renewalMonths: 12 },
      },
      "2026-11-02",
    ),
  ).toMatchObject({ annualMinor: 13300, cycles: 2 });
  for (const start of ["2027-02-28", "2028-02-29", "2027-03-01"])
    expect(offerBudget({ ...prepaid, prepaid: { initialMonths: 12, renewalMonths: 12 } }, start).cycles).toBe(
      1,
    );
});
it.each([
  "missing-period",
  "zero",
  "fraction",
  "too-long",
  "swapped",
  "wrong-amount",
  "no-renewal",
  "unretrieved",
  "calendar-mix",
  "intro-mix",
  "legacy-annual",
  "unexpected-period",
])("withholds an unsupported prepaid representation (%s)", (variant) => {
  const value = structuredClone(prepaid);
  if (variant === "missing-period") delete value.prepaid;
  if (variant === "zero") value.prepaid!.initialMonths = 0;
  if (variant === "fraction") value.prepaid!.renewalMonths = 1.5;
  if (variant === "too-long") value.prepaid!.initialMonths = 61;
  if (variant === "swapped") value.prepaid = { initialMonths: 12, renewalMonths: 27 };
  if (variant === "wrong-amount") value.renewalMinor = 11900;
  if (variant === "no-renewal") value.priceEvidence!.quote = "£96 for the first 27 months.";
  if (variant === "unretrieved") value.priceEvidence!.source = "https://harbour-privacy.co.uk/not-retrieved";
  if (variant === "calendar-mix")
    value.scheduledChanges = [
      { on: "2027-01-01", priceMinor: 13000, quote: "£130 from 1 January 2027", source },
    ];
  if (variant === "intro-mix") value.introductoryCycles = 1;
  if (variant === "legacy-annual") {
    value.billingUnit = "year";
    delete value.prepaid;
    value.renewalMinor = 9600;
    value.priceEvidence!.quote = "£96 for the first 27 months.";
  }
  if (variant === "unexpected-period") {
    value.billingUnit = "month";
    value.renewalMinor = 9600;
  }
  expect(admit(value)).toEqual([]);
});
it("never loops on an unvalidated zero-length renewal period", () => {
  expect(() => offerBudget({ ...prepaid, prepaid: { initialMonths: 3, renewalMonths: 0 } })).toThrow(
    RangeError,
  );
});
it("keeps a prepaid subscription payment separate from additional source-backed setup fees", () => {
  expect(admit({ ...prepaid, upfrontMinor: 9600 })).toEqual([]);
  const fee = {
    ...prepaid,
    upfrontMinor: 500,
    priceEvidence: {
      ...prepaid.priceEvidence!,
      quote: prepaid.priceEvidence!.quote + " Additional setup fee £5.",
    },
  };
  expect(admit(fee)).toEqual([fee]);
  expect(offerBudget(fee).annualMinor).toBe(10100);
  expect(
    admit({
      ...fee,
      priceEvidence: { ...fee.priceEvidence, quote: fee.priceEvidence.quote + " No setup fee." },
    }),
  ).toEqual([]);
});
it("records bounded validation reasons without changing which offers are admitted", () => {
  const rejected: { offerIndex: number; code: string }[] = [];
  const missingSource = { ...prepaid, providerUrl: "https://harbour-privacy.co.uk/unretrieved" };
  const incorrectPeriod = {
    ...prepaid,
    billingUnit: "year" as const,
    prepaid: null,
    renewalMinor: 9600,
    priceEvidence: { ...prepaid.priceEvidence!, quote: "£96 for the first 27 months." },
  };
  expect(
    acceptedOffers(
      { offers: [missingSource, incorrectPeriod, prepaid] },
      new Set([source]),
      ["harbour-privacy.co.uk"],
      [],
      true,
      (item) => rejected.push(item),
    ),
  ).toEqual([prepaid]);
  expect(rejected).toEqual([
    { offerIndex: 0, code: "provider_source" },
    { offerIndex: 1, code: "billing_period" },
  ]);
});
it("accepts explicitly stated USD context without guessing the meaning of a bare dollar symbol", () => {
  const value = {
    ...prepaid,
    currency: "USD" as const,
    priceEvidence: {
      kind: "native_currency" as const,
      quote: "All prices in USD. $96 for the first 27 months. Then renews at $120 per year.",
      source,
    },
  };
  expect(admit(value)).toEqual([value]);
  for (const quote of [
    "$96 for the first 27 months. Then renews at $120 per year.",
    "USD and CAD prices: $96 for the first 27 months. Then renews at $120 per year.",
  ])
    expect(admit({ ...value, priceEvidence: { ...value.priceEvidence, quote } })).toEqual([]);
});

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
it.each([null, "1"])(
  "asks an older comparison client to refresh before doing paid work (%s)",
  async (adviceFormat) => {
    const browser = app.browser();
    await browser.login();
    const before = app.model.requests.length;
    const saved = (await browser.get("/api/subscriptions")).body;
    for (const method of ["GET", "POST"]) {
      const result = await browser.request(
        method,
        method === "GET" ? "/api/subscriptions/reviews?revision=0" : "/api/subscriptions/review",
        method === "POST" ? { serviceId: "anything", expectedRevision: 0 } : undefined,
        { adviceFormat },
      );
      expect(result.status).toBe(426);
      expect(result.body.error).toBe("client_update_required");
      expect(result.body.message).toContain("Refresh this page");
    }
    expect(app.model.requests.length).toBe(before);
    expect((await browser.get("/api/subscriptions")).body).toEqual(saved);
    expect((await browser.get("/api/subscriptions/reviews?revision=0")).status).toBe(200);
  },
);
it.each([
  { currency: "GBP" as const, fee: 0 },
  { currency: "USD" as const, fee: 0 },
  { currency: "GBP" as const, fee: 500 },
])(
  "carries a prepaid $currency charge with $fee setup through research, API/cache and visible comparison text",
  async ({ currency, fee }) => {
    const browser = app.browser();
    await browser.login();
    const ownerId = String((await browser.open()).body.ownerId),
      serviceId = "pp_unlisted_privacy";
    const purpose =
      "Privacy on a phone and a tablet while using public Wi-Fi. No streaming or special location needed.";
    await app.ctx.db.insert(ownerSubscriptions).values({
      ownerId,
      revision: 1,
      subscriptions: [
        {
          serviceId,
          name: "Original Privacy",
          amountMinor: 1400,
          cycle: "month",
          purpose,
          source: "paypal",
        },
      ],
    });
    const value = {
      ...prepaid,
      currency,
      upfrontMinor: fee,
      priceEvidence:
        currency === "GBP"
          ? {
              ...prepaid.priceEvidence!,
              quote: prepaid.priceEvidence!.quote + (fee ? " Additional setup fee £5." : ""),
            }
          : {
              kind: "native_currency" as const,
              quote: "USD 96 for the first 27 months. Then renews at USD 120 per year.",
              source,
            },
    };
    const previous = app.ctx.model;
    app.ctx.config.liveDiscovery = true;
    const web = (answer: unknown): Response =>
      ({
        id: "synthetic-research",
        model: agentModel,
        status: "completed",
        output: [
          {
            id: "retrieved-source",
            type: "web_search_call",
            status: "completed",
            action: { type: "search", sources: [{ type: "url", url: source }] },
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
      }) as Response;
    app.ctx.model = {
      responses: {
        create: async (request, options) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return web({
              providers: [{ name: value.name, website: source }],
              searchPurpose: purpose,
              namedApps: [],
              uncertainties: [],
            });
          if (stage === "ProviderOffers") return web({ offers: [value], uncertainties: [] });
          if (stage === "OfficialProvidersVerification") return web({ providers: [], uncertainties: [] });
          return app.model.responses.create(request, options);
        },
      },
    };
    app.model.script = (request) => {
      const input = JSON.parse((request.input as any[])[0].content);
      expect(input.candidates[0].price).toMatchObject({
        amount: 96,
        unit: "prepaid",
        prepaid: { initialMonths: 27, renewalMonths: 12 },
      });
      expect(input.candidates[0].annualMinor).toBe(9600 + fee);
      return {
        answer: {
          summary: "A potential alternative for the saved privacy need.",
          options: [
            {
              serviceId: input.candidates[0].id,
              reason: "Supports both devices.",
              replacement: currency === "GBP" ? "supported" : "conditional",
              condition: currency === "GBP" ? null : "GBP conversion and fees are unverified.",
            },
          ],
          uncertainties: currency === "GBP" ? [] : ["GBP conversion and fees are unverified."],
        },
      };
    };
    try {
      const response = await browser.post("/api/subscriptions/review", { serviceId, expectedRevision: 1 });
      expect(response.status).toBe(200);
      expect(response.body.comparisons[0]).toMatchObject({
        priceUnit: "prepaid",
        priceMinor: 9600,
        renewalMinor: 12000,
        prepaid: { initialMonths: 27, renewalMonths: 12 },
        upfrontMinor: fee,
        annualMinor: 9600 + fee,
        savingAnnualMinor: currency === "GBP" ? 7200 - fee : null,
      });
      const saved = await browser.get("/api/subscriptions/reviews?revision=1");
      expect(saved.body.reviews[0].advice).toEqual({
        ...response.body,
        discovery: { ...response.body.discovery, status: "cached" },
      });
      const html = renderToStaticMarkup(
        createElement(ValueComparison, {
          advice: response.body,
          data: {
            portfolio: (await browser.get("/api/subscriptions")).body,
            catalogue: (await browser.get("/api/catalogue")).body,
          },
          onRefresh: () => {},
          pending: false,
        }),
      );
      expect(html).toContain("for the first 27 months");
      expect(html).toContain("every 12 months");
      expect(html).toContain("Paid upfront.");
      if (fee) expect(html).toContain("Additional £5 setup fee.");
      expect(html).not.toMatch(/96\.00<small>\/ (?:month|year)/);
      if (currency === "USD") {
        expect(html).toContain("GBP cost and savings unverified");
        expect(html).not.toContain("less over");
      }
      expect((await browser.get("/api/subscriptions")).body.subscriptions[0]).toMatchObject({
        purpose,
        amountMinor: 1400,
        cycle: "month",
      });
    } finally {
      app.ctx.model = previous;
      app.model.script = null;
      app.ctx.config.liveDiscovery = false;
    }
  },
);
