import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type {
  ApprovalResult,
  AsyncCommandResult,
  CheckoutCommand,
  Consent,
  ConsentCommand,
  PreviewCommand,
  PurchasePreview,
  PurchaseTerms,
} from "../shared/contracts";
import { latestEvaluations, latestPolicy, setCaseState } from "./cases";
import type { AppContext } from "./context";
import {
  artifacts,
  cases,
  consents,
  previews,
  providerAccounts,
  quotes,
  recommendations,
  transitions,
} from "./db/schema";
import { buildOverlap, readOldBilling, saveRenewedBoundary } from "./exits";
import { HttpError } from "./http";
import { evidenceMaxAgeMs } from "./investigation";
import { approvalOrJob, dispatchCreation, loadOperation, planSubscription, type CaseRow } from "./operations";
import { describePlanMismatch } from "./payment-evidence";
import { paypalFor } from "./paypal";
import { resolveSubscriptionPlan } from "./plans";
import { exportHistory, getQuote, openBackup, readTranscripts } from "./providers";
import { buildManifest, orderedComparison, orderedOffer, previewHashOf } from "./validation";
import { verifiedSetup } from "./policy";

const previewLifetimeMs = 5 * 60 * 1000;

const refused = (code: string, message: string) => new HttpError(409, code, message);

/**
 * Derives the purchase terms from facts read now: the stored investigation, a fresh quote, the configured PayPal plan,
 * Provider A's live billing boundary and its current history. Preview and checkout both use this, so a checkout
 * that no longer matches what the user saw is detectable by hash.
 */
