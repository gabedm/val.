import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { AsyncCommandResult, CaseRecord, RetryCommand } from "../shared/contracts";
import { latestPolicy, moveTransition, openTransition, type TransitionRow } from "./cases";
import type { AppContext } from "./context";
import {
  artifacts,
  cases,
  consents,
  evidence,
  operations,
  policies,
  previews,
  transitions,
} from "./db/schema";
import { loadEvidence, evidenceIdForArtifact } from "./evidence";
import { remainingExits, runExits } from "./exits";
import { HttpError } from "./http";
import { evidenceMaxAgeMs } from "./investigation";
import { queueJob, type Commit } from "./jobs";
import {
  dispatchCreation,
  retryableOperation,
  runLocalOperation,
  type CaseRow,
  type OperationRow,
} from "./operations";
import {
  activateAccount,
  benchmarkTurns,
  generateSubscribedSample,
  importHistory,
  openBackup,
  ProviderError,
} from "./providers";
import { checkSample } from "./validation";

/** An approval that is still unfinished after this long needs a person to look at it. */
const approvalWindowMs = 30 * 60 * 1000;

type Failure = { reason: NonNullable<CaseRecord["reason"]>; message: string };

/**
 * One pass over a case's open transition, from whatever state it was left in. Each step records its own fact and is
 * safe to repeat, so a restarted or delayed worker simply continues: PayPal's side first, then Provider B readiness,
 * then the exits that valid authority allows. Read-only reconciliation of PayPal has already run before this.
 */
export async function advanceTransition(
  ctx: AppContext,
  caseId: string,
  commit: Commit,
  options: { retry: boolean },
) {
  const transition = await openTransition(ctx.db, caseId);
  if (!transition) return;
  const [caseRow] = await ctx.db.select().from(cases).where(eq(cases.id, caseId));
  const [purchase] = await ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.transitionId, transition.id), eq(operations.kind, "replacement_create")));

  if (await endedBeforeApproval(ctx, purchase!)) {
    await commit((tx) =>
      moveTransition(
        tx,
        transition,
        "MONITORING",
        null,
        "The PayPal approval was cancelled or expired before approval. Nothing was bought.",
      ),
    );
    return;
  }
  const waiting = purchaseProgress(purchase!);
  if (waiting) return settle(commit, caseRow!, transition, waiting.state, waiting.reason, waiting.message);

  const failure = await verifyReplacement(ctx, caseRow!, transition, purchase!, commit, options.retry);
  if (failure)
    return settle(commit, caseRow!, transition, "ATTENTION_REQUIRED", failure.reason, failure.message);
  await settle(commit, caseRow!, transition, "VERIFYING_NEW", null, null);

  // The verification steps just recorded their facts on the transition; continue from the stored row.
  const [verifiedTransition] = await ctx.db
    .select()
    .from(transitions)
    .where(eq(transitions.id, transition.id));
  if ((await remainingExits(ctx.db, transition.id)).length === 0) {
    await commit((tx) => moveTransition(tx, verifiedTransition!, "COMPLETE"));
    return;
  }
  if (await capabilityEvidenceIsStale(ctx, verifiedTransition!)) {
    const refreshed = await verifyCapability(ctx, caseRow!, verifiedTransition!, commit);
    if (refreshed)
      return settle(
        commit,
        caseRow!,
        verifiedTransition!,
        "ATTENTION_REQUIRED",
        refreshed.reason,
        refreshed.message,
      );
  }
  await runExits(ctx, caseRow!, verifiedTransition!, commit);
}

/** Writes a progress state only when it differs from what is stored, so a 30-second poll leaves no trail. */
async function settle(
  commit: Commit,
  caseRow: CaseRow,
  transition: TransitionRow,
  state: CaseRecord["state"],
  reason: CaseRecord["reason"],
  message: string | null,
) {
  if (transition.state === state && caseRow.reason === reason && transition.lastError === message) return;
  await commit((tx) => moveTransition(tx, transition, state, reason, message));
}

/** An unapproved PayPal resource that was observed cancelled or expired. Anything ever approved stays visible instead. */
async function endedBeforeApproval(ctx: AppContext, purchase: OperationRow): Promise<boolean> {
  if (purchase.billingStatus !== "CANCELLED" && purchase.billingStatus !== "EXPIRED") return false;
  const observations = await ctx.db
    .select({ detail: evidence.detail })
    .from(evidence)
    .where(
      and(
        eq(evidence.operationId, purchase.id),
        eq(evidence.kind, "subscription"),
        eq(evidence.advisory, false),
      ),
    );
  const wasApproved = observations.some((row) =>
    ["ACTIVE", "APPROVED", "SUSPENDED"].includes((row.detail as { status: string | null }).status ?? ""),
  );
  return !wasApproved && purchase.paymentStatus !== "VERIFIED";
}

