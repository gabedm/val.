import { randomUUID } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import type {
  ExitAuthorization,
  ExitAuthorizationCommand,
  ExitReview,
  ExitReviewCommand,
  ExitTerms,
  Money,
  Overlap,
  PauseExitsCommand,
} from "../shared/contracts";
import {
  latestPolicy,
  lockCaseAndTransition,
  moveTransition,
  openTransition,
  type TransitionRow,
} from "./cases";
import type { AppContext } from "./context";
import type { Database, Executor, Transaction } from "./db";
import {
  consents,
  exitAuthorizations,
  exitReviews,
  operations,
  providerAccounts,
  transitions,
} from "./db/schema";
import { HttpError } from "./http";
import type { Commit } from "./jobs";
import {
  claimOperation,
  runLocalOperation,
  sendCancellation,
  type CaseRow,
  type OperationRow,
} from "./operations";
import { associationProblem, describePlanMismatch, observeTransaction, parseMoney } from "./payment-evidence";
import { paypalFor } from "./paypal";
import { resolveSubscriptionPlan } from "./plans";
import { exitService, ProviderError, readTranscripts } from "./providers";
import { readOrNull, reconcileSubscription } from "./reconcile";
import { buildManifest, formatGbp, orderedExitTerms, reviewHashOf } from "./validation";

const reviewLifetimeMs = 5 * 60 * 1000;
const renewalLookbackMs = 5 * 60 * 1000;

type ExitStep = ExitTerms["remainingExits"][number];
type SetupOperation = { operation: OperationRow; paidThrough: Date };

const gbp = (amountMinor: number): Money => ({ currency: "GBP", amountMinor });

/** What the user pays now and what Provider A could still charge, for the date Provider A's current period ends. */
export function buildOverlap(input: {
  oldAmountMinor: number;
  boundary: Date;
  dueNowMinor: number;
}): Overlap {
  const ends = input.boundary.toISOString();
  return {
    oldPaidAmount: gbp(input.oldAmountMinor),
    oldPaidThrough: ends,
    newDueNow: gbp(input.dueNowMinor),
    possibleOldRenewal: gbp(input.oldAmountMinor),
    oldNextBillingTime: ends,
    explanation: `Provider A stays active until ${ends}. You pay ${formatGbp(input.dueNowMinor)} to Provider B now. If Provider A's billing were not stopped before ${ends}, it could charge ${formatGbp(input.oldAmountMinor)} again.`,
  };
}

/**
 * A fresh read of Provider A's billing. The paid-through boundary must equal the one saved from verified payment; if A
 * renewed since, the renewal's own COMPLETED transaction in the new period must be found, otherwise nothing is trusted.
 */
export async function readOldBilling(
  ctx: AppContext,
  setup: SetupOperation,
): Promise<{ status: string; boundary: Date; renewed: boolean }> {
  const client = paypalFor(ctx.paypal, "A");
  const plan = resolveSubscriptionPlan(ctx.planMapping, setup.operation.planId);
  const subscription = await readOrNull(() => client.getSubscription(setup.operation.remoteId!));
  const unverified = (why: string) =>
    new HttpError(409, "old_billing_unverified", `Provider A's billing could not be verified: ${why}`);
  if (!subscription) throw unverified("the subscription is not visible.");
  if (
    associationProblem(subscription, {
      subscriptionId: setup.operation.remoteId!,
      paypalPlanId: plan.paypalPlanId,
      customId: setup.operation.customId!,
    })
  )
    throw unverified("it does not match the stored operation.");
  if (subscription.status === "CANCELLED")
    return { status: "CANCELLED", boundary: setup.paidThrough, renewed: false };

  const observed = Date.parse(subscription.billing_info?.next_billing_time ?? "");
  if (Number.isNaN(observed) || observed < setup.paidThrough.getTime())
    throw unverified("the paid-through boundary is missing or earlier than the saved one.");
  if (observed === setup.paidThrough.getTime())
    return { status: subscription.status, boundary: setup.paidThrough, renewed: false };

  const renewals = await client.listTransactions(
    setup.operation.remoteId!,
    new Date(setup.paidThrough.getTime() - renewalLookbackMs),
    new Date(),
  );
  const renewalFound = renewals.map(observeTransaction).some((transaction) => {
    const paidAt = Date.parse(transaction.time ?? "");
    return (
      transaction.status === "COMPLETED" &&
      transaction.gross?.currency === "GBP" &&
      transaction.gross.amountMinor === plan.recurringMinor &&
      paidAt >= setup.paidThrough.getTime() &&
      paidAt < observed
    );
  });
  if (!renewalFound) throw unverified("the boundary moved but no matching renewal payment was found.");
  return { status: subscription.status, boundary: new Date(observed), renewed: true };
}

