import { isCurrentSubscription } from "../shared/subscriptions";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import {
  nextPriceCheck,
  validCadence,
  type PriceCheckDraft,
  type PriceCheckSchedule,
} from "../shared/price-checks";
import { portfolioLimit } from "../shared/subscriptions";
import { requireLogin } from "./auth";
import { requireCurrentComparisonView } from "./comparison-view";
import type { AppContext } from "./context";
import { judgeDemoOwners, ownerPriceChecks, ownerSubscriptions, ownerRecognizedServices } from "./db/schema";
import { HttpError } from "./http";
import { subscriptionAdviceService } from "./subscription-advice";
import { adviceContext, recognitionBasisMatches } from "./advice-context";
import { currentWorker } from "./worker-deployment";
import { comparisonLeaseMs } from "./research-limits";

export async function readPriceChecks(
  ctx: AppContext,
  ownerId: string,
  catalogue?: CatalogueResponse["catalogue"],
): Promise<PriceCheckSchedule[]> {
  const [portfolio] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const schedules = await ctx.db.select().from(ownerPriceChecks).where(eq(ownerPriceChecks.ownerId, ownerId));
  const identities = await ctx.db
    .select()
    .from(ownerRecognizedServices)
    .where(eq(ownerRecognizedServices.ownerId, ownerId));
  return schedules
    .filter((row) => portfolio?.subscriptions.some((item) => item.serviceId === row.serviceId))
    .map((row) => ({
      serviceId: row.serviceId,
      revision: row.revision,
      cadence: row.cadence,
      nextCheckAt:
        (row.retryAt && row.nextCheckAt && row.retryAt > row.nextCheckAt
          ? row.retryAt
          : row.nextCheckAt
        )?.toISOString() ?? null,
      lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
      status: row.status,
      advice:
        portfolio &&
        recognitionBasisMatches(
          {},
          identities.find((item) => item.serviceId === row.serviceId)?.updatedAt,
          row.lastCheckedAt,
        ) &&
        (row.adviceDependencyKey && catalogue
          ? row.adviceDependencyKey ===
            adviceContext(portfolio.subscriptions, row.serviceId, catalogue.services)?.dependencyKey
          : row.adviceRevision === portfolio.revision)
          ? row.advice
          : null,
    }));
}

