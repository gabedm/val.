import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type {
  AccountSnapshot,
  CandidateEvaluation,
  CandidateQuote,
  CapabilityResult,
  CaseRecord,
  CaseSnapshot,
  CaseSummary,
  Evidence,
  Policy,
  Receipt,
  Recommendation,
  Transition,
} from "../shared/contracts";
import type { Database, Executor, Transaction } from "./db";
import {
  agentRuns,
  artifacts,
  cases,
  evaluations,
  evidence,
  jobs,
  operations,
  policies,
  providerAccounts,
  quotes,
  recommendations,
  transitions,
} from "./db/schema";
import { HttpError } from "./http";
import { retryableOperation, type CaseRow, type OperationRow } from "./operations";
import { benchmarkTurns, listPlans, seedWorkspaces } from "./providers";
import { checkSample } from "./validation";

export type TransitionRow = typeof transitions.$inferSelect;

export async function createCase(
  db: Database,
  ownerId: string,
  scenario: CaseRecord["scenario"],
): Promise<CaseRow> {
  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(cases)
      .values({
        id: randomUUID(),
        ownerId,
        scenario,
        state: "SETUP",
        initialAccountId: randomUUID(),
        replacementAccountId: randomUUID(),
      })
      .returning();
    await seedWorkspaces(tx, created!);
    return created!;
  });
}

/** The owner check lives in the query: another owner's case is indistinguishable from a missing one. */
export async function ownedCase(db: Database, ownerId: string, caseId: string): Promise<CaseRow> {
  const [row] = await db
    .select()
    .from(cases)
    .where(and(eq(cases.id, caseId), eq(cases.ownerId, ownerId)));
  if (!row) throw new HttpError(404, "case_not_found", "No such case.");
  return row;
}

export async function setCaseState(
  tx: Executor,
  caseId: string,
  state: CaseRecord["state"],
  reason: CaseRecord["reason"] = null,
) {
  await tx.update(cases).set({ state, reason }).where(eq(cases.id, caseId));
}

/** The case's transition that has not completed or been closed, if any. */
export async function openTransition(db: Executor, caseId: string): Promise<TransitionRow | null> {
  const [row] = await db
    .select()
    .from(transitions)
    .where(and(eq(transitions.caseId, caseId), isNull(transitions.closedAt)));
  return row ?? null;
}

/**
 * Takes the case lock and then its open transition's lock, always in that order. Pausing, authorizing, policy changes
 * and the exit dispatch boundary all start here, so each sees the others' completed changes and none can interleave.
 */
export async function lockCaseAndTransition(
  tx: Transaction,
  caseId: string,
): Promise<{ state: CaseRecord["state"]; transition: TransitionRow | null }> {
  const [locked] = await tx
    .select({ state: cases.state })
    .from(cases)
    .where(eq(cases.id, caseId))
    .for("update");
  const [transition] = await tx
    .select()
    .from(transitions)
    .where(and(eq(transitions.caseId, caseId), isNull(transitions.closedAt)))
    .for("update");
  return { state: locked!.state, transition: transition ?? null };
}

/**
 * Moves a transition and its case together. Completing a transition, or returning to MONITORING after its unapproved
 * PayPal resource ended, closes it; every other state keeps it open for further reconciliation.
 */
export async function moveTransition(
  tx: Executor,
  transition: TransitionRow,
  state: CaseRecord["state"],
  reason: CaseRecord["reason"] = null,
  lastError: string | null = null,
) {
  const closes = state === "COMPLETE" || state === "MONITORING";
  await tx
    .update(transitions)
    .set({ state, lastError, updatedAt: new Date(), ...(closes && { closedAt: new Date() }) })
    .where(eq(transitions.id, transition.id));
  await setCaseState(tx, transition.caseId, state, reason);
}

/**
 * Archives the case and starts a healthy new one for the same owner. This is navigation only: consent, jobs and an
 * ongoing transition of the archived case carry on exactly as before.
 */
export async function resetCase(db: Database, caseRow: CaseRow): Promise<CaseRow> {
  return db.transaction(async (tx) => {
    await tx
      .update(cases)
      .set({ archivedAt: new Date() })
      .where(and(eq(cases.id, caseRow.id), isNull(cases.archivedAt)));
    const [fresh] = await tx
      .insert(cases)
      .values({
        id: randomUUID(),
        ownerId: caseRow.ownerId,
        scenario: caseRow.scenario,
        state: "SETUP",
        initialAccountId: randomUUID(),
        replacementAccountId: randomUUID(),
      })
      .returning();
    await seedWorkspaces(tx, fresh!);
    return fresh!;
  });
}

