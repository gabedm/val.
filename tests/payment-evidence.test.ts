import { describe, expect, it } from "vitest";
import {
  checkInitialPayment,
  observeTransaction,
  parseMinorUnits,
  type ExpectedInitialPayment,
} from "../src/server/payment-evidence";
import type { PaidOffer } from "../src/shared/contracts";
import type { PaypalPlan, PaypalSubscription, PaypalTransaction } from "../src/server/paypal";

// These fixtures reproduce the shapes the real sandbox returned in the 9 October A probe
// (one-decimal plan/billing amounts, two-decimal gross amount, 12:00 GBP, paid through 9 November).
const expected: ExpectedInitialPayment = {
  subscriptionId: "I-469H639RWBT5",
  paypalPlanId: "P-1NX57942CX660720SNLELG2A",
  customId: "38515fcf-b01a-480f-bca8-b35a8c3bad9f",
  recurringMinor: 1200,
};

const activeSubscription: PaypalSubscription = {
  id: expected.subscriptionId,
  plan_id: expected.paypalPlanId,
  custom_id: expected.customId,
  status: "ACTIVE",
  start_time: "2026-10-09T09:27:04Z",
  billing_info: {
    outstanding_balance: { currency_code: "GBP", value: "0.0" },
    next_billing_time: "2026-11-09T10:00:00Z",
    last_payment: { amount: { currency_code: "GBP", value: "12.0" }, time: "2026-10-09T09:33:57Z" },
  },
};

const monthlyPlan: PaypalPlan = {
  id: expected.paypalPlanId,
  product_id: "PROD-1",
  status: "ACTIVE",
  billing_cycles: [
    {
      tenure_type: "REGULAR",
      total_cycles: 0,
      frequency: { interval_unit: "MONTH", interval_count: 1 },
      pricing_scheme: { fixed_price: { currency_code: "GBP", value: "12.0" } },
    },
  ],
};

const completedTransaction: PaypalTransaction = {
  id: "79511525759051601",
  time: "2026-10-09T09:33:57.000Z",
  status: "COMPLETED",
  amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "12.00" } },
};

function check(
  overrides: {
    subscription?: Partial<PaypalSubscription>;
    plan?: Partial<PaypalPlan>;
    transactions?: PaypalTransaction[] | null;
  } = {},
) {
  const transactions = overrides.transactions === undefined ? [completedTransaction] : overrides.transactions;
  return checkInitialPayment({
    expected,
    subscription: { ...activeSubscription, ...overrides.subscription },
    plan: { ...monthlyPlan, ...overrides.plan },
    transactions: transactions && transactions.map(observeTransaction),
  });
}

describe("GBP amounts", () => {
  it.each([
    ["12", 1200],
    ["12.0", 1200],
    ["12.00", 1200],
    ["0.0", 0],
    ["9.5", 950],
  ])("reads %s as %i minor units", (value, minorUnits) => {
    expect(parseMinorUnits(value)).toBe(minorUnits);
  });

  it.each(["12.001", "-12", "abc", "", "12.", ".5", "1e3", " 12", "12,00"])(
    "rejects %j rather than rounding",
    (value) => {
      expect(parseMinorUnits(value)).toBeNull();
    },
  );
});