/** A verified renewal becomes the new saved boundary, so access never ends earlier than what was paid for. */
export async function saveRenewedBoundary(db: Database, caseRow: CaseRow, boundary: Date) {
  await db
    .update(providerAccounts)
    .set({ paidThrough: boundary })
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
}

export async function remainingExits(db: Database, transitionId: string): Promise<ExitStep[]> {
  const done = await db
    .select({ kind: operations.kind, status: operations.status })
    .from(operations)
    .where(eq(operations.transitionId, transitionId));
  const succeeded = (kind: string) =>
    done.some((operation) => operation.kind === kind && operation.status === "SUCCEEDED");
  return [
    ...(succeeded("cancel_old_billing") ? [] : ["old_billing" as const]),
    ...(succeeded("exit_old_service") ? [] : ["old_service" as const]),
  ];
}

/** The exit terms the user accepted with the purchase consent, once Provider B's subscription exists. */
function initialExitTerms(transition: TransitionRow, purchase: OperationRow): ExitTerms {
  const terms = transition.acceptedPurchaseTerms;
  return {
    newSubscriptionId: purchase.remoteId!,
    oldSubscriptionId: terms.oldSubscriptionId,
    effectiveRecurring: terms.recurring,
    oldAccessEndsAt: terms.oldAccessEndsAt,
    overlap: terms.overlap,
    ...(terms.offer ? { offer: terms.offer } : {}),
    ...(terms.comparison ? { comparison: terms.comparison } : {}),
    backupManifestDigest: terms.backupManifestDigest,
    importManifestDigest: terms.backupManifestDigest,
    remainingExits: ["old_billing", "old_service"],
  };
}

/** What an exit is authorized by: the authorization if one was made, otherwise the purchase consent. */
const authorityKeyOf = (transition: TransitionRow) => transition.exitAuthorizationId ?? transition.consentId;

interface ExitAuthority {
  key: string;
  accepted: ExitTerms;
  policyRevision: number;
}

/** The exits currently authorized, with the policy revision and terms they were authorized under; null when none are. */
async function exitAuthority(
  db: Executor,
  transition: TransitionRow,
  purchase: OperationRow,
): Promise<ExitAuthority | null> {
  const key = authorityKeyOf(transition);
  if (transition.exitsPausedAt) return null;
  if (transition.exitAuthorizationId) {
    const [authorization] = await db
      .select()
      .from(exitAuthorizations)
      .where(eq(exitAuthorizations.id, transition.exitAuthorizationId));
    if (!authorization || authorization.revokedAt || !authorization.approveRemainingExits) return null;
    const [review] = await db.select().from(exitReviews).where(eq(exitReviews.id, authorization.reviewId));
    return { key, accepted: review!.materialTerms, policyRevision: review!.policyRevision };
  }
  const [consent] = await db.select().from(consents).where(eq(consents.id, transition.consentId));
  if (consent!.revokedAt || !consent!.approveOldExitAfterReadiness) return null;
  return {
    key,
    accepted: initialExitTerms(transition, purchase),
    policyRevision: transition.acceptedPolicyRevision,
  };
}

interface Readiness {
  problems: string[];
  terms: ExitTerms | null;
  evidenceIds: string[];
  renewedBoundary: Date | null;
}

/**
 * Re-reads everything an exit depends on: Provider B's live subscription and effective price, the independent
 * statuses already verified, the imported history as it is now, and Provider A's billing boundary.
 */