async function currentPurchaseTerms(
  ctx: AppContext,
  caseRow: CaseRow,
  recommendationId: string,
): Promise<{ terms: PurchaseTerms; policyRevision: number; renewedBoundary: Date | null }> {
  const policy = await latestPolicy(ctx.db, caseRow.id);
  const [recommendation] = await ctx.db
    .select()
    .from(recommendations)
    .where(and(eq(recommendations.id, recommendationId), eq(recommendations.caseId, caseRow.id)));
  if (!policy || !recommendation)
    throw new HttpError(404, "recommendation_not_found", "No such recommendation on this case.");
  if (recommendation.policyRevision !== policy.revision)
    throw refused("stale_policy", "The policy changed after this recommendation.");
  const candidateId = recommendation.candidateId;
  if (recommendation.action !== "switch" || !candidateId?.startsWith("b_"))
    throw refused("not_a_switch", "Only an eligible Provider B switch can be previewed.");

  const evaluation = (await latestEvaluations(ctx.db, caseRow.id, policy.revision)).find(
    (row) => row.candidateId === candidateId,
  );
  const [account] = await ctx.db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
  if (!evaluation?.result.eligible)
    throw refused("candidate_ineligible", "The candidate is not eligible under the current policy.");
  if (
    Date.now() - evaluation.observedAt.getTime() > evidenceMaxAgeMs ||
    evaluation.entitlementRevision !== account!.entitlementRevision
  )
    throw refused(
      "evidence_stale",
      "The evaluation is too old or predates an entitlement change; run a fresh check.",
    );

  const quote = await getQuote(ctx.db, caseRow, candidateId);
  const [evaluatedQuote] = await ctx.db
    .select()
    .from(quotes)
    .where(and(eq(quotes.id, evaluation.result.quoteId), eq(quotes.advisory, false)));
  if (evaluatedQuote!.revision !== quote.revision)
    throw refused("quote_changed", "The price changed since the evaluation; run a fresh check.");
  const priorOffer = evaluatedQuote!.offer;
  if (
    Boolean(priorOffer) !== Boolean(quote.offer) ||
    (priorOffer &&
      quote.offer &&
      JSON.stringify(orderedOffer(priorOffer)) !== JSON.stringify(orderedOffer(quote.offer)))
  )
    throw refused("offer_changed", "The paid offer or its eligibility changed; run a fresh check.");
  if (
    quote.offer &&
    (quote.offer.eligibility !== "ELIGIBLE" ||
      quote.offer.regularAmount.amountMinor !== quote.recurringTotal.amountMinor ||
      quote.offer.introductoryAmount.amountMinor + quote.offer.setupFee.amountMinor !==
        quote.dueNowTotal.amountMinor)
  )
    throw refused("offer_unverified", "The introductory price, full renewal or eligibility is not verified.");
  const priorComparison = evaluatedQuote!.comparison;
  if (
    caseRow.scenario === "value_offer" &&
    (!priorComparison ||
      !quote.comparison ||
      JSON.stringify(orderedComparison(priorComparison)) !==
        JSON.stringify(orderedComparison(quote.comparison)))
  )
    throw refused("value_changed", "The dated price comparison changed; run a fresh check.");
  if (quote.recurringTotal.amountMinor > policy.recurringCeilingMinor)
    throw refused("over_ceiling", "The quote now exceeds the recurring ceiling.");

  const planB = resolveSubscriptionPlan(ctx.planMapping, candidateId);
  const mismatch = describePlanMismatch(
    await paypalFor(ctx.paypal, "B").getPlan(planB.paypalPlanId),
    quote.recurringTotal.amountMinor,
    quote.offer,
  );
  if (mismatch)
    throw refused("plan_mismatch", `The configured PayPal plan does not match the quote: ${mismatch}`);

  const setup = await verifiedSetup(ctx.db, caseRow);
  if (!setup) throw refused("setup_incomplete", "Provider A's paid period is not verified.");
  const old = await readOldBilling(ctx, setup);
  if (old.status !== "ACTIVE")
    throw refused("old_billing_changed", `Provider A's subscription is ${old.status}.`);
  if (priorComparison && priorComparison.oldNextBillingAt !== old.boundary.toISOString())
    throw refused(
      "value_changed",
      "Original service's paid-through boundary changed; run a fresh value check.",
    );

  const history = buildManifest(await readTranscripts(ctx.db, caseRow.initialAccountId));
  const terms: PurchaseTerms = {
    candidateId,
    providerId: "provider_b",
    planId: candidateId,
    quoteRevision: quote.revision,
    dueNow: quote.dueNowTotal,
    recurring: quote.recurringTotal,
    interval: "MONTH",
    intervalCount: 1,
    oldSubscriptionId: setup.operation.remoteId!,
    oldAccessEndsAt: old.boundary.toISOString(),
    overlap: buildOverlap({
      oldAmountMinor: resolveSubscriptionPlan(ctx.planMapping, setup.operation.planId).recurringMinor,
      boundary: old.boundary,
      dueNowMinor: quote.dueNowTotal.amountMinor,
    }),
    ...(priorOffer ? { offer: priorOffer } : {}),
    ...(priorComparison ? { comparison: priorComparison } : {}),
    backupManifestDigest: history.manifestDigest,
  };
  return { terms, policyRevision: policy.revision, renewedBoundary: old.renewed ? old.boundary : null };
}