describe("initial payment predicate", () => {
  it("verifies the exact completed charge and returns the paid-period boundary", () => {
    expect(check()).toEqual({
      verdict: "VERIFIED",
      transaction: expect.objectContaining({
        id: "79511525759051601",
        status: "COMPLETED",
        gross: { currency: "GBP", amountMinor: 1200 },
      }),
      period: { periodStart: "2026-10-09T09:27:04.000Z", paidThrough: "2026-11-09T10:00:00.000Z" },
    });
  });

  it.each([
    ["approval is still pending", { subscription: { status: "APPROVAL_PENDING" } }],
    ["ACTIVE has no recorded transaction", { transactions: [] }],
    ["the transaction list is unavailable (404)", { transactions: null }],
    ["the transaction is still PENDING", { transactions: [{ ...completedTransaction, status: "PENDING" }] }],
    ["the transaction has no status", { transactions: [{ ...completedTransaction, status: undefined }] }],
    [
      "an outstanding balance remains",
      {
        subscription: {
          billing_info: {
            ...activeSubscription.billing_info,
            outstanding_balance: { currency_code: "GBP", value: "12.0" },
          },
        },
      },
    ],
    [
      "the outstanding balance is not reported",
      {
        subscription: {
          billing_info: { ...activeSubscription.billing_info, outstanding_balance: undefined },
        },
      },
    ],
    [
      "the next billing boundary is missing",
      {
        subscription: { billing_info: { ...activeSubscription.billing_info, next_billing_time: undefined } },
      },
    ],
    [
      "last_payment is missing",
      { subscription: { billing_info: { ...activeSubscription.billing_info, last_payment: undefined } } },
    ],
  ])("stays pending when %s", (_label, overrides) => {
    expect(check(overrides)).toMatchObject({ verdict: "PENDING" });
  });

  it.each([
    ["the subscription overrides the accepted plan", { subscription: { plan_overridden: true } }],
    ["the transaction has no identifier", { transactions: [{ ...completedTransaction, id: "" }] }],
    [
      "the shipping charge is malformed",
      { subscription: { shipping_amount: { currency_code: "GBP", value: "unknown" } } },
    ],
    [
      "the setup fee is malformed",
      { plan: { payment_preferences: { setup_fee: { currency_code: "GBP", value: "unknown" } } } },
    ],
    [
      "the amount differs",
      {
        transactions: [
          {
            ...completedTransaction,
            amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "14.00" } },
          },
        ],
      },
    ],
    [
      "the currency differs",
      {
        transactions: [
          {
            ...completedTransaction,
            amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "12.00" } },
          },
        ],
      },
    ],
    [
      "the gross amount is malformed",
      {
        transactions: [
          {
            ...completedTransaction,
            amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "12.005" } },
          },
        ],
      },
    ],
    ["the charge was refunded", { transactions: [{ ...completedTransaction, status: "REFUNDED" }] }],
    [
      "the charge was partially refunded",
      { transactions: [{ ...completedTransaction, status: "PARTIALLY_REFUNDED" }] },
    ],
    ["the charge was declined", { transactions: [{ ...completedTransaction, status: "DECLINED" }] }],
    [
      "two transactions exist for the initial period",
      { transactions: [completedTransaction, { ...completedTransaction, id: "second" }] },
    ],
    ["the subscription belongs to another plan", { subscription: { plan_id: "P-OTHER" } }],
    [
      "the custom_id names another case or operation",
      { subscription: { custom_id: "other-case.other-operation" } },
    ],
    ["the subscription ID is not the stored one", { subscription: { id: "I-SOMEONE-ELSE" } }],
    ["the subscription is SUSPENDED", { subscription: { status: "SUSPENDED" } }],
    [
      "the plan price differs from the accepted price",
      {
        plan: {
          billing_cycles: [
            {
              ...monthlyPlan.billing_cycles![0]!,
              pricing_scheme: { fixed_price: { currency_code: "GBP", value: "14.0" } },
            },
          ],
        },
      },
    ],
    [
      "the plan has a trial cycle",
      {
        plan: {
          billing_cycles: [
            { ...monthlyPlan.billing_cycles![0]!, tenure_type: "TRIAL" },
            monthlyPlan.billing_cycles![0]!,
          ],
        },
      },
    ],
    [
      "the plan is yearly",
      {
        plan: {
          billing_cycles: [
            { ...monthlyPlan.billing_cycles![0]!, frequency: { interval_unit: "YEAR", interval_count: 1 } },
          ],
        },
      },
    ],
    [
      "the plan has a setup fee",
      { plan: { payment_preferences: { setup_fee: { currency_code: "GBP", value: "1.00" } } } },
    ],
    [
      "last_payment contradicts the transaction time",
      {
        subscription: {
          billing_info: {
            ...activeSubscription.billing_info,
            last_payment: { amount: { currency_code: "GBP", value: "12.0" }, time: "2026-10-09T08:00:00Z" },
          },
        },
      },
    ],
    [
      "last_payment contradicts the amount",
      {
        subscription: {
          billing_info: {
            ...activeSubscription.billing_info,
            last_payment: { amount: { currency_code: "GBP", value: "9.0" }, time: "2026-10-09T09:33:57Z" },
          },
        },
      },
    ],
    [
      "the paid boundary is not after the period start",
      {
        subscription: {
          billing_info: { ...activeSubscription.billing_info, next_billing_time: "2026-10-09T09:00:00Z" },
        },
      },
    ],
    ["the payment falls outside the paid period", { subscription: { start_time: "2026-10-09T09:40:00Z" } }],
  ])("fails when %s", (_label, overrides) => {
    expect(check(overrides)).toMatchObject({ verdict: "FAILED" });
  });

  it("never treats an unknown transaction status as complete", () => {
    expect(observeTransaction({ ...completedTransaction, status: "SOMETHING_NEW" }).status).toBe("UNKNOWN");
    expect(observeTransaction({ ...completedTransaction, status: undefined }).status).toBe("UNKNOWN");
  });

  it("records an unreadable transaction time as unknown", () => {
    expect(observeTransaction({ ...completedTransaction, time: "not-a-date" }).time).toBeNull();
    expect(check({ transactions: [{ ...completedTransaction, time: "not-a-date" }] }).verdict).toBe("FAILED");
  });

  it("keeps a wrong-currency observation instead of normalising it", () => {
    const observed = observeTransaction({
      ...completedTransaction,
      amount_with_breakdown: { gross_amount: { currency_code: "USD", value: "12.00" } },
    });
    expect(observed.gross).toEqual({ currency: "USD", amountMinor: 1200 });
  });
});