async function assessReadiness(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  purchase: OperationRow,
  setup: SetupOperation,
): Promise<Readiness> {
  const accepted = transition.acceptedPurchaseTerms;
  const problems: string[] = [];
  const clientB = paypalFor(ctx.paypal, "B");
  const planB = resolveSubscriptionPlan(ctx.planMapping, purchase.planId);

  const subscription = await readOrNull(() => clientB.getSubscription(purchase.remoteId!));
  if (!subscription) problems.push("Provider B's subscription is not visible.");
  else if (
    associationProblem(subscription, {
      subscriptionId: purchase.remoteId!,
      paypalPlanId: planB.paypalPlanId,
      customId: purchase.customId!,
    })
  )
    problems.push("Provider B's subscription does not match the stored purchase.");
  else if (subscription.status !== "ACTIVE" || subscription.plan_overridden)
    problems.push(
      `Provider B's subscription is ${subscription.plan_overridden ? "on an overridden plan" : subscription.status}.`,
    );

  const planDetail = await clientB.getPlan(planB.paypalPlanId);
  const effectiveRecurring = parseMoney(
    planDetail.billing_cycles?.[accepted.offer ? 1 : 0]?.pricing_scheme?.fixed_price,
  );
  // The purchase-time plan predicate, applied to the live plan at its own price: the price is a term the user can
  // re-authorize, but status, interval, trial, tenure, fees and tax must still be the accepted monthly plan.
  const planProblem = effectiveRecurring
    ? describePlanMismatch(planDetail, effectiveRecurring.amountMinor, accepted.offer)
    : "its price cannot be read.";
  if (planProblem) problems.push(`Provider B's live plan is not the accepted monthly plan: ${planProblem}`);
  if (purchase.paymentStatus !== "VERIFIED") problems.push("Provider B's initial payment is not verified.");
  if (transition.capabilityStatus !== "VERIFIED")
    problems.push("Provider B's subscribed output has not passed.");
  if (transition.historyStatus !== "VERIFIED") problems.push("The imported history has not been verified.");

  let old: Awaited<ReturnType<typeof readOldBilling>> | null = null;
  try {
    old = await readOldBilling(ctx, setup);
    if (old.status !== "ACTIVE" && old.status !== "CANCELLED")
      problems.push(`Provider A's subscription is ${old.status}.`);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    problems.push(error.message);
  }
  // The history counts only while Provider B still holds exactly what was backed up, read now rather than remembered.
  const destination = buildManifest(await readTranscripts(ctx.db, caseRow.replacementAccountId));
  if (destination.manifestDigest !== accepted.backupManifestDigest)
    problems.push("Provider B's history no longer matches the verified backup.");
  if (problems.length > 0 || !old || effectiveRecurring?.currency !== "GBP")
    return { problems, terms: null, evidenceIds: [], renewedBoundary: null };

  const terms: ExitTerms = {
    newSubscriptionId: purchase.remoteId!,
    oldSubscriptionId: transition.oldSubscriptionId,
    effectiveRecurring: gbp(effectiveRecurring.amountMinor),
    oldAccessEndsAt: old.boundary.toISOString(),
    overlap: buildOverlap({
      oldAmountMinor: accepted.overlap.oldPaidAmount.amountMinor,
      boundary: old.boundary,
      dueNowMinor: accepted.dueNow.amountMinor,
    }),
    ...(accepted.offer ? { offer: accepted.offer } : {}),
    ...(accepted.comparison ? { comparison: accepted.comparison } : {}),
    backupManifestDigest: accepted.backupManifestDigest,
    importManifestDigest: destination.manifestDigest,
    remainingExits: await remainingExits(ctx.db, transition.id),
  };
  const evidenceIds = [
    purchase.resultEvidenceId,
    transition.capabilityEvidenceId,
    transition.historyEvidenceId,
  ].filter((id): id is string => id !== null);
  return { problems, terms, evidenceIds, renewedBoundary: old.renewed ? old.boundary : null };
}

