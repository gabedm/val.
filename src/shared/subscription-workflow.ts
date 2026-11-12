import { isCurrentSubscription, type SubscriptionEntry, type SubscriptionPortfolio } from "./subscriptions";

export type SubscriptionReadiness = {
  revision: number;
  phase: "empty" | "collecting_needs" | "ready";
  confirmedServiceIds: string[];
  pendingServiceIds: string[];
  researchableServiceIds: string[];
  unknownCostServiceIds: string[];
};

export function needsSubscriptionPurpose(
  row: Pick<SubscriptionEntry, "serviceId" | "purpose">,
  revisitServiceIds: readonly string[] = [],
) {
  return !row.purpose.trim() || revisitServiceIds.includes(row.serviceId);
}

/** Saved needs are authoritative; a proposed draft or a browser marker never confirms them. */
export function subscriptionReadiness(
  portfolio: SubscriptionPortfolio,
  revisitServiceIds: readonly string[] = [],
): SubscriptionReadiness {
  const current = portfolio.subscriptions.filter(isCurrentSubscription);
  const pending = current.filter((row) => needsSubscriptionPurpose(row, revisitServiceIds));
  const confirmed = current.filter((row) => !needsSubscriptionPurpose(row, revisitServiceIds));
  return {
    revision: portfolio.revision,
    phase: !current.length ? "empty" : pending.length ? "collecting_needs" : "ready",
    confirmedServiceIds: confirmed.map((row) => row.serviceId),
    pendingServiceIds: pending.map((row) => row.serviceId),
    researchableServiceIds: confirmed
      .filter((row) => row.amountMinor !== null && row.amountMinor > 0)
      .map((row) => row.serviceId),
    unknownCostServiceIds: current.filter((row) => row.amountMinor === null).map((row) => row.serviceId),
  };
}
