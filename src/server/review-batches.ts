import { randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import { queueInitialReviews } from "./review-queue";
import type { AppContext } from "./context";
import { ownerReviewBatches, ownerSubscriptions, ownerSubscriptionReviews, owners } from "./db/schema";
import { requireLogin } from "./auth";
import { requireCurrentComparisonView } from "./comparison-view";
import { HttpError } from "./http";
import { subscriptionAdviceService } from "./subscription-advice";
import { currentWorker } from "./worker-deployment";
import { comparisonLeaseMs } from "./research-limits";
import { comparisonOutcome } from "../shared/subscription-insights";

type Batch = typeof ownerReviewBatches.$inferSelect;
function view(batch: Batch) {
  return {
    revision: batch.revision,
    serviceIds: batch.serviceIds,
    completed: batch.completed,
    failed: batch.failed,
    status: batch.status,
    currentServiceId: batch.currentServiceId,
    pauseReason: batch.pauseReason,
  };
}

export function reviewBatchRoutes(ctx: AppContext, catalogue: CatalogueResponse["catalogue"]) {
  const router = Router();
  router.post("/subscriptions/review-batch", async (req, res) => {
    const { ownerId } = requireLogin(res);
    requireCurrentComparisonView(req.get("X-Val-Advice-Format"));
    if (!ctx.model)
      throw new HttpError(
        503,
        "model_unavailable",
        "Val's research service is unavailable. Your saved needs are safe.",
      );
    const body = req.body;
    if (
      !body ||
      !Number.isSafeInteger(body.expectedRevision) ||
      (body.retry !== undefined && typeof body.retry !== "boolean") ||
      Object.keys(body).some((key) => !["expectedRevision", "retry"].includes(key))
    )
      throw new HttpError(400, "invalid_request", "Choose your current subscriptions.");
    // Read before locking so concurrent visitors never hold one pool connection
    // while waiting for another. The transaction checks the portfolio revision.
    const saved = await subscriptionAdviceService(ctx, catalogue).savedAdvice(
      ownerId,
      body.expectedRevision,
      undefined,
      true,
    );
    const batch = await ctx.db.transaction(async (tx) => {
      await tx.select().from(owners).where(eq(owners.id, ownerId)).for("update");
      const [portfolio] = await tx
        .select()
        .from(ownerSubscriptions)
        .where(eq(ownerSubscriptions.ownerId, ownerId));
      if (!portfolio || portfolio.revision !== body.expectedRevision)
        throw new HttpError(
          409,
          "subscriptions_changed",
          "Your subscriptions changed. Reload before comparing.",
        );
      // A previous success counts only while its model version and saved needs
      // still match. Historical prices may be displayed, but retired results may not.
      return queueInitialReviews(
        tx,
        ownerId,
        portfolio,
        catalogue.services,
        body.retry,
        new Set(
          [...saved]
            .filter(([, result]) => !body.retry || comparisonOutcome(result.advice) !== "incomplete")
            .map(([id]) => id),
        ),
      );
    });
    res.json(view(batch));
  });
  router.get("/subscriptions/review-batch", async (req, res) => {
    const { ownerId } = requireLogin(res);
    requireCurrentComparisonView(req.get("X-Val-Advice-Format"));
    if (typeof req.query.revision !== "string" || !/^\d+$/.test(req.query.revision))
      throw new HttpError(400, "invalid_request", "Choose your current subscriptions.");
    const [batch] = await ctx.db
      .select()
      .from(ownerReviewBatches)
      .where(eq(ownerReviewBatches.ownerId, ownerId));
    if (!batch || batch.revision !== Number(req.query.revision))
      throw new HttpError(
        409,
        "subscriptions_changed",
        "Your comparison has changed. Reload your subscriptions.",
      );
    res.json(view(batch));
  });
  return router;
}

/** One item per claim. Saved advice closes the commit/restart gap without another paid request. */
export async function runReviewBatch(
  ctx: AppContext,
  catalogue: CatalogueResponse["catalogue"],
  now = new Date(),
) {
  if (!ctx.model) return false;
  const claim = await ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return null;
    const [row] = await tx
      .select()
      .from(ownerReviewBatches)
      .where(
        sql`(${ownerReviewBatches.status} in ('queued','running') or (${ownerReviewBatches.status} = 'paused' and ${ownerReviewBatches.pauseReason} = 'budget'))
      and ${ownerReviewBatches.nextAttemptAt} <= ${now}
      and (${ownerReviewBatches.leaseUntil} is null or ${ownerReviewBatches.leaseUntil} <= ${now})`,
      )
      .orderBy(ownerReviewBatches.nextAttemptAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    const token = randomUUID();
    const partialResearch = new Set(
      (
        await tx
          .selectDistinctOn([ownerSubscriptionReviews.serviceId], {
            serviceId: ownerSubscriptionReviews.serviceId,
            pending: sql<unknown>`${ownerSubscriptionReviews.result}->'advice'->'discovery'->'pendingProviders'`,
          })
          .from(ownerSubscriptionReviews)
          .where(
            and(
              eq(ownerSubscriptionReviews.ownerId, row.ownerId),
              eq(ownerSubscriptionReviews.portfolioRevision, row.revision),
              sql`jsonb_typeof(${ownerSubscriptionReviews.result}->'advice') = 'object'`,
            ),
          )
          .orderBy(ownerSubscriptionReviews.serviceId, desc(ownerSubscriptionReviews.createdAt))
      )
        .filter((review) => Array.isArray(review.pending) && review.pending.length > 0)
        .map((review) => review.serviceId),
    );
    const serviceId = row.serviceIds
      .filter((id) => !row.completed.includes(id) && !row.failed.includes(id))
      .sort(
        (a, b) =>
          (row.attempts[a] ?? 0) +
          Number(partialResearch.has(a)) -
          (row.attempts[b] ?? 0) -
          Number(partialResearch.has(b)),
      )[0];
    await tx
      .update(ownerReviewBatches)
      .set({
        status: "running",
        pauseReason: null,
        currentServiceId: serviceId ?? null,
        leaseToken: token,
        leaseUntil: new Date(now.getTime() + comparisonLeaseMs),
      })
      .where(eq(ownerReviewBatches.ownerId, row.ownerId));
    return { ...row, token, serviceId };
  });
  if (!claim) return false;
  let status: Batch["status"] = "queued";
  let pauseReason: Batch["pauseReason"] = null;
  let nextAttemptAt = now;
  let completed = [...claim.completed];
  let completionVerified = false;
  const failed = [...claim.failed],
    attempts = { ...claim.attempts };
  try {
    const [portfolio] = await ctx.db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, claim.ownerId));
    if (!portfolio || portfolio.revision !== claim.revision) status = "superseded";
    else {
      const advice = subscriptionAdviceService(ctx, catalogue);
      const saved = await advice.savedAdvice(claim.ownerId, claim.revision, undefined, true);
      completed = completed.filter((id) => saved.has(id));
      completionVerified = true;
      if (claim.serviceId) {
        const previous = saved.get(claim.serviceId)?.advice;
        const savedAt = Date.parse(saved.get(claim.serviceId)?.checkedAt ?? "");
        const staleIncomplete =
          previous && comparisonOutcome(previous) === "incomplete" && savedAt < claim.nextAttemptAt.getTime();
        const result =
          !previous ||
          (previous.discovery?.pendingProviders?.length && !previous.options.length) ||
          staleIncomplete
            ? await advice.review(
                claim.ownerId,
                {
                  serviceId: claim.serviceId,
                  expectedRevision: claim.revision,
                  ...(previous && !previous.discovery?.pendingProviders?.length ? { fresh: true } : {}),
                },
                undefined,
                true,
              )
            : previous;
        const previousAge = Date.now() - Date.parse(previous?.discovery?.checkedAt ?? "");
        const resumedPending =
          previous?.discovery?.pendingProviders?.length && previousAge >= 0 && previousAge < 900_000;
        // A connection error is not a completed research pass. Allow one
        // continuation of fresh partial evidence, independently of failures.
        if (result.discovery?.pendingProviders?.length && !result.options.length) {
          // One bounded continuation may finish partial research. Pending
          // evidence without a usable option must never become a success.
          if (!resumedPending) nextAttemptAt = now;
          else failed.push(claim.serviceId);
        } else completed.push(claim.serviceId);
      }
    }
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "unknown";
    if (code === "subscriptions_changed") status = "superseded";
    else if (code === "worker_superseded") nextAttemptAt = now;
    else if (
      ["review_running", "model_rate_limited", "judge_rate_limited", "judge_request_running"].includes(code)
    ) {
      nextAttemptAt = new Date(now.getTime() + 30_000);
    } else if (
      code.startsWith("judge_") ||
      [
        "model_credit_exhausted",
        "model_access_unavailable",
        "model_request_rejected",
        "model_unavailable",
      ].includes(code)
    ) {
      status = "paused";
      pauseReason = code === "judge_budget_exhausted" ? "budget" : "access";
      nextAttemptAt = new Date(now.getTime() + 60_000);
    } else if (claim.serviceId) {
      attempts[claim.serviceId] = (attempts[claim.serviceId] ?? 0) + 1;
      if (attempts[claim.serviceId]! >= 2) failed.push(claim.serviceId);
      else nextAttemptAt = new Date(now.getTime() + 30_000);
    }
  }
  if (
    status !== "superseded" &&
    completionVerified &&
    completed.length + failed.length >= claim.serviceIds.length
  )
    status = failed.length ? "failed" : "complete";
  await ctx.db
    .update(ownerReviewBatches)
    .set({
      completed,
      failed,
      attempts,
      status,
      pauseReason,
      nextAttemptAt,
      currentServiceId: null,
      leaseToken: null,
      leaseUntil: null,
    })
    .where(
      and(
        eq(ownerReviewBatches.ownerId, claim.ownerId),
        eq(ownerReviewBatches.revision, claim.revision),
        eq(ownerReviewBatches.leaseToken, claim.token),
      ),
    );
  return true;
}
