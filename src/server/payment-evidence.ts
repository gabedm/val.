import type { ObservedMoney, PaidOffer, PaymentEvidence } from "../shared/contracts";
import type { PaypalMoney, PaypalPlan, PaypalSubscription, PaypalTransaction } from "./paypal";

const knownTransactionStatuses: string[] = [
  "COMPLETED",
  "DECLINED",
  "PARTIALLY_REFUNDED",
  "PENDING",
  "REFUNDED",
  "FAILED",
];

export interface ObservedTransaction {
  id: string;
  status: PaymentEvidence["status"];
  gross: ObservedMoney | null;
  time: string | null;
}

export interface ExpectedInitialPayment {
  subscriptionId: string;
  paypalPlanId: string;
  customId: string;
  /** Exact gross charge for the first paid cycle; legacy plans use their regular monthly amount. */
  recurringMinor: number;
  offer?: PaidOffer;
}

export interface PaidPeriod {
  periodStart: string;
  paidThrough: string;
}

export type PaymentVerdict =
  | { verdict: "VERIFIED"; transaction: ObservedTransaction; period: PaidPeriod }
  | { verdict: "PENDING" | "FAILED"; reason: string };

/** Parses 12, 12.0 and 12.00 exactly (all 1200); rejects negative, non-numeric and excess-precision values. */
export function parseMinorUnits(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) return null;
  const minorUnits = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(minorUnits) ? minorUnits : null;
}

export function parseMoney(money: PaypalMoney | undefined): ObservedMoney | null {
  if (!money || !/^[A-Z]{3}$/.test(money.currency_code)) return null;
  const amountMinor = parseMinorUnits(money.value);
  return amountMinor === null ? null : { currency: money.currency_code, amountMinor };
}

const isGbpAmount = (money: ObservedMoney | null, minorUnits: number) =>
  money?.currency === "GBP" && money.amountMinor === minorUnits;

/** A transaction with a missing or unrecognised status is UNKNOWN, never assumed complete. */
export function observeTransaction(transaction: PaypalTransaction): ObservedTransaction {
  const status =
    transaction.status && knownTransactionStatuses.includes(transaction.status)
      ? transaction.status
      : "UNKNOWN";
  return {
    id: transaction.id,
    status: status as ObservedTransaction["status"],
    gross: parseMoney(transaction.amount_with_breakdown?.gross_amount),
    time: Number.isFinite(Date.parse(transaction.time)) ? transaction.time : null,
  };
}

const billingStatuses = [
  "APPROVAL_PENDING",
  "APPROVED",
  "ACTIVE",
  "SUSPENDED",
  "CANCELLED",
  "EXPIRED",
] as const;

export function billingStatusOf(status: string): (typeof billingStatuses)[number] | "UNKNOWN" {
  return billingStatuses.find((known) => known === status) ?? "UNKNOWN";
}

/** The remote subscription must be the one this operation created: same ID, mapped plan and case/operation custom_id. */
export function associationProblem(
  subscription: PaypalSubscription,
  expected: Pick<ExpectedInitialPayment, "subscriptionId" | "paypalPlanId" | "customId">,
): string | null {
  const matches =
    subscription.id === expected.subscriptionId &&
    subscription.plan_id === expected.paypalPlanId &&
    subscription.custom_id === expected.customId;
  return matches ? null : "Subscription, plan or custom_id does not match the stored operation.";
}

const pending = (reason: string): PaymentVerdict => ({ verdict: "PENDING", reason });
const failed = (reason: string): PaymentVerdict => ({ verdict: "FAILED", reason });

/**
 * Decides whether the initial payment is proven. ACTIVE alone is never enough: it also needs
 * exactly one identified COMPLETED transaction for the accepted gross amount, a zero balance,
 * matching effective plan terms and a verifiable paid period.
 * `transactions` is null when PayPal's transaction list was unavailable (404 before approval).
 * Renewals are handled separately; multiple initial-period transactions remain ambiguous.
 */
