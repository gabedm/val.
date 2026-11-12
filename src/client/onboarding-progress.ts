import type { SubscriptionPortfolio } from "../shared/subscriptions";
import { subscriptionReadiness } from "../shared/subscription-workflow";

export interface OnboardingProgress {
  confirmed: string[];
  complete: boolean;
}

/** The authenticated portfolio owns saved memory; a tab marker cannot reset it. */
export function readOnboardingProgress(portfolio: SubscriptionPortfolio): OnboardingProgress {
  const readiness = subscriptionReadiness(portfolio);
  return {
    confirmed: readiness.confirmedServiceIds,
    complete: readiness.phase === "ready",
  };
}
