import type {
  SubscriptionAdvice,
  SubscriptionEntry,
  SubscriptionPortfolio,
  SubscriptionReviewBatch,
} from "../shared/subscriptions";
import { comparisonOutcome } from "../shared/subscription-insights";
import { subscriptionReadiness } from "../shared/subscription-workflow";
import { isCurrentSubscription } from "../shared/subscriptions";

export interface ResearchFinding {
  row: SubscriptionEntry;
  advice: SubscriptionAdvice;
  historicalCheckedAt?: string;
}

export interface ResearchOrb {
  row: SubscriptionEntry;
  state: "queued" | "checking" | "paused" | "ready" | "incomplete" | "no_match" | "needs_details";
  label: string;
  available: boolean;
}

/** A completed job is not proof of a suitable offer. Each bubble reflects its saved result. */
export function researchOrbs(
  portfolio: SubscriptionPortfolio,
  findings: ResearchFinding[],
  batch: SubscriptionReviewBatch | null,
  busy: boolean,
  interrupted: boolean,
): ResearchOrb[] {
  const researchable = new Set(subscriptionReadiness(portfolio).researchableServiceIds);
  const currentBatch = batch?.revision === portfolio.revision ? batch : null;
  return portfolio.subscriptions.filter(isCurrentSubscription).map((row) => {
    const finding = findings.find((item) => item.row.serviceId === row.serviceId);
    if (currentBatch?.currentServiceId === row.serviceId && busy)
      return { row, state: "checking", label: "Checking offers", available: !!finding };
    if (finding) {
      const state = comparisonOutcome(finding.advice);
      return {
        row,
        state: state === "alternatives" ? "ready" : state,
        available: true,
        label: finding.historicalCheckedAt
          ? "Previous check"
          : state === "alternatives"
            ? "See alternatives"
            : state === "incomplete"
              ? "Partial results"
              : "View comparison",
      };
    }
    if (!researchable.has(row.serviceId))
      return { row, state: "needs_details", label: "Add details", available: true };
    if (currentBatch?.failed.includes(row.serviceId))
      return { row, state: "incomplete", label: "Check interrupted", available: true };
    if (currentBatch?.status === "paused") return { row, state: "paused", label: "Paused", available: false };
    if (!busy && (interrupted || currentBatch?.completed.includes(row.serviceId)))
      return { row, state: "incomplete", label: "Check interrupted", available: true };
    return { row, state: "queued", label: busy ? "Up next" : "Waiting to check", available: false };
  });
}

export function researchSceneVisible(input: {
  selected: boolean;
  introduced: boolean;
  ready: boolean;
  specificService: boolean;
  pending: boolean;
  operation?: string;
  proposal: boolean;
  failure: boolean;
  reviewFailure: boolean;
}) {
  return (
    input.selected &&
    input.introduced &&
    input.ready &&
    !input.specificService &&
    !input.proposal &&
    (!input.pending || input.operation === "setup" || input.operation === "schedule") &&
    (!input.failure || input.reviewFailure)
  );
}