/** Exports and verifies Provider A's history, then shows the exact terms for five minutes. Nothing is purchased. */
export async function createPreview(
  ctx: AppContext,
  caseRow: CaseRow,
  command: PreviewCommand,
): Promise<PurchasePreview> {
  if (caseRow.state !== "AWAITING_CONSENT")
    throw refused("not_awaiting_consent", "A preview needs an eligible switch recommendation.");
  const { terms, policyRevision, renewedBoundary } = await currentPurchaseTerms(
    ctx,
    caseRow,
    command.recommendationId,
  );
  if (renewedBoundary) await saveRenewedBoundary(ctx.db, caseRow, renewedBoundary);

  // The backup counts only if the stored bytes still match the source history it was made from.
  const { manifest } = await exportHistory(ctx.db, caseRow, caseRow.initialAccountId, "backup");
  const [stored] = await ctx.db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, manifest.artifactId), eq(artifacts.advisory, false)));
  const verified = openBackup(stored!);
  if (verified.manifest.manifestDigest !== terms.backupManifestDigest)
    throw refused("backup_unverified", "The backup does not match Provider A's current history.");

  const { hashPayload, hash } = previewHashOf({
    caseId: caseRow.id,
    ownerId: caseRow.ownerId,
    recommendationId: command.recommendationId,
    policyRevision,
    materialTerms: terms,
  });
  const createdAt = new Date();
  const [preview] = await ctx.db
    .insert(previews)
    .values({
      id: randomUUID(),
      caseId: caseRow.id,
      ownerId: caseRow.ownerId,
      recommendationId: command.recommendationId,
      policyRevision,
      materialTerms: terms,
      hashPayload,
      previewHash: hash,
      backupEvidenceId: manifest.id,
      createdAt,
      expiresAt: new Date(createdAt.getTime() + previewLifetimeMs),
    })
    .returning();
  return {
    id: preview!.id,
    caseId: preview!.caseId,
    ownerId: preview!.ownerId,
    recommendationId: preview!.recommendationId,
    policyRevision: preview!.policyRevision,
    materialTerms: preview!.materialTerms,
    backupEvidenceId: preview!.backupEvidenceId,
    previewHash: preview!.previewHash,
    createdAt: preview!.createdAt.toISOString(),
    expiresAt: preview!.expiresAt.toISOString(),
  };
}

/** Records the user's two separate agreements to one exact preview. It authorizes nothing until checkout consumes it. */
export async function recordConsent(
  ctx: AppContext,
  caseRow: CaseRow,
  session: { sessionId: string },
  command: ConsentCommand,
): Promise<Consent> {
  const [preview] = await ctx.db
    .select()
    .from(previews)
    .where(and(eq(previews.id, command.previewId), eq(previews.caseId, caseRow.id)));
  if (!preview) throw new HttpError(404, "preview_not_found", "No such preview on this case.");
  if (preview.previewHash !== command.previewHash)
    throw refused("hash_mismatch", "The consent does not name this preview's terms.");
  if (preview.expiresAt.getTime() <= Date.now())
    throw refused("preview_expired", "The preview expired; request a new one.");
  const policy = await latestPolicy(ctx.db, caseRow.id);
  if (caseRow.state !== "AWAITING_CONSENT" || policy?.revision !== preview.policyRevision)
    throw refused("stale_policy", "The case or policy moved on; request a new preview.");

  const [consent] = await ctx.db
    .insert(consents)
    .values({
      id: randomUUID(),
      caseId: caseRow.id,
      ownerId: caseRow.ownerId,
      sessionId: session.sessionId,
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvePurchase: command.approvePurchase,
      approveOldExitAfterReadiness: command.approveOldExitAfterReadiness,
    })
    .returning();
  return { ...consent!, createdAt: consent!.createdAt.toISOString(), consumedAt: null, revokedAt: null };
}

/** The user declines before anything was created: unused consent is revoked and the case goes back to monitoring. */
export async function declinePurchase(ctx: AppContext, caseRow: CaseRow) {
  await ctx.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(cases).where(eq(cases.id, caseRow.id)).for("update");
    if (locked!.state !== "AWAITING_CONSENT")
      throw refused("nothing_to_decline", "There is no pending purchase to decline.");
    await tx
      .update(consents)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(consents.caseId, caseRow.id),
          isNull(consents.consumedByOperationId),
          isNull(consents.revokedAt),
        ),
      );
    await setCaseState(tx, caseRow.id, "MONITORING");
  });
}

/**
 * Turns one valid consent into exactly one Provider B purchase. Facts are re-read and must still hash to what the user
 * saw; then consent, transition and the creation operation are written in a single transaction, so concurrent
 * or repeated requests all find the same operation. Approval, expiry and the policy revision are checked again under
 * the consent's lock; once consumed, only the stored operation is ever continued.
 */