export function checkInitialPayment(input: {
  expected: ExpectedInitialPayment;
  subscription: PaypalSubscription;
  plan: PaypalPlan;
  transactions: ObservedTransaction[] | null;
}): PaymentVerdict {
  const { expected, subscription, plan, transactions } = input;

  const mismatch = associationProblem(subscription, expected);
  if (mismatch) return failed(mismatch);
  if (subscription.status === "APPROVAL_PENDING" || subscription.status === "APPROVED")
    return pending(`Subscription is ${subscription.status}.`);
  if (subscription.status !== "ACTIVE") return failed(`Subscription is ${subscription.status}.`);
  if (subscription.plan_overridden) return failed("Subscription-specific plan terms have not been accepted.");

  const planProblem = describePlanMismatch(
    plan,
    expected.offer?.regularAmount.amountMinor ?? expected.recurringMinor,
    expected.offer,
  );
  if (
    expected.offer &&
    (expected.offer.introductoryAmount.amountMinor !== expected.recurringMinor ||
      expected.offer.eligibility !== "ELIGIBLE" ||
      !Number.isFinite(Date.parse(expected.offer.validFrom)) ||
      !Number.isFinite(Date.parse(expected.offer.eligibleUntil)) ||
      Date.parse(expected.offer.validFrom) >= Date.parse(expected.offer.eligibleUntil))
  )
    return failed("The first paid cycle or offer eligibility does not match approved terms.");
  if (planProblem) return failed(planProblem);
  const shipping = parseMoney(subscription.shipping_amount);
  if (subscription.shipping_amount && !isGbpAmount(shipping, 0))
    return failed("Subscription has an unexpected or unreadable shipping charge.");

  if (!transactions) return pending("The subscription's transaction list is not available yet.");
  if (transactions.length === 0) return pending("No payment has been recorded yet.");
  if (transactions.length > 1) return failed("More than one transaction was found for the initial period.");

  const transaction = transactions[0]!;
  if (!transaction.id?.trim()) return failed("Initial payment has no transaction identifier.");
  if (transaction.status === "PENDING" || transaction.status === "UNKNOWN")
    return pending(`Initial payment is ${transaction.status}.`);
  if (transaction.status !== "COMPLETED") return failed(`Initial payment is ${transaction.status}.`);
  if (!isGbpAmount(transaction.gross, expected.recurringMinor))
    return failed("Initial payment does not match the accepted gross amount and currency.");

  const billing = subscription.billing_info;
  const outstanding = parseMoney(billing?.outstanding_balance);
  if (!outstanding) return pending("Outstanding balance is not reported.");
  if (!isGbpAmount(outstanding, 0)) return pending("An outstanding balance remains.");

  // last_payment corroborates the transaction (same amount and time) but never replaces its ID and status.
  const lastPayment = billing?.last_payment;
  if (!lastPayment) return pending("The subscription does not yet report its last payment.");
  const paidAt = Date.parse(transaction.time ?? "");
  if (expected.offer && paidAt < Date.parse(expected.offer.validFrom))
    return failed("First payment preceded the accepted offer's start; the old plan is kept for review.");
  if (expected.offer && paidAt >= Date.parse(expected.offer.eligibleUntil))
    return failed(
      "First payment followed the accepted offer's eligibility end; the old plan is kept for review.",
    );
  const lastPaymentMatches =
    isGbpAmount(parseMoney(lastPayment.amount), expected.recurringMinor) &&
    Date.parse(lastPayment.time) === paidAt;
  if (!lastPaymentMatches)
    return failed("The subscription's last payment contradicts the identified transaction.");

  const periodStart = Date.parse(subscription.start_time ?? "");
  const paidThrough = Date.parse(billing?.next_billing_time ?? "");
  if (Number.isNaN(periodStart) || Number.isNaN(paidThrough))
    return pending("The paid period boundary is not reported.");
  const boundaryIsOrdered = paidThrough > periodStart;
  const paymentIsInsidePeriod = paidAt >= periodStart && paidAt < paidThrough;
  if (!boundaryIsOrdered || !paymentIsInsidePeriod)
    return failed("The paid period boundary contradicts the payment.");
  if (expected.offer) {
    const executions = billing?.cycle_executions;
    if (!executions) return pending("The paid introductory cycle has not been reported by PayPal.");
    const trial = executions.find((cycle) => cycle.tenure_type === "TRIAL" && cycle.sequence === 1);
    const regular = executions.find((cycle) => cycle.tenure_type === "REGULAR" && cycle.sequence === 2);
    if (
      executions.length !== 2 ||
      !trial ||
      !regular ||
      trial.total_cycles !== expected.offer.introductoryCycles ||
      trial.cycles_completed !== 1 ||
      trial.cycles_remaining !== expected.offer.introductoryCycles - 1 ||
      regular.cycles_completed !== 0
    )
      return failed(
        "PayPal's paid-cycle execution differs from the accepted first charge and renewal schedule.",
      );
  }

  return {
    verdict: "VERIFIED",
    transaction,
    period: {
      periodStart: new Date(periodStart).toISOString(),
      paidThrough: new Date(paidThrough).toISOString(),
    },
  };
}