export async function listCases(db: Database, ownerId: string): Promise<CaseSummary[]> {
  const rows = await db.select().from(cases).where(eq(cases.ownerId, ownerId)).orderBy(desc(cases.createdAt));
  return rows.map(({ id, scenario, state, archivedAt, createdAt }) => ({
    id,
    scenario,
    state,
    archivedAt: archivedAt?.toISOString() ?? null,
    createdAt: createdAt.toISOString(),
  }));
}

export async function listEvidence(db: Database, caseId: string): Promise<Evidence[]> {
  const rows = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.caseId, caseId), eq(evidence.advisory, false)))
    .orderBy(evidence.observedAt);
  return rows.map((row) => ({
    id: row.id,
    caseId: row.caseId,
    providerId: row.providerId,
    accountId: row.accountId,
    planId: row.planId,
    entitlementRevision: row.entitlementRevision,
    kind: row.kind,
    observedAt: row.observedAt.toISOString(),
    artifactId: row.artifactId,
    summary: row.summary,
  }));
}

export const toPolicy = (row: typeof policies.$inferSelect): Policy => ({
  id: row.id,
  caseId: row.caseId,
  revision: row.revision,
  purpose: row.purpose,
  requiredCapabilities: row.requiredCapabilities as Policy["requiredCapabilities"],
  recurringCeiling: { currency: "GBP", amountMinor: row.recurringCeilingMinor },
  preserveHistory: row.preserveHistory,
  allowInvestigation: row.allowInvestigation,
  confirmedAt: row.confirmedAt.toISOString(),
});

export async function latestPolicy(db: Executor, caseId: string) {
  const [row] = await db
    .select()
    .from(policies)
    .where(eq(policies.caseId, caseId))
    .orderBy(desc(policies.revision))
    .limit(1);
  return row ?? null;
}

export const toRecommendation = (row: typeof recommendations.$inferSelect): Recommendation => ({
  id: row.id,
  caseId: row.caseId,
  policyRevision: row.policyRevision,
  action: row.action,
  candidateId: row.candidateId,
  evidenceIds: row.evidenceIds,
  explanation: row.explanation,
  uncertainties: row.uncertainties,
  createdAt: row.createdAt.toISOString(),
});

/** The newest evaluation of each candidate under one policy revision. */
export async function latestEvaluations(db: Executor, caseId: string, policyRevision: number) {
  const rows = await db
    .select()
    .from(evaluations)
    .where(and(eq(evaluations.caseId, caseId), eq(evaluations.policyRevision, policyRevision)))
    .orderBy(desc(evaluations.observedAt));
  const newest = new Map<string, (typeof rows)[number]>();
  for (const row of rows) if (!newest.has(row.candidateId)) newest.set(row.candidateId, row);
  return [...newest.values()];
}

const toQuote = (row: typeof quotes.$inferSelect): CandidateQuote => {
  const money = { currency: "GBP", amountMinor: row.recurringMinor } as const;
  return {
    id: row.id,
    caseId: row.caseId,
    candidateId: row.candidateId,
    providerId: row.providerId,
    planId: row.candidateId,
    revision: row.revision,
    recurringTotal: money,
    dueNowTotal: { currency: "GBP", amountMinor: row.dueNowMinor },
    interval: "MONTH",
    intervalCount: 1,
    taxMinor: 0,
    feesMinor: 0,
    ...(row.offer ? { offer: row.offer } : {}),
    ...(row.comparison ? { comparison: row.comparison } : {}),
    observedAt: row.observedAt.toISOString(),
    evidenceId: row.evidenceId,
  };
};

async function latestAccountSnapshot(db: Executor, accountId: string): Promise<AccountSnapshot | null> {
  const [row] = await db
    .select()
    .from(evidence)
    .where(and(eq(evidence.accountId, accountId), eq(evidence.kind, "account"), eq(evidence.advisory, false)))
    .orderBy(desc(evidence.observedAt))
    .limit(1);
  return row
    ? {
        ...(row.detail as Omit<AccountSnapshot, "observedAt" | "evidenceId">),
        observedAt: row.observedAt.toISOString(),
        evidenceId: row.id,
      }
    : null;
}