export function priceCheckRoutes(ctx: AppContext, catalogue?: CatalogueResponse["catalogue"]) {
  const router = Router();
  router.get("/subscriptions/price-checks", async (req, res) => {
    const { ownerId } = requireLogin(res);
    requireCurrentComparisonView(req.get("X-Val-Advice-Format"));
    res.json({ schedules: await readPriceChecks(ctx, ownerId, catalogue) });
  });
  router.put("/subscriptions/price-checks", async (req, res) => {
    const { ownerId } = requireLogin(res);
    requireCurrentComparisonView(req.get("X-Val-Advice-Format"));
    const body = req.body as PriceCheckDraft & { expectedRevision: number };
    if (
      !body ||
      Object.keys(body).some(
        (key) => !["serviceIds", "cadence", "expectedRevisions", "expectedRevision"].includes(key),
      ) ||
      !Number.isSafeInteger(body.expectedRevision) ||
      !Array.isArray(body.serviceIds) ||
      !body.serviceIds.length ||
      body.serviceIds.length > portfolioLimit ||
      body.serviceIds.some((id) => typeof id !== "string" || !id || id.length > 200) ||
      new Set(body.serviceIds).size !== body.serviceIds.length ||
      (body.cadence !== null && !validCadence(body.cadence)) ||
      !body.expectedRevisions ||
      typeof body.expectedRevisions !== "object" ||
      Array.isArray(body.expectedRevisions) ||
      Object.keys(body.expectedRevisions).length !== body.serviceIds.length ||
      body.serviceIds.some(
        (id) =>
          !Object.hasOwn(body.expectedRevisions, id) ||
          !Number.isSafeInteger(body.expectedRevisions[id]) ||
          body.expectedRevisions[id]! < 0,
      )
    ) {
      throw new HttpError(
        400,
        "invalid_schedule",
        "Choose saved subscriptions and a checking interval of at least one hour.",
      );
    }
    await ctx.db.transaction(async (tx) => {
      // Same owner row lock as subscription writes: deletion or concurrent edits cannot alter the confirmed selection.
      const [portfolio] = await tx
        .select()
        .from(ownerSubscriptions)
        .where(eq(ownerSubscriptions.ownerId, ownerId))
        .for("update");
      if ((portfolio?.revision ?? 0) !== body.expectedRevision)
        throw new HttpError(
          409,
          "subscriptions_changed",
          "Your subscriptions changed. Ask Val for an updated schedule.",
        );
      if (
        !portfolio ||
        body.serviceIds.some(
          (id) => !portfolio.subscriptions.some((row) => row.serviceId === id && isCurrentSubscription(row)),
        )
      )
        throw new HttpError(404, "subscription_not_found", "Choose subscriptions in your own list.");
      const existing = await tx
        .select()
        .from(ownerPriceChecks)
        .where(eq(ownerPriceChecks.ownerId, ownerId))
        .for("update");
      if (
        body.serviceIds.some(
          (id) =>
            (existing.find((row) => row.serviceId === id)?.revision ?? 0) !== body.expectedRevisions[id],
        )
      )
        throw new HttpError(
          409,
          "schedules_changed",
          "Your checking schedule changed. Ask Val to review it again.",
        );
      const now = new Date();
      for (const serviceId of body.serviceIds) {
        const revision = body.expectedRevisions[serviceId]! + 1;
        const values = {
          revision,
          cadence: body.cadence,
          anchorAt: now,
          nextCheckAt: body.cadence ? nextPriceCheck(now, body.cadence) : null,
          retryAt: null,
          leaseToken: null,
          leaseUntil: null,
          status: body.cadence ? ("scheduled" as const) : ("paused" as const),
        };
        await tx
          .insert(ownerPriceChecks)
          .values({ ownerId, serviceId, ...values })
          .onConflictDoUpdate({
            target: [ownerPriceChecks.ownerId, ownerPriceChecks.serviceId],
            set: values,
          });
      }
    });
    res.json({ schedules: await readPriceChecks(ctx, ownerId, catalogue) });
  });
  return router;
}

