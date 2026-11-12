/** Details supplied by the owner, separate from provider-verified billing and executable cases. */
export const portfolioLimit = 50;
/** Older comparison views default unknown billing periods to monthly. Require the matching display contract. */
export const subscriptionAdviceFormat = "3";
export type BillingCycle = "month" | "year" | "30_days";
export const billingCycles: readonly BillingCycle[] = ["month", "year", "30_days"];

export interface PrepaidTerm {
  initialMonths: number;
  renewalMonths: number;
}

export function billingCycleLabel(cycle: BillingCycle) {
  return cycle === "30_days" ? "30 days" : cycle;
}

export interface SubscriptionEntry {
  serviceId: string;
  name: string;
  amountMinor: number | null;
  cycle: BillingCycle;
  purpose: string;
  source: "manual" | "paypal" | "provider";
  /** Server-observed provider account state; it grants no further payment authority. */
  providerState?: {
    switchId: string;
    status: "active" | "cancelled" | "review";
    verifiedAt: string;
    endsOn?: string;
  };
  /** Latest verified status of an owner-bound merchant subscription; absent for wallet-derived rows. */
  paypalStatus?: "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED";
  currency?: string;
  productServiceId?: string;
  /** Product labels read from PayPal; they do not supply the customer's purpose or prove entitlements. */
  paypalProduct?: { name: string; planName?: string; recordedAt: string };
  paypalEvidence?: {
    key: string;
    merchant: string;
    paymentCount: number;
    lastPaidOn: string;
    agreementStatus: "active" | "inferred" | "inactive";
    checkedAt: string;
    cycleBasis?: "payment_history" | "owner_confirmation";
    excludedByOwner?: boolean;
    /** A completed refresh no longer supports this charge; this does not revoke the agreement. */
    recurrenceStale?: boolean;
  };
  /** Server-owned recurring bill evidence; a different effective cost is an owner's explicit correction. */
  paypalBilling?: { amountMinor: number; cycle: BillingCycle; recordedAt: string };
}
export interface SubscriptionPortfolio {
  revision: number;
  subscriptions: SubscriptionEntry[];
}

export function isCurrentSubscription(row: SubscriptionEntry) {
  return (
    row.providerState?.status !== "cancelled" &&
    (row.paypalStatus === undefined || row.paypalStatus === "ACTIVE") &&
    row.paypalEvidence?.agreementStatus !== "inactive" &&
    !row.paypalEvidence?.excludedByOwner &&
    !row.paypalEvidence?.recurrenceStale
  );
}

/** Keep the basis of a bill separate from the payment permission and future charges. */
export function subscriptionPaymentEvidence(row: SubscriptionEntry) {
  const evidence = row.paypalEvidence;
  return evidence
    ? {
        agreementStatus: evidence.agreementStatus,
        observedPayments: evidence.paymentCount,
        lastPaidOn: evidence.lastPaidOn,
        checkedAt: evidence.checkedAt,
        cycleBasis: evidence.cycleBasis ?? "payment_history",
      }
    : null;
}

/** A stored reference identifies a bill; a PayPal product label identifies what the bill is for. */
export function subscriptionCatalogueId(
  row: Pick<SubscriptionEntry, "serviceId" | "productServiceId" | "paypalProduct" | "name">,
  services: { id: string; service: string }[],
) {
  if (!row.paypalProduct) return row.productServiceId ?? row.serviceId;
  const key = (name: string) =>
    name
      .normalize("NFKC")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "");
  return services.find((service) => key(service.service) === key(row.name))?.id;
}

/** A familiar brand mark may accompany a plan label; it does not establish plan features or ownership. */
export function subscriptionBrandId(
  row: Pick<SubscriptionEntry, "serviceId" | "productServiceId" | "paypalProduct" | "name">,
  services: { id: string; service: string }[],
) {
  return (
    subscriptionCatalogueId(row, services) ??
    services.find((service) => row.name.toLowerCase().startsWith(`${service.service.toLowerCase()} `))?.id
  );
}
export interface SubscriptionCommand {
  expectedRevision: number;
  startResearch?: boolean;
  subscriptions: Pick<SubscriptionEntry, "serviceId" | "amountMinor" | "cycle" | "purpose">[];
}
export interface SubscriptionImport {
  source?: "wallet" | "merchant" | "sandbox";
  unresolvedPayments?: number;
  excludedPaymentGroups?: number;
  portfolio: SubscriptionPortfolio;
  status: "checked" | "partial" | "unavailable" | "identity_only";
  checkedAt: string;
  verifiedServiceIds: string[];
}
export interface ValChatDraft {
  currency?: string;
  serviceId: string;
  name: string;
  amountMinor: number | null;
  cycle: BillingCycle;
  purpose: string;
  source: "manual" | "paypal" | "provider";
}
export interface ValChatReply {
  searchAttributions?: string[];
  message: string;
  portfolio: SubscriptionPortfolio;
  draft: ValChatDraft | null;
  compareServiceId: string | null;
  compareServiceIds?: string[];
  activeServiceId?: string | null;
  checkedAt: string | null;
  scheduleDraft?: import("./price-checks").PriceCheckDraft | null;
}
export interface ValChatCommand {
  message: string | null;
  history: { from: "you" | "val"; text: string }[];
  expectedRevision: number;
  activeServiceId?: string | null;
  revisitServiceIds?: string[];
}
export interface ValChatRequest {
  id: string;
  createdAt: string;
  status: "queued" | "running" | "complete" | "failed" | "superseded";
  command: ValChatCommand;
  progress: SubscriptionIngestionProgress[];
  reply: ValChatReply | null;
  error: { status: number; code: string; message: string; retryAfterSeconds?: number } | null;
}
export const subscriptionIngestionVersion = "subscription-ingestion.5";
export type SubscriptionIngestionEvent =
  | { type: "stage"; stage: "reading" | "checking_paypal" | "understanding" | "restoring" }
  | { type: "subscription"; subscription: SubscriptionEntry }
  | { type: "result"; reply: ValChatReply }
  | { type: "error"; message: string };