describe("paid introductory first charge (authored local PayPal stand-in shape)", () => {
  const money = (amountMinor: number) => ({ currency: "GBP" as const, amountMinor });
  const offer: PaidOffer = {
    introductoryAmount: money(600),
    introductoryCycles: 3,
    regularAmount: money(900),
    validFrom: "2026-10-09T00:00:00.000Z",
    eligibleUntil: "2026-11-09T00:00:00.000Z",
    firstChargeBasis: "BUYER_APPROVAL",
    eligibility: "ELIGIBLE",
    setupFee: money(0),
    commitmentMonths: 0,
  };
  const accepted = { ...expected, paypalPlanId: "P-PAID-INTRO", recurringMinor: 600, offer };
  const plan: PaypalPlan = {
    ...monthlyPlan,
    id: accepted.paypalPlanId,
    billing_cycles: [
      {
        tenure_type: "TRIAL",
        sequence: 1,
        total_cycles: 3,
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        pricing_scheme: { fixed_price: { currency_code: "GBP", value: "6.0" } },
      },
      {
        tenure_type: "REGULAR",
        sequence: 2,
        total_cycles: 0,
        frequency: { interval_unit: "MONTH", interval_count: 1 },
        pricing_scheme: { fixed_price: { currency_code: "GBP", value: "9.0" } },
      },
    ],
  };
  const subscription: PaypalSubscription = {
    ...activeSubscription,
    plan_id: accepted.paypalPlanId,
    billing_info: {
      ...activeSubscription.billing_info,
      last_payment: { amount: { currency_code: "GBP", value: "6.0" }, time: completedTransaction.time },
      cycle_executions: [
        { tenure_type: "TRIAL", sequence: 1, total_cycles: 3, cycles_completed: 1, cycles_remaining: 2 },
        { tenure_type: "REGULAR", sequence: 2, total_cycles: 0, cycles_completed: 0, cycles_remaining: 0 },
      ],
    },
  };
  const transaction: PaypalTransaction = {
    ...completedTransaction,
    amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "6.00" } },
  };
  const decide = (
    changes: {
      expected?: ExpectedInitialPayment;
      plan?: PaypalPlan;
      subscription?: PaypalSubscription;
      transactions?: PaypalTransaction[];
    } = {},
  ) =>
    checkInitialPayment({
      expected: changes.expected ?? accepted,
      plan: changes.plan ?? plan,
      subscription: changes.subscription ?? subscription,
      transactions: (changes.transactions ?? [transaction]).map(observeTransaction),
    });

  it("verifies one positive £6 payment only with the accepted three paid cycles and £9 renewal", () => {
    expect(decide()).toMatchObject({
      verdict: "VERIFIED",
      transaction: { gross: money(600) },
      period: { paidThrough: "2026-11-09T10:00:00.000Z" },
    });
    expect(decide({ transactions: [transaction, { ...transaction, id: "second" }] }).verdict).toBe("FAILED");
  });

  it("verifies payment inside the approved offer window, not before its start or at its end", () => {
    expect(decide().verdict).toBe("VERIFIED");
    expect(
      decide({ expected: { ...accepted, offer: { ...offer, validFrom: "2026-10-09T10:00:00.000Z" } } })
        .verdict,
    ).toBe("FAILED");
    expect(
      decide({ expected: { ...accepted, offer: { ...offer, eligibleUntil: "2026-10-09T08:00:00.000Z" } } })
        .verdict,
    ).toBe("FAILED");
  });

  it("does not mistake a free, changed or unreported schedule for the approved paid offer", () => {
    const cycles = plan.billing_cycles!;
    expect(
      decide({
        transactions: [
          {
            ...transaction,
            amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "0.00" } },
          },
        ],
      }).verdict,
    ).toBe("FAILED");
    expect(
      decide({
        plan: {
          ...plan,
          billing_cycles: [
            { ...cycles[0]!, pricing_scheme: { fixed_price: { currency_code: "GBP", value: "0.0" } } },
            cycles[1]!,
          ],
        },
      }).verdict,
    ).toBe("FAILED");
    expect(
      decide({
        plan: {
          ...plan,
          billing_cycles: [
            cycles[0]!,
            { ...cycles[1]!, pricing_scheme: { fixed_price: { currency_code: "GBP", value: "10.0" } } },
          ],
        },
      }).verdict,
    ).toBe("FAILED");
    expect(
      decide({ plan: { ...plan, billing_cycles: [{ ...cycles[0]!, total_cycles: 2 }, cycles[1]!] } }).verdict,
    ).toBe("FAILED");
    expect(
      decide({
        subscription: {
          ...subscription,
          billing_info: { ...subscription.billing_info, cycle_executions: undefined },
        },
      }).verdict,
    ).toBe("PENDING");
    expect(
      decide({
        subscription: {
          ...subscription,
          billing_info: {
            ...subscription.billing_info,
            cycle_executions: [
              { ...subscription.billing_info!.cycle_executions![0]!, cycles_completed: 2 },
              subscription.billing_info!.cycle_executions![1]!,
            ],
          },
        },
      }).verdict,
    ).toBe("FAILED");
  });
});