/** The live plan must have exactly the accepted paid cycles, GBP amounts and monthly interval, with no hidden fee or tax. */
export function describePlanMismatch(
  plan: PaypalPlan,
  recurringMinor: number,
  offer?: Pick<PaidOffer, "introductoryAmount" | "introductoryCycles" | "regularAmount" | "setupFee">,
): string | null {
  if (plan.status !== "ACTIVE") return `Plan is ${plan.status}.`;
  const cycles = plan.billing_cycles;
  if (offer) {
    if (
      offer.introductoryAmount.amountMinor <= 0 ||
      offer.regularAmount.amountMinor !== recurringMinor ||
      offer.setupFee.amountMinor !== 0 ||
      !Number.isInteger(offer.introductoryCycles) ||
      offer.introductoryCycles < 1
    )
      return "Paid offer terms are not complete.";
    if (cycles?.length !== 2)
      return "Plan does not have exactly the accepted introductory and regular cycles.";
    const [intro, regular] = cycles;
    const monthly = (cycle: NonNullable<PaypalPlan["billing_cycles"]>[number]) =>
      cycle.frequency.interval_unit === "MONTH" && cycle.frequency.interval_count === 1;
    if (
      intro!.sequence !== 1 ||
      intro!.tenure_type !== "TRIAL" ||
      intro!.total_cycles !== offer.introductoryCycles ||
      !monthly(intro!) ||
      !isGbpAmount(parseMoney(intro!.pricing_scheme?.fixed_price), offer.introductoryAmount.amountMinor)
    )
      return "Paid introductory cycle differs from the accepted offer.";
    if (
      regular!.sequence !== 2 ||
      regular!.tenure_type !== "REGULAR" ||
      regular!.total_cycles !== 0 ||
      !monthly(regular!) ||
      !isGbpAmount(parseMoney(regular!.pricing_scheme?.fixed_price), recurringMinor)
    )
      return "Regular renewal cycle differs from the accepted offer.";
  } else {
    if (cycles?.length !== 1) return "Plan has a trial or an extra billing cycle.";
    const cycle = cycles[0]!;
    if (
      cycle.frequency.interval_unit !== "MONTH" ||
      cycle.frequency.interval_count !== 1 ||
      cycle.tenure_type !== "REGULAR" ||
      cycle.total_cycles !== 0
    )
      return "Plan is not an open-ended monthly regular cycle.";
    if (!isGbpAmount(parseMoney(cycle.pricing_scheme?.fixed_price), recurringMinor))
      return "Plan price does not match the accepted recurring price.";
  }
  const setupFee = parseMoney(plan.payment_preferences?.setup_fee);
  if (plan.payment_preferences?.setup_fee && !isGbpAmount(setupFee, 0))
    return "Plan has an unexpected or unreadable setup fee.";
  if (plan.taxes && Number(plan.taxes.percentage) !== 0) return "Plan adds tax.";
  return null;
}
