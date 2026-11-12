import { sql } from "drizzle-orm";
import {
  boolean,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  AccountSnapshot,
  CandidateEvaluation,
  CaseRecord,
  Evidence,
  ExitTerms,
  Job,
  Operation,
  PaidOffer,
  PolicyDraft,
  PurchaseTerms,
  Receipt,
  Recommendation,
  SessionView,
  Transcript,
  ValueComparison,
} from "../../shared/contracts";
import type { ModelUsage, TraceStep } from "../responses-loop";
import type { SubscriptionEntry } from "../../shared/subscriptions";
import type { ProductProfile } from "../subscription-recognition";
import type { PriceCheckCadence, PriceCheckSchedule } from "../../shared/price-checks";
import type { SubscriptionAdvice } from "../../shared/subscriptions";
import type { WalletPhase, PayPalWalletResult, WalletCandidateChoice } from "../../shared/paypal-wallet";

const timestampColumn = (name: string) => timestamp(name, { withTimezone: true });

/** One database belongs to one build profile; a public/judge launch cannot adopt private owner data. */
export const applicationDeployment = pgTable("application_deployment", {
  id: text("id").primaryKey(),
  profile: text("profile").notNull(),
  paypalIdentityEnvironment: text("paypal_identity_environment").notNull().default("sandbox"),
  paypalWalletEnvironment: text("paypal_wallet_environment"),
  workerGeneration: integer("worker_generation"),
  workerRevision: text("worker_revision"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

export const owners = pgTable("owners", {
  id: text("id").primaryKey(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

export const ownerSubscriptions = pgTable("owner_subscriptions", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  revision: integer("revision").notNull(),
  subscriptions: jsonb("subscriptions").$type<SubscriptionEntry[]>().notNull(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

/** Durable switch authority and browser capability envelopes. No model output grants spending authority. */
export const ownerSubscriptionSwitches = pgTable(
  "owner_subscription_switches",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    revision: integer("revision").notNull().default(1),
    phase: text("phase").$type<import("../../shared/subscription-switch").SwitchPhase>().notNull(),
    state: jsonb("state").$type<import("../subscription-switch").SwitchState>().notNull(),
    secrets: text("secrets"),
    browserSlots: integer("browser_slots").notNull().default(0),
    nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
    leaseToken: text("lease_token"),
    leaseUntil: timestampColumn("lease_until"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("owner_subscription_switches_owner").on(table.ownerId, table.createdAt),
    uniqueIndex("owner_subscription_switches_active")
      .on(table.ownerId)
      .where(
        sql`${table.phase} not in ('completed','stopped') or (${table.state}->>'purchaseDispatchedAt' is not null and ${table.state}->'newProof' = 'null'::jsonb) or (${table.state}->>'cancelDispatchedAt' is not null and ${table.state}->'oldProof' = 'null'::jsonb)`,
      ),
  ],
);

/** The initial comparison queue survives the browser and server process. */
export const ownerReviewBatches = pgTable("owner_review_batches", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  revision: integer("revision").notNull(),
  serviceIds: jsonb("service_ids").$type<string[]>().notNull(),
  completed: jsonb("completed").$type<string[]>().notNull(),
  failed: jsonb("failed").$type<string[]>().notNull(),
  attempts: jsonb("attempts").$type<Record<string, number>>().notNull(),
  status: text("status")
    .$type<"queued" | "running" | "paused" | "complete" | "failed" | "superseded">()
    .notNull(),
  pauseReason: text("pause_reason").$type<"budget" | "access" | null>(),
  currentServiceId: text("current_service_id"),
  nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
  leaseToken: text("lease_token"),
  leaseUntil: timestampColumn("lease_until"),
});

/** Resource capabilities and report state are encrypted with an owner/environment binding. */
export const paypalWalletConnections = pgTable("paypal_wallet_connections", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  environment: text("environment").notNull(),
  phase: text("phase").$type<WalletPhase>().notNull(),
  secrets: text("secrets"),
  result: jsonb("result").$type<PayPalWalletResult>(),
  nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
  leaseToken: text("lease_token"),
  leaseUntil: timestampColumn("lease_until"),
  browserReserved: boolean("browser_reserved").notNull().default(false),
  failureCode: text("failure_code"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

/** Owner decisions outlive a disposable provider browser; no source identifiers or credentials are stored. */
export const paypalWalletReviews = pgTable(
  "paypal_wallet_reviews",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    environment: text("environment").$type<"sandbox" | "live">().notNull(),
    paymentKey: text("payment_key").notNull(),
    choice: text("choice").$type<WalletCandidateChoice>().notNull(),
    revision: integer("revision").notNull(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.environment, table.paymentKey] })],
);

/** Explicitly confirmed, owner-scoped recurring research. No payment authority. */
export const ownerPriceChecks = pgTable(
  "owner_price_checks",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    serviceId: text("service_id").notNull(),
    revision: integer("revision").notNull(),
    cadence: jsonb("cadence").$type<PriceCheckCadence>(),
    anchorAt: timestampColumn("anchor_at").notNull(),
    nextCheckAt: timestampColumn("next_check_at"),
    retryAt: timestampColumn("retry_at"),
    lastCheckedAt: timestampColumn("last_checked_at"),
    status: text("status").$type<PriceCheckSchedule["status"]>().notNull(),
    advice: jsonb("advice").$type<SubscriptionAdvice>(),
    adviceRevision: integer("advice_revision"),
    adviceDependencyKey: text("advice_dependency_key"),
    leaseToken: text("lease_token"),
    leaseUntil: timestampColumn("lease_until"),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.serviceId] }),
    index("owner_price_checks_due").on(table.nextCheckAt),
  ],
);

/** Public provider facts only; no payment IDs, usage notes or owner references. */
export const subscriptionProductProfiles = pgTable("subscription_product_profiles", {
  key: text("key").primaryKey(),
  version: text("version").notNull(),
  profile: jsonb("profile").$type<ProductProfile>().notNull(),
  expiresAt: timestampColumn("expires_at").notNull(),
});
/** Private product clarification and registration; saving usage still requires confirmation. */
export const ownerRecognizedServices = pgTable(
  "owner_recognized_services",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    serviceId: text("service_id").notNull(),
    name: text("name").notNull(),
    profile: jsonb("profile").$type<ProductProfile>().notNull(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ownerId, table.serviceId] })],
);

