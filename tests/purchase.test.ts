import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatorFor } from "../src/shared/contracts";
import { consents, evaluations, evidence, operations, previews, transitions } from "../src/server/db/schema";
import { orderedPurchaseTerms, sha256 } from "../src/server/validation";
import { startTestApp, type TestApp } from "./helpers";
import {
  approvePurchaseAndReturn,
  caseAwaitingConsent,
  previewAndConsent,
  snapshotOf,
  startPurchase,
  valueAwaitingConsent,
} from "./scenarios";

// Preview, consent and the single consumption of purchase authority. Real PostgreSQL and application; PayPal is the
// local stand-in, so none of this is sandbox evidence. Provider B's own subscription is never created before checkout.

const examples = JSON.parse(readFileSync("docs/build-pack/preservation-examples.json", "utf8"));

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

const providerBCreations = (caseId: string) =>
  app.paypal.createRequests.filter(
    (request) => request.merchant === "B" && request.body.custom_id.startsWith(caseId),
  );
const replacementOperations = (caseId: string) =>
  app.ctx.db
    .select()
    .from(operations)
    .where(and(eq(operations.caseId, caseId), eq(operations.kind, "replacement_create")));
const transitionsOf = (caseId: string) =>
  app.ctx.db.select().from(transitions).where(eq(transitions.caseId, caseId));