/** One persisted claim per tick; shared model funding, access and rate guards are never bypassed. */
export async function runDuePriceCheck(
  ctx: AppContext,
  catalogue: CatalogueResponse["catalogue"],
  now = new Date(),
) {
  if (!ctx.model || !ctx.config.liveDiscovery) return false;
  const claim = await ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return null;
    const [due] = await tx
      .select()
      .from(ownerPriceChecks)
      .where(
        sql`${ownerPriceChecks.cadence} is not null and (
          ${ownerPriceChecks.nextCheckAt} <= ${now} or (
            ${ownerPriceChecks.status} = 'budget_reached'
          ) or (
            ${ownerPriceChecks.status} = 'access_needed' and exists (
              select 1 from ${judgeDemoOwners} where ${judgeDemoOwners.ownerId} = ${ownerPriceChecks.ownerId}
            )
          )
        )
      and (${ownerPriceChecks.retryAt} is null or ${ownerPriceChecks.retryAt} <= ${now})
      and (${ownerPriceChecks.leaseUntil} is null or ${ownerPriceChecks.leaseUntil} <= ${now})`,
      )
      .orderBy(sql`coalesce(${ownerPriceChecks.retryAt}, ${ownerPriceChecks.nextCheckAt})`)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!due) return null;
    const token = randomUUID();
    await tx
      .update(ownerPriceChecks)
      .set({ leaseToken: token, leaseUntil: new Date(now.getTime() + comparisonLeaseMs), status: "checking" })
      .where(and(eq(ownerPriceChecks.ownerId, due.ownerId), eq(ownerPriceChecks.serviceId, due.serviceId)));
    return { ...due, token };
  });
  if (!claim) return false;
  const ownedClaim = and(
    eq(ownerPriceChecks.ownerId, claim.ownerId),
    eq(ownerPriceChecks.serviceId, claim.serviceId),
    eq(ownerPriceChecks.revision, claim.revision),
    eq(ownerPriceChecks.leaseToken, claim.token),
  );
  let status: PriceCheckSchedule["status"] = "scheduled";
  let advice: PriceCheckSchedule["advice"] = null;
  let adviceRevision: number | null = null;
  let adviceDependencyKey: string | null = null;
  let retryAt: Date | null = null;
  let nextCheckAt: Date | null = claim.nextCheckAt ?? now;
  let completed = false;
  try {
    const [portfolio] = await ctx.db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, claim.ownerId));
    const selected = portfolio?.subscriptions.find((row) => row.serviceId === claim.serviceId);
    if (
      !selected ||
      selected.providerState?.status === "cancelled" ||
      (selected.paypalStatus !== undefined && selected.paypalStatus !== "ACTIVE") ||
      selected.paypalEvidence?.agreementStatus === "inactive" ||
      selected.paypalEvidence?.excludedByOwner
    ) {
      status = "paused";
      nextCheckAt = null;
    } else if (
      selected.paypalEvidence?.recurrenceStale ||
      !selected.purpose.trim() ||
      selected.amountMinor === null
    ) {
      status = "needs_details";
      retryAt = new Date(now.getTime() + 86400_000);
    } else {
      advice = await subscriptionAdviceService(ctx, catalogue).review(
        claim.ownerId,
        {
          serviceId: claim.serviceId,
          expectedRevision: portfolio!.revision,
          fresh: true,
        },
        { serviceId: claim.serviceId, revision: claim.revision, leaseToken: claim.token },
      );
      adviceRevision = portfolio!.revision;
      adviceDependencyKey = adviceContext(
        portfolio!.subscriptions,
        claim.serviceId,
        catalogue.services,
      )!.dependencyKey;
      completed = true;
      // Missed intervals are coalesced. Never replay a backlog of paid searches after downtime.
      nextCheckAt = nextPriceCheck(now, claim.cadence!, claim.anchorAt.getUTCDate());
    }
  } catch (error) {
    const code = error instanceof HttpError ? error.code : "unknown";
    if (code === "worker_superseded") {
      status = "retrying";
      retryAt = now;
    } else if (["judge_budget_exhausted", "judge_owner_limit"].includes(code)) {
      status = "budget_reached";
      nextCheckAt = null;
      retryAt = new Date(now.getTime() + 60_000);
    } else if (["judge_access_required", "not_authenticated"].includes(code)) {
      status = "access_needed";
      nextCheckAt = null;
    } else if (
      [
        "review_running",
        "chat_running",
        "judge_request_running",
        "model_rate_limited",
        "judge_rate_limited",
      ].includes(code)
    ) {
      // These refusals happen before dispatch. Retry promptly without replaying unknown calls.
      status = "retrying";
      const seconds = error instanceof HttpError ? error.retryAfterSeconds : undefined;
      retryAt = new Date(
        now.getTime() + (seconds && Number.isFinite(seconds) ? Math.max(1, seconds) : 30) * 1000,
      );
    } else {
      status = "retrying";
      retryAt = new Date(now.getTime() + 60 * 60_000);
    }
  }
  await ctx.db
    .update(ownerPriceChecks)
    .set({
      status,
      nextCheckAt,
      retryAt,
      leaseToken: null,
      leaseUntil: null,
      ...(completed ? { advice, adviceRevision, adviceDependencyKey, lastCheckedAt: new Date() } : {}),
    })
    .where(ownedClaim);
  return true;
}
