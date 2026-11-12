import { eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validate } from "../src/shared/contracts";
import {
  evidence,
  operations,
  providerAccounts,
  providerTranscripts,
  transitions,
} from "../src/server/db/schema";
import { readTranscripts } from "../src/server/providers";
import { buildManifest } from "../src/server/validation";
import { startTestApp, type TestApp } from "./helpers";
import { Recovery } from "../src/client/Purchase";
import {
  approvePurchaseAndReturn,
  cancelCallsFor,
  caseAwaitingConsent,
  previewAndConsent,
  putPolicy,
  returnCommandFor,
  snapshotOf,
  startPurchase,
  valueAwaitingConsent,
} from "./scenarios";

// The Provider B purchase and everything Val verifies before Provider A is touched. Real PostgreSQL and application;
// PayPal is the local stand-in with induced faults, so these results are not sandbox evidence.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

const providerBCreations = (caseId: string) =>
  app.paypal.createRequests.filter(
    (request) => request.merchant === "B" && request.body.custom_id.startsWith(caseId),
  );
const operationsOf = (caseId: string) =>
  app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
const kindOf = (caseId: string, kind: string) =>
  operationsOf(caseId).then((rows) => rows.find((row) => row.kind === kind));
const evidenceOf = (caseId: string) =>
  app.ctx.db.select().from(evidence).where(eq(evidence.caseId, caseId)).orderBy(evidence.observedAt);
const accountOf = async (accountId: string) =>
  (await app.ctx.db.select().from(providerAccounts).where(eq(providerAccounts.id, accountId)))[0]!;

/** Consent, checkout, buyer approval and the work that follows, leaving the purchase in whatever state it reaches. */
async function purchased(
  options: { beforeReturn?: (flow: Awaited<ReturnType<typeof caseAwaitingConsent>>) => Promise<void> } = {},
) {
  const flow = await caseAwaitingConsent(app);
  const purchase = await startPurchase(app, flow);
  await options.beforeReturn?.(flow);
  await approvePurchaseAndReturn(app, flow, purchase.approval);
  return { ...flow, ...purchase };
}

const stateOf = async (flow: { browser: Parameters<typeof snapshotOf>[0]; caseId: string }) =>
  (await snapshotOf(flow.browser, flow.caseId)).case;