describe("purchase preview", () => {
  it("shows the exact terms, verified backup and Provider A's paid-through boundary, and buys nothing", async () => {
    const flow = await caseAwaitingConsent(app);
    const boundary = (await snapshotOf(flow.browser, flow.caseId)).receipt.oldAccessEndsAt;

    const response = await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
      recommendationId: flow.recommendationId,
    });
    expect(response.status).toBe(200);
    const preview = response.body;
    expect(validatorFor("PurchasePreview")(preview)).toBe(true);
    expect(preview.materialTerms).toMatchObject({
      candidateId: "b_02",
      providerId: "provider_b",
      planId: "b_02",
      quoteRevision: 1,
      dueNow: { currency: "GBP", amountMinor: 1400 },
      recurring: { currency: "GBP", amountMinor: 1400 },
      interval: "MONTH",
      intervalCount: 1,
      oldSubscriptionId: flow.setupSubscriptionId,
      oldAccessEndsAt: boundary,
      backupManifestDigest: examples.manifestDigest,
    });
    expect(preview.materialTerms.overlap).toMatchObject({
      oldPaidAmount: { amountMinor: 1200 },
      newDueNow: { amountMinor: 1400 },
      possibleOldRenewal: { amountMinor: 1200 },
      oldPaidThrough: boundary,
      oldNextBillingTime: boundary,
    });
    expect(Date.parse(preview.expiresAt) - Date.parse(preview.createdAt)).toBe(5 * 60 * 1000);

    const [stored] = await app.ctx.db.select().from(previews).where(eq(previews.id, preview.id));
    expect(Object.keys(JSON.parse(stored!.hashPayload))).toEqual([
      "caseId",
      "ownerId",
      "recommendationId",
      "policyRevision",
      "materialTerms",
    ]);
    expect(stored!.hashPayload).toBe(
      JSON.stringify({
        caseId: flow.caseId,
        ownerId: preview.ownerId,
        recommendationId: flow.recommendationId,
        policyRevision: 1,
        materialTerms: orderedPurchaseTerms(preview.materialTerms),
      }),
    );
    expect(sha256(stored!.hashPayload)).toBe(preview.previewHash);

    const [backup] = await app.ctx.db
      .select()
      .from(evidence)
      .where(eq(evidence.id, preview.backupEvidenceId));
    expect(backup).toMatchObject({ kind: "backup", caseId: flow.caseId });
    expect(providerBCreations(flow.caseId)).toEqual([]);
    expect(await replacementOperations(flow.caseId)).toEqual([]);
  });

  it("binds a positive paid offer, full renewal, eligibility, dated comparison and overlap before consent", async () => {
    const flow = await valueAwaitingConsent(app);
    const response = await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
      recommendationId: flow.recommendationId,
    });
    expect(response.status).toBe(200);
    const preview = response.body;
    expect(validatorFor("PurchasePreview")(preview)).toBe(true);
    expect(preview.materialTerms).toMatchObject({
      candidateId: "b_03",
      quoteRevision: 2,
      dueNow: { currency: "GBP", amountMinor: 600 },
      recurring: { currency: "GBP", amountMinor: 900 },
      offer: {
        introductoryAmount: { amountMinor: 600 },
        introductoryCycles: 3,
        regularAmount: { amountMinor: 900 },
        eligibility: "ELIGIBLE",
        setupFee: { amountMinor: 0 },
      },
      comparison: {
        horizonMonths: 12,
        currentTotal: { amountMinor: 19200 },
        candidateTotal: { amountMinor: 9900 },
        netSavingMinor: 9300,
      },
      overlap: { oldPaidAmount: { amountMinor: 1200 }, newDueNow: { amountMinor: 600 } },
    });
    const [stored] = await app.ctx.db.select().from(previews).where(eq(previews.id, preview.id));
    expect(stored!.hashPayload).toContain('"introductoryCycles":3');
    expect(stored!.hashPayload).toContain('"netSavingMinor":9300');
    expect(sha256(stored!.hashPayload)).toBe(preview.previewHash);
    expect(providerBCreations(flow.caseId)).toHaveLength(0);
    expect(await app.ctx.db.select().from(consents).where(eq(consents.caseId, flow.caseId))).toHaveLength(0);
  });

  it("keeps the same hash when only timestamps refresh", async () => {
    const flow = await caseAwaitingConsent(app);
    const first = (
      await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
        recommendationId: flow.recommendationId,
      })
    ).body;
    const second = (
      await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
        recommendationId: flow.recommendationId,
      })
    ).body;
    expect(second.id).not.toBe(first.id);
    expect(second.previewHash).toBe(first.previewHash);
  });

  it("is refused when the price moved, the evaluation is stale or Provider A's billing is not active", async () => {
    const priced = await caseAwaitingConsent(app);
    await priced.browser.post(`/api/admin/cases/${priced.caseId}/fault`, {
      fault: "price_change",
      enabled: true,
    });
    expect(
      (
        await priced.browser.post(`/api/cases/${priced.caseId}/preview`, {
          recommendationId: priced.recommendationId,
        })
      ).status,
    ).toBe(409);

    const stale = await caseAwaitingConsent(app);
    await app.ctx.db
      .update(evaluations)
      .set({ observedAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(evaluations.caseId, stale.caseId));
    expect(
      (
        await stale.browser.post(`/api/cases/${stale.caseId}/preview`, {
          recommendationId: stale.recommendationId,
        })
      ).body.error,
    ).toBe("evidence_stale");

    const cancelled = await caseAwaitingConsent(app);
    app.paypal.subscriptions.get(cancelled.setupSubscriptionId)!.status = "CANCELLED";
    expect(
      (
        await cancelled.browser.post(`/api/cases/${cancelled.caseId}/preview`, {
          recommendationId: cancelled.recommendationId,
        })
      ).body.error,
    ).toBe("old_billing_changed");
    expect(
      providerBCreations(priced.caseId).length +
        providerBCreations(stale.caseId).length +
        providerBCreations(cancelled.caseId).length,
    ).toBe(0);
  });

  it("follows a verified Provider A renewal to the new boundary, and refuses a boundary with no renewal payment", async () => {
    const renewed = await caseAwaitingConsent(app);
    const originalBoundary = (await snapshotOf(renewed.browser, renewed.caseId)).receipt.oldAccessEndsAt!;
    app.paypal.renew(renewed.setupSubscriptionId);
    const preview = (
      await renewed.browser.post(`/api/cases/${renewed.caseId}/preview`, {
        recommendationId: renewed.recommendationId,
      })
    ).body;
    expect(Date.parse(preview.materialTerms.oldAccessEndsAt)).toBeGreaterThan(Date.parse(originalBoundary));
    expect((await snapshotOf(renewed.browser, renewed.caseId)).receipt.oldAccessEndsAt).toBe(
      preview.materialTerms.oldAccessEndsAt,
    );

    const unproven = await caseAwaitingConsent(app);
    app.paypal.renew(unproven.setupSubscriptionId, { withoutTransaction: true });
    expect(
      (
        await unproven.browser.post(`/api/cases/${unproven.caseId}/preview`, {
          recommendationId: unproven.recommendationId,
        })
      ).body.error,
    ).toBe("old_billing_unverified");
  });
});

