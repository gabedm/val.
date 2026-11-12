import type { PriceCheckSchedule } from "./price-checks";
import type { SavedSubscriptionReview, SubscriptionAdvice, SubscriptionReviewBatch } from "./subscriptions";

export interface SubscriptionCheckEvent {
  id: string;
  serviceId: string;
  name: string;
  checkedAt: string;
  outcome: "alternatives" | "no_match" | "incomplete";
  alternatives: number;
  available: boolean;
}

export interface SubscriptionInsights {
  revision: number;
  reviews: SavedSubscriptionReview[];
  schedules: PriceCheckSchedule[];
  batch: SubscriptionReviewBatch | null;
  activity: SubscriptionCheckEvent[];
  moreActivity: boolean;
}

/** Count admitted options, rather than candidates that research never established as a match. */
export function comparisonAlternatives(advice: SubscriptionAdvice) {
  if (!Array.isArray(advice.options) || !Array.isArray(advice.comparisons)) return [];
  return advice.options.filter(
    (option) =>
      option &&
      typeof option.serviceId === "string" &&
      advice.comparisons?.some((value) => value && value.serviceId === option.serviceId),
  );
}

/** A failed or partial search cannot establish the absence of a suitable option. */
export function comparisonOutcome(advice: SubscriptionAdvice): SubscriptionCheckEvent["outcome"] {
  if (comparisonAlternatives(advice).length) return "alternatives";
  if (
    !advice.discovery ||
    advice.discovery.status === "fallback" ||
    advice.discovery.coverage?.incomplete.length ||
    advice.discovery.pendingProviders?.length ||
    advice.discovery.uncertainties?.length ||
    !advice.discovery.providerOnly
  )
    return "incomplete";
  return "no_match";
}