/** Same material terms: only the list of remaining exits may shrink, and nothing new may appear. */
function sameMaterialTerms(accepted: ExitTerms, current: ExitTerms): boolean {
  const withoutRemaining = (terms: ExitTerms) =>
    JSON.stringify(orderedExitTerms({ ...terms, remainingExits: [] }));
  return (
    withoutRemaining(accepted) === withoutRemaining(current) &&
    current.remainingExits.every((step) => accepted.remainingExits.includes(step))
  );
}

async function loadSetup(ctx: AppContext, caseRow: CaseRow): Promise<SetupOperation> {
  const [operation] = await ctx.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.caseId, caseRow.id),
        eq(operations.kind, "setup_create"),
        eq(operations.probe, false),
      ),
    );
  const [account] = await ctx.db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
  return { operation: operation!, paidThrough: account!.paidThrough! };
}

async function loadPurchase(ctx: AppContext, transition: TransitionRow): Promise<OperationRow> {
  const [purchase] = await ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.transitionId, transition.id), eq(operations.kind, "replacement_create")));
  return purchase!;
}

async function ownedTransition(
  ctx: AppContext,
  caseRow: CaseRow,
  transitionId: string,
): Promise<TransitionRow> {
  const transition = await openTransition(ctx.db, caseRow.id);
  if (!transition || transition.id !== transitionId)
    throw new HttpError(404, "transition_not_found", "No open transition with that ID on this case.");
  return transition;
}

/** A five-minute review of the exits still to be done on an existing transition. It reads fresh facts and grants nothing. */
export async function createExitReview(
  ctx: AppContext,
  caseRow: CaseRow,
  command: ExitReviewCommand,
): Promise<ExitReview> {
  const transition = await ownedTransition(ctx, caseRow, command.transitionId);
  const policy = await latestPolicy(ctx.db, caseRow.id);
  if (!policy) throw new HttpError(409, "policy_required", "Confirm a policy first.");
  const readiness = await assessReadiness(
    ctx,
    caseRow,
    transition,
    await loadPurchase(ctx, transition),
    await loadSetup(ctx, caseRow),
  );
  if (!readiness.terms)
    throw new HttpError(
      409,
      "not_ready",
      `The remaining exits cannot be authorized yet: ${readiness.problems.join(" ")}`,
    );

  const { hashPayload, hash } = reviewHashOf({
    caseId: caseRow.id,
    ownerId: caseRow.ownerId,
    transitionId: transition.id,
    policyRevision: policy.revision,
    materialTerms: readiness.terms,
  });
  const createdAt = new Date();
  const [stored] = await ctx.db
    .insert(exitReviews)
    .values({
      id: randomUUID(),
      caseId: caseRow.id,
      ownerId: caseRow.ownerId,
      transitionId: transition.id,
      policyRevision: policy.revision,
      materialTerms: readiness.terms,
      readinessEvidenceIds: readiness.evidenceIds,
      hashPayload,
      reviewHash: hash,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + reviewLifetimeMs),
    })
    .returning();
  return {
    id: stored!.id,
    caseId: stored!.caseId,
    ownerId: stored!.ownerId,
    transitionId: stored!.transitionId,
    policyRevision: stored!.policyRevision,
    materialTerms: stored!.materialTerms,
    readinessEvidenceIds: stored!.readinessEvidenceIds,
    reviewHash: stored!.reviewHash,
    createdAt: stored!.createdAt.toISOString(),
    expiresAt: stored!.expiresAt.toISOString(),
  };
}

/**
 * Grants only the exits the review named, for this transition. It re-reads the facts first and refuses if anything
 * material moved since the review; readiness is checked again here, so authorization can never bypass it.
 */
