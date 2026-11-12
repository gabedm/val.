export const switchConsentVersion = "subscription-switch.1";
export type SwitchPhase =
  | "preparing_old"
  | "preparing_new"
  | "awaiting_approval"
  | "purchasing"
  | "verifying_new"
  | "cancelling_old"
  | "verifying_old"
  | "needs_user"
  | "completed"
  | "stopped";

export interface SwitchTerms {
  name: string;
  plan: string;
  currency: "GBP" | "USD" | "EUR";
  chargeMinor: number;
  renewalMinor: number;
  cycle: "month" | "year" | "30_days";
  upfrontMinor: number;
  minimumTermMonths: number;
  quote: string;
}
export interface SwitchCancellation {
  currency: "GBP" | "USD" | "EUR";
  reference: string;
  quote: string;
  effectiveOn: string;
  feeMinor: number;
}
export interface SwitchEvidence {
  reference: string;
  quote: string;
  observedAt: string;
}
export interface SubscriptionSwitchView {
  id: string;
  revision: number;
  phase: SwitchPhase;
  oldName: string;
  newName: string;
  message: string;
  terms: SwitchTerms | null;
  cancellation: Omit<SwitchCancellation, "reference"> | null;
  approvalDigest: string | null;
  approvalExpiresAt: string | null;
  newActive: boolean;
  oldCancelled: boolean;
  unresolved: boolean;
  preparationOnly?: boolean;
  handoff: { url: string; provider: string } | null;
  createdAt: string;
}

export const switchPhaseLabels: Record<SwitchPhase, string> = {
  preparing_old: "Checking your current subscription",
  preparing_new: "Preparing your replacement",
  awaiting_approval: "Review your switch",
  purchasing: "Starting your replacement",
  verifying_new: "Confirming your replacement is active",
  cancelling_old: "Ending your old subscription",
  verifying_old: "Confirming cancellation",
  needs_user: "Your input is needed",
  completed: "Your switch is complete",
  stopped: "Switch stopped",
};