describe("consent", () => {
  it("must name the exact preview, both agreements and an unexpired preview, and authorizes nothing by itself", async () => {
    const flow = await caseAwaitingConsent(app);
    const preview = (
      await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
        recommendationId: flow.recommendationId,
      })
    ).body;
    const consent = {
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvePurchase: true,
      approveOldExitAfterReadiness: true,
    };

    expect(
      (
        await flow.browser.post(`/api/cases/${flow.caseId}/consents`, {
          ...consent,
          previewHash: "0".repeat(64),
        })
      ).body.error,
    ).toBe("hash_mismatch");
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/consents`, { ...consent, approvePurchase: false }))
        .status,
    ).toBe(400);
    expect(
      (
        await flow.browser.post(`/api/cases/${flow.caseId}/consents`, {
          ...consent,
          approveOldExitAfterReadiness: false,
        })
      ).status,
    ).toBe(400);
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/consents`, { ...consent, previewId: "unknown" }))
        .status,
    ).toBe(404);

    const accepted = await flow.browser.post(`/api/cases/${flow.caseId}/consents`, consent);
    expect(accepted.status).toBe(201);
    expect(validatorFor("Consent")(accepted.body)).toBe(true);
    expect(accepted.body).toMatchObject({
      ownerId: preview.ownerId,
      consumedByOperationId: null,
      revokedAt: null,
    });
    expect(providerBCreations(flow.caseId)).toEqual([]);

    await app.ctx.db
      .update(previews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(previews.id, preview.id));
    expect((await flow.browser.post(`/api/cases/${flow.caseId}/consents`, consent)).body.error).toBe(
      "preview_expired",
    );
  });

  it("is declined without effect: unused consent is revoked and the case returns to monitoring", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    const declined = await flow.browser.post(`/api/cases/${flow.caseId}/decline`);
    expect(declined.status).toBe(200);
    expect(declined.body.case.state).toBe("MONITORING");

    const [stored] = await app.ctx.db.select().from(consents).where(eq(consents.id, consent.id));
    expect(stored!.revokedAt).not.toBeNull();
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id })).body.error,
    ).toBe("consent_revoked");
    expect(await replacementOperations(flow.caseId)).toEqual([]);
    expect((await flow.browser.post(`/api/cases/${flow.caseId}/decline`)).status).toBe(409);
  });
});

