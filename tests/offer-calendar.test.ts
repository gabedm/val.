import { expect, it } from "vitest";
import { acceptedOffers, offerBudget, type LiveOffer } from "../src/server/live-discovery";
const source = "https://provider.co.uk/plans";
const base: LiveOffer = {
  name: "Provider",
  plan: "Monthly plan",
  providerUrl: source,
  currency: "GBP",
  market: "GB",
  priceMinor: 750,
  renewalMinor: 750,
  billingUnit: "month",
  billingEvidence: { quote: "We bill you every calendar month.", source },
  introductoryCycles: 0,
  minimumTermMonths: 24,
  upfrontMinor: 0,
  features: ["2GB ordinary data"],
  conditions: ["The monthly price is scheduled to rise to £7.95 on 1 April 2027."],
  sources: [source],
  priceEvidence: {
    kind: "direct_gbp",
    quote: "£7.50 a month; total monthly cost will increase to £7.95 on 01 Apr 2027.",
    source,
  },
};
const change = {
  on: "2027-04-01",
  priceMinor: 795,
  quote: "Total monthly cost will increase to £7.95 on 01 Apr 2027.",
  source,
};
const admit = (offer: LiveOffer) =>
  acceptedOffers({ offers: [offer] }, new Set([source]), ["provider.co.uk"], [], true);
it("rejects a flat or guessed-cycle representation of a published calendar rise", () => {
  expect(admit(base)).toEqual([]);
  expect(admit({ ...base, introductoryCycles: 12, renewalMinor: 795 })).toEqual([]);
  expect(
    admit({
      ...base,
      introductoryCycles: 12,
      renewalMinor: 795,
      conditions: [],
      priceEvidence: { kind: "direct_gbp", quote: "£7.50; £7.95 from 1 April 2027", source },
    }),
  ).toEqual([]);
  expect(admit({ ...base, scheduledChanges: [change] })).toHaveLength(1);
});
it("budgets actual monthly charge dates and known fees rather than twelve starting-price payments", () => {
  const offer = { ...base, scheduledChanges: [change] };
  expect(offerBudget(offer, "2026-10-18")).toMatchObject({
    annualMinor: 9270,
    cycles: 12,
    firstChargeMinor: 750,
  });
  expect(14400 - offerBudget(offer, "2026-10-18").annualMinor).toBe(5130);
  expect(offerBudget({ ...offer, upfrontMinor: 500 }, "2026-10-18").annualMinor).toBe(9770);
  expect(offerBudget(offer, "2027-04-01")).toMatchObject({ annualMinor: 9540, firstChargeMinor: 795 });
});
it("handles end-of-month anchoring, effective-date inclusivity and 30-day intervals", () => {
  const february = { ...base, scheduledChanges: [{ ...change, on: "2027-02-28" }] };
  expect(offerBudget(february, "2027-01-31").annualMinor).toBe(9495);
  const rolling = {
    ...base,
    billingUnit: "30_days" as const,
    scheduledChanges: [{ ...change, on: "2027-03-02" }],
  };
  expect(offerBudget(rolling, "2027-01-01")).toMatchObject({ annualMinor: 10245, cycles: 13 });
});
it("supports multiple source-backed rates without double-counting them", () => {
  const second = { on: "2027-07-01", priceMinor: 850, quote: "From 1 July 2027: £8.50 per month.", source };
  const offer = {
    ...base,
    priceEvidence: {
      ...base.priceEvidence!,
      quote: base.priceEvidence!.quote + " From 1 July 2027: £8.50 per month.",
    },
    scheduledChanges: [second, change],
  };
  expect(admit(offer)).toHaveLength(1);
  expect(offerBudget(offer, "2026-10-18").annualMinor).toBe(9435);
});
it("rejects invented dates, ungrounded rates, conflicting events and unsupported pricing combinations", () => {
  for (const altered of [
    { ...change, on: "2027-02-30" },
    { ...change, on: "2027-04-02" },
    { ...change, priceMinor: 650 },
    { ...change, source: "https://provider.co.uk/not-retrieved" },
    { ...change, quote: "£7.95 on 1 April 2027 or £8.50" },
  ])
    expect(admit({ ...base, scheduledChanges: [altered] })).toEqual([]);
  expect(admit({ ...base, scheduledChanges: [change, { ...change, priceMinor: 850 }] })).toEqual([]);
  expect(admit({ ...base, introductoryCycles: 2, scheduledChanges: [change] })).toEqual([]);
  expect(admit({ ...base, conditions: ["Prices increase with CPI"], scheduledChanges: [change] })).toEqual(
    [],
  );
  expect(
    admit({ ...base, scheduledChanges: [{ ...change, quote: "£7.95 excluding VAT from 1 April 2027" }] }),
  ).toEqual([]);
  const flat = {
    ...base,
    conditions: ["Prices will not increase."],
    priceEvidence: { kind: "direct_gbp" as const, quote: "£7.50 per month", source },
  };
  expect(admit(flat)).toHaveLength(1);
  expect(admit({ ...flat, priceEvidence: { ...flat.priceEvidence, quote: "£7.50 excluding VAT" } })).toEqual(
    [],
  );
  expect(admit({ ...flat, priceEvidence: { ...flat.priceEvidence, quote: "£7.5001 per month" } })).toEqual(
    [],
  );
});