export type SubscriptionIngestionProgress = Exclude<SubscriptionIngestionEvent, { type: "result" | "error" }>;
export interface SavedSubscriptionReview {
  serviceId: string;
  advice: SubscriptionAdvice;
  checkedAt: string;
  historical: boolean;
}
export interface SubscriptionReviewBatch {
  revision: number;
  serviceIds: string[];
  completed: string[];
  failed: string[];
  status: "queued" | "running" | "paused" | "complete" | "failed" | "superseded";
  pauseReason?: "budget" | "access" | null;
  currentServiceId: string | null;
}
export function reviewPauseMessage(batch: Pick<SubscriptionReviewBatch, "pauseReason">) {
  return batch.pauseReason === "budget"
    ? "Checks paused: the AI allowance is unavailable. Your completed results are saved."
    : "Renew research access to resume checks. Your completed results are saved.";
}
export interface SubscriptionAdvice {
  /** Confirmed owner memory used for this check, never inferred by the recommendation model. */
  basedOn?: { serviceId: string; purpose: string };
  searchAttributions?: string[];
  summary: string;
  options: { serviceId: string; reason: string }[];
  uncertainties: string[];
  comparisons?: {
    serviceId: string;
    name: string;
    plan: string;
    owned: boolean;
    fit?: "supported" | "conditional";
    fitCondition?: string;
    currency?: "GBP" | "USD" | "EUR";
    monthlyMinor: number;
    savingMonthlyMinor: number | null;
    priceMinor: number;
    priceUnit: string;
    prepaid?: PrepaidTerm;
    savingAnnualMinor: number | null;
    annualMinor: number;
    checkedOn: string;
    sources: string[];
    logoServiceId?: string;
    conditions?: string[];
    /** Decision-relevant restrictions selected from the retrieved provider conditions. */
    highlights?: string[];
    introductoryCycles?: number;
    renewalMinor?: number;
    upfrontMinor?: number | null;
    minimumTermMonths?: number | null;
    feesKnown?: boolean;
    priceEstimated?: boolean;
    priceQuote?: string;
    scheduledChanges?: { on: string; priceMinor: number }[];
  }[];
  discovery?: {
    status: "live" | "cached" | "fallback";
    checkedAt: string;
    uncertainties: string[];
    providerOnly: boolean;
    coverage?: { discovered: string[]; checked: string[]; incomplete: string[] };
    pendingProviders?: string[];
  } | null;
}

/** Accept exact amounts only. A missing price is never replaced with an advertised catalogue price. */
export function subscriptionCost(text: string): { amountMinor: number | null; cycle: BillingCycle } | null {
  if (/^(?:skip|not sure|don[’']?t know|unknown)$/i.test(text.trim()))
    return { amountMinor: null, cycle: "month" };
  const match = text
    .trim()
    .match(
      /^(?:£|GBP\s*)?(\d{1,6})(?:\.(\d{1,2}))?\s*(?:(?:\/\s*|per\s+|a\s+|each\s+|every\s+)?(month|monthly|mo|year|yearly|annual|annually|yr|30[-\s]*days?|30d))?$/i,
    );
  if (!match) return null;
  return {
    amountMinor: Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0")),
    cycle: /^30/i.test(match[3] ?? "")
      ? "30_days"
      : /^(year|yearly|annual|annually|yr)$/i.test(match[3] ?? "")
        ? "year"
        : "month",
  };
}

/** A 365-day budget includes thirteen charges for a plan billed every thirty days. */
export function annualSubscriptionCost(entry: Pick<SubscriptionEntry, "amountMinor" | "cycle">) {
  if (entry.amountMinor === null) return null;
  switch (entry.cycle) {
    case "year":
      return entry.amountMinor;
    case "month":
      return entry.amountMinor * 12;
    case "30_days":
      return entry.amountMinor * 13;
    default:
      return null;
  }
}

export function monthlySubscriptionCost(entry: Pick<SubscriptionEntry, "amountMinor" | "cycle">) {
  const annual = annualSubscriptionCost(entry);
  return annual === null ? null : annual / 12;
}

export function monthlyPortfolioTotal(entries: SubscriptionEntry[], currency = "GBP") {
  return Math.round(
    entries
      .filter((entry) => (entry.currency ?? "GBP") === currency)
      .reduce((sum, entry) => sum + (monthlySubscriptionCost(entry) ?? 0), 0),
  );
}

export function monthlyPortfolioTotals(entries: SubscriptionEntry[]) {
  return [
    ...new Set(entries.filter((entry) => entry.amountMinor !== null).map((entry) => entry.currency ?? "GBP")),
  ]
    .sort((a, b) => (a === "GBP" ? -1 : b === "GBP" ? 1 : a.localeCompare(b)))
    .map((currency) => ({ currency, amountMinor: monthlyPortfolioTotal(entries, currency) }));
}
