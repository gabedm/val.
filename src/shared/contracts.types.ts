export interface UrnValContracts06 {
  [k: string]: unknown;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Money".
 */
export interface Money {
  currency: "GBP";
  amountMinor: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PositiveMoney".
 */
export interface PositiveMoney {
  currency: "GBP";
  amountMinor: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PaidOffer".
 */
export interface PaidOffer {
  introductoryAmount: PositiveMoney;
  introductoryCycles: number;
  regularAmount: PositiveMoney;
  validFrom: string;
  eligibleUntil: string;
  firstChargeBasis: "BUYER_APPROVAL";
  eligibility: "ELIGIBLE" | "INELIGIBLE" | "UNKNOWN";
  setupFee: Money;
  commitmentMonths: 0;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ValueComparison".
 */
export interface ValueComparison {
  assessedAt: string;
  horizonMonths: 12;
  oldNextBillingAt: string;
  renewalEffectiveAt: string;
  announcedRenewal: PositiveMoney;
  currentTotal: Money;
  candidateTotal: Money;
  netSavingMinor: number;
  basis: "AUTHORED_NOTICE_PROJECTION";
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "EmptyCommand".
 */
export interface EmptyCommand {}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PolicyFields".
 */
export interface PolicyFields {
  purpose: string;
  /**
   * @minItems 1
   * @maxItems 2
   */
  requiredCapabilities:
    ["editable_text" | "speaker_labels"] | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  recurringCeiling: Money;
  preserveHistory: boolean;
  allowInvestigation: boolean;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Policy".
 */
export interface Policy {
  id: string;
  caseId: string;
  revision: number;
  purpose: string;
  /**
   * @minItems 1
   * @maxItems 2
   */
  requiredCapabilities:
    ["editable_text" | "speaker_labels"] | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  recurringCeiling: Money;
  preserveHistory: boolean;
  allowInvestigation: boolean;
  confirmedAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PolicyDraft".
 */
export interface PolicyDraft {
  purpose: string;
  /**
   * @maxItems 2
   */
  requiredCapabilities:
    | []
    | ["editable_text" | "speaker_labels"]
    | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  recurringCeiling: Money | null;
  preserveHistory: boolean | null;
  allowInvestigation: boolean | null;
  interpretationNotes: string[];
  unsupportedRequirements: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ModelRecommendation".
 */
export interface ModelRecommendation {
  action: "stay" | "change_plan" | "switch" | "investigate";
  candidateId: string | null;
  policyRevision: number;
  evidenceIds: string[];
  explanation: string;
  uncertainties: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Recommendation".
 */
export interface Recommendation {
  id: string;
  caseId: string;
  policyRevision: number;
  action: "stay" | "change_plan" | "switch" | "investigate";
  candidateId: string | null;
  evidenceIds: string[];
  explanation: string;
  uncertainties: string[];
  createdAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "AccountSnapshot".
 */
export interface AccountSnapshot {
  caseId: string;
  providerId: "provider_a" | "provider_b";
  accountId: string;
  planId: string | null;
  subscriptionId: string | null;
  entitlementRevision: number;
  accessStatus: "TRIAL" | "ACTIVE" | "EXIT_SCHEDULED" | "ENDED";
  billingStatus:
    "NONE" | "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | "UNKNOWN";
  paidThrough: string | null;
  accessEndsAt: string | null;
  observedAt: string;
  evidenceId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PlanSummary".
 */
export interface PlanSummary {
  candidateId: string;
  providerId: "provider_a" | "provider_b";
  planId: string;
  label: string;
  marketingText: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CandidateQuote".
 */
export interface CandidateQuote {
  id: string;
  caseId: string;
  candidateId: string;
  providerId: "provider_a" | "provider_b";
  planId: string;
  revision: number;
  recurringTotal: Money;
  dueNowTotal: Money;
  interval: "MONTH";
  intervalCount: 1;
  taxMinor: number;
  feesMinor: number;
  offer?: PaidOffer;
  comparison?: ValueComparison | null;
  observedAt: string;
  evidenceId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CapabilityResult".
 */
export interface CapabilityResult {
  capability: "editable_text" | "speaker_labels";
  passes: boolean;
  reason: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CandidateEvaluation".
 */
export interface CandidateEvaluation {
  candidateId: string;
  quoteId: string;
  policyRevision: number;
  evidenceIds: string[];
  capabilityResults: CapabilityResult[];
  eligible: boolean;
  rejectionReasons: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Evidence".
 */
export interface Evidence {
  id: string;
  caseId: string;
  providerId: ("provider_a" | "provider_b") | null;
  accountId: string | null;
  planId: string | null;
  entitlementRevision: number | null;
  kind: "account" | "sample" | "quote" | "backup" | "import" | "payment" | "subscription" | "service_exit";
  observedAt: string;
  artifactId: string | null;
  summary: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Artifact".
 */
export interface Artifact {
  id: string;
  caseId: string;
  mimeType: "text/plain" | "application/json";
  content: string;
  sha256: string;
  createdAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "TranscriptTurn".
 */
export interface TranscriptTurn {
  speaker: string;
  text: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Transcript".
 */
export interface Transcript {
  id: string;
  title: string;
  turns: TranscriptTurn[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ManifestRecord".
 */
export interface ManifestRecord {
  id: string;
  canonicalDigest: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "HistoryManifest".
 */
export interface HistoryManifest {
  id: string;
  caseId: string;
  providerId: "provider_a" | "provider_b";
  accountId: string;
  version: 1;
  count: number;
  records: ManifestRecord[];
  manifestDigest: string;
  artifactId: string;
  observedAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ImportResult".
 */
export interface ImportResult {
  operationKey: string;
  destinationManifest: HistoryManifest;
  matchesSource: boolean;
  evidenceId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ServiceExitResult".
 */
export interface ServiceExitResult {
  operationKey: string;
  accountId: string;
  status: "SCHEDULED" | "ENDED";
  accessEndsAt: string;
  observedAt: string;
  evidenceId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Overlap".
 */
export interface Overlap {
  oldPaidAmount: Money;
  oldPaidThrough: string;
  newDueNow: Money;
  possibleOldRenewal: Money | null;
  oldNextBillingTime: string | null;
  explanation: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PurchaseTerms".
 */
export interface PurchaseTerms {
  candidateId: string;
  providerId: "provider_b";
  planId: string;
  quoteRevision: number;
  dueNow: Money;
  recurring: Money;
  interval: "MONTH";
  intervalCount: 1;
  oldSubscriptionId: string;
  oldAccessEndsAt: string;
  overlap: Overlap;
  offer?: PaidOffer;
  comparison?: ValueComparison;
  backupManifestDigest: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PurchasePreview".
 */
export interface PurchasePreview {
  id: string;
  caseId: string;
  ownerId: string;
  recommendationId: string;
  policyRevision: number;
  materialTerms: PurchaseTerms;
  backupEvidenceId: string;
  previewHash: string;
  createdAt: string;
  expiresAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Consent".
 */
export interface Consent {
  id: string;
  caseId: string;
  ownerId: string;
  sessionId: string;
  previewId: string;
  previewHash: string;
  approvePurchase: boolean;
  approveOldExitAfterReadiness: boolean;
  createdAt: string;
  consumedByOperationId: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ExitTerms".
 */
export interface ExitTerms {
  newSubscriptionId: string;
  oldSubscriptionId: string;
  effectiveRecurring: Money;
  oldAccessEndsAt: string;
  overlap: Overlap;
  offer?: PaidOffer;
  comparison?: ValueComparison;
  backupManifestDigest: string;
  importManifestDigest: string;
  remainingExits: ("old_billing" | "old_service")[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ExitReview".
 */
export interface ExitReview {
  id: string;
  caseId: string;
  ownerId: string;
  transitionId: string;
  policyRevision: number;
  materialTerms: ExitTerms;
  readinessEvidenceIds: string[];
  reviewHash: string;
  createdAt: string;
  expiresAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ExitAuthorization".
 */
export interface ExitAuthorization {
  id: string;
  caseId: string;
  ownerId: string;
  sessionId: string;
  transitionId: string;
  reviewId: string;
  reviewHash: string;
  approveRemainingExits: boolean;
  createdAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PaymentEvidence".
 */
export interface PaymentEvidence {
  id: string;
  caseId: string;
  providerId: "provider_a" | "provider_b";
  merchantContext: string;
  subscriptionId: string;
  transactionId: string | null;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "PENDING" | "REFUNDED" | "FAILED" | "UNKNOWN";
  grossAmount: ObservedMoney | null;
  transactionTime: string | null;
  queryStart: string;
  queryEnd: string;
  observedAt: string;
  sourceArtifactId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ObservedMoney".
 */
export interface ObservedMoney {
  currency: string;
  amountMinor: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PaymentPeriod".
 */
export interface PaymentPeriod {
  subscriptionId: string;
  paymentEvidenceId: string;
  periodStart: string;
  paidThrough: string;
  boundaryEvidenceId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Receipt".
 */
export interface Receipt {
  newSubscriptionId: string | null;
  newBillingStatus:
    "NONE" | "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | "UNKNOWN";
  duePayment: "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
  paymentEvidenceId: string | null;
  capability: "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
  capabilityEvidenceId: string | null;
  history: "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
  historyEvidenceId: string | null;
  oldSubscriptionId: string | null;
  oldBilling: "ACTIVE" | "CANCELLED" | "UNKNOWN";
  oldService: "ACTIVE" | "EXIT_SCHEDULED" | "ENDED" | "UNKNOWN";
  oldAccessEndsAt: string | null;
  message: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Transition".
 */
export interface Transition {
  id: string;
  caseId: string;
  consentId: string;
  exitAuthorizationId: string | null;
  state:
    | "SETUP"
    | "MONITORING"
    | "INVESTIGATING"
    | "STAY"
    | "NEEDS_REVIEW"
    | "AWAITING_CONSENT"
    | "AWAITING_PAYPAL"
    | "VERIFYING_NEW"
    | "EXITING_OLD"
    | "COMPLETE"
    | "ATTENTION_REQUIRED";
  newSubscriptionId: string | null;
  oldSubscriptionId: string;
  receipt: Receipt;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  acceptedPurchaseTerms: PurchaseTerms;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Operation".
 */
export interface Operation {
  id: string;
  caseId: string;
  transitionId: string | null;
  kind:
    | "setup_create"
    | "replacement_create"
    | "backup"
    | "activate_account"
    | "import"
    | "cancel_old_billing"
    | "exit_old_service"
    | "cleanup"
    | "probe_cancel";
  operationKey: string;
  targetId: string | null;
  status: "PLANNED" | "IN_FLIGHT" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
  claimGeneration: number;
  requestId: string | null;
  remoteId: string | null;
  attempts: number;
  dispatchedAt: string | null;
  resultEvidenceId: string | null;
  createdAt: string;
  updatedAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CaseRecord".
 */
export interface CaseRecord {
  id: string;
  ownerId: string;
  scenario: "feature_removed" | "grandfathered" | "value_offer";
  state:
    | "SETUP"
    | "MONITORING"
    | "INVESTIGATING"
    | "STAY"
    | "NEEDS_REVIEW"
    | "AWAITING_CONSENT"
    | "AWAITING_PAYPAL"
    | "VERIFYING_NEW"
    | "EXITING_OLD"
    | "COMPLETE"
    | "ATTENTION_REQUIRED";
  reason:
    | (
        | "advice_only"
        | "no_candidate"
        | "evidence_missing"
        | "permission_required"
        | "approval_unresolved"
        | "authority_changed"
        | "operation_failed"
      )
    | null;
  initialAccountId: string;
  replacementAccountId: string;
  archivedAt: string | null;
  createdAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CaseSummary".
 */
export interface CaseSummary {
  id: string;
  scenario: "feature_removed" | "grandfathered" | "value_offer";
  state:
    | "SETUP"
    | "MONITORING"
    | "INVESTIGATING"
    | "STAY"
    | "NEEDS_REVIEW"
    | "AWAITING_CONSENT"
    | "AWAITING_PAYPAL"
    | "VERIFYING_NEW"
    | "EXITING_OLD"
    | "COMPLETE"
    | "ATTENTION_REQUIRED";
  archivedAt: string | null;
  createdAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "WhatIfCommand".
 */
export interface WhatIfCommand {
  expectedPolicyRevision: number;
  overrides: {
    recurringCeiling?: Money;
    /**
     * @minItems 1
     * @maxItems 2
     */
    requiredCapabilities?:
      ["editable_text" | "speaker_labels"] | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  };
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "WhatIfResult".
 */
export interface WhatIfResult {
  advisory: true;
  id: string;
  caseId: string;
  createdAt: string;
  baseline: {
    policyRevision: number;
    entitlementRevision: number;
    caseState:
      | "SETUP"
      | "MONITORING"
      | "INVESTIGATING"
      | "STAY"
      | "NEEDS_REVIEW"
      | "AWAITING_CONSENT"
      | "AWAITING_PAYPAL"
      | "VERIFYING_NEW"
      | "EXITING_OLD"
      | "COMPLETE"
      | "ATTENTION_REQUIRED";
    agentFingerprint: string;
  };
  proposed: {
    recurringCeiling: Money;
    /**
     * @minItems 1
     * @maxItems 2
     */
    requiredCapabilities:
      ["editable_text" | "speaker_labels"] | ["editable_text" | "speaker_labels", "editable_text" | "speaker_labels"];
  };
  status: "current" | "stale";
  staleReason: string | null;
  verdict: "accepted" | "rejected" | "review";
  outcome: {
    action: "stay" | "change_plan" | "switch" | "investigate";
    candidateId: string | null;
    reason:
      | (
          | "advice_only"
          | "no_candidate"
          | "evidence_missing"
          | "permission_required"
          | "approval_unresolved"
          | "authority_changed"
          | "operation_failed"
        )
      | null;
  } | null;
  modelRecommendation: ModelRecommendation | null;
  problem: string | null;
  current: {
    planId: string;
    artifactId: string;
    capabilityResults: CapabilityResult[];
  } | null;
  candidates: {
    candidateId: string;
    providerId: "provider_a" | "provider_b";
    label: string;
    recurringTotal: Money;
    dueNowTotal?: Money;
    offer?: PaidOffer;
    comparison?: ValueComparison | null;
    withinCeiling: boolean;
    tested: boolean;
    eligible: boolean;
    capabilityResults: CapabilityResult[];
    artifactId: string | null;
    rejectionReasons: string[];
  }[];
  evidenceExpiresAt: string | null;
  usage: {
    modelCalls: number;
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
  };
  elapsedMs: number;
  version: {
    model: string;
    promptVersion: string;
    fingerprint: string;
  };
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CatalogueResponse".
 */
export interface CatalogueResponse {
  catalogue: {
    schema_version: string;
    researched_on: string;
    status: string;
    scope: string;
    categories: {
      id: string;
      label: string;
      count: number;
      [k: string]: unknown;
    }[];
    services: {
      id: string;
      service: string;
      plan: string;
      category: string;
      comparison_group: string;
      purpose: string;
      audience: string;
      capability_tags: string[];
      constraints: string[];
      price: {
        [k: string]: unknown;
      };
      sources: {
        [k: string]: unknown;
      }[];
      research_flags: string[];
      evidence: {
        [k: string]: unknown;
      }[];
      execution: {
        [k: string]: unknown;
      };
      [k: string]: unknown;
    }[];
    [k: string]: unknown;
  };
  logos: {
    [k: string]: string;
  };
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CaseSnapshot".
 */
export interface CaseSnapshot {
  case: CaseRecord;
  policy: Policy | null;
  recommendation: Recommendation | null;
  evaluations: CandidateEvaluation[];
  transition: Transition | null;
  receipt: Receipt;
  pendingJobId: string | null;
  currentAccount: AccountSnapshot | null;
  currentQuote: CandidateQuote | null;
  evaluationQuotes: CandidateQuote[];
  currentOutput: {
    planId: string;
    artifactId: string;
    capabilityResults: CapabilityResult[];
    observedAt: string;
  } | null;
  activeFaults: ("price_change" | "output_failure" | "import_failure" | "timeout")[];
  handover: {
    operationId: string;
    kind:
      | "setup_create"
      | "replacement_create"
      | "backup"
      | "activate_account"
      | "import"
      | "cancel_old_billing"
      | "exit_old_service"
      | "cleanup"
      | "probe_cancel";
    status: "PLANNED" | "IN_FLIGHT" | "UNKNOWN" | "SUCCEEDED" | "FAILED";
    billingStatus:
      ("NONE" | "APPROVAL_PENDING" | "APPROVED" | "ACTIVE" | "SUSPENDED" | "CANCELLED" | "EXPIRED" | "UNKNOWN") | null;
    paymentStatus: "NOT_STARTED" | "PENDING" | "VERIFIED" | "FAILED" | "UNKNOWN";
    note: string | null;
    approvalUrl: string | null;
    retryable: boolean;
  } | null;
  investigationRun: {
    id: string;
    outcome: "accepted" | "rejected" | "review";
    model: string;
    promptVersion: string;
    usage: {
      modelCalls: number;
      inputTokens: number;
      outputTokens: number;
      reasoningTokens: number;
    };
    elapsedMs: number;
    createdAt: string;
  } | null;
  availablePlans: PlanSummary[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "SessionView".
 */
export interface SessionView {
  authenticated: boolean;
  role: ("reviewer" | "admin") | null;
  ownerId: string | null;
  csrfToken: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "LoginResult".
 */
export interface LoginResult {
  session: SessionView;
  newOwnerRecoveryCode: string | null;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "AsyncCommandResult".
 */
export interface AsyncCommandResult {
  jobId: string;
  caseId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ApprovalResult".
 */
export interface ApprovalResult {
  operationId: string;
  subscriptionId: string;
  approvalUrl: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "LoginCommand".
 */
export interface LoginCommand {
  username: string;
  password: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "RecoveryCommand".
 */
export interface RecoveryCommand {
  recoveryCode: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CreateCaseCommand".
 */
export interface CreateCaseCommand {
  scenario: "feature_removed" | "grandfathered" | "value_offer";
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "DraftCommand".
 */
export interface DraftCommand {
  purpose: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PolicyCommand".
 */
export interface PolicyCommand {
  policy: PolicyFields;
  expectedRevision: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CheckCommand".
 */
export interface CheckCommand {
  expectedPolicyRevision: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ScenarioCommand".
 */
export interface ScenarioCommand {
  scenario: "feature_removed" | "grandfathered" | "value_offer";
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PreviewCommand".
 */
export interface PreviewCommand {
  recommendationId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ConsentCommand".
 */
export interface ConsentCommand {
  previewId: string;
  previewHash: string;
  approvePurchase: true;
  approveOldExitAfterReadiness: true;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CheckoutCommand".
 */
export interface CheckoutCommand {
  consentId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ReturnCommand".
 */
export interface ReturnCommand {
  operationId: string;
  returnToken: string;
  subscriptionId: string | null;
  outcome: "approved" | "cancelled";
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ExitReviewCommand".
 */
export interface ExitReviewCommand {
  transitionId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ExitAuthorizationCommand".
 */
export interface ExitAuthorizationCommand {
  reviewId: string;
  reviewHash: string;
  approveRemainingExits: true;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "PauseExitsCommand".
 */
export interface PauseExitsCommand {
  transitionId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "RetryCommand".
 */
export interface RetryCommand {
  operationId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ResetCommand".
 */
export interface ResetCommand {
  acknowledgeEarlierTransitionContinues: true;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "FaultCommand".
 */
export interface FaultCommand {
  fault: "price_change" | "output_failure" | "import_failure" | "timeout" | "provider_instruction" | "stale_evidence";
  enabled: boolean;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "CleanupCommand".
 */
export interface CleanupCommand {
  expectedClaimGeneration: number;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ReadAccountArgs".
 */
export interface ReadAccountArgs {}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ListPlansArgs".
 */
export interface ListPlansArgs {}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "GetQuoteArgs".
 */
export interface GetQuoteArgs {
  candidateId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "TestCandidateArgs".
 */
export interface TestCandidateArgs {
  candidateId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ReadArtifactArgs".
 */
export interface ReadArtifactArgs {
  artifactId: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ReadAccountResult".
 */
export interface ReadAccountResult {
  account: AccountSnapshot;
  sample: Artifact;
  capabilityResults: CapabilityResult[];
  evidenceIds: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ListPlansResult".
 */
export interface ListPlansResult {
  plans: PlanSummary[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "GetQuoteResult".
 */
export interface GetQuoteResult {
  quote: CandidateQuote;
  replacementCeiling: Money;
  withinCeiling: boolean;
  comparisonSummary?: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "TestCandidateResult".
 */
export interface TestCandidateResult {
  candidateId: string;
  artifact: Artifact;
  capabilityResults: CapabilityResult[];
  evidenceIds: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "ReadArtifactResult".
 */
export interface ReadArtifactResult {
  artifact: Artifact;
  evidenceIds: string[];
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "Job".
 */
export interface Job {
  id: string;
  caseId: string;
  eventId: string;
  policyRevision: number;
  status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";
  claimOwner: string | null;
  claimGeneration: number;
  leaseExpiresAt: string | null;
  heartbeatAt: string | null;
  createdAt: string;
  updatedAt: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "StoredOperation".
 */
export interface StoredOperation {
  operation: Operation;
  ownerId: string;
  claimOwner: string | null;
  leaseExpiresAt: string | null;
  requestBody: string | null;
  authorityHash: string | null;
  returnTokenHash: string | null;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "SampleTurn".
 */
export interface SampleTurn {
  speaker: string | null;
  text: string;
}
/**
 * This interface was referenced by `UrnValContracts06`'s JSON-Schema
 * via the `definition` "SampleOutput".
 */
export interface SampleOutput {
  editableText: string;
  turns: SampleTurn[];
}
