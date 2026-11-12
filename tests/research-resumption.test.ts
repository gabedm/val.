import { expect, it, vi } from "vitest";
import type { Response } from "openai/resources/responses/responses";
import {
  acceptedOffers,
  discoverLiveOffers,
  validatedProviderCache,
  type LiveOffer,
} from "../src/server/live-discovery";

const url = "https://unlisted-utility.example.org/plans";
const entry = {
  serviceId: "opaque-utility",
  name: "An unfamiliar utility",
  source: "paypal" as const,
  amountMinor: 1400,
  cycle: "month" as const,
  purpose: "Only need private document search for myself, offline on a Windows laptop.",
};
const offer: LiveOffer = {
  name: "Unlisted Utility",
  plan: "Personal",
  providerUrl: url,
  currency: "GBP",
  market: "GB",
  priceMinor: 800,
  billingUnit: "month",
  billingEvidence: { quote: "Plan automatically renews until cancelled.", source: url },
  priceEvidence: { kind: "direct_gbp", quote: "Personal £8/month", source: url },
  introductoryCycles: 0,
  renewalMinor: 800,
  minimumTermMonths: 0,
  upfrontMinor: 0,
  features: ["Offline document search on Windows"],
  conditions: [],
  sources: [url],
};
function response(answer: unknown): Response {
  return {
    id: "receipt-" + Math.random(),
    model: "test",
    status: "completed",
    output: [
      {
        id: "retrieval",
        type: "web_search_call",
        status: "completed",
        action: { type: "search", query: "utility plans", sources: [{ type: "url", url }] },
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

it("resolves an ambiguous price with a separately retrieved charge-currency clause without inventing an exchange rate", () => {
  const currencyUrl = "https://unlisted-utility.example.org/billing";
  const native: LiveOffer = {
    ...offer,
    currency: "USD",
    priceEvidence: { kind: "native_currency", quote: "$8/month", source: url },
    currencyEvidence: { quote: "All subscription payments are charged in US dollars.", source: currencyUrl },
    sources: [url, currencyUrl],
  };
  const accept = (value: LiveOffer, sources = new Set([url, currencyUrl])) =>
    acceptedOffers({ offers: [value] }, sources, ["unlisted-utility.example.org"], [], true);
  expect(accept(native)).toEqual([native]);
  expect(accept({ ...native, currencyEvidence: null })).toEqual([]);
  expect(accept(native, new Set([url]))).toEqual([]);
  for (const quote of [
    "Prices shown in approximate USD equivalents.",
    "Payments are not charged in US dollars.",
    "US dollars are supported as a display currency; charges are CAD.",
  ])
    expect(accept({ ...native, currencyEvidence: { quote, source: currencyUrl } })).toEqual([]);
  expect(accept({ ...native, priceMinor: 700, renewalMinor: 700 })).toEqual([]);
  expect(
    accept({
      ...native,
      currencyEvidence: {
        quote: "Payments are charged in USD.",
        source: "https://unrelated.example.net/billing",
      },
    }),
  ).toEqual([]);
});

it("repairs an unsourced provider check with a focused fact question inside the remaining research window", async () => {
  const stages: string[] = [],
    start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    const result = await discoverLiveOffers(
      {
        provider: "google",
        responses: {
          create: async (request) => {
            const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
            stages.push(stage);
            if (stage === "OfficialProviders")
              return response({
                providers: [{ name: offer.name, website: url }],
                searchPurpose: entry.purpose,
                namedApps: [],
                uncertainties: [],
              });
            if (stage === "ProviderOffers") {
              clock.mockReturnValue(start + 150_000);
              const empty = response({
                offers: [],
                researchGaps: ["Ongoing price and required offline support on this provider's own pages."],
                uncertainties: [],
                billingResearchNeeded: false,
              });
              (empty.output[0] as any).action.sources = [
                { type: "url", url: "https://unrelated.example.net/review" },
              ];
              return empty;
            }
            expect(JSON.stringify(request.input)).toContain("researchGaps");
            expect(request.instructions).toContain("focused query");
            return response({
              offers: [offer],
              researchGaps: [],
              uncertainties: [],
              billingResearchNeeded: false,
            });
          },
        },
      },
      entry,
    );
    expect(stages).toEqual(["OfficialProviders", "ProviderOffers", "ProviderOffersRepair"]);
    expect(result.offers).toEqual([offer]);
    expect(result.pendingProviders).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

it("retains zero-offer checkpoints and resumes rejected billing without repeating discovery", async () => {
  const first = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders")
            return response({
              providers: [{ name: offer.name, website: url }],
              searchPurpose: entry.purpose,
              namedApps: [],
              uncertainties: [],
            });
          if (stage === "ProviderOffersRepair") throw new Error("Temporary source failure");
          return response({
            offers: [{ ...offer, billingEvidence: null }],
            uncertainties: [],
            billingResearchNeeded: true,
          });
        },
      },
    },
    entry,
  );
  expect(first.offers).toEqual([]);
  expect(first.pendingProviders).toEqual(["unlisted-utility.example.org"]);
  expect(validatedProviderCache(first, entry)?.offers).toEqual([]);
  const stages: string[] = [];
  const resumed = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          stages.push(stage);
          if (stage === "OfficialProvidersExpansion")
            return response({
              providers: [],
              searchPurpose: entry.purpose,
              namedApps: [],
              uncertainties: [],
            });
          return response({ offers: [offer], uncertainties: [], billingResearchNeeded: false });
        },
      },
    },
    entry,
    undefined,
    [],
    { resume: first },
  );
  expect(stages).toEqual(["OfficialProvidersExpansion", "ProviderOffersRepair"]);
  expect(resumed.offers).toEqual([offer]);
  expect(resumed.pendingProviders).toEqual([]);
});