export async function authorizeExits(
  ctx: AppContext,
  caseRow: CaseRow,
  session: { sessionId: string },
  command: ExitAuthorizationCommand,
): Promise<ExitAuthorization> {
  const [review] = await ctx.db
    .select()
    .from(exitReviews)
    .where(and(eq(exitReviews.id, command.reviewId), eq(exitReviews.caseId, caseRow.id)));
  if (!review || review.reviewHash !== command.reviewHash)
    throw new HttpError(404, "review_not_found", "No such exit review.");
  if (review.expiresAt.getTime() <= Date.now())
    throw new HttpError(409, "review_expired", "The exit review expired; request a new one.");
  const transition = await ownedTransition(ctx, caseRow, review.transitionId);
  const policy = await latestPolicy(ctx.db, caseRow.id);
  if (policy?.revision !== review.policyRevision)
    throw new HttpError(409, "terms_changed", "The policy changed since the review.");

  const readiness = await assessReadiness(
    ctx,
    caseRow,
    transition,
    await loadPurchase(ctx, transition),
    await loadSetup(ctx, caseRow),
  );
  if (!readiness.terms || !sameMaterialTerms(review.materialTerms, readiness.terms))
    throw new HttpError(409, "terms_changed", "The facts changed since the review; request a new one.");
  if (readiness.renewedBoundary) await saveRenewedBoundary(ctx.db, caseRow, readiness.renewedBoundary);

  return ctx.db.transaction(async (tx) => {
    // Facts were read above without a lock; what the review depends on locally is settled again under the shared locks.
    const locked = await lockCaseAndTransition(tx, caseRow.id);
    if (
      locked.transition?.id !== transition.id ||
      (await latestPolicy(tx, caseRow.id))?.revision !== review.policyRevision
    )
      throw new HttpError(409, "terms_changed", "The transition or policy changed since the review.");
    const [created] = await tx
      .insert(exitAuthorizations)
      .values({
        id: randomUUID(),
        caseId: caseRow.id,
        ownerId: caseRow.ownerId,
        sessionId: session.sessionId,
        transitionId: transition.id,
        reviewId: review.id,
        reviewHash: review.reviewHash,
        approveRemainingExits: command.approveRemainingExits,
      })
      .returning();
    await tx
      .update(exitAuthorizations)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(exitAuthorizations.transitionId, transition.id),
          isNull(exitAuthorizations.revokedAt),
          ne(exitAuthorizations.id, created!.id),
        ),
      );
    await tx
      .update(transitions)
      .set({
        exitAuthorizationId: created!.id,
        exitsPausedAt: null,
        acceptedPolicyRevision: review.policyRevision,
        updatedAt: new Date(),
      })
      .where(eq(transitions.id, transition.id));
    return {
      id: created!.id,
      caseId: created!.caseId,
      ownerId: created!.ownerId,
      sessionId: created!.sessionId,
      transitionId: created!.transitionId,
      reviewId: created!.reviewId,
      reviewHash: created!.reviewHash,
      approveRemainingExits: created!.approveRemainingExits,
      createdAt: created!.createdAt.toISOString(),
      consumedAt: null,
      revokedAt: null,
    };
  });
}

/** Stops further exit steps now. A write already sent stays sent; reconciliation of it continues. */
export async function pauseExits(ctx: AppContext, caseRow: CaseRow, command: PauseExitsCommand) {
  const transition = await ownedTransition(ctx, caseRow, command.transitionId);
  await ctx.db.transaction(async (tx) => {
    await lockCaseAndTransition(tx, caseRow.id);
    await tx
      .update(exitAuthorizations)
      .set({ revokedAt: new Date() })
      .where(and(eq(exitAuthorizations.transitionId, transition.id), isNull(exitAuthorizations.revokedAt)));
    await tx.update(transitions).set({ exitsPausedAt: new Date() }).where(eq(transitions.id, transition.id));
    await moveTransition(
      tx,
      transition,
      "ATTENTION_REQUIRED",
      "authority_changed",
      "Exits are paused. Review the remaining exits to continue.",
    );
  });
}

type ExitFailure = { reason: "authority_changed" | "operation_failed"; message: string };
type ExitGate = { ok: true; authority: ExitAuthority } | ({ ok: false } & ExitFailure);