export const judgeDemoAccess = pgTable("judge_demo_access", {
  tokenHash: text("token_hash").primaryKey(),
  expiresAt: timestampColumn("expires_at").notNull(),
});

export const judgeDemoOwners = pgTable("judge_demo_owners", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  expiresAt: timestampColumn("expires_at").notNull(),
});

/** Shared budget and hashed login-rate windows; never reset by browser or session changes. */
export const judgeDemoCounters = pgTable("judge_demo_counters", {
  key: text("key").primaryKey(),
  calls: integer("calls").notNull().default(0),
  usedMicros: integer("used_micros").notNull().default(0),
  windowStartedAt: timestampColumn("window_started_at").notNull().defaultNow(),
});

/** Unknown outcomes retain their full reservation. No prompt or credential content is stored. */
export const judgeDemoRequests = pgTable(
  "judge_demo_requests",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    reservedMicros: integer("reserved_micros").notNull(),
    chargedMicros: integer("charged_micros").notNull(),
    state: text("state").$type<"pending" | "settled" | "uncertain" | "rejected">().notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => [index("judge_demo_requests_owner_created").on(table.ownerId, table.createdAt)],
);

/** Trusted service bindings created by the sandbox setup, never by chat or customer-supplied IDs. */
export const paypalSubscriptionLinks = pgTable(
  "paypal_subscription_links",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    merchant: text("merchant").$type<"A" | "B">().notNull(),
    subscriptionId: text("subscription_id").notNull(),
    planId: text("plan_id").notNull(),
    customId: text("custom_id").notNull(),
    serviceId: text("service_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => [
    unique("paypal_subscription_links_remote").on(table.merchant, table.subscriptionId),
    index("paypal_subscription_links_owner").on(table.ownerId),
  ],
);

