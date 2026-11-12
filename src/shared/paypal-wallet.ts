import type { BillingCycle, SubscriptionPortfolio } from "./subscriptions";

export const paypalWalletConsentVersion = "paypal-wallet.1";
export const paypalWalletRefreshMs = 6 * 60 * 60_000;

export type WalletPhase =
  | "disconnected"
  | "queued"
  | "sign_in"
  | "preparing"
  | "reading"
  | "complete"
  | "reconnect"
  | "failed"
  | "disconnecting";
export interface PayPalWalletStatus {
  enabled: boolean;
  phase: WalletPhase;
  message: string;
  /** Short-lived browser capability, returned only to this connection's authenticated owner. */
  signInUrl: string | null;
  checkedAt: string | null;
  pollAfterMs: number;
  portfolio: SubscriptionPortfolio;
  findings: { ledgerRecords: number; recurringGroups: number; unresolvedPayments: number } | null;
  /** Active permissions with payment evidence, but without an established recurring bill. */
  candidates?: PayPalWalletCandidate[];
}
export type WalletCandidateChoice = BillingCycle | "not_recurring" | "later";
export interface PayPalWalletCandidate {
  key: string;
  merchant: string;
  currency: string;
  lastPaymentMinor: number;
  paymentCount: number;
  lastPaidOn: string;
  historyCycle?: BillingCycle;
  choice?: WalletCandidateChoice;
  reviewRevision: number;
}
export interface WalletCandidateCommand {
  key: string;
  checkedAt: string;
  expectedRevision: number;
  expectedReviewRevision: number;
  choice: WalletCandidateChoice;
}
export interface PayPalWalletBill {
  /** An owner-keyed digest; never a PayPal transaction, agreement or payer identifier. */
  key: string;
  merchant: string;
  currency: string;
  amountMinor: number;
  cycle: BillingCycle;
  paymentCount: number;
  lastPaidOn: string;
  agreementStatus: "active" | "inferred";
  cycleBasis?: "payment_history" | "owner_confirmation";
}
export interface PayPalWalletResult {
  bills: PayPalWalletBill[];
  inactiveKeys?: string[];
  ledgerRecords: number;
  unresolvedPayments: number;
  checkedAt: string;
  candidates?: PayPalWalletCandidate[];
}