/** Everything that must hold, judged from fresh reads, before an old-provider step is attempted. */
async function checkExitGate(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  purchase: OperationRow,
  setup: SetupOperation,
): Promise<ExitGate> {
  const authority = await exitAuthority(ctx.db, transition, purchase);
  if (!authority)
    return {
      ok: false,
      reason: "authority_changed",
      message: transition.exitsPausedAt
        ? "Exits are paused. Review the remaining exits to continue."
        : "No valid exit authority remains. Review the remaining exits to continue.",
    };
  const policy = await latestPolicy(ctx.db, caseRow.id);
  if (policy?.revision !== authority.policyRevision)
    return {
      ok: false,
      reason: "authority_changed",
      message: "The policy changed after the exits were authorized. Review the remaining exits to continue.",
    };

  const readiness = await assessReadiness(ctx, caseRow, transition, purchase, setup);
  if (!readiness.terms)
    return {
      ok: false,
      reason: "operation_failed",
      message: `Exit readiness failed: ${readiness.problems.join(" ")}`,
    };
  if (!sameMaterialTerms(authority.accepted, readiness.terms))
    return {
      ok: false,
      reason: "authority_changed",
      message:
        "Charges, access end, backup or imported history changed since the exits were authorized. Review the remaining exits to continue.",
    };
  return { ok: true, authority };
}

const authorityMovedOn: ExitFailure = {
  reason: "authority_changed",
  message:
    "Exits were paused or their authority changed while readiness was being checked. Nothing was sent. Review the remaining exits to continue.",
};

/**
 * The atomic dispatch boundary. The gate's reads happen over the network, so by the time a step is about to be sent the
 * authority they were judged against may have been paused, replaced or outdated by a policy change. This re-reads that
 * authority locally under the case and transition locks that pausing, authorizing and policy changes also take; only if
 * it still stands does it mark the exit under way and the authorization used. It runs inside the job's claimed commit,
 * so a worker whose claim lapsed cannot pass it. The write that follows is outside any lock: a pause arriving after
 * this commits finds the step already claimed, and a sent write cannot be recalled.
 */
async function openDispatchBoundary(
  tx: Transaction,
  transition: TransitionRow,
  purchase: OperationRow,
  judged: ExitAuthority,
): Promise<boolean> {
  const locked = await lockCaseAndTransition(tx, transition.caseId);
  if (locked.transition?.id !== transition.id) return false;
  const current = await exitAuthority(tx, locked.transition, purchase);
  const policy = await latestPolicy(tx, transition.caseId);
  if (
    !current ||
    current.key !== judged.key ||
    policy?.revision !== current.policyRevision ||
    current.policyRevision !== judged.policyRevision
  )
    return false;

  if (locked.transition.exitAuthorizationId) {
    await tx
      .update(exitAuthorizations)
      .set({ consumedAt: new Date() })
      .where(
        and(
          eq(exitAuthorizations.id, locked.transition.exitAuthorizationId),
          isNull(exitAuthorizations.consumedAt),
        ),
      );
  }
  await moveTransition(tx, locked.transition, "EXITING_OLD");
  return true;
}

const stopForAttention = (commit: Commit, transition: TransitionRow, failure: ExitFailure) =>
  commit((tx) => moveTransition(tx, transition, "ATTENTION_REQUIRED", failure.reason, failure.message));

/**
 * Takes the exits in order. Before each one the transition is read again, never the pass's first read, readiness and
 * authority are judged from fresh reads, and the dispatch boundary confirms them once more just before sending.
 * Billing must read CANCELLED from a fresh PayPal read before the service exit is even considered.
 */
export async function runExits(ctx: AppContext, caseRow: CaseRow, started: TransitionRow, commit: Commit) {
  const purchase = await loadPurchase(ctx, started);
  for (;;) {
    const [transition] = await ctx.db.select().from(transitions).where(eq(transitions.id, started.id));
    if (transition!.closedAt) return;
    const [next] = await remainingExits(ctx.db, transition!.id);
    if (!next) {
      await commit((tx) => moveTransition(tx, transition!, "COMPLETE"));
      return;
    }
    const setup = await loadSetup(ctx, caseRow);
    const gate = await checkExitGate(ctx, caseRow, transition!, purchase, setup);
    if (!gate.ok) return stopForAttention(commit, transition!, gate);

    const failure =
      next === "old_billing"
        ? await cancelOldBilling(ctx, caseRow, transition!, purchase, setup, gate.authority, commit)
        : await scheduleServiceExit(caseRow, transition!, purchase, setup, gate.authority, commit);
    if (failure) return stopForAttention(commit, transition!, failure);
  }
}