export const ownerSubscriptionReviews = pgTable("owner_subscription_reviews", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => owners.id),
  portfolioRevision: integer("portfolio_revision").notNull(),
  serviceId: text("service_id").notNull(),
  version: jsonb("version").notNull(),
  input: jsonb("input").notNull(),
  result: jsonb("result").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** Resumable read-only chat work. Request IDs are scoped to an authenticated owner. */
export const ownerChatRequests = pgTable(
  "owner_chat_requests",
  {
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    id: text("id").notNull(),
    commandHash: text("command_hash").notNull(),
    command: jsonb("command").$type<import("../../shared/subscriptions").ValChatCommand>().notNull(),
    status: text("status").$type<"queued" | "running" | "complete" | "failed">().notNull(),
    progress: jsonb("progress")
      .$type<import("../../shared/subscriptions").SubscriptionIngestionProgress[]>()
      .notNull()
      .default([]),
    reply: jsonb("reply").$type<import("../../shared/subscriptions").ValChatReply>(),
    error: jsonb("error").$type<NonNullable<import("../../shared/subscriptions").ValChatRequest["error"]>>(),
    attempts: integer("attempts").notNull().default(0),
    reviewId: text("review_id"),
    leaseToken: text("lease_token"),
    leaseUntil: timestampColumn("lease_until"),
    workerRevision: text("worker_revision"),
    nextAttemptAt: timestampColumn("next_attempt_at").notNull().defaultNow(),
    deadlineAt: timestampColumn("deadline_at").notNull(),
    expiresAt: timestampColumn("expires_at").notNull(),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.id] }),
    index("owner_chat_requests_queue").on(table.status, table.nextAttemptAt),
    index("owner_chat_requests_owner").on(table.ownerId, table.createdAt),
    uniqueIndex("owner_chat_requests_active")
      .on(table.ownerId)
      .where(sql`${table.status} in ('queued','running')`),
  ],
);

/** Shared short-lived model health; contains no customer content or credentials. */
export const chatModelHealth = pgTable("chat_model_health", {
  model: text("model").primaryKey(),
  failures: integer("failures").notNull().default(0),
  openUntil: timestampColumn("open_until"),
  updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
});