/** Where the purchase stands until PayPal confirms ACTIVE plus the exact accepted initial payment; null once it does. */
function purchaseProgress(
  purchase: OperationRow,
): { state: CaseRecord["state"]; reason: CaseRecord["reason"]; message: string | null } | null {
  const attention = (reason: NonNullable<CaseRecord["reason"]>, message: string) => ({
    state: "ATTENTION_REQUIRED" as const,
    reason,
    message,
  });
  if (purchase.status === "FAILED")
    return attention(
      "operation_failed",
      `PayPal refused the Provider B subscription request: ${purchase.note ?? "no detail"}.`,
    );
  if (purchase.status === "UNKNOWN" && !purchase.remoteId)
    return attention(
      "operation_failed",
      "The Provider B subscription request has an unknown outcome. It is being reconciled; no second purchase will be made.",
    );
  if (!purchase.remoteId) return { state: "AWAITING_PAYPAL", reason: null, message: null };

  if (purchase.billingStatus === "APPROVAL_PENDING" || purchase.billingStatus === "APPROVED") {
    const waitedTooLong = Date.now() - purchase.createdAt.getTime() > approvalWindowMs;
    return waitedTooLong
      ? attention(
          "approval_unresolved",
          "PayPal approval is still unfinished after 30 minutes. The subscription stays visible; nothing else has happened.",
        )
      : { state: "AWAITING_PAYPAL", reason: null, message: null };
  }
  if (purchase.billingStatus !== "ACTIVE")
    return attention(
      "operation_failed",
      `The Provider B subscription is ${purchase.billingStatus}. Provider A is kept.`,
    );
  if (purchase.paymentStatus === "FAILED")
    return attention(
      "operation_failed",
      `${purchase.note ?? "The initial payment did not verify."} Provider A is kept.`,
    );
  if (purchase.paymentStatus !== "VERIFIED") return { state: "AWAITING_PAYPAL", reason: null, message: null };
  return null;
}

/**
 * Provider B readiness: activate the account, pass the subscribed-output check and verify the imported history, each
 * recorded as its own fact. A failed step is not repeated on every poll; an explicit retry runs it again.
 */
async function verifyReplacement(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  purchase: OperationRow,
  commit: Commit,
  retry: boolean,
): Promise<Failure | null> {
  const terms = transition.acceptedPurchaseTerms;
  const activation = await runLocalOperation(
    commit,
    caseRow,
    {
      transitionId: transition.id,
      kind: "activate_account",
      target: caseRow.replacementAccountId,
      merchant: "B",
      planId: terms.planId,
    },
    (tx) =>
      activateAccount(tx, caseRow.replacementAccountId, {
        planId: terms.planId,
        subscriptionId: purchase.remoteId!,
      }),
  );
  if (activation.operation.status !== "SUCCEEDED")
    return {
      reason: "operation_failed",
      message: `Provider B could not be activated: ${activation.operation.note}`,
    };

  const [current] = await ctx.db.select().from(transitions).where(eq(transitions.id, transition.id));
  if (current!.capabilityStatus === "FAILED" && !retry) return failedBefore(current!);
  if (current!.capabilityStatus !== "VERIFIED") {
    const failure = await verifyCapability(ctx, caseRow, current!, commit);
    if (failure) return failure;
  }
  if (current!.historyStatus === "FAILED" && !retry) return failedBefore(current!);
  if (current!.historyStatus !== "VERIFIED") return verifyHistory(ctx, caseRow, current!, commit);
  return null;
}

const failedBefore = (transition: TransitionRow): Failure => ({
  reason: "operation_failed",
  message: transition.lastError ?? "A verification step failed earlier; retry it to try again.",
});