describe("the authorized switch (G2 locally; T26 needs the real sandbox)", () => {
  it("keeps Provider A until Provider B is paid and verified, then stops A's billing and schedules its exit in order", async () => {
    const flow = await caseAwaitingConsent(app);
    const { preview, approval } = await startPurchase(app, flow);

    const waiting = await snapshotOf(flow.browser, flow.caseId);
    expect(waiting.case.state).toBe("AWAITING_PAYPAL");
    expect(waiting.receipt).toMatchObject({
      newBillingStatus: "APPROVAL_PENDING",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
      duePayment: "NOT_STARTED",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    await approvePurchaseAndReturn(app, flow, approval);
    const done = await snapshotOf(flow.browser, flow.caseId);
    expect(validate.caseSnapshot(done)).toBe(true);
    expect(done.case.state).toBe("COMPLETE");
    expect(done.transition).toMatchObject({
      state: "COMPLETE",
      newSubscriptionId: approval.subscriptionId,
      oldSubscriptionId: flow.setupSubscriptionId,
      acceptedPurchaseTerms: preview.materialTerms,
    });
    expect(done.receipt).toMatchObject({
      newBillingStatus: "ACTIVE",
      duePayment: "VERIFIED",
      capability: "VERIFIED",
      history: "VERIFIED",
      oldBilling: "CANCELLED",
      oldService: "EXIT_SCHEDULED",
      oldAccessEndsAt: preview.materialTerms.oldAccessEndsAt,
    });
    expect(done.receipt.message).toMatch(/access is scheduled to end/);

    const rows = await evidenceOf(flow.caseId);
    for (const [field, kind] of [
      ["paymentEvidenceId", "payment"],
      ["capabilityEvidenceId", "sample"],
      ["historyEvidenceId", "import"],
    ] as const) {
      expect(rows.find((row) => row.id === done.receipt[field])?.kind).toBe(kind);
    }
    const billingStopped = rows.findIndex(
      (row) =>
        row.kind === "subscription" &&
        row.summary.includes(`${flow.setupSubscriptionId} (merchant A`) &&
        row.summary.endsWith("CANCELLED."),
    );
    const serviceExit = rows.findIndex((row) => row.kind === "service_exit");
    expect(billingStopped).toBeGreaterThan(-1);
    expect(serviceExit).toBeGreaterThan(billingStopped);

    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    expect(cancelCallsFor(app, approval.subscriptionId)).toHaveLength(0);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect(app.paypal.subscriptions.get(approval.subscriptionId)!.status).toBe("ACTIVE");
    expect(app.paypal.subscriptions.get(flow.setupSubscriptionId)!.status).toBe("CANCELLED");
  });

  it("proves preservation from Provider B's own content and schedules the exit at the saved boundary", async () => {
    const flow = await purchased();
    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    const source = buildManifest(await readTranscripts(app.ctx.db, snapshot.case.initialAccountId));
    const destination = buildManifest(await readTranscripts(app.ctx.db, snapshot.case.replacementAccountId));
    expect(destination).toEqual(source);
    expect(destination.manifestDigest).toBe(flow.preview.materialTerms.backupManifestDigest);

    expect(await accountOf(snapshot.case.initialAccountId)).toMatchObject({
      accessStatus: "EXIT_SCHEDULED",
      accessEndsAt: new Date(flow.preview.materialTerms.oldAccessEndsAt),
    });
    expect(await accountOf(snapshot.case.replacementAccountId)).toMatchObject({
      accessStatus: "ACTIVE",
      planId: "b_02",
      subscriptionId: flow.approval.subscriptionId,
    });
    const imports = await kindOf(flow.caseId, "import");
    const exit = await kindOf(flow.caseId, "exit_old_service");
    expect([imports?.status, exit?.status]).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });
});

describe("paid introductory value switch (isolated local stand-ins)", () => {
  it("keeps Original service until the exact positive payment, subscribed output and history pass, then bills the stated renewals", async () => {
    const flow = await valueAwaitingConsent(app);
    const { preview, consent, approval } = await startPurchase(app, flow);
    expect(preview.materialTerms).toMatchObject({
      dueNow: { amountMinor: 600 },
      recurring: { amountMinor: 900 },
      offer: { introductoryCycles: 3 },
    });
    expect(new Date(preview.materialTerms.offer!.validFrom).getUTCMilliseconds()).toBe(0);
    expect(new Date(preview.materialTerms.offer!.eligibleUntil).getUTCMilliseconds()).toBe(0);
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id })).body
        .operationId,
    ).toBe(approval.operationId);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    app.paypal.approve(approval.subscriptionId, { withoutTransaction: true });
    expect(
      (
        await flow.browser.post(
          `/api/cases/${flow.caseId}/checkout/return`,
          await returnCommandFor(app, approval.operationId),
        )
      ).status,
    ).toBe(200);
    await app.runJobs();
    const pending = await snapshotOf(flow.browser, flow.caseId);
    expect(pending.receipt).toMatchObject({
      newBillingStatus: "ACTIVE",
      duePayment: "PENDING",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    app.paypal.approve(approval.subscriptionId);
    expect((await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`)).status).toBe(200);
    await app.runJobs();
    const completed = await snapshotOf(flow.browser, flow.caseId);
    expect(
      completed.case.state,
      JSON.stringify({
        reason: completed.case.reason,
        receipt: completed.receipt,
        error: completed.transition?.lastError,
      }),
    ).toBe("COMPLETE");
    expect(completed.transition?.acceptedPurchaseTerms).toEqual(preview.materialTerms);
    expect(completed.receipt).toMatchObject({
      duePayment: "VERIFIED",
      capability: "VERIFIED",
      history: "VERIFIED",
      oldBilling: "CANCELLED",
      oldService: "EXIT_SCHEDULED",
      oldAccessEndsAt: preview.materialTerms.oldAccessEndsAt,
    });
    const renderReceipt = (snapshot: typeof completed) =>
      renderToStaticMarkup(createElement(Recovery, { snapshot, refresh: async () => {} }));
    const receipt = renderReceipt(completed);
    expect(receipt).toContain("Outcome receipt");
    expect(receipt).toContain("Margin Value is ready. Original service billing stopped.");
    expect(receipt).toContain("End scheduled");
    expect(receipt).not.toContain("Original service access has ended");
    for (const receiptPatch of [
      { paymentEvidenceId: null },
      { capabilityEvidenceId: null },
      { historyEvidenceId: null },
      { newSubscriptionId: null },
      { oldBilling: "ACTIVE" as const },
      { oldAccessEndsAt: null },
    ]) {
      const incomplete = renderReceipt({ ...completed, receipt: { ...completed.receipt, ...receiptPatch } });
      expect(incomplete).toContain("Some steps need checking.");
      expect(incomplete).not.toContain("Outcome receipt");
      expect(incomplete).not.toContain("Margin Value is ready. Original service billing stopped.");
    }
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect(app.paypal.planPriceMinor.get("P-A_01")).toBe(1200);
    for (let cycle = 0; cycle < 3; cycle++) app.paypal.renew(approval.subscriptionId);
    const charged = app.paypal.subscriptions
      .get(approval.subscriptionId)!
      .transactions.map((row: any) => row.amount_with_breakdown.gross_amount.value);
    expect(charged).toEqual(["6.00", "6.00", "6.00", "9.00"]);
  });

  it("keeps Original service billing active when an ACTIVE introductory subscription lacks a completed first payment", async () => {
    const flow = await valueAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId, { gross: "0.00" });
    expect(
      (
        await flow.browser.post(
          `/api/cases/${flow.caseId}/checkout/return`,
          await returnCommandFor(app, approval.operationId),
        )
      ).status,
    ).toBe(200);
    await app.runJobs();
    expect((await snapshotOf(flow.browser, flow.caseId)).receipt).toMatchObject({
      newBillingStatus: "ACTIVE",
      duePayment: "FAILED",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
  });

  it("cannot spend an earlier unconsumed approval if the live regular renewal changes", async () => {
    const flow = await valueAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    expect(consent.consumedByOperationId).toBeNull();
    app.paypal.planPriceMinor.set("P-B_03", 1000);
    try {
      const checkout = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, {
        consentId: consent.id,
      });
      expect(checkout.status).toBe(409);
      expect(
        (
          await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
            recommendationId: flow.recommendationId,
          })
        ).status,
      ).toBe(409);
      expect(providerBCreations(flow.caseId)).toHaveLength(0);
      expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    } finally {
      app.paypal.planPriceMinor.set("P-B_03", 900);
    }
  });
});

describe("after completion", () => {
  it("stays complete when a later policy revision is confirmed", async () => {
    const flow = await purchased();
    expect((await putPolicy(flow.browser, flow.caseId, 1)).body.revision).toBe(2);
    expect((await stateOf(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });
});

describe("Provider A is kept while anything is unproven", () => {
  it("does nothing to Provider A when Provider B's initial payment is the wrong amount", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId, { gross: "13.00" });
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );
    await app.runJobs();

    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(snapshot.receipt).toMatchObject({
      newSubscriptionId: approval.subscriptionId,
      duePayment: "FAILED",
      capability: "NOT_STARTED",
      history: "NOT_STARTED",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect((await evidenceOf(flow.caseId)).some((row) => row.kind === "service_exit")).toBe(false);
  });

  it("waits while Provider B is ACTIVE without a recorded payment, then completes once PayPal shows it", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId, { withoutTransaction: true });
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("AWAITING_PAYPAL");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    app.paypal.approve(approval.subscriptionId);
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("COMPLETE");
  });

  it("keeps the paid Provider B visible and Provider A active when the subscribed output fails, until an explicit retry (T14)", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, {
      fault: "output_failure",
      enabled: true,
    });
    await approvePurchaseAndReturn(app, flow, approval);

    const failed = await snapshotOf(flow.browser, flow.caseId);
    expect(failed.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(failed.receipt).toMatchObject({
      newBillingStatus: "ACTIVE",
      duePayment: "VERIFIED",
      capability: "FAILED",
      history: "NOT_STARTED",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect(failed.receipt.message).toMatch(/subscribed output failed.*Provider A is kept/);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    const samples = (await evidenceOf(flow.caseId)).filter((row) => row.kind === "sample").length;
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await app.runJobs();
    expect((await evidenceOf(flow.caseId)).filter((row) => row.kind === "sample").length).toBe(samples);

    await flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, {
      fault: "output_failure",
      enabled: false,
    });
    const retried = await flow.browser.post(`/api/cases/${flow.caseId}/retry`, {
      operationId: approval.operationId,
    });
    expect(retried.status).toBe(200);
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("COMPLETE");
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });

  it("keeps Provider A and shows the existing purchase when the history import fails, then recovers by retrying only the import (T13)", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, {
      fault: "import_failure",
      enabled: true,
    });
    await approvePurchaseAndReturn(app, flow, approval);

    const failed = await snapshotOf(flow.browser, flow.caseId);
    expect(failed.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(failed.receipt).toMatchObject({
      duePayment: "VERIFIED",
      capability: "VERIFIED",
      history: "FAILED",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect(
      await app.ctx.db
        .select()
        .from(providerTranscripts)
        .where(eq(providerTranscripts.accountId, failed.case.replacementAccountId)),
    ).toHaveLength(0);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    const importOperation = (await kindOf(flow.caseId, "import"))!;
    expect(importOperation.status).toBe("FAILED");
    await flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, {
      fault: "import_failure",
      enabled: false,
    });
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/retry`, { operationId: importOperation.id }))
        .status,
    ).toBe(200);
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("COMPLETE");
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });

  it("refuses to retry work that is neither failed nor unknown", async () => {
    const flow = await purchased();
    const activation = (await kindOf(flow.caseId, "activate_account"))!;
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/retry`, { operationId: activation.id })).body.error,
    ).toBe("not_recoverable");
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/retry`, { operationId: "unknown" })).status,
    ).toBe(404);
  });

  it("will not test Provider B's output again when sample testing is no longer permitted", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await putPolicy(flow.browser, flow.caseId, 1, { allowInvestigation: false });
    await approvePurchaseAndReturn(app, flow, approval);

    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "permission_required" });
    expect(snapshot.receipt).toMatchObject({
      duePayment: "VERIFIED",
      capability: "NOT_STARTED",
      oldBilling: "ACTIVE",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
  });
});

