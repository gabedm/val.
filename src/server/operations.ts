import { randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { ApprovalResult, AsyncCommandResult, Operation, ReturnCommand } from "../shared/contracts";
import { keyedHash, newToken } from "./auth";
import type { AppContext } from "./context";
import type { Database, Executor, Transaction } from "./db";
import { cases, jobs, operationObservations, operations } from "./db/schema";
import { HttpError, safeEqual } from "./http";
import { queueJob, type Commit } from "./jobs";
import { recordEvidence } from "./evidence";
import { associationProblem, billingStatusOf } from "./payment-evidence";
import { approvalLink, PaypalApiError, paypalFor, type PaypalSubscription } from "./paypal";
import { resolveSubscriptionPlan } from "./plans";
import { ProviderError } from "./providers";
import { readOrNull, reconcileSubscription } from "./reconcile";

export type CaseRow = typeof cases.$inferSelect;
export type OperationRow = typeof operations.$inferSelect;
export function retryableOperation(operation: OperationRow, transitionState?: string | null): boolean {
  const kinds = [
    "replacement_create",
    "activate_account",
    "import",
    "cancel_old_billing",
    "exit_old_service",
  ];
  return (
    kinds.includes(operation.kind) &&
    (["FAILED", "UNKNOWN"].includes(operation.status) ||
      (operation.kind === "replacement_create" && transitionState === "ATTENTION_REQUIRED"))
  );
}
type CreationKind = "setup_create" | "replacement_create";

const leaseMs = 120_000;
/** PayPal remembers a PayPal-Request-Id for 72 hours; past that, a replay could create a second subscription. */
const requestIdRetentionMs = 72 * 60 * 60 * 1000;
const returnRoutes: Record<CreationKind, string> = {
  setup_create: "/paypal/setup",
  replacement_create: "/paypal/transition",
};

export function toOperation(row: OperationRow): Operation {
  return {
    id: row.id,
    caseId: row.caseId,
    transitionId: row.transitionId,
    kind: row.kind,
    operationKey: row.operationKey,
    targetId: row.targetId,
    status: row.status,
    claimGeneration: row.claimGeneration,
    requestId: row.requestId,
    remoteId: row.remoteId,
    attempts: row.attempts,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    resultEvidenceId: row.resultEvidenceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function loadOperation(db: Database, id: string): Promise<OperationRow> {
  const [row] = await db.select().from(operations).where(eq(operations.id, id));
  return row!;
}

/**
 * Persists the immutable request before anything is sent. The operation key makes
 * "one subscription per case, scope and plan" a database fact; a repeat returns the existing row.
 * `probe` marks disposable test resources that probe_cancel may later cancel.
 */
export async function planSubscription(
  ctx: AppContext,
  input: {
    caseRow: CaseRow;
    kind: CreationKind;
    planId: string;
    probe: boolean;
    transition?: { id: string; authorityHash: string };
  },
  db: Executor = ctx.db,
): Promise<OperationRow> {
  const { caseRow, kind, planId, probe, transition } = input;
  const plan = resolveSubscriptionPlan(ctx.planMapping, planId);
  paypalFor(ctx.paypal, plan.merchant);

  const id = randomUUID();
  const returnToken = newToken();
  const returnQuery = new URLSearchParams({ caseId: caseRow.id, operationId: id, return_token: returnToken });
  const returnBase = `${ctx.config.appOrigin}${returnRoutes[kind]}`;
  // The stored body carries the return token because an identical replay must resend it; the operation row keeps only its hash.
  const requestBody = JSON.stringify({
    plan_id: plan.paypalPlanId,
    custom_id: `${caseRow.id}.${id}`,
    application_context: {
      brand_name: "Val",
      locale: "en-GB",
      shipping_preference: "NO_SHIPPING",
      user_action: "SUBSCRIBE_NOW",
      return_url: `${returnBase}/return?${returnQuery}`,
      cancel_url: `${returnBase}/cancel?${returnQuery}`,
    },
  });

  const operationKey = `${caseRow.id}:${probe ? "probe" : (transition?.id ?? "setup")}:${kind}:${planId}`;
  const [created] = await db
    .insert(operations)
    .values({
      id,
      caseId: caseRow.id,
      ownerId: caseRow.ownerId,
      transitionId: transition?.id,
      kind,
      operationKey,
      targetId: planId,
      status: "PLANNED",
      requestId: randomUUID(),
      requestBody,
      authorityHash: transition?.authorityHash,
      returnTokenHash: keyedHash(ctx.config, returnToken),
      merchant: plan.merchant,
      planId,
      customId: `${caseRow.id}.${id}`,
      probe,
    })
    .onConflictDoNothing({ target: operations.operationKey })
    .returning();
  if (created) return created;

  const [existing] = await db.select().from(operations).where(eq(operations.operationKey, operationKey));
  return existing!;
}

/**
 * Takes the exclusive right to send an operation: a new one, or one whose previous sender's lease has lapsed.
 * Returns null when another sender holds it or it has already succeeded.
 */
export async function claimOperation(db: Executor, operationId: string): Promise<OperationRow | null> {
  const now = new Date();
  const [claimed] = await db
    .update(operations)
    .set({
      status: "IN_FLIGHT",
      claimGeneration: sql`${operations.claimGeneration} + 1`,
      claimOwner: randomUUID(),
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      attempts: sql`${operations.attempts} + 1`,
      dispatchedAt: sql`coalesce(${operations.dispatchedAt}, ${now})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(operations.id, operationId),
        or(
          eq(operations.status, "PLANNED"),
          and(
            inArray(operations.status, ["IN_FLIGHT", "UNKNOWN", "FAILED"]),
            or(isNull(operations.leaseExpiresAt), lt(operations.leaseExpiresAt, now)),
          ),
        ),
      ),
    )
    .returning();
  return claimed ?? null;
}

/** Writes the outcome only if this sender still holds the current claim; a stale sender's late result stays an observation. */
export async function settleOperation(
  db: Database,
  claimed: OperationRow,
  outcome: Partial<typeof operations.$inferInsert>,
) {
  await db
    .update(operations)
    .set({ ...outcome, leaseExpiresAt: null, updatedAt: new Date() })
    .where(and(eq(operations.id, claimed.id), eq(operations.claimGeneration, claimed.claimGeneration)));
}

export async function observe(db: Database, claimed: OperationRow, httpStatus: number | null, body: unknown) {
  await db.insert(operationObservations).values({
    id: randomUUID(),
    operationId: claimed.id,
    claimGeneration: claimed.claimGeneration,
    httpStatus,
    body,
  });
}

/**
 * Sends the stored creation request. A retry after a timeout or crash reuses the identical body and
 * PayPal-Request-Id inside PayPal's retention window; outside it the operation stays UNKNOWN for manual investigation.
 */
export async function dispatchCreation(ctx: AppContext, operation: OperationRow): Promise<OperationRow> {
  const replayExpired =
    operation.dispatchedAt && Date.now() - operation.dispatchedAt.getTime() > requestIdRetentionMs;
  if (operation.remoteId || replayExpired) return operation;
  const claimed = await claimOperation(ctx.db, operation.id);
  if (!claimed) return loadOperation(ctx.db, operation.id);

  let subscription: PaypalSubscription;
  try {
    subscription = await paypalFor(ctx.paypal, claimed.merchant).createSubscription(
      JSON.parse(claimed.requestBody!),
      claimed.requestId!,
    );
  } catch (error) {
    const rejected = error instanceof PaypalApiError && error.httpStatus < 500;
    await observe(ctx.db, claimed, error instanceof PaypalApiError ? error.httpStatus : null, {
      error:
        error instanceof PaypalApiError
          ? error.responseName
          : error instanceof Error
            ? error.name
            : "unknown",
    });
    await settleOperation(ctx.db, claimed, {
      status: rejected ? "FAILED" : "UNKNOWN",
      note: error instanceof Error ? error.message : null,
    });
    return loadOperation(ctx.db, operation.id);
  }

  await observe(ctx.db, claimed, 201, {
    id: subscription.id,
    status: subscription.status,
    planId: subscription.plan_id,
  });
  if (!subscription.id) {
    await settleOperation(ctx.db, claimed, {
      status: "UNKNOWN",
      note: "PayPal returned no subscription ID; reconcile before any retry.",
    });
  } else {
    await settleOperation(ctx.db, claimed, {
      status: "SUCCEEDED",
      remoteId: subscription.id,
      approvalUrl: approvalLink(subscription),
      billingStatus: billingStatusOf(subscription.status),
    });
  }
  return loadOperation(ctx.db, operation.id);
}

/** Creates (or reuses) the single subscription for a case's scope and returns where the buyer approves it. */
export async function startSubscription(
  ctx: AppContext,
  input: Parameters<typeof planSubscription>[1],
): Promise<ApprovalResult | AsyncCommandResult> {
  return approvalOrJob(ctx, await dispatchCreation(ctx, await planSubscription(ctx, input)));
}

/** Where the buyer approves a created subscription, or the reconciliation job that will find out what happened. */
export async function approvalOrJob(
  ctx: AppContext,
  operation: OperationRow,
): Promise<ApprovalResult | AsyncCommandResult> {
  if (operation.billingStatus === "CANCELLED" || operation.billingStatus === "EXPIRED") {
    throw new HttpError(
      409,
      "subscription_closed",
      "This subscription was cancelled or expired before approval; start a fresh demo case.",
    );
  }
  if (operation.remoteId && operation.approvalUrl && operation.billingStatus === "APPROVAL_PENDING") {
    return {
      operationId: operation.id,
      subscriptionId: operation.remoteId,
      approvalUrl: operation.approvalUrl,
    };
  }
  const job = await queueJob(
    ctx.db,
    operation.caseId,
    operation.remoteId ? `reconcile:${operation.id}:${operation.billingStatus}` : `create:${operation.id}`,
  );
  return { jobId: job.id, caseId: operation.caseId };
}

/**
 * Validates a PayPal return and queues reconciliation. The return itself proves nothing: it only
 * names an operation, which must belong to this owner's case and carry the issued token.
 * A repeated return maps to the same job.
 */
export async function acceptReturn(
  ctx: AppContext,
  input: { caseRow: CaseRow; kind: CreationKind; command: ReturnCommand },
): Promise<AsyncCommandResult> {
  const { caseRow, kind, command } = input;
  const [operation] = await ctx.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.id, command.operationId),
        eq(operations.caseId, caseRow.id),
        eq(operations.kind, kind),
      ),
    );
  if (!operation)
    throw new HttpError(404, "operation_not_found", "No matching PayPal operation for this case.");
  if (
    !operation.returnTokenHash ||
    !safeEqual(keyedHash(ctx.config, command.returnToken), operation.returnTokenHash)
  ) {
    throw new HttpError(403, "return_token_mismatch", "The return token does not match this operation.");
  }
  if (command.subscriptionId && operation.remoteId && command.subscriptionId !== operation.remoteId) {
    throw new HttpError(
      409,
      "subscription_mismatch",
      "The returned subscription is not the one created for this operation.",
    );
  }
  const job = await queueJob(ctx.db, caseRow.id, `return:${operation.id}:${command.outcome}`);
  return { jobId: job.id, caseId: caseRow.id };
}

/**
 * Administrator test cancellation is limited to a resource that the
 * explicit probe created. Billing counts as stopped only when a fresh read shows CANCELLED.
 */
export async function cancelProbeSubscription(
  ctx: AppContext,
  input: { ownerId: string; operationId: string },
): Promise<OperationRow> {
  const [target] = await ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.id, input.operationId), eq(operations.ownerId, input.ownerId)));
  if (!target?.probe || !target.remoteId)
    throw new HttpError(404, "probe_not_found", "No probe subscription with that ID.");

  const client = paypalFor(ctx.paypal, target.merchant);
  const plan = resolveSubscriptionPlan(ctx.planMapping, target.planId);
  const expected = {
    subscriptionId: target.remoteId,
    paypalPlanId: plan.paypalPlanId,
    customId: target.customId!,
  };
  const current = await client.getSubscription(target.remoteId);
  if (associationProblem(current, expected))
    throw new HttpError(
      409,
      "association_mismatch",
      "The remote subscription does not match the probe operation.",
    );
  if (!["ACTIVE", "SUSPENDED", "CANCELLED"].includes(current.status))
    throw new HttpError(409, "not_cancellable", `The probe subscription is ${current.status}.`);

  const operationKey = `${target.caseId}:probe:probe_cancel:${target.id}`;
  await ctx.db
    .insert(operations)
    .values({
      id: randomUUID(),
      caseId: target.caseId,
      ownerId: target.ownerId,
      kind: "probe_cancel",
      operationKey,
      targetId: target.remoteId,
      status: "PLANNED",
      merchant: target.merchant,
      planId: target.planId,
      customId: target.customId,
      probe: true,
    })
    .onConflictDoNothing({ target: operations.operationKey });
  const [cancelOperation] = await ctx.db
    .select()
    .from(operations)
    .where(eq(operations.operationKey, operationKey));

  if (current.status !== "CANCELLED") {
    const claimed = await claimOperation(ctx.db, cancelOperation!.id);
    if (claimed)
      await sendCancellation(ctx, claimed, target.remoteId, "Explicit Val sandbox probe cancellation.");
  }

  const billingStatus = await reconcileSubscription(ctx, target, (write) => ctx.db.transaction(write));
  await ctx.db
    .update(operations)
    .set({
      status: billingStatus === "CANCELLED" ? "SUCCEEDED" : "UNKNOWN",
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(eq(operations.id, cancelOperation!.id));
  return loadOperation(ctx.db, cancelOperation!.id);
}

export async function sendCancellation(
  ctx: AppContext,
  claimed: OperationRow,
  subscriptionId: string,
  reason: string,
) {
  try {
    await paypalFor(ctx.paypal, claimed.merchant).cancelSubscription(subscriptionId, reason);
    await observe(ctx.db, claimed, 204, { requested: "cancel" });
  } catch (error) {
    await observe(ctx.db, claimed, error instanceof PaypalApiError ? error.httpStatus : null, {
      error: error instanceof Error ? error.name : "unknown",
    });
    await settleOperation(ctx.db, claimed, {
      status: "UNKNOWN",
      note: error instanceof Error ? error.message : null,
    });
  }
}

/**
 * One reconciliation pass for a case: finish or replay unresolved creations, then re-read every
 * created subscription. It never creates anything new and needs no LLM or consent.
 */
export async function reconcileCase(ctx: AppContext, caseId: string, commit: Commit) {
  const creations = await ctx.db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.caseId, caseId),
        inArray(operations.kind, ["setup_create", "replacement_create"]),
        isNull(operations.retiredAt),
      ),
    );
  for (const operation of creations) {
    if (operation.remoteId) await reconcileSubscription(ctx, operation, commit);
    else if (operation.status !== "FAILED") await dispatchCreation(ctx, operation);
  }
}

/**
 * Runs a provider-local change (backup, import, activation, service exit) exactly once for its operation key. It
 * executes in a savepoint inside the caller's claimed commit: a refused change leaves no partial writes, an operation
 * that already succeeded is never repeated, and a worker whose claim lapsed cannot commit it. An optional guard runs in
 * the same transaction just before the change; when it declines, nothing is attempted and `refused` is true.
 */
export async function runLocalOperation<T>(
  commit: Commit,
  caseRow: CaseRow,
  spec: {
    transitionId: string;
    kind: Operation["kind"];
    target: string;
    merchant: "A" | "B";
    planId: string;
  },
  work: (tx: Transaction) => Promise<T>,
  guard: (tx: Transaction) => Promise<boolean> = async () => true,
): Promise<{ operation: OperationRow; result: T | null; refused: boolean }> {
  const operationKey = `${caseRow.id}:${spec.transitionId}:${spec.kind}:${spec.target}`;
  return commit(async (tx) => {
    await tx
      .insert(operations)
      .values({
        id: randomUUID(),
        caseId: caseRow.id,
        ownerId: caseRow.ownerId,
        transitionId: spec.transitionId,
        kind: spec.kind,
        operationKey,
        targetId: spec.target,
        status: "PLANNED",
        merchant: spec.merchant,
        planId: spec.planId,
      })
      .onConflictDoNothing({ target: operations.operationKey });
    const [row] = await tx
      .select()
      .from(operations)
      .where(eq(operations.operationKey, operationKey))
      .for("update");
    if (row!.status === "SUCCEEDED") return { operation: row!, result: null, refused: false };
    if (!(await guard(tx))) return { operation: row!, result: null, refused: true };

    const attempt = {
      attempts: row!.attempts + 1,
      claimGeneration: row!.claimGeneration + 1,
      updatedAt: new Date(),
    };
    try {
      const result = await tx.transaction(work);
      const [done] = await tx
        .update(operations)
        .set({ ...attempt, status: "SUCCEEDED", note: null })
        .where(eq(operations.id, row!.id))
        .returning();
      return { operation: done!, result, refused: false };
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const [failed] = await tx
        .update(operations)
        .set({ ...attempt, status: "FAILED", note: error.message })
        .where(eq(operations.id, row!.id))
        .returning();
      return { operation: failed!, result: null, refused: false };
    }
  });
}

/**
 * Administrator cleanup of an orphaned PayPal resource. It never cancels anything: it only records that a resource of an
 * archived case was observed CANCELLED or EXPIRED, and only while no job or write could still be acting on it. Receipts,
 * evidence and any existing transition are left exactly as they were.
 */
export async function retireTerminalOperation(
  ctx: AppContext,
  input: { operationId: string; expectedClaimGeneration: number },
): Promise<AsyncCommandResult> {
  const [target] = await ctx.db.select().from(operations).where(eq(operations.id, input.operationId));
  if (!target || !target.remoteId || (target.kind !== "setup_create" && target.kind !== "replacement_create"))
    throw new HttpError(404, "operation_not_found", "No such PayPal resource operation.");
  const [owningCase] = await ctx.db.select().from(cases).where(eq(cases.id, target.caseId));
  if (!owningCase!.archivedAt)
    throw new HttpError(409, "not_archived", "Only resources of archived cases can be retired.");

  const remote = await readOrNull(() =>
    paypalFor(ctx.paypal, target.merchant).getSubscription(target.remoteId!),
  );
  if (remote?.status !== "CANCELLED" && remote?.status !== "EXPIRED") {
    throw new HttpError(
      409,
      "not_terminal",
      `The PayPal resource is ${remote?.status ?? "not visible"}; only an observed CANCELLED or EXPIRED resource can be retired.`,
    );
  }

  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(operations).where(eq(operations.id, target.id)).for("update");
    const [busy] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.caseId, target.caseId), inArray(jobs.status, ["QUEUED", "RUNNING"])));
    if (
      locked!.claimGeneration !== input.expectedClaimGeneration ||
      ["PLANNED", "IN_FLIGHT"].includes(locked!.status)
    )
      throw new HttpError(409, "stale_claim", "The operation changed since it was listed.");
    if (busy) throw new HttpError(409, "job_active", "A job is still working on this case.");
    if (locked!.retiredAt) return;

    const cleanupKey = `${target.caseId}:cleanup:cleanup:${target.id}`;
    await tx
      .insert(operations)
      .values({
        id: randomUUID(),
        caseId: target.caseId,
        ownerId: target.ownerId,
        kind: "cleanup",
        operationKey: cleanupKey,
        targetId: target.id,
        status: "SUCCEEDED",
        merchant: target.merchant,
        planId: target.planId,
      })
      .onConflictDoNothing({ target: operations.operationKey });
    await recordEvidence(tx, {
      caseId: target.caseId,
      kind: "subscription",
      operationId: target.id,
      summary: `PayPal subscription ${target.remoteId} was observed ${remote.status} and retired from the unresolved list.`,
    });
    await tx.update(operations).set({ retiredAt: new Date() }).where(eq(operations.id, target.id));
  });
  const job = await queueJob(ctx.db, target.caseId, `cleanup:${target.id}`);
  return { jobId: job.id, caseId: target.caseId };
}
