import { expect, it } from "vitest";
import { subscriptionBilling } from "../src/server/subscription-billing";
import type { PaypalPlan, PaypalSubscription } from "../src/server/paypal";

const subscription = (): PaypalSubscription => ({
  id: "I-test",
  plan_id: "P-test",
  status: "ACTIVE",
  billing_info: {
    last_payment: { amount: { currency_code: "GBP", value: "12.0" }, time: "2026-10-16T10:00:00Z" },
  },
});
const plan = (): PaypalPlan => ({
  id: "P-test",
  product_id: "PROD-test",
  status: "ACTIVE",
  billing_cycles: [
    {
      tenure_type: "REGULAR",
      sequence: 1,
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "GBP", value: "12.00" } },
    },
  ],
});

it("reads the actual monthly or annual GBP agreement without treating it as payment verification", () => {
  expect(subscriptionBilling(subscription(), plan())).toEqual({ amountMinor: 1200, cycle: "month" });
  const annual = plan();
  annual.billing_cycles![0]!.frequency = { interval_unit: "YEAR", interval_count: 1 };
  expect(subscriptionBilling(subscription(), annual)).toEqual({ amountMinor: 1200, cycle: "year" });
  annual.billing_cycles![0]!.frequency = { interval_unit: "MONTH", interval_count: 12 };
  expect(subscriptionBilling(subscription(), annual)).toEqual({ amountMinor: 1200, cycle: "year" });
  expect(subscriptionBilling({ ...subscription(), billing_info: undefined }, plan())).toEqual({
    amountMinor: 1200,
    cycle: "month",
  });
});

it("uses subscription-specific terms and refuses to replace an override with the general plan", () => {
  const value = subscription();
  const effective = plan();
  effective.billing_cycles![0]!.pricing_scheme!.fixed_price!.value = "9.99";
  value.plan_overridden = true;
  value.plan = effective;
  value.billing_info!.last_payment!.amount.value = "9.99";
  expect(subscriptionBilling(value, plan())).toBeNull();
  expect(subscriptionBilling(value, value.plan)).toEqual({ amountMinor: 999, cycle: "month" });
});

it("imports an explicit thirty-day PayPal charge without relabelling it as calendar-month billing", () => {
  const terms = plan();
  terms.billing_cycles![0]!.frequency = { interval_unit: "DAY", interval_count: 30 };
  expect(subscriptionBilling(subscription(), terms)).toEqual({ amountMinor: 1200, cycle: "30_days" });
  for (const days of [1, 28, 31, 365]) {
    terms.billing_cycles![0]!.frequency.interval_count = days;
    expect(subscriptionBilling(subscription(), terms)).toBeNull();
  }
  terms.billing_cycles![0]!.frequency.interval_count = 30;
  const arrears = subscription();
  arrears.billing_info!.last_payment!.amount.value = "24.00";
  expect(subscriptionBilling(arrears, terms)).toBeNull();
});

it("retains unknown costs for missing, non-GBP, malformed, tiered or unsupported billing terms", () => {
  expect(subscriptionBilling(subscription(), undefined)).toBeNull();
  const variants = [
    (value: PaypalPlan) => {
      value.id = "P-other";
    },
    (value: PaypalPlan) => {
      value.billing_cycles = [];
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.frequency.interval_unit = "WEEK";
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.frequency.interval_count = 3;
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.pricing_scheme!.fixed_price!.currency_code = "USD";
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.pricing_scheme!.fixed_price!.value = "12.001";
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.pricing_scheme!.fixed_price!.value = "-12.00";
    },
    (value: PaypalPlan) => {
      value.billing_cycles![0]!.pricing_scheme!.pricing_model = "TIERED";
    },
    (value: PaypalPlan) => {
      value.taxes = { percentage: "20", inclusive: false };
    },
  ];
  for (const mutate of variants) {
    const value = plan();
    mutate(value);
    expect(subscriptionBilling(subscription(), value)).toBeNull();
  }
  expect(subscriptionBilling({ ...subscription(), quantity: "0.5" }, plan())).toBeNull();
  expect(subscriptionBilling({ ...subscription(), status: "CANCELLED" }, plan())).toBeNull();
});

it("does not mistake a setup charge, arrears or a changed last payment for the regular bill", () => {
  const value = subscription();
  value.billing_info!.last_payment!.amount.value = "24.00";
  expect(subscriptionBilling(value, plan())).toBeNull();
  value.billing_info!.last_payment!.amount = { currency_code: "USD", value: "12.00" };
  expect(subscriptionBilling(value, plan())).toBeNull();
});

it("handles supported quantities, shipping and inclusive tax using exact amounts", () => {
  const value = subscription();
  const terms = plan();
  terms.quantity_supported = true;
  terms.taxes = { percentage: "20", inclusive: true };
  value.quantity = "2";
  value.shipping_amount = { currency_code: "GBP", value: "1.25" };
  value.billing_info!.last_payment!.amount.value = "25.25";
  expect(subscriptionBilling(value, terms)).toEqual({ amountMinor: 2525, cycle: "month" });
});

it("waits for regular billing after a trial instead of turning a temporary rate into lasting savings", () => {
  const value = subscription();
  const terms = plan();
  terms.billing_cycles![0]!.sequence = 2;
  terms.billing_cycles!.unshift({
    tenure_type: "TRIAL",
    sequence: 1,
    total_cycles: 2,
    frequency: { interval_unit: "MONTH", interval_count: 1 },
    pricing_scheme: { fixed_price: { currency_code: "GBP", value: "1.00" } },
  });
  expect(subscriptionBilling(value, terms)).toBeNull();
  value.billing_info!.cycle_executions = [
    { tenure_type: "TRIAL", sequence: 1, cycles_completed: 2 },
    { tenure_type: "REGULAR", sequence: 2, cycles_completed: 1 },
  ];
  expect(subscriptionBilling(value, terms)).toEqual({ amountMinor: 1200, cycle: "month" });
});