describe("pending, abandoned and cancelled approvals (T15)", () => {
  it("treats a cancel return as nothing: the approval stays open and a second checkout reopens the same link", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent, approval } = await startPurchase(app, flow);
    const cancelled = await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId, "cancelled"),
    );
    expect(cancelled.status).toBe(200);
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("AWAITING_PAYPAL");
    expect(app.paypal.subscriptions.get(approval.subscriptionId)!.status).toBe("APPROVAL_PENDING");

    const again = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id });
    expect(again.body).toMatchObject({
      operationId: approval.operationId,
      subscriptionId: approval.subscriptionId,
      approvalUrl: approval.approvalUrl,
    });
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });

  it("flags an approval left unfinished for 30 minutes without cancelling it, and still finishes when the buyer approves", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await app.ctx.db
      .update(operations)
      .set({ createdAt: new Date(Date.now() - 31 * 60 * 1000) })
      .where(eq(operations.id, approval.operationId));
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await app.runJobs();
    expect(await stateOf(flow)).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "approval_unresolved" });
    expect(cancelCallsFor(app, approval.subscriptionId)).toHaveLength(0);

    await approvePurchaseAndReturn(app, flow, approval);
    expect((await stateOf(flow)).state).toBe("COMPLETE");
  });

  it("returns to monitoring only when PayPal shows the unapproved subscription expired, and then allows a deliberate new purchase", async () => {
    const flow = await caseAwaitingConsent(app);
    const first = await startPurchase(app, flow);
    app.paypal.subscriptions.get(first.approval.subscriptionId)!.status = "EXPIRED";
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await app.runJobs();
    expect((await stateOf(flow)).state).toBe("MONITORING");
    const [closed] = await app.ctx.db
      .select()
      .from(transitions)
      .where(eq(transitions.id, (await kindOf(flow.caseId, "replacement_create"))!.transitionId!));
    expect(closed!.closedAt).not.toBeNull();

    await flow.browser.post(`/api/cases/${flow.caseId}/check`, { expectedPolicyRevision: 1 });
    await app.runJobs();
    const next = (await snapshotOf(flow.browser, flow.caseId)).recommendation!;
    expect(next).toMatchObject({ action: "switch", candidateId: "b_02" });
    expect(next.id).not.toBe(flow.recommendationId);
    const second = await startPurchase(app, { ...flow, recommendationId: next.id });
    expect(second.approval.operationId).not.toBe(first.approval.operationId);
    await approvePurchaseAndReturn(app, flow, second.approval);
    expect((await stateOf(flow)).state).toBe("COMPLETE");
    expect(providerBCreations(flow.caseId)).toHaveLength(2);
  });

  it("keeps an approved Provider B visible as an existing transition if it is later cancelled, and never repurchases it", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent, approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId, { withoutTransaction: true });
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );
    await app.runJobs();
    app.paypal.subscriptions.get(approval.subscriptionId)!.status = "CANCELLED";
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await app.runJobs();

    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(snapshot.transition).toMatchObject({ newSubscriptionId: approval.subscriptionId });
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id })).status,
    ).toBe(409);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
  });
});
