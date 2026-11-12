import type { PriceCheckSchedule } from "../shared/price-checks";
import { isCurrentSubscription, type SubscriptionPortfolio } from "../shared/subscriptions";

export type MonitoringStatus = {
  phase: "scheduled" | "checking" | "paused" | "attention" | "unset";
  count: number;
  next: { name: string; at: string } | null;
  heading: string;
  detail: string;
};

/** Only committed, current source records can interrupt the quiet monitoring view. */
export function newPayPalSubscriptions(known: ReadonlySet<string>, portfolio: SubscriptionPortfolio) {
  return portfolio.subscriptions.filter(
    (row) => isCurrentSubscription(row) && row.source === "paypal" && !known.has(row.serviceId),
  );
}

/** An append-only import does not invalidate a proposal about an unchanged saved product. */
export function paymentImportOnly(previous: SubscriptionPortfolio, next: SubscriptionPortfolio) {
  const added = newPayPalSubscriptions(new Set(previous.subscriptions.map((row) => row.serviceId)), next);
  return (
    next.revision > previous.revision &&
    added.length > 0 &&
    next.subscriptions.length === previous.subscriptions.length + added.length &&
    previous.subscriptions.every((row) =>
      next.subscriptions.some((current) => current.serviceId === row.serviceId && sameFields(current, row)),
    )
  );
}

function sameFields(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const a = Object.entries(left),
    b = Object.entries(right);
  return (
    a.length === b.length &&
    a.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameFields(value, (right as Record<string, unknown>)[key]),
    )
  );
}

export function monitoringStatus(
  portfolio: SubscriptionPortfolio,
  schedules: readonly PriceCheckSchedule[],
  unavailable = false,
): MonitoringStatus {
  const current = portfolio.subscriptions.filter(isCurrentSubscription);
  const owned = schedules.filter((schedule) => current.some((row) => row.serviceId === schedule.serviceId));
  const active = owned.filter(
    (schedule) =>
      schedule.cadence &&
      (schedule.status === "checking" ||
        (schedule.status === "scheduled" &&
          !!schedule.nextCheckAt &&
          Number.isFinite(Date.parse(schedule.nextCheckAt)))),
  );
  const next = active
    .filter((row) => row.nextCheckAt && Number.isFinite(Date.parse(row.nextCheckAt)))
    .sort((a, b) => Date.parse(a.nextCheckAt!) - Date.parse(b.nextCheckAt!))[0];
  const base = {
    count: active.length,
    next: next
      ? { name: current.find((row) => row.serviceId === next.serviceId)!.name, at: next.nextCheckAt! }
      : null,
  };
  if (unavailable)
    return {
      ...base,
      phase: "attention",
      heading: "Schedule unavailable.",
      detail: "Open chat to check its status.",
    };
  const attention = owned.find((row) =>
    ["budget_reached", "access_needed", "retrying", "needs_details"].includes(row.status),
  );
  if (attention) {
    const detail = {
      budget_reached: "AI allowance unavailable.",
      access_needed: "Renew access to resume checks.",
      retrying: "I’ll retry at the saved time.",
      needs_details: "One check needs more details.",
    }[attention.status as "budget_reached" | "access_needed" | "retrying" | "needs_details"];
    return { ...base, phase: "attention", heading: "A price check needs attention.", detail };
  }
  if (active.length)
    return {
      ...base,
      phase: active.some((row) => row.status === "checking") ? "checking" : "scheduled",
      heading: active.some((row) => row.status === "checking") ? "I’m checking prices." : "I’m on it.",
      detail: `${active.length} ${active.length === 1 ? "subscription" : "subscriptions"} monitored`,
    };
  return {
    ...base,
    phase: owned.length ? "paused" : "unset",
    heading: owned.length ? "Your price checks are paused." : "Your needs are remembered.",
    detail: owned.length ? "Resume checks in chat." : "Set a schedule to monitor prices.",
  };
}

/** A delayed read must not roll a confirmed save back to an older revision. */
export function newestPortfolio(current: SubscriptionPortfolio, incoming: SubscriptionPortfolio) {
  return incoming.revision > current.revision ? incoming : current;
}