/** Stops Provider A's recurring billing. It counts only when a fresh PayPal read says CANCELLED, whatever the write returned. */
async function cancelOldBilling(
  ctx: AppContext,
  caseRow: CaseRow,
  transition: TransitionRow,
  purchase: OperationRow,
  setup: SetupOperation,
  judged: ExitAuthority,
  commit: Commit,
): Promise<ExitFailure | null> {
  const operationKey = `${caseRow.id}:${transition.id}:cancel_old_billing:${transition.oldSubscriptionId}`;
  await commit((tx) =>
    tx
      .insert(operations)
      .values({
        id: randomUUID(),
        caseId: caseRow.id,
        ownerId: caseRow.ownerId,
        transitionId: transition.id,
        kind: "cancel_old_billing",
        operationKey,
        targetId: transition.oldSubscriptionId,
        status: "PLANNED",
        remoteId: transition.oldSubscriptionId,
        merchant: "A",
        planId: setup.operation.planId,
        customId: setup.operation.customId,
      })
      .onConflictDoNothing({ target: operations.operationKey }),
  );
  const [operation] = await ctx.db.select().from(operations).where(eq(operations.operationKey, operationKey));
  if (operation!.status === "SUCCEEDED") return null;

  // A cancellation that timed out earlier is settled by looking, before deciding whether to ask again.
  const current = await readOrNull(() =>
    paypalFor(ctx.paypal, "A").getSubscription(transition.oldSubscriptionId),
  );
  if (current?.status === "ACTIVE" || current?.status === "SUSPENDED") {
    const claim = await commit(async (tx) =>
      (await openDispatchBoundary(tx, transition, purchase, judged))
        ? { claimed: await claimOperation(tx, operation!.id) }
        : null,
    );
    if (!claim) return authorityMovedOn;
    if (claim.claimed)
      await sendCancellation(
        ctx,
        claim.claimed,
        transition.oldSubscriptionId,
        "Val completed the authorized switch to Provider B.",
      );
  }
  const billingStatus = await reconcileSubscription(ctx, setup.operation, commit);
  if (billingStatus !== "CANCELLED")
    return {
      reason: "operation_failed",
      message: "Provider A's billing is not confirmed cancelled. Provider A's service is untouched.",
    };
  await commit((tx) =>
    tx
      .update(operations)
      .set({ status: "SUCCEEDED", leaseExpiresAt: null, note: null, updatedAt: new Date() })
      .where(eq(operations.id, operation!.id)),
  );
  return null;
}

/** Schedules the end of Provider A's service at the saved paid-through boundary; access continues until then. */
async function scheduleServiceExit(
  caseRow: CaseRow,
  transition: TransitionRow,
  purchase: OperationRow,
  setup: SetupOperation,
  judged: ExitAuthority,
  commit: Commit,
): Promise<ExitFailure | null> {
  const key = `${caseRow.id}:${transition.id}:exit_old_service:${caseRow.initialAccountId}`;
  const { operation, refused } = await runLocalOperation(
    commit,
    caseRow,
    {
      transitionId: transition.id,
      kind: "exit_old_service",
      target: caseRow.initialAccountId,
      merchant: "A",
      planId: setup.operation.planId,
    },
    async (tx) => {
      const exit = await exitService(tx, caseRow, caseRow.initialAccountId, key, setup.paidThrough);
      if (exit.accessEndsAt !== setup.paidThrough.toISOString())
        throw new ProviderError("The scheduled access end differs from the saved paid-through boundary.");
    },
    (tx) => openDispatchBoundary(tx, transition, purchase, judged),
  );
  if (refused) return authorityMovedOn;
  if (operation.status === "SUCCEEDED") return null;
  return {
    reason: "operation_failed",
    message: `Provider A's billing is stopped, but its service exit failed: ${operation.note}. Retry the service exit; billing will not be restored.`,
  };
}