/** The purchase and old-billing facts behind a case's receipt, each read independently. */
async function receiptFor(db: Executor, row: CaseRow, transition: TransitionRow | null): Promise<Receipt> {
  const [setup] = await db
    .select()
    .from(operations)
    .where(
      and(eq(operations.caseId, row.id), eq(operations.kind, "setup_create"), eq(operations.probe, false)),
    );
  const [account] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, row.initialAccountId));
  const purchase = transition
    ? (
        await db
          .select()
          .from(operations)
          .where(and(eq(operations.transitionId, transition.id), eq(operations.kind, "replacement_create")))
      )[0]
    : undefined;

  const oldBillingVerified = setup?.billingStatus === "ACTIVE" && setup.paymentStatus === "VERIFIED";
  const oldBilling: Receipt["oldBilling"] =
    setup?.billingStatus === "CANCELLED" ? "CANCELLED" : oldBillingVerified ? "ACTIVE" : "UNKNOWN";
  // Provider A's service stays ACTIVE through billing cancellation; only the service exit changes it.
  const oldService: Receipt["oldService"] =
    !account?.subscriptionId || account.accessStatus === "TRIAL" ? "UNKNOWN" : account.accessStatus;

  return {
    newSubscriptionId: purchase?.remoteId ?? null,
    newBillingStatus: purchase?.billingStatus ?? "NONE",
    duePayment: purchase?.paymentStatus ?? "NOT_STARTED",
    paymentEvidenceId: purchase?.paymentStatus === "VERIFIED" ? purchase.resultEvidenceId : null,
    capability: transition?.capabilityStatus ?? "NOT_STARTED",
    capabilityEvidenceId: transition?.capabilityEvidenceId ?? null,
    history: transition?.historyStatus ?? "NOT_STARTED",
    historyEvidenceId: transition?.historyEvidenceId ?? null,
    oldSubscriptionId: transition?.oldSubscriptionId ?? setup?.remoteId ?? null,
    oldBilling,
    oldService,
    oldAccessEndsAt: (account?.accessEndsAt ?? account?.paidThrough)?.toISOString() ?? null,
    message: transition ? transitionMessage(transition, purchase, oldService) : setupMessage(setup),
  };
}

function setupMessage(setup: OperationRow | undefined): string {
  if (!setup) return "The initial Provider A subscription has not been started.";
  if (!setup.remoteId) return "Creating the PayPal subscription.";
  if (setup.billingStatus === "APPROVAL_PENDING") return "Waiting for buyer approval at PayPal.";
  return setup.note ?? "Reconciling with PayPal.";
}

/** Plain statements of what is and is not yet true; scheduled access is never described as closed. */
function transitionMessage(
  transition: TransitionRow,
  purchase: OperationRow | undefined,
  oldService: Receipt["oldService"],
): string {
  if (transition.lastError) return transition.lastError;
  if (transition.state === "COMPLETE")
    return oldService === "EXIT_SCHEDULED"
      ? "Switch complete. Provider A billing is stopped and its access is scheduled to end at the paid-through date."
      : "Switch complete.";
  if (!purchase?.remoteId) return "Creating the Provider B subscription.";
  if (purchase.billingStatus === "APPROVAL_PENDING")
    return "Waiting for buyer approval of the Provider B subscription at PayPal.";
  if (purchase.paymentStatus !== "VERIFIED")
    return purchase.note ?? "Checking the Provider B payment with PayPal.";
  return "Provider B is paid. Provider A is kept until Provider B output and history are verified and exit authority is valid.";
}