export async function checkout(
  ctx: AppContext,
  caseRow: CaseRow,
  command: CheckoutCommand,
): Promise<ApprovalResult | AsyncCommandResult> {
  const [consent] = await ctx.db
    .select()
    .from(consents)
    .where(and(eq(consents.id, command.consentId), eq(consents.caseId, caseRow.id)));
  if (!consent) throw new HttpError(404, "consent_not_found", "No such consent on this case.");
  if (consent.consumedByOperationId) return continuePurchase(ctx, consent.consumedByOperationId);
  if (consent.revokedAt) throw refused("consent_revoked", "This consent was withdrawn.");
  if (!consent.approvePurchase)
    throw refused("purchase_not_approved", "This consent does not approve a purchase.");

  const [preview] = await ctx.db.select().from(previews).where(eq(previews.id, consent.previewId));
  if (preview!.expiresAt.getTime() <= Date.now())
    throw refused("preview_expired", "The preview expired before checkout; request a new one.");
  const { terms, policyRevision } = await currentPurchaseTerms(ctx, caseRow, preview!.recommendationId);
  const current = previewHashOf({
    caseId: caseRow.id,
    ownerId: caseRow.ownerId,
    recommendationId: preview!.recommendationId,
    policyRevision,
    materialTerms: terms,
  });
  if (current.hash !== preview!.previewHash) {
    await ctx.db
      .update(consents)
      .set({ revokedAt: new Date() })
      .where(and(eq(consents.id, consent.id), isNull(consents.consumedByOperationId)));
    throw refused(
      "terms_changed",
      "The terms changed since the preview; nothing was bought. Request a new preview.",
    );
  }
  return continuePurchase(ctx, await consume(ctx, caseRow, consent.id));
}

async function consume(ctx: AppContext, caseRow: CaseRow, consentId: string): Promise<string> {
  return ctx.db.transaction(async (tx) => {
    // Case lock first, as policy changes and the exit dispatch boundary take it, so they cannot deadlock with this.
    const [locked] = await tx.select().from(cases).where(eq(cases.id, caseRow.id)).for("update");
    const [consent] = await tx.select().from(consents).where(eq(consents.id, consentId)).for("update");
    if (consent!.consumedByOperationId) return consent!.consumedByOperationId;
    if (consent!.revokedAt) throw refused("consent_revoked", "This consent was withdrawn.");
    if (!consent!.approvePurchase)
      throw refused("purchase_not_approved", "This consent does not approve a purchase.");

    const [preview] = await tx.select().from(previews).where(eq(previews.id, consent!.previewId));
    if (preview!.expiresAt.getTime() <= Date.now())
      throw refused("preview_expired", "The preview expired before checkout; request a new one.");
    if (locked!.state !== "AWAITING_CONSENT")
      throw refused("not_awaiting_consent", "The case is no longer waiting for this purchase.");
    if ((await latestPolicy(tx, caseRow.id))?.revision !== preview!.policyRevision)
      throw refused("stale_policy", "The policy changed after the preview; request a new one.");

    const transitionId = randomUUID();
    await tx.insert(transitions).values({
      id: transitionId,
      caseId: caseRow.id,
      ownerId: caseRow.ownerId,
      consentId,
      state: "AWAITING_PAYPAL",
      oldSubscriptionId: preview!.materialTerms.oldSubscriptionId,
      acceptedPolicyRevision: preview!.policyRevision,
      acceptedPurchaseTerms: preview!.materialTerms,
    });
    const operation = await planSubscription(
      ctx,
      {
        caseRow,
        kind: "replacement_create",
        planId: preview!.materialTerms.planId,
        probe: false,
        transition: { id: transitionId, authorityHash: consent!.previewHash },
      },
      tx,
    );
    await tx
      .update(consents)
      .set({ consumedByOperationId: operation.id, consumedAt: new Date() })
      .where(eq(consents.id, consentId));
    await setCaseState(tx, caseRow.id, "AWAITING_PAYPAL");
    return operation.id;
  });
}

/** Sends the stored creation request if it has not been sent, and tells the buyer where to approve. */
async function continuePurchase(
  ctx: AppContext,
  operationId: string,
): Promise<ApprovalResult | AsyncCommandResult> {
  return approvalOrJob(ctx, await dispatchCreation(ctx, await loadOperation(ctx.db, operationId)));
}