/** Parent ownership isolates hosted examples from the customer's real portfolio. */
export const ownerSwitchExamples = pgTable("owner_switch_examples", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  exampleOwnerId: text("example_owner_id")
    .notNull()
    .unique()
    .references(() => owners.id),
  sessionId: text("session_id").notNull().unique(),
  providerOrigin: text("provider_origin").notNull(),
  company: text("company").notNull(),
  purpose: text("purpose").notNull(),
  sourceServiceId: text("source_service_id"),
  sourceName: text("source_name"),
  sourceBasis: text("source_basis"),
  switchId: text("switch_id"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** Only the hash of the browser's owner cookie is stored. */
export const ownerCookies = pgTable("owner_cookies", {
  tokenHash: text("token_hash").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => owners.id),
  expiresAt: timestampColumn("expires_at").notNull(),
});

export const recoveryCodes = pgTable("recovery_codes", {
  ownerId: text("owner_id")
    .primaryKey()
    .references(() => owners.id),
  codeHash: text("code_hash").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** Anonymous bootstrap sessions have no role or owner until login succeeds. */
export const sessions = pgTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  role: text("role").$type<NonNullable<SessionView["role"]>>(),
  ownerId: text("owner_id").references(() => owners.id),
  csrfToken: text("csrf_token").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  lastSeenAt: timestampColumn("last_seen_at").notNull().defaultNow(),
});

/** PayPal sandbox subjects are opaque identifiers, never emails or an inferred browser/account link. */
export const loginIdentities = pgTable("login_identities", {
  subjectHash: text("subject_hash").primaryKey(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => owners.id),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** Short-lived, single-use login state bound to the initiating browser's bootstrap session. */
export const loginAttempts = pgTable("login_attempts", {
  stateHash: text("state_hash").primaryKey(),
  sessionIdHash: text("session_id_hash")
    .notNull()
    .unique()
    .references(() => sessions.idHash, { onDelete: "cascade" }),
  expiresAt: timestampColumn("expires_at").notNull(),
});

export const cases = pgTable(
  "cases",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id")
      .notNull()
      .references(() => owners.id),
    scenario: text("scenario").$type<CaseRecord["scenario"]>().notNull(),
    state: text("state").$type<CaseRecord["state"]>().notNull(),
    reason: text("reason").$type<CaseRecord["reason"]>(),
    initialAccountId: text("initial_account_id").notNull(),
    replacementAccountId: text("replacement_account_id").notNull(),
    /** Named test faults switched on by an administrator; never set by customers or a model. */
    faults: jsonb("faults").$type<CaseFaults>().notNull().default({}),
    /** Plan behaviour and notice of an offline evaluation workspace. Null for every customer case. */
    evaluation: jsonb("evaluation").$type<EvaluationWorkspace>(),
    archivedAt: timestampColumn("archived_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
  },
  (table) => [unique("cases_id_owner").on(table.id, table.ownerId), index("cases_owner").on(table.ownerId)],
);

export type CaseFaults = Partial<
  Record<"price_change" | "output_failure" | "import_failure" | "timeout", boolean>
>;

/** A materialised challenger or fixed-fixture configuration: what each plan actually outputs and claims. */
export interface EvaluationWorkspace {
  notice: string;
  plans: Record<string, { marketingText: string; editableText: boolean; speakerLabels: boolean }>;
  valueCase?: { source: "AUTHORED_EVALUATION"; paidThrough: string };
}

export const operations = pgTable(
  "operations",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id").notNull(),
    ownerId: text("owner_id").notNull(),
    transitionId: text("transition_id"),
    kind: text("kind").$type<Operation["kind"]>().notNull(),
    operationKey: text("operation_key").notNull().unique(),
    targetId: text("target_id"),
    status: text("status").$type<Operation["status"]>().notNull(),
    claimGeneration: integer("claim_generation").notNull().default(0),
    claimOwner: text("claim_owner"),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    requestId: text("request_id"),
    requestBody: text("request_body"),
    authorityHash: text("authority_hash"),
    returnTokenHash: text("return_token_hash"),
    remoteId: text("remote_id"),
    attempts: integer("attempts").notNull().default(0),
    dispatchedAt: timestampColumn("dispatched_at"),
    resultEvidenceId: text("result_evidence_id"),
    merchant: text("merchant").$type<"A" | "B">().notNull(),
    planId: text("plan_id").notNull(),
    /** PayPal custom_id; null for operations that never touch PayPal (backup, import, activation, service exit). */
    customId: text("custom_id"),
    approvalUrl: text("approval_url"),
    /** Latest observed PayPal subscription status and the independent initial-payment verdict. */
    billingStatus: text("billing_status").$type<Receipt["newBillingStatus"]>(),
    paymentStatus: text("payment_status").$type<Receipt["duePayment"]>().notNull().default("NOT_STARTED"),
    note: text("note"),
    /** Only resources created by the explicit Sandbox probe may be cancelled by probe cleanup. */
    probe: boolean("probe").notNull().default(false),
    /** Set by administrator cleanup once the remote resource was observed terminal; receipts and evidence stay. */
    retiredAt: timestampColumn("retired_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.caseId, table.ownerId], foreignColumns: [cases.id, cases.ownerId] }),
    unique("operations_id_case").on(table.id, table.caseId),
    index("operations_unresolved")
      .on(table.status)
      .where(sql`${table.status} in ('PLANNED', 'IN_FLIGHT', 'UNKNOWN')`),
  ],
);

/** Immutable record of each remote write attempt and what came back. */
export const operationObservations = pgTable("operation_observations", {
  id: text("id").primaryKey(),
  operationId: text("operation_id")
    .notNull()
    .references(() => operations.id),
  claimGeneration: integer("claim_generation").notNull(),
  httpStatus: integer("http_status"),
  body: jsonb("body"),
  observedAt: timestampColumn("observed_at").notNull().defaultNow(),
});

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    eventId: text("event_id").notNull(),
    policyRevision: integer("policy_revision").notNull(),
    status: text("status").$type<Job["status"]>().notNull(),
    claimOwner: text("claim_owner"),
    claimGeneration: integer("claim_generation").notNull().default(0),
    leaseExpiresAt: timestampColumn("lease_expires_at"),
    heartbeatAt: timestampColumn("heartbeat_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  (table) => [
    unique("jobs_case_event_revision").on(table.caseId, table.eventId, table.policyRevision),
    index("jobs_pending")
      .on(table.createdAt)
      .where(sql`${table.status} in ('QUEUED', 'RUNNING')`),
  ],
);

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: text("id").primaryKey(),
    merchant: text("merchant").$type<"A" | "B">().notNull(),
    eventId: text("event_id"),
    eventType: text("event_type"),
    verified: boolean("verified").notNull(),
    rejectionReason: text("rejection_reason"),
    receivedAt: timestampColumn("received_at").notNull().defaultNow(),
  },
  // Rejected deliveries are kept for evidence but must not occupy a real event's dedupe key.
  (table) => [
    uniqueIndex("webhook_events_verified")
      .on(table.merchant, table.eventId)
      .where(sql`${table.verified}`),
  ],
);

