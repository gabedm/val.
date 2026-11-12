import type { PaypalPlan, PaypalSubscription } from "./paypal";
import { parseMoney } from "./payment-evidence";
import type { BillingCycle } from "../shared/subscriptions";

/** Read an unambiguous recurring GBP bill, never a catalogue price or a one-off last charge. */
export function subscriptionBilling(
  subscription: PaypalSubscription,
  plan: PaypalSubscription["plan"] | PaypalPlan | undefined,
): { amountMinor: number; cycle: BillingCycle } | null {
  if (subscription.status !== "ACTIVE" || !plan || (plan.id && plan.id !== subscription.plan_id)) return null;
  if (subscription.plan_overridden && plan !== subscription.plan) return null;
  const cycles = plan.billing_cycles;
  const regular = cycles?.filter((cycle) => cycle.tenure_type === "REGULAR");
  if (
    !cycles ||
    regular?.length !== 1 ||
    cycles.some((cycle) => !["TRIAL", "REGULAR"].includes(cycle.tenure_type))
  )
    return null;
  const cycle = regular[0]!;
  // A temporary trial charge is not the ongoing bill. Wait until regular billing is established.
  if (cycles.some((item) => item.tenure_type === "TRIAL")) {
    const executions = subscription.billing_info?.cycle_executions;
    if (
      !executions?.some(
        (item) =>
          item.tenure_type === "REGULAR" && item.sequence === cycle.sequence && item.cycles_completed > 0,
      ) ||
      !cycles
        .filter((item) => item.tenure_type === "TRIAL")
        .every((trial) =>
          executions.some(
            (item) =>
              item.sequence === trial.sequence &&
              item.tenure_type === "TRIAL" &&
              item.cycles_completed >= trial.total_cycles,
          ),
        )
    )
      return null;
  }
  const frequency = cycle.frequency;
  const billingCycle =
    frequency.interval_unit === "MONTH" && frequency.interval_count === 1
      ? "month"
      : (frequency.interval_unit === "YEAR" && frequency.interval_count === 1) ||
          (frequency.interval_unit === "MONTH" && frequency.interval_count === 12)
        ? "year"
        : frequency.interval_unit === "DAY" && frequency.interval_count === 30
          ? "30_days"
          : null;
  if (!billingCycle || cycle.pricing_scheme?.pricing_model) return null;
  const fixed = parseMoney(cycle.pricing_scheme?.fixed_price);
  if (fixed?.currency !== "GBP") return null;
  const quantity = Number(subscription.quantity ?? "1");
  if (!Number.isSafeInteger(quantity) || quantity < 1 || (quantity !== 1 && !plan.quantity_supported))
    return null;
  if (
    plan.taxes &&
    (!/^\d+(?:\.\d+)?$/.test(plan.taxes.percentage) ||
      !Number.isFinite(Number(plan.taxes.percentage)) ||
      (Number(plan.taxes.percentage) > 0 && !plan.taxes.inclusive))
  )
    return null;
  const shipping = subscription.shipping_amount
    ? parseMoney(subscription.shipping_amount)
    : { currency: "GBP", amountMinor: 0 };
  if (shipping?.currency !== "GBP") return null;
  const amountMinor = fixed.amountMinor * quantity + shipping.amountMinor;
  if (!Number.isSafeInteger(amountMinor) || amountMinor > 99_999_999) return null;
  // Arrears, setup fees, a recent price change or a discount can make the last charge differ.
  // Do not silently turn that charge into a recurring bill when the two records disagree.
  if (subscription.billing_info?.last_payment) {
    const paid = parseMoney(subscription.billing_info.last_payment.amount);
    if (paid?.currency !== "GBP" || paid.amountMinor !== amountMinor) return null;
  }
  return { amountMinor, cycle: billingCycle };
}
