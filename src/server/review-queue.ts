import { eq } from "drizzle-orm";
import {
  isCurrentSubscription,
  subscriptionCatalogueId,
  type SubscriptionPortfolio,
} from "../shared/subscriptions";
import type { Transaction } from "./db";
import { ownerReviewBatches } from "./db/schema";
import { HttpError } from "./http";
import { subscriptionReadiness } from "../shared/subscription-workflow";

/** Call inside the owner-locked transaction that saves the confirmed needs. */
export async function queueInitialReviews(
  tx: Transaction,
  ownerId: string,
  portfolio: SubscriptionPortfolio,
  services: { id: string; service: string; category?: string }[],
  retry = false,
  validCompleted?: ReadonlySet<string>,
) {
  const current = portfolio.subscriptions.filter(isCurrentSubscription);
  const readiness = subscriptionReadiness(portfolio);
  if (readiness.phase !== "ready")
    throw new HttpError(409, "purpose_needed", "Tell Val what you use each subscription for first.");
  const [existing] = await tx
    .select()
    .from(ownerReviewBatches)
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  const invalidCompletion =
    existing?.revision === portfolio.revision &&
    ["complete", "failed", "paused"].includes(existing.status) &&
    validCompleted !== undefined &&
    existing.completed.some((id) => !validCompleted.has(id));
  if (
    existing?.revision === portfolio.revision &&
    !invalidCompletion &&
    !(retry && ["failed", "paused"].includes(existing.status))
  )
    return existing;
  const priority = (id: string) =>
    ["video", "mobile"].includes(services.find((s) => s.id === id)?.category ?? "") ? 0 : 1;
  const serviceIds = current
    .filter((row) => readiness.researchableServiceIds.includes(row.serviceId))
    .sort(
      (a, b) =>
        priority(subscriptionCatalogueId(a, services) ?? "") -
        priority(subscriptionCatalogueId(b, services) ?? ""),
    )
    .map((row) => row.serviceId);
  const next = {
    ownerId,
    revision: portfolio.revision,
    serviceIds,
    completed:
      existing?.revision === portfolio.revision
        ? existing.completed.filter((id) => !validCompleted || validCompleted.has(id))
        : [],
    failed: [],
    attempts: {},
    status: serviceIds.length ? ("queued" as const) : ("complete" as const),
    currentServiceId: null,
    pauseReason: null,
    leaseToken: null,
    leaseUntil: null,
    nextAttemptAt: new Date(),
  };
  const [saved] = await tx
    .insert(ownerReviewBatches)
    .values(next)
    .onConflictDoUpdate({ target: ownerReviewBatches.ownerId, set: next })
    .returning();
  return saved!;
}