export const artifacts = pgTable("artifacts", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  mimeType: text("mime_type").$type<"text/plain" | "application/json">().notNull(),
  content: text("content").notNull(),
  sha256: text("sha256").notNull(),
  advisory: boolean("advisory").notNull().default(false),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** Evidence rows carry the Evidence contract; `detail` holds the typed payment/subscription facts behind the summary. */
export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    operationId: text("operation_id"),
    providerId: text("provider_id").$type<Evidence["providerId"]>(),
    accountId: text("account_id"),
    planId: text("plan_id"),
    entitlementRevision: integer("entitlement_revision"),
    kind: text("kind").$type<Evidence["kind"]>().notNull(),
    observedAt: timestampColumn("observed_at").notNull(),
    artifactId: text("artifact_id").references(() => artifacts.id),
    advisory: boolean("advisory").notNull().default(false),
    summary: text("summary").notNull(),
    detail: jsonb("detail"),
  },
  (table) => [
    foreignKey({
      columns: [table.operationId, table.caseId],
      foreignColumns: [operations.id, operations.caseId],
    }),
    index("evidence_case").on(table.caseId, table.observedAt),
  ],
);

/** One case-owned workspace per provider: its account, entitlement and (for A) the seeded transcript history. */
export const providerAccounts = pgTable("provider_accounts", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  providerId: text("provider_id").$type<AccountSnapshot["providerId"]>().notNull(),
  planId: text("plan_id"),
  subscriptionId: text("subscription_id"),
  entitlementRevision: integer("entitlement_revision").notNull(),
  publicSpeakerLabels: boolean("public_speaker_labels").notNull(),
  accountSpeakerLabels: boolean("account_speaker_labels").notNull(),
  historyRetained: boolean("history_retained").notNull(),
  accessStatus: text("access_status").$type<AccountSnapshot["accessStatus"]>().notNull(),
  paidThrough: timestampColumn("paid_through"),
  accessEndsAt: timestampColumn("access_ends_at"),
});

export const providerTranscripts = pgTable(
  "provider_transcripts",
  {
    accountId: text("account_id")
      .notNull()
      .references(() => providerAccounts.id),
    id: text("id").notNull(),
    title: text("title").notNull(),
    turns: jsonb("turns").$type<Transcript["turns"]>().notNull(),
  },
  (table) => [primaryKey({ columns: [table.accountId, table.id] })],
);

