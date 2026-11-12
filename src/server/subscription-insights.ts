import { and, desc, eq, sql } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import type { SubscriptionCheckEvent, SubscriptionInsights } from "../shared/subscription-insights";
import { comparisonAlternatives, comparisonOutcome } from "../shared/subscription-insights";
import { isCurrentSubscription, type SubscriptionAdvice } from "../shared/subscriptions";
import { requireLogin } from "./auth";
import { requireCurrentComparisonView } from "./comparison-view";
import type { AppContext } from "./context";
import { ownerReviewBatches, ownerSubscriptionReviews, ownerSubscriptions } from "./db/schema";
import { HttpError } from "./http";
import { readPriceChecks } from "./price-checks";
import { subscriptionAdviceService } from "./subscription-advice";

/** These pages only read existing work. A visit must never queue a check or call a model. */
export function subscriptionInsightsRoutes(ctx: AppContext, catalogue: CatalogueResponse["catalogue"]) {
  const router = Router();
  router.get("/subscriptions/insights", async (req, res) => {
    const { ownerId } = requireLogin(res);
    requireCurrentComparisonView(req.get("X-Val-Advice-Format"));
    const revision = Number(req.query.revision);
    if (
      typeof req.query.revision !== "string" ||
      !/^\d+$/.test(req.query.revision) ||
      !Number.isSafeInteger(revision)
    )
      throw new HttpError(400, "invalid_request", "Choose your current subscriptions.");
    const loadPortfolio = async () =>
      (await ctx.db.select().from(ownerSubscriptions).where(eq(ownerSubscriptions.ownerId, ownerId)))[0];
    const portfolio = await loadPortfolio();
    const changed = () =>
      new HttpError(
        409,
        "subscriptions_changed",
        "Your subscriptions changed. Reload to see the latest results.",
      );
    if ((portfolio?.revision ?? 0) !== revision) throw changed();
    const current = new Set(
      portfolio?.subscriptions.filter(isCurrentSubscription).map((row) => row.serviceId),
    );
    const [saved, schedules, batches, records] = await Promise.all([
      subscriptionAdviceService(ctx, catalogue).savedAdvice(ownerId, revision, undefined, true),
      readPriceChecks(ctx, ownerId, catalogue),
      ctx.db.select().from(ownerReviewBatches).where(eq(ownerReviewBatches.ownerId, ownerId)),
      ctx.db
        .select({
          id: ownerSubscriptionReviews.id,
          serviceId: ownerSubscriptionReviews.serviceId,
          createdAt: ownerSubscriptionReviews.createdAt,
          advice: sql<SubscriptionAdvice | null>`${ownerSubscriptionReviews.result}->'advice'`,
          completed: sql<boolean | null>`${ownerSubscriptionReviews.result}->'completed'`,
        })
        .from(ownerSubscriptionReviews)
        .where(
          and(
            eq(ownerSubscriptionReviews.ownerId, ownerId),
            sql`coalesce(${ownerSubscriptionReviews.result}->>'reason','') <> 'research_checkpoint'`,
            sql`(jsonb_typeof(${ownerSubscriptionReviews.result}->'advice') = 'object' OR ${ownerSubscriptionReviews.result}->>'completed' = 'false')`,
          ),
        )
        .orderBy(desc(ownerSubscriptionReviews.createdAt), desc(ownerSubscriptionReviews.id))
        .limit(101),
    ]);
    if (((await loadPortfolio())?.revision ?? 0) !== revision) throw changed();
    const activity: SubscriptionCheckEvent[] = records.slice(0, 100).map((record) => {
      const row = portfolio?.subscriptions.find((item) => item.serviceId === record.serviceId);
      const alternatives = record.advice ? comparisonAlternatives(record.advice).length : 0;
      return {
        id: record.id,
        serviceId: record.serviceId,
        name: row?.name ?? "Previous subscription",
        checkedAt: record.createdAt.toISOString(),
        alternatives,
        available: current.has(record.serviceId),
        outcome: record.advice ? comparisonOutcome(record.advice) : "incomplete",
      };
    });
    const batch = batches[0];
    const result: SubscriptionInsights = {
      revision,
      reviews: [...saved]
        .filter(([id]) => current.has(id))
        .map(([serviceId, value]) => ({ serviceId, ...value })),
      schedules: schedules.filter((row) => current.has(row.serviceId)),
      batch:
        batch?.revision === revision
          ? {
              revision: batch.revision,
              serviceIds: batch.serviceIds,
              completed: batch.completed,
              failed: batch.failed,
              status: batch.status,
              currentServiceId: batch.currentServiceId,
              pauseReason: batch.pauseReason,
            }
          : null,
      activity,
      moreActivity: records.length > 100,
    };
    res.set("Cache-Control", "no-store").json(result);
  });
  return router;
}