/** Generates Provider B's output from the paid account and checks it against the policy the purchase was made under. */
async function verifyCapability(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  commit: Commit,
): Promise<Failure | null> {
  const current = await latestPolicy(ctx.db, caseRow.id);
  if (!current?.allowInvestigation)
    return {
      reason: "permission_required",
      message: "Provider B's output must be tested again, but sample testing is not currently permitted.",
    };
  const [accepted] = await ctx.db
    .select()
    .from(policies)
    .where(and(eq(policies.caseId, caseRow.id), eq(policies.revision, transition.acceptedPolicyRevision)));

  return commit(async (tx) => {
    const artifact = await generateSubscribedSample(tx, caseRow, caseRow.replacementAccountId);
    const results = checkSample(JSON.parse(artifact.content), benchmarkTurns, accepted!.requiredCapabilities);
    const failing = results.find((result) => !result.passes);
    const message = failing
      ? `Provider B's subscribed output failed (${failing.capability}: ${failing.reason}) Provider A is kept.`
      : null;
    await tx
      .update(transitions)
      .set({
        capabilityStatus: failing ? "FAILED" : "VERIFIED",
        capabilityEvidenceId: await evidenceIdForArtifact(tx, artifact.id),
        lastError: message,
      })
      .where(eq(transitions.id, transition.id));
    return failing ? { reason: "operation_failed" as const, message: message! } : null;
  });
}

/** Imports the verified backup into Provider B, then proves it from an independent re-read of Provider B's own content. */
async function verifyHistory(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  commit: Commit,
): Promise<Failure | null> {
  const terms = transition.acceptedPurchaseTerms;
  const [consent] = await ctx.db.select().from(consents).where(eq(consents.id, transition.consentId));
  const [preview] = await ctx.db.select().from(previews).where(eq(previews.id, consent!.previewId));
  const [backupEvidence] = await ctx.db
    .select()
    .from(evidence)
    .where(and(eq(evidence.id, preview!.backupEvidenceId), eq(evidence.advisory, false)));
  const [backupArtifact] = await ctx.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, backupEvidence!.artifactId!), eq(artifacts.advisory, false)));
  const operationKey = `${caseRow.id}:${transition.id}:import:${caseRow.replacementAccountId}`;

  const { operation } = await runLocalOperation(
    commit,
    caseRow,
    {
      transitionId: transition.id,
      kind: "import",
      target: caseRow.replacementAccountId,
      merchant: "B",
      planId: terms.planId,
    },
    async (tx) => {
      const imported = await importHistory(
        tx,
        caseRow,
        caseRow.replacementAccountId,
        operationKey,
        openBackup(backupArtifact!),
      );
      if (
        !imported.matchesSource ||
        imported.destinationManifest.manifestDigest !== terms.backupManifestDigest
      )
        throw new ProviderError("Provider B's content, read back, does not match the verified backup.");
      await tx
        .update(transitions)
        .set({ historyStatus: "VERIFIED", historyEvidenceId: imported.evidenceId, lastError: null })
        .where(eq(transitions.id, transition.id));
    },
  );
  if (operation.status === "SUCCEEDED") return null;

  const message = `The history import failed: ${operation.note} Provider B is paid and kept visible; Provider A is kept.`;
  await commit((tx) =>
    tx
      .update(transitions)
      .set({ historyStatus: "FAILED", lastError: message })
      .where(eq(transitions.id, transition.id)),
  );
  return { reason: "operation_failed", message };
}

async function capabilityEvidenceIsStale(ctx: AppContext, transition: TransitionRow): Promise<boolean> {
  const current = await loadEvidence(ctx.db, transition.capabilityEvidenceId!);
  return Date.now() - current.observedAt.getTime() > evidenceMaxAgeMs;
}

/**
 * Re-attempts failed or unknown work of the case under whatever authority still stands. A creation is replayed with its
 * stored request ID and body, never as a new subscription; every other step is retried by the next pass. Naming the
 * purchase itself while the transition needs attention re-runs its failed verification steps.
 */
export async function retryOperation(
  ctx: AppContext,
  caseRow: CaseRow,
  command: RetryCommand,
): Promise<AsyncCommandResult> {
  const [operation] = await ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.id, command.operationId), eq(operations.caseId, caseRow.id)));
  if (!operation) throw new HttpError(404, "operation_not_found", "No such operation on this case.");
  if (!retryableOperation(operation, (await openTransition(ctx.db, caseRow.id))?.state))
    throw new HttpError(
      409,
      "not_recoverable",
      "Only a failed or unknown purchase or transition step can be retried.",
    );
  if (operation.kind === "replacement_create") await dispatchCreation(ctx, operation);
  const job = await queueJob(ctx.db, caseRow.id, `retry:${operation.id}:${randomUUID()}`);
  return { jobId: job.id, caseId: caseRow.id };
}