export const policies = pgTable(
  "policies",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    revision: integer("revision").notNull(),
    purpose: text("purpose").notNull(),
    requiredCapabilities: jsonb("required_capabilities")
      .$type<("editable_text" | "speaker_labels")[]>()
      .notNull(),
    recurringCeilingMinor: integer("recurring_ceiling_minor").notNull(),
    preserveHistory: boolean("preserve_history").notNull(),
    allowInvestigation: boolean("allow_investigation").notNull(),
    confirmedAt: timestampColumn("confirmed_at").notNull().defaultNow(),
  },
  (table) => [unique("policies_case_revision").on(table.caseId, table.revision)],
);

export const quotes = pgTable("quotes", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  candidateId: text("candidate_id").notNull(),
  providerId: text("provider_id").$type<AccountSnapshot["providerId"]>().notNull(),
  revision: integer("revision").notNull(),
  recurringMinor: integer("recurring_minor").notNull(),
  dueNowMinor: integer("due_now_minor").notNull(),
  offer: jsonb("offer").$type<PaidOffer>(),
  comparison: jsonb("comparison").$type<ValueComparison>(),
  evidenceId: text("evidence_id").notNull(),
  observedAt: timestampColumn("observed_at").notNull(),
  advisory: boolean("advisory").notNull().default(false),
});

/** One investigation's verdict on a candidate, tied to the policy and entitlement revisions it was computed under. */
export const evaluations = pgTable("evaluations", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  policyRevision: integer("policy_revision").notNull(),
  candidateId: text("candidate_id").notNull(),
  entitlementRevision: integer("entitlement_revision").notNull(),
  result: jsonb("result").$type<CandidateEvaluation>().notNull(),
  observedAt: timestampColumn("observed_at").notNull(),
});

