import type { SubscriptionAdvice } from "./subscriptions";

export type PriceCheckCadence = { every: number; unit: "hour" | "day" | "week" | "month" };
export interface PriceCheckSchedule {
  serviceId: string;
  revision: number;
  cadence: PriceCheckCadence | null;
  nextCheckAt: string | null;
  lastCheckedAt: string | null;
  status:
    "scheduled" | "paused" | "checking" | "needs_details" | "retrying" | "access_needed" | "budget_reached";
  advice: SubscriptionAdvice | null;
}
export interface PriceCheckDraft {
  serviceIds: string[];
  cadence: PriceCheckCadence | null;
  expectedRevisions: Record<string, number>;
}
export function validCadence(value: unknown): value is PriceCheckCadence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as PriceCheckCadence;
  const limits = { hour: 720, day: 365, week: 52, month: 12 };
  return (
    Object.keys(item).length === 2 &&
    Object.hasOwn(limits, item.unit) &&
    Number.isSafeInteger(item.every) &&
    item.every >= 1 &&
    item.every <= limits[item.unit]
  );
}
export function cadenceLabel(value: PriceCheckCadence) {
  return value.every === 1 ? `Every ${value.unit}` : `Every ${value.every} ${value.unit}s`;
}
/** Fixed intervals; calendar months retain the original day, clamped only in shorter months. */
export function nextPriceCheck(from: Date, cadence: PriceCheckCadence, anchorDay = from.getUTCDate()) {
  if (!validCadence(cadence)) throw new Error("Invalid price-check interval");
  if (cadence.unit !== "month")
    return new Date(
      from.getTime() + cadence.every * { hour: 3600_000, day: 86400_000, week: 604800_000 }[cadence.unit],
    );
  const next = new Date(from);
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + cadence.every);
  next.setUTCDate(
    Math.min(anchorDay, new Date(Date.UTC(next.getUTCFullYear(), next.getUTCMonth() + 1, 0)).getUTCDate()),
  );
  return next;
}