it("composes separately retrieved price and renewal clauses without accepting a forged source or contradictory cycle", () => {
  const accept = (value: LiveOffer) =>
    acceptedOffers({ offers: [value] }, new Set([url]), ["unlisted-utility.example.org"], [], true);
  expect(accept(offer)).toEqual([offer]);
  expect(
    accept({ ...offer, priceEvidence: { ...offer.priceEvidence!, quote: "Personal £8\u200B/month" } }),
  ).toHaveLength(1);
  expect(
    accept({
      ...offer,
      priceEvidence: { ...offer.priceEvidence!, source: "https://unlisted-utility.example.org/unretrieved" },
    }),
  ).toEqual([]);
  expect(accept({ ...offer, conditions: ["Billed annually in advance"] })).toEqual([]);
  expect(
    accept({ ...offer, billingEvidence: { quote: "Automatically renews every 30 days", source: url } }),
  ).toEqual([]);
});

it("automatically continues with unread candidates instead of getting stuck on the first unpriceable sites", async () => {
  const domains = [
    "one.example.org",
    "two.example.org",
    "three.example.org",
    "four.example.org",
    "five.example.org",
  ];
  const sources = (host: string, answer: unknown) => {
    const result = response(answer);
    (result.output[0] as any).action.sources = [{ type: "url", url: `https://${host}/plans` }];
    return result;
  };
  const first = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          if (
            request.text?.format?.type === "json_schema" &&
            request.text.format.name === "OfficialProviders"
          )
            return response({
              providers: domains.map((host) => ({ name: host, website: `https://${host}/plans` })),
              searchPurpose: entry.purpose,
              namedApps: [],
              uncertainties: [],
            });
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          const host = tool?.type === "web_search" ? tool.filters!.allowed_domains![0]! : "";
          return sources(host, { offers: [], uncertainties: [], billingResearchNeeded: false });
        },
      },
    },
    entry,
  );
  expect(first.pendingProviders).toEqual(domains.slice(3));
  const called: string[] = [];
  const next = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          if (
            request.text?.format?.type === "json_schema" &&
            request.text.format.name === "OfficialProvidersExpansion"
          )
            return response({
              providers: [],
              searchPurpose: entry.purpose,
              namedApps: [],
              uncertainties: [],
            });
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          const host = tool?.type === "web_search" ? tool.filters!.allowed_domains![0]! : "";
          called.push(host);
          const source = `https://${host}/plans`;
          return sources(host, {
            offers: [
              {
                ...offer,
                providerUrl: source,
                sources: [source],
                priceEvidence: { ...offer.priceEvidence!, source },
                billingEvidence: { ...offer.billingEvidence!, source },
              },
            ],
            uncertainties: [],
            billingResearchNeeded: false,
          });
        },
      },
    },
    entry,
    undefined,
    [],
    { resume: first },
  );
  expect(called).toEqual(domains.slice(3));
  expect(next.offers).toHaveLength(2);
  expect(next.pendingProviders).toEqual([]);
  expect(validatedProviderCache(next, entry)?.offers).toHaveLength(2);
});

it("discovers another provider when initial sites are unpriceable and retains that lead for fresh price checks", async () => {
  const extra = "https://other-utility.example.net/plans";
  const reply = (answer: unknown, source = url) => {
    const result = response(answer);
    (result.output[0] as any).action.sources = [{ type: "url", url: source }];
    return result;
  };
  const providers = {
    providers: [{ name: offer.name, website: url }],
    searchPurpose: entry.purpose,
    namedApps: [],
    uncertainties: [],
  };
  const first = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProviders") return reply(providers);
          if (stage === "ProviderOffersRepair") throw new Error("Unpriceable source");
          return reply({
            offers: [],
            uncertainties: ["The price could not be established."],
            billingResearchNeeded: false,
          });
        },
      },
    },
    entry,
  );
  const nextOffer = {
    ...offer,
    name: "Another Utility",
    providerUrl: extra,
    sources: [extra],
    priceEvidence: { ...offer.priceEvidence!, source: extra },
    billingEvidence: { ...offer.billingEvidence!, source: extra },
  };
  const resumed = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          if (stage === "OfficialProvidersExpansion")
            return reply({ ...providers, providers: [{ name: nextOffer.name, website: extra }] }, extra);
          if (stage === "ProviderOffersRepair") throw new Error("Original site remains unpriceable");
          return reply({ offers: [nextOffer], uncertainties: [], billingResearchNeeded: false }, extra);
        },
      },
    },
    entry,
    undefined,
    [],
    { resume: first },
  );
  expect(resumed.offers).toEqual([nextOffer]);
  const freshCalls: string[] = [];
  const refreshed = {
    ...nextOffer,
    priceMinor: 900,
    renewalMinor: 900,
    priceEvidence: { ...nextOffer.priceEvidence, quote: "Personal £9/month" },
  };
  const fresh = await discoverLiveOffers(
    {
      responses: {
        create: async (request) => {
          const stage = request.text?.format?.type === "json_schema" ? request.text.format.name : "";
          expect(stage).toBe("ProviderOffers");
          const tool = request.tools?.find((tool) => tool.type === "web_search");
          const host = tool?.type === "web_search" ? tool.filters!.allowed_domains![0]! : "";
          freshCalls.push(host);
          return host === "other-utility.example.net"
            ? reply({ offers: [refreshed], uncertainties: [] }, extra)
            : reply({ offers: [], uncertainties: [] });
        },
      },
    },
    entry,
    undefined,
    [],
    { seed: resumed },
  );
  expect(freshCalls[0]).toBe("other-utility.example.net");
  expect(fresh.offers).toEqual([refreshed]);
});