export async function caseSnapshot(db: Database, row: CaseRow): Promise<CaseSnapshot> {
  const policyRow = await latestPolicy(db, row.id);
  const [recommendationRow] = await db
    .select()
    .from(recommendations)
    .where(eq(recommendations.caseId, row.id))
    .orderBy(desc(recommendations.createdAt))
    .limit(1);
  const [transitionRow] = await db
    .select()
    .from(transitions)
    .where(eq(transitions.caseId, row.id))
    .orderBy(desc(transitions.createdAt))
    .limit(1);
  const [pendingJob] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.caseId, row.id), inArray(jobs.status, ["QUEUED", "RUNNING"])))
    .orderBy(jobs.createdAt)
    .limit(1);
  const [currentQuote] = await db
    .select()
    .from(quotes)
    .where(and(eq(quotes.caseId, row.id), eq(quotes.candidateId, "a_01"), eq(quotes.advisory, false)))
    .orderBy(desc(quotes.observedAt))
    .limit(1);

  const receipt = await receiptFor(db, row, transitionRow ?? null);
  const evaluationRows = policyRow ? await latestEvaluations(db, row.id, policyRow.revision) : [];
  const evaluationQuotes = evaluationRows.length
    ? await db
        .select()
        .from(quotes)
        .where(
          and(
            inArray(
              quotes.id,
              evaluationRows.map((evaluation) => evaluation.result.quoteId),
            ),
            eq(quotes.advisory, false),
          ),
        )
    : [];
  const [activeTransition] = await db
    .select()
    .from(transitions)
    .where(and(eq(transitions.caseId, row.id), isNull(transitions.closedAt)));
  const operationRows = await db
    .select()
    .from(operations)
    .where(and(eq(operations.caseId, row.id), isNull(operations.retiredAt)))
    .orderBy(desc(operations.updatedAt));
  const unresolvedHandover = (operation: OperationRow) =>
    operation.status !== "SUCCEEDED" ||
    (["setup_create", "replacement_create"].includes(operation.kind) &&
      (operation.billingStatus === "APPROVAL_PENDING" ||
        operation.billingStatus === "APPROVED" ||
        (operation.billingStatus === "ACTIVE" && operation.paymentStatus !== "VERIFIED")));
  const handoverOperation = operationRows.find((operation) =>
    activeTransition
      ? operation.transitionId === activeTransition.id && unresolvedHandover(operation)
      : operation.kind === "setup_create" && !operation.probe && unresolvedHandover(operation),
  );
  const [investigationRun] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.caseId, row.id), eq(agentRuns.task, "investigation")))
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  const sampleStep = investigationRun?.trace
    .slice()
    .reverse()
    .find((step) => step.tool === "read_account");
  const sampleArtifactId = (sampleStep?.result as { sample?: { id?: string } } | undefined)?.sample?.id;
  const [sampleEvidence] = sampleArtifactId
    ? await db
        .select()
        .from(evidence)
        .where(
          and(
            eq(evidence.caseId, row.id),
            eq(evidence.artifactId, sampleArtifactId),
            eq(evidence.kind, "sample"),
            eq(evidence.advisory, false),
          ),
        )
        .orderBy(desc(evidence.observedAt))
        .limit(1)
    : [];
  const [sampleArtifact] = sampleEvidence?.artifactId
    ? await db
        .select()
        .from(artifacts)
        .where(
          and(
            eq(artifacts.id, sampleEvidence.artifactId),
            eq(artifacts.caseId, row.id),
            eq(artifacts.advisory, false),
          ),
        )
    : [];
  const currentOutput =
    sampleArtifact && sampleEvidence?.planId && policyRow
      ? {
          planId: sampleEvidence.planId,
          artifactId: sampleArtifact.id,
          capabilityResults: checkSample(
            JSON.parse(sampleArtifact.content),
            benchmarkTurns,
            policyRow.requiredCapabilities as CapabilityResult["capability"][],
          ),
          observedAt: sampleEvidence.observedAt.toISOString(),
        }
      : null;
  const runVersion = investigationRun?.version as { model?: string; promptVersion?: string } | undefined;
  const transition: Transition | null = transitionRow
    ? {
        id: transitionRow.id,
        caseId: transitionRow.caseId,
        consentId: transitionRow.consentId,
        exitAuthorizationId: transitionRow.exitAuthorizationId,
        state: transitionRow.state,
        newSubscriptionId: receipt.newSubscriptionId,
        oldSubscriptionId: transitionRow.oldSubscriptionId,
        receipt,
        lastError: transitionRow.lastError,
        createdAt: transitionRow.createdAt.toISOString(),
        updatedAt: transitionRow.updatedAt.toISOString(),
        acceptedPurchaseTerms: transitionRow.acceptedPurchaseTerms,
      }
    : null;

  return {
    case: {
      id: row.id,
      ownerId: row.ownerId,
      scenario: row.scenario,
      state: row.state,
      reason: row.reason,
      initialAccountId: row.initialAccountId,
      replacementAccountId: row.replacementAccountId,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    },
    policy: policyRow ? toPolicy(policyRow) : null,
    recommendation: recommendationRow ? toRecommendation(recommendationRow) : null,
    evaluations: evaluationRows.map((evaluation): CandidateEvaluation => evaluation.result),
    transition,
    receipt,
    pendingJobId: pendingJob?.id ?? null,
    currentAccount: await latestAccountSnapshot(db, row.initialAccountId),
    currentQuote: currentQuote ? toQuote(currentQuote) : null,
    evaluationQuotes: evaluationQuotes.map(toQuote),
    currentOutput,
    activeFaults: Object.entries(row.faults)
      .filter((entry) => entry[1])
      .map(([fault]) => fault) as CaseSnapshot["activeFaults"],
    handover: handoverOperation
      ? {
          operationId: handoverOperation.id,
          kind: handoverOperation.kind,
          status: handoverOperation.status,
          billingStatus: handoverOperation.billingStatus,
          paymentStatus: handoverOperation.paymentStatus,
          note: handoverOperation.note,
          approvalUrl:
            handoverOperation.billingStatus === "APPROVAL_PENDING" ? handoverOperation.approvalUrl : null,
          retryable: retryableOperation(handoverOperation, activeTransition?.state),
        }
      : null,
    investigationRun: investigationRun
      ? {
          id: investigationRun.id,
          outcome: investigationRun.outcome,
          model: runVersion?.model ?? "",
          promptVersion: runVersion?.promptVersion ?? "",
          usage: investigationRun.usage,
          elapsedMs: investigationRun.elapsedMs,
          createdAt: investigationRun.createdAt.toISOString(),
        }
      : null,
    availablePlans: await listPlans(db, row),
  };
}