export const recommendations = pgTable("recommendations", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  policyRevision: integer("policy_revision").notNull(),
  action: text("action").$type<Recommendation["action"]>().notNull(),
  candidateId: text("candidate_id"),
  evidenceIds: jsonb("evidence_ids").$type<string[]>().notNull(),
  explanation: text("explanation").notNull(),
  uncertainties: jsonb("uncertainties").$type<string[]>().notNull(),
  /** Checked model recommendations use 'agent'; historical manual records retain their original source. */
  source: text("source").notNull(),
  agentRunId: text("agent_run_id"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

export const previews = pgTable("previews", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  ownerId: text("owner_id").notNull(),
  recommendationId: text("recommendation_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  materialTerms: jsonb("material_terms").$type<PurchaseTerms>().notNull(),
  /** The exact JSON that previewHash covers. */
  hashPayload: text("hash_payload").notNull(),
  previewHash: text("preview_hash").notNull(),
  backupEvidenceId: text("backup_evidence_id").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  expiresAt: timestampColumn("expires_at").notNull(),
});

export const consents = pgTable("consents", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  ownerId: text("owner_id").notNull(),
  sessionId: text("session_id").notNull(),
  previewId: text("preview_id")
    .notNull()
    .references(() => previews.id),
  previewHash: text("preview_hash").notNull(),
  approvePurchase: boolean("approve_purchase").notNull(),
  approveOldExitAfterReadiness: boolean("approve_old_exit_after_readiness").notNull(),
  consumedByOperationId: text("consumed_by_operation_id"),
  consumedAt: timestampColumn("consumed_at"),
  revokedAt: timestampColumn("revoked_at"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** The purchase made from one consent. Accepted terms never change; later facts are compared against them. */
export const transitions = pgTable(
  "transitions",
  {
    id: text("id").primaryKey(),
    caseId: text("case_id")
      .notNull()
      .references(() => cases.id),
    ownerId: text("owner_id").notNull(),
    consentId: text("consent_id")
      .notNull()
      .unique()
      .references(() => consents.id),
    exitAuthorizationId: text("exit_authorization_id"),
    state: text("state").$type<CaseRecord["state"]>().notNull(),
    oldSubscriptionId: text("old_subscription_id").notNull(),
    acceptedPolicyRevision: integer("accepted_policy_revision").notNull(),
    acceptedPurchaseTerms: jsonb("accepted_purchase_terms").$type<PurchaseTerms>().notNull(),
    capabilityStatus: text("capability_status")
      .$type<Receipt["capability"]>()
      .notNull()
      .default("NOT_STARTED"),
    capabilityEvidenceId: text("capability_evidence_id"),
    historyStatus: text("history_status").$type<Receipt["history"]>().notNull().default("NOT_STARTED"),
    historyEvidenceId: text("history_evidence_id"),
    exitsPausedAt: timestampColumn("exits_paused_at"),
    lastError: text("last_error"),
    /** Set when the transition ends: completed, or its unapproved PayPal resource was observed cancelled/expired. */
    closedAt: timestampColumn("closed_at"),
    createdAt: timestampColumn("created_at").notNull().defaultNow(),
    updatedAt: timestampColumn("updated_at").notNull().defaultNow(),
  },
  // At most one transition per case is open at a time.
  (table) => [
    uniqueIndex("transitions_one_open_per_case")
      .on(table.caseId)
      .where(sql`${table.closedAt} is null`),
  ],
);

export const exitReviews = pgTable("exit_reviews", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  ownerId: text("owner_id").notNull(),
  transitionId: text("transition_id")
    .notNull()
    .references(() => transitions.id),
  policyRevision: integer("policy_revision").notNull(),
  materialTerms: jsonb("material_terms").$type<ExitTerms>().notNull(),
  readinessEvidenceIds: jsonb("readiness_evidence_ids").$type<string[]>().notNull(),
  hashPayload: text("hash_payload").notNull(),
  reviewHash: text("review_hash").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
  expiresAt: timestampColumn("expires_at").notNull(),
});

export const exitAuthorizations = pgTable("exit_authorizations", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  ownerId: text("owner_id").notNull(),
  sessionId: text("session_id").notNull(),
  transitionId: text("transition_id")
    .notNull()
    .references(() => transitions.id),
  reviewId: text("review_id")
    .notNull()
    .references(() => exitReviews.id),
  reviewHash: text("review_hash").notNull(),
  approveRemainingExits: boolean("approve_remaining_exits").notNull(),
  consumedAt: timestampColumn("consumed_at"),
  revokedAt: timestampColumn("revoked_at"),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

/** One bounded model task: its version, tool trace, final output and outcome. Private reasoning is never stored. */
export const agentRuns = pgTable("agent_runs", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  task: text("task").$type<"policy_draft" | "investigation" | "what_if">().notNull(),
  policyRevision: integer("policy_revision"),
  input: jsonb("input").$type<{ baseline: Record<string, unknown>; overrides: Record<string, unknown> }>(),
  version: jsonb("version").$type<Record<string, unknown>>().notNull(),
  /** accepted by the deterministic checks, rejected by them, or ended in review before a usable answer. */
  outcome: text("outcome").$type<"accepted" | "rejected" | "review">().notNull(),
  detail: text("detail"),
  trace: jsonb("trace").$type<TraceStep[]>().notNull(),
  output: jsonb("output"),
  usage: jsonb("usage").$type<ModelUsage>().notNull(),
  elapsedMs: integer("elapsed_ms").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});

export const policyDrafts = pgTable("policy_drafts", {
  id: text("id").primaryKey(),
  caseId: text("case_id")
    .notNull()
    .references(() => cases.id),
  purpose: text("purpose").notNull(),
  draft: jsonb("draft").$type<PolicyDraft>().notNull(),
  agentRunId: text("agent_run_id").notNull(),
  createdAt: timestampColumn("created_at").notNull().defaultNow(),
});