describe("checkout consumes authority once", () => {
  it("creates nothing, and calls no API, when the consent does not approve the purchase", async () => {
    const flow = await caseAwaitingConsent(app);
    const preview = (
      await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
        recommendationId: flow.recommendationId,
      })
    ).body;
    const consentId = randomUUID();
    // The API cannot produce this record; a damaged or hand-written one must still be refused.
    await app.ctx.db.insert(consents).values({
      id: consentId,
      caseId: flow.caseId,
      ownerId: preview.ownerId,
      sessionId: "test",
      previewId: preview.id,
      previewHash: preview.previewHash,
      approvePurchase: false,
      approveOldExitAfterReadiness: true,
    });

    const callsBefore = app.paypal.calls.length;
    const refused = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("purchase_not_approved");
    expect(app.paypal.calls.length).toBe(callsBefore);
    expect(await replacementOperations(flow.caseId)).toEqual([]);
    expect(await transitionsOf(flow.caseId)).toEqual([]);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("AWAITING_CONSENT");
  });

  it("refuses an expired, unconsumed preview, and one whose policy revision has moved on, without creating anything", async () => {
    const expired = await caseAwaitingConsent(app);
    const first = await previewAndConsent(expired.browser, expired.caseId, expired.recommendationId);
    await app.ctx.db
      .update(previews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(previews.id, first.preview.id));
    expect(
      (await expired.browser.post(`/api/cases/${expired.caseId}/checkout`, { consentId: first.consent.id }))
        .body.error,
    ).toBe("preview_expired");
    expect(await replacementOperations(expired.caseId)).toEqual([]);

    const moved = await caseAwaitingConsent(app);
    const second = await previewAndConsent(moved.browser, moved.caseId, moved.recommendationId);
    await app.ctx.db.update(previews).set({ policyRevision: 99 }).where(eq(previews.id, second.preview.id));
    expect(
      (await moved.browser.post(`/api/cases/${moved.caseId}/checkout`, { consentId: second.consent.id })).body
        .error,
    ).toBe("stale_policy");
    expect(await replacementOperations(moved.caseId)).toEqual([]);
    expect(await transitionsOf(moved.caseId)).toEqual([]);
  });

  it("revokes the consent and buys nothing when the terms changed after the user saw them", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    app.paypal.planPriceMinor.set("P-B_02", 1500);
    const refused = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id });
    app.paypal.planPriceMinor.set("P-B_02", 1400);
    expect(refused.status).toBe(409);
    expect(providerBCreations(flow.caseId)).toEqual([]);
    expect(await replacementOperations(flow.caseId)).toEqual([]);
  });

  it("returns one operation, one transition and one remote subscription to simultaneous clicks", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () =>
        flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));

    const operationIds = new Set(
      responses.filter((response) => response.body.operationId).map((response) => response.body.operationId),
    );
    expect(operationIds.size).toBeLessThanOrEqual(1);
    const [operation, ...others] = await replacementOperations(flow.caseId);
    expect(others).toEqual([]);
    expect(operation).toMatchObject({
      kind: "replacement_create",
      merchant: "B",
      planId: "b_02",
      probe: false,
      status: "SUCCEEDED",
    });
    expect(await transitionsOf(flow.caseId)).toHaveLength(1);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);

    const [consumed] = await app.ctx.db.select().from(consents).where(eq(consents.id, consent.id));
    expect(consumed).toMatchObject({ consumedByOperationId: operation!.id });
    expect(operation!.authorityHash).toBe(consent.previewHash);

    const repeat = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id });
    expect(repeat.body.operationId).toBe(operation!.id);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });

  it("cannot reuse a consumed preview's authority for a second purchase", async () => {
    const flow = await caseAwaitingConsent(app);
    const purchase = await startPurchase(app, flow);
    const again = await flow.browser.post(`/api/cases/${flow.caseId}/consents`, {
      previewId: purchase.preview.id,
      previewHash: purchase.preview.previewHash,
      approvePurchase: true,
      approveOldExitAfterReadiness: true,
    });
    expect(again.status).toBe(409);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("AWAITING_PAYPAL");
  });

  it("stores the accepted terms, request body and stable request ID before anything is sent, and never changes them", async () => {
    const flow = await caseAwaitingConsent(app);
    const { preview, approval } = await startPurchase(app, flow);
    const [operation] = await replacementOperations(flow.caseId);
    const [transition] = await transitionsOf(flow.caseId);
    expect(transition!.acceptedPurchaseTerms).toEqual(preview.materialTerms);
    expect(operation).toMatchObject({ id: approval.operationId, transitionId: transition!.id });
    expect(operation!.requestId).toBeTruthy();
    expect(JSON.parse(operation!.requestBody!)).toMatchObject({
      plan_id: "P-B_02",
      custom_id: operation!.customId,
    });
    const request = providerBCreations(flow.caseId)[0]!;
    expect(request).toMatchObject({
      requestId: operation!.requestId,
      body: JSON.parse(operation!.requestBody!),
    });
  });

  it("replays an unknown creation with the stored request ID instead of buying again", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    app.paypal.loseNextCreateResponse = true;
    const first = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id });
    expect(first.body.jobId).toBeTruthy();

    await app.runJobs();
    const [operation] = await replacementOperations(flow.caseId);
    expect(operation).toMatchObject({ status: "SUCCEEDED", billingStatus: "APPROVAL_PENDING" });
    expect(providerBCreations(flow.caseId)).toHaveLength(2);
    expect(providerBCreations(flow.caseId)[1]).toEqual(providerBCreations(flow.caseId)[0]);
    expect(
      [...app.paypal.subscriptions.values()].filter(
        (subscription) => subscription.merchant === "B" && subscription.customId.startsWith(flow.caseId),
      ),
    ).toHaveLength(1);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("AWAITING_PAYPAL");
  });

  it("lets an expired preview stay irrelevant after purchase: the delayed return still completes against the accepted terms", async () => {
    const flow = await caseAwaitingConsent(app);
    const { preview, approval } = await startPurchase(app, flow);
    await app.ctx.db
      .update(previews)
      .set({ expiresAt: new Date(Date.now() - 6 * 60 * 1000) })
      .where(eq(previews.id, preview.id));
    await approvePurchaseAndReturn(app, flow, approval);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("COMPLETE");
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });
});
