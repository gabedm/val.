import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatorFor } from "../src/shared/contracts";
import {
  evidence,
  exitAuthorizations,
  exitReviews,
  jobs,
  operations,
  providerAccounts,
  providerTranscripts,
  transitions,
} from "../src/server/db/schema";
import { runCaseJob } from "../src/server/casework";
import { claimJob, runJob } from "../src/server/jobs";
import type { PaypalPlan } from "../src/server/paypal";
import { orderedExitTerms, sha256 } from "../src/server/validation";
import { reviewerLogin, startTestApp, type Browser, type TestApp } from "./helpers";
import {
  approvePurchaseAndReturn,
  cancelCallsFor,
  caseAwaitingConsent,
  putPolicy,
  returnCommandFor,
  snapshotOf,
  startPurchase,
} from "./scenarios";

// What Val checks, and what it refuses to do, before and between the old-provider exits. Real PostgreSQL and
// application; PayPal is the local stand-in with induced faults, so none of this is sandbox evidence.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

type Flow = Awaited<ReturnType<typeof caseAwaitingConsent>>;

const providerBCreations = (caseId: string) =>
  app.paypal.createRequests.filter(
    (request) => request.merchant === "B" && request.body.custom_id.startsWith(caseId),
  );
const operationOf = async (caseId: string, kind: string) =>
  (await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId))).find(
    (operation) => operation.kind === kind,
  );
const caseState = async (flow: Flow) => (await snapshotOf(flow.browser, flow.caseId)).case;
const reconcile = async (flow: Flow) => {
  await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
  await app.runJobs();
};
const setFault = (flow: Flow, fault: string, enabled: boolean) =>
  flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, { fault, enabled });

/** Checkout done, buyer not yet returned. The first exit step is made to fail so the case can change before the next one. */
async function purchaseWithFailingFirstExit() {
  const flow = await caseAwaitingConsent(app);
  const purchase = await startPurchase(app, flow);
  app.paypal.cancelsFail = true;
  try {
    await approvePurchaseAndReturn(app, flow, purchase.approval);
  } finally {
    app.paypal.cancelsFail = false;
  }
  expect((await caseState(flow)).state).toBe("ATTENTION_REQUIRED");
  return { ...flow, ...purchase };
}

async function reviewAndAuthorize(flow: Flow, transitionId: string) {
  const review = await flow.browser.post(`/api/cases/${flow.caseId}/exit-review`, { transitionId });
  expect(review.status).toBe(200);
  const authorized = await flow.browser.post(`/api/cases/${flow.caseId}/exit-authorizations`, {
    reviewId: review.body.id,
    reviewHash: review.body.reviewHash,
    approveRemainingExits: true,
  });
  expect(authorized.status).toBe(201);
  await app.runJobs();
  return { review: review.body, authorization: authorized.body };
}

describe("old billing and service exit as separate facts (T17, T18)", () => {
  it("does not touch Provider A's service until PayPal itself shows its billing CANCELLED, and retries the cancel after an outage", async () => {
    const flow = await purchaseWithFailingFirstExit();
    const failed = await snapshotOf(flow.browser, flow.caseId);
    expect(failed.case.reason).toBe("operation_failed");
    expect(failed.receipt).toMatchObject({
      duePayment: "VERIFIED",
      capability: "VERIFIED",
      history: "VERIFIED",
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
    });
    expect((await operationOf(flow.caseId, "cancel_old_billing"))!.status).toBe("UNKNOWN");
    expect(await operationOf(flow.caseId, "exit_old_service")).toBeUndefined();

    await reconcile(flow);
    const done = await snapshotOf(flow.browser, flow.caseId);
    expect(done.case.state).toBe("COMPLETE");
    expect(done.receipt).toMatchObject({ oldBilling: "CANCELLED", oldService: "EXIT_SCHEDULED" });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(2);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });

  it("reports stopped billing and unfinished service exit separately, retries only the exit and never restores billing", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await setFault(flow, "timeout", true);
    await approvePurchaseAndReturn(app, flow, approval);

    const partial = await snapshotOf(flow.browser, flow.caseId);
    expect(partial.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(partial.receipt).toMatchObject({ oldBilling: "CANCELLED", oldService: "ACTIVE" });
    expect(partial.receipt.message).toMatch(
      /billing is stopped.*service exit failed.*billing will not be restored/,
    );
    expect(app.paypal.subscriptions.get(flow.setupSubscriptionId)!.status).toBe("CANCELLED");

    await setFault(flow, "timeout", false);
    const exit = (await operationOf(flow.caseId, "exit_old_service"))!;
    expect(exit.status).toBe("FAILED");
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/retry`, { operationId: exit.id })).status,
    ).toBe(200);
    await app.runJobs();

    const done = await snapshotOf(flow.browser, flow.caseId);
    expect(done.receipt).toMatchObject({ oldBilling: "CANCELLED", oldService: "EXIT_SCHEDULED" });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });
});

/** Intercepts the live Provider B plan reads the exit gate makes once this case's replacement is verified. */
async function interceptGatePlanRead<T>(
  caseId: string,
  onGateRead: (plan: PaypalPlan) => Promise<void>,
  scenario: () => Promise<T>,
): Promise<T> {
  const client = app.ctx.paypal.B!;
  const original = client.getPlan.bind(client);
  client.getPlan = async (planId) => {
    const plan = await original(planId);
    const [transition] = await app.ctx.db.select().from(transitions).where(eq(transitions.caseId, caseId));
    if (transition?.capabilityStatus === "VERIFIED" && transition.historyStatus === "VERIFIED")
      await onGateRead(plan);
    return plan;
  };
  try {
    return await scenario();
  } finally {
    client.getPlan = original;
  }
}

const liveChanges: [string, (plan: PaypalPlan) => void][] = [
  ["status INACTIVE", (plan) => void (plan.status = "INACTIVE")],
  ["a bounded number of cycles", (plan) => void (plan.billing_cycles![0]!.total_cycles = 12)],
  ["a two-month interval", (plan) => void (plan.billing_cycles![0]!.frequency.interval_count = 2)],
  ["a trial tenure", (plan) => void (plan.billing_cycles![0]!.tenure_type = "TRIAL")],
  ["tax", (plan) => void (plan.taxes = { percentage: "20" })],
  [
    "a setup fee",
    (plan) => void (plan.payment_preferences = { setup_fee: { currency_code: "GBP", value: "5.00" } }),
  ],
];

describe("the dispatch boundary and the live plan (audit repairs)", () => {
  it("sends nothing when a policy change lands while readiness is being read, and resumes through review", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    let changed = false;
    await interceptGatePlanRead(
      flow.caseId,
      async () => {
        if (changed) return;
        changed = true;
        expect((await putPolicy(flow.browser, flow.caseId, 1)).status).toBe(200);
      },
      () => approvePurchaseAndReturn(app, flow, approval),
    );

    expect(changed).toBe(true);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect(await operationOf(flow.caseId, "cancel_old_billing")).toMatchObject({
      status: "PLANNED",
      dispatchedAt: null,
    });
    expect(await caseState(flow)).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });

    await reviewAndAuthorize(flow, (await snapshotOf(flow.browser, flow.caseId)).transition!.id);
    expect((await caseState(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });

  it("holds the service exit when a pause lands after billing was stopped, without restoring billing", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const transitionId = (await snapshotOf(flow.browser, flow.caseId)).transition!.id;
    let paused = false;
    await interceptGatePlanRead(
      flow.caseId,
      async () => {
        if (paused || (await operationOf(flow.caseId, "cancel_old_billing"))?.status !== "SUCCEEDED") return;
        paused = true;
        expect(
          (await flow.browser.post(`/api/cases/${flow.caseId}/pause-exits`, { transitionId })).status,
        ).toBe(200);
      },
      () => approvePurchaseAndReturn(app, flow, approval),
    );

    expect(paused).toBe(true);
    const held = await snapshotOf(flow.browser, flow.caseId);
    expect(held.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });
    expect(held.receipt).toMatchObject({ oldBilling: "CANCELLED", oldService: "ACTIVE" });
    expect(await operationOf(flow.caseId, "exit_old_service")).toMatchObject({ status: "PLANNED" });
    expect(
      (await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, flow.caseId))).some(
        (row) => row.kind === "service_exit",
      ),
    ).toBe(false);

    await reviewAndAuthorize(flow, transitionId);
    expect((await caseState(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });

  it.each(liveChanges)(
    "keeps Provider A when the live replacement plan gains %s",
    async (_change, change) => {
      const flow = await caseAwaitingConsent(app);
      const { approval } = await startPurchase(app, flow);
      let changed = false;
      await interceptGatePlanRead(
        flow.caseId,
        async (plan) => {
          changed = true;
          change(plan);
        },
        () => approvePurchaseAndReturn(app, flow, approval),
      );

      expect(changed).toBe(true);
      expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
      const snapshot = await snapshotOf(flow.browser, flow.caseId);
      expect(snapshot.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
      expect(snapshot.receipt).toMatchObject({ oldBilling: "ACTIVE", oldService: "ACTIVE" });
      expect(snapshot.receipt.message).toMatch(/live plan is not the accepted monthly plan/);
    },
  );

  it("lets a worker whose claim lapsed during the gate's reads send nothing, and the current worker finish exactly once", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId);
    await app.runJobs();
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );

    const stale = (await claimJob(app.ctx, "worker-1"))!;
    expect(stale.caseId).toBe(flow.caseId);
    let current: Awaited<ReturnType<typeof claimJob>> = null;
    await interceptGatePlanRead(
      flow.caseId,
      async () => {
        if (current) return;
        await app.ctx.db
          .update(jobs)
          .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
          .where(eq(jobs.id, stale.id));
        current = await claimJob(app.ctx, "worker-2");
      },
      () => runJob(app.ctx, stale, (job, commit) => runCaseJob(app.ctx, job, commit)),
    );

    expect(current).toMatchObject({ id: stale.id, claimGeneration: 2, claimOwner: "worker-2" });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect((await app.ctx.db.select().from(jobs).where(eq(jobs.id, stale.id)))[0]).toMatchObject({
      status: "RUNNING",
      claimOwner: "worker-2",
    });

    await runJob(app.ctx, current!, (job, commit) => runCaseJob(app.ctx, job, commit));
    expect((await caseState(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });
});
describe("concurrent workers (T19, T20)", () => {
  it("lets two workers advance the same transition without a second cancellation or exit", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    app.paypal.approve(approval.subscriptionId);
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);

    await Promise.all([app.runJobs(), app.runJobs(), app.runJobs()]);
    expect((await caseState(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    const exits = (
      await app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId))
    ).filter((operation) => operation.kind === "exit_old_service" || operation.kind === "cancel_old_billing");
    expect(exits.map((operation) => operation.status)).toEqual(["SUCCEEDED", "SUCCEEDED"]);
  });
});

describe("authority changes stop exits that have not been dispatched (T21)", () => {
  it("pauses on a policy change after purchase, then finishes through an exit-only review without buying again", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await putPolicy(flow.browser, flow.caseId, 1, {
      recurringCeiling: { currency: "GBP", amountMinor: 1600 },
    });
    await approvePurchaseAndReturn(app, flow, approval);

    const paused = await snapshotOf(flow.browser, flow.caseId);
    expect(paused.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });
    expect(paused.receipt).toMatchObject({
      duePayment: "VERIFIED",
      capability: "VERIFIED",
      history: "VERIFIED",
      oldBilling: "ACTIVE",
    });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);

    const { review, authorization } = await reviewAndAuthorize(flow, paused.transition!.id);
    expect(validatorFor("ExitReview")(review)).toBe(true);
    expect(validatorFor("ExitAuthorization")(authorization)).toBe(true);
    expect(review).toMatchObject({
      policyRevision: 2,
      materialTerms: {
        newSubscriptionId: approval.subscriptionId,
        remainingExits: ["old_billing", "old_service"],
      },
    });
    expect(review.readinessEvidenceIds).toHaveLength(3);
    const [stored] = await app.ctx.db.select().from(exitReviews).where(eq(exitReviews.id, review.id));
    expect(Object.keys(JSON.parse(stored!.hashPayload))).toEqual([
      "caseId",
      "ownerId",
      "transitionId",
      "policyRevision",
      "materialTerms",
    ]);
    expect(stored!.hashPayload).toContain(JSON.stringify(orderedExitTerms(review.materialTerms)));
    expect(sha256(stored!.hashPayload)).toBe(review.reviewHash);

    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("COMPLETE");
    const [used] = await app.ctx.db
      .select()
      .from(exitAuthorizations)
      .where(eq(exitAuthorizations.id, authorization.id));
    expect(used!.consumedAt).not.toBeNull();
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });

  it("refuses an authorization for another review hash, an expired review, or facts that moved since the review", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await putPolicy(flow.browser, flow.caseId, 1);
    await approvePurchaseAndReturn(app, flow, approval);
    const transitionId = (await snapshotOf(flow.browser, flow.caseId)).transition!.id;
    const review = (await flow.browser.post(`/api/cases/${flow.caseId}/exit-review`, { transitionId })).body;
    const authorize = (overrides: object = {}) =>
      flow.browser.post(`/api/cases/${flow.caseId}/exit-authorizations`, {
        reviewId: review.id,
        reviewHash: review.reviewHash,
        approveRemainingExits: true,
        ...overrides,
      });

    expect((await authorize({ reviewHash: "0".repeat(64) })).status).toBe(404);
    expect(
      (
        await flow.browser.post(`/api/cases/${flow.caseId}/exit-authorizations`, {
          reviewId: review.id,
          reviewHash: review.reviewHash,
          approveRemainingExits: false,
        })
      ).status,
    ).toBe(400);

    app.paypal.planPriceMinor.set("P-B_02", 1500);
    expect((await authorize()).body.error).toBe("terms_changed");
    app.paypal.planPriceMinor.set("P-B_02", 1400);

    await app.ctx.db
      .update(exitReviews)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(exitReviews.id, review.id));
    expect((await authorize()).body.error).toBe("review_expired");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect(
      await app.ctx.db
        .select()
        .from(exitAuthorizations)
        .where(eq(exitAuthorizations.transitionId, transitionId)),
    ).toEqual([]);
  });

  it("stops before the next step when Provider B's effective price changed after the exits were authorized", async () => {
    const flow = await purchaseWithFailingFirstExit();
    app.paypal.planPriceMinor.set("P-B_02", 1500);
    await reconcile(flow);
    app.paypal.planPriceMinor.set("P-B_02", 1400);

    expect(await caseState(flow)).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    expect(app.paypal.subscriptions.get(flow.setupSubscriptionId)!.status).toBe("ACTIVE");
  });

  it("stops when the imported history no longer matches the verified backup", async () => {
    const flow = await purchaseWithFailingFirstExit();
    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    await app.ctx.db
      .update(providerTranscripts)
      .set({ title: "Edited after import" })
      .where(
        and(
          eq(providerTranscripts.accountId, snapshot.case.replacementAccountId),
          eq(providerTranscripts.id, "history_001"),
        ),
      );
    await reconcile(flow);

    const stopped = await snapshotOf(flow.browser, flow.caseId);
    expect(stopped.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    expect(stopped.receipt.message).toMatch(/no longer matches the verified backup/);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
    const review = await flow.browser.post(`/api/cases/${flow.caseId}/exit-review`, {
      transitionId: stopped.transition!.id,
    });
    expect(review.status).toBe(409);
  });

  it("holds every exit while paused, and resumes only through a fresh review and authorization", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const transitionId = (await snapshotOf(flow.browser, flow.caseId)).transition!.id;
    const paused = await flow.browser.post(`/api/cases/${flow.caseId}/pause-exits`, { transitionId });
    expect(paused.status).toBe(200);
    expect(paused.body.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });

    await approvePurchaseAndReturn(app, flow, approval);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect((await snapshotOf(flow.browser, flow.caseId)).receipt).toMatchObject({
      duePayment: "VERIFIED",
      history: "VERIFIED",
      oldBilling: "ACTIVE",
    });

    await reviewAndAuthorize(flow, transitionId);
    expect((await caseState(flow)).state).toBe("COMPLETE");
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(1);
  });

  it("follows a Provider A renewal that PayPal can prove, and refuses one it cannot", async () => {
    const renewed = await caseAwaitingConsent(app);
    const purchase = await startPurchase(app, renewed);
    app.paypal.renew(renewed.setupSubscriptionId);
    await approvePurchaseAndReturn(app, renewed, purchase.approval);
    const stopped = await snapshotOf(renewed.browser, renewed.caseId);
    expect(stopped.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "authority_changed" });
    expect(cancelCallsFor(app, renewed.setupSubscriptionId)).toHaveLength(0);

    const { review } = await reviewAndAuthorize(renewed, stopped.transition!.id);
    expect(Date.parse(review.materialTerms.oldAccessEndsAt)).toBeGreaterThan(
      Date.parse(purchase.preview.materialTerms.oldAccessEndsAt),
    );
    const done = await snapshotOf(renewed.browser, renewed.caseId);
    expect(done.case.state).toBe("COMPLETE");
    expect(done.receipt.oldAccessEndsAt).toBe(review.materialTerms.oldAccessEndsAt);

    const unproven = await caseAwaitingConsent(app);
    const second = await startPurchase(app, unproven);
    app.paypal.renew(unproven.setupSubscriptionId, { withoutTransaction: true });
    await approvePurchaseAndReturn(app, unproven, second.approval);
    expect(await caseState(unproven)).toMatchObject({
      state: "ATTENTION_REQUIRED",
      reason: "operation_failed",
    });
    const transitionId = (await snapshotOf(unproven.browser, unproven.caseId)).transition!.id;
    expect(
      (await unproven.browser.post(`/api/cases/${unproven.caseId}/exit-review`, { transitionId })).status,
    ).toBe(409);
    expect(cancelCallsFor(app, unproven.setupSubscriptionId)).toHaveLength(0);
  });
});

describe("reset, isolation and cleanup (T24)", () => {
  it("archives for navigation only: the earlier purchase finishes under its accepted authority", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const [openBefore] = await app.ctx.db
      .select()
      .from(transitions)
      .where(eq(transitions.caseId, flow.caseId));

    expect(
      (
        await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
          acknowledgeEarlierTransitionContinues: false,
        })
      ).status,
    ).toBe(400);
    const reset = await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    expect(reset.status).toBe(201);
    expect(reset.body.case).toMatchObject({ state: "SETUP", archivedAt: null });
    expect(reset.body.case.id).not.toBe(flow.caseId);

    const [openAfter] = await app.ctx.db
      .select()
      .from(transitions)
      .where(eq(transitions.caseId, flow.caseId));
    expect(openAfter).toMatchObject({
      exitsPausedAt: null,
      closedAt: null,
      exitAuthorizationId: null,
      state: openBefore!.state,
    });

    await approvePurchaseAndReturn(app, flow, approval);
    const earlier = await snapshotOf(flow.browser, flow.caseId);
    expect(earlier.case).toMatchObject({ state: "COMPLETE" });
    expect(earlier.case.archivedAt).not.toBeNull();

    const listed = (await flow.browser.get("/api/cases")).body as {
      id: string;
      archivedAt: string | null;
      state: string;
    }[];
    expect(listed.find((item) => item.id === flow.caseId)).toMatchObject({ state: "COMPLETE" });
    expect(listed.find((item) => item.id === reset.body.case.id)).toMatchObject({
      state: "SETUP",
      archivedAt: null,
    });
    expect(providerBCreations(flow.caseId)).toHaveLength(1);
  });

  it("keeps an archived transition and retry reachable only by its owner without changing billing", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await setFault(flow, "timeout", true);
    await approvePurchaseAndReturn(app, flow, approval);
    await setFault(flow, "timeout", false);

    const failed = await snapshotOf(flow.browser, flow.caseId);
    expect(failed.case).toMatchObject({ state: "ATTENTION_REQUIRED", reason: "operation_failed" });
    const transitionId = failed.transition!.id;
    const exit = (await operationOf(flow.caseId, "exit_old_service"))!;
    expect(exit.status).toBe("FAILED");

    const beforeReset = {
      operations: await app.ctx.db
        .select()
        .from(operations)
        .where(eq(operations.caseId, flow.caseId))
        .orderBy(operations.id),
      evidence: await app.ctx.db
        .select()
        .from(evidence)
        .where(eq(evidence.caseId, flow.caseId))
        .orderBy(evidence.id),
      transition: await app.ctx.db
        .select()
        .from(transitions)
        .where(eq(transitions.caseId, flow.caseId))
        .orderBy(transitions.id),
      billing: [flow.setupSubscriptionId, approval.subscriptionId].map(
        (id) => app.paypal.subscriptions.get(id)!.status,
      ),
      cancellations: cancelCallsFor(app, flow.setupSubscriptionId).length,
    };
    expect(beforeReset.transition).toHaveLength(1);
    expect(beforeReset.transition[0]!.closedAt).toBeNull();
    expect(beforeReset.evidence.some((item) => item.kind === "payment")).toBe(true);

    const reset = await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    expect(reset.status).toBe(201);
    const freshCaseId = reset.body.case.id as string;
    const archived = await snapshotOf(flow.browser, flow.caseId);
    expect(archived.case.archivedAt).not.toBeNull();
    expect(archived.transition?.id).toBe(transitionId);
    expect(
      await app.ctx.db
        .select()
        .from(operations)
        .where(eq(operations.caseId, flow.caseId))
        .orderBy(operations.id),
    ).toEqual(beforeReset.operations);
    expect(
      await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, flow.caseId)).orderBy(evidence.id),
    ).toEqual(beforeReset.evidence);
    expect(
      await app.ctx.db
        .select()
        .from(transitions)
        .where(eq(transitions.caseId, flow.caseId))
        .orderBy(transitions.id),
    ).toEqual(beforeReset.transition);
    expect(await app.ctx.db.select().from(operations).where(eq(operations.caseId, freshCaseId))).toEqual([]);
    expect(await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, freshCaseId))).toEqual([]);
    expect(
      [flow.setupSubscriptionId, approval.subscriptionId].map(
        (id) => app.paypal.subscriptions.get(id)!.status,
      ),
    ).toEqual(beforeReset.billing);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(beforeReset.cancellations);

    const stranger = app.browser();
    await stranger.login(reviewerLogin);
    expect((await stranger.get(`/api/cases/${flow.caseId}`)).status).toBe(404);
    expect((await stranger.get(`/api/cases/${flow.caseId}/evidence`)).status).toBe(404);
    expect((await stranger.post(`/api/cases/${flow.caseId}/retry`, { operationId: exit.id })).status).toBe(
      404,
    );

    const retry = await flow.browser.post(`/api/cases/${flow.caseId}/retry`, { operationId: exit.id });
    expect(retry.status).toBe(200);
    await app.runJobs();
    expect((await snapshotOf(flow.browser, flow.caseId)).case).toMatchObject({ state: "COMPLETE" });
  });

  it("keeps every purchase command inside the owning account", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent, preview, approval } = await startPurchase(app, flow);
    await approvePurchaseAndReturn(app, flow, approval);
    const transitionId = (await snapshotOf(flow.browser, flow.caseId)).transition!.id;

    const stranger: Browser = app.browser();
    await stranger.login(reviewerLogin);
    const attempts = [
      stranger.post(`/api/cases/${flow.caseId}/preview`, { recommendationId: flow.recommendationId }),
      stranger.post(`/api/cases/${flow.caseId}/consents`, {
        previewId: preview.id,
        previewHash: preview.previewHash,
        approvePurchase: true,
        approveOldExitAfterReadiness: true,
      }),
      stranger.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id }),
      stranger.post(`/api/cases/${flow.caseId}/decline`),
      stranger.post(`/api/cases/${flow.caseId}/exit-review`, { transitionId }),
      stranger.post(`/api/cases/${flow.caseId}/pause-exits`, { transitionId }),
      stranger.post(`/api/cases/${flow.caseId}/retry`, { operationId: approval.operationId }),
      stranger.post(`/api/cases/${flow.caseId}/reset`, { acknowledgeEarlierTransitionContinues: true }),
      stranger.get(`/api/cases/${flow.caseId}`),
    ];
    expect((await Promise.all(attempts)).map((response) => response.status)).toEqual(Array(9).fill(404));
    const evidenceArtifact = (await flow.browser.get(`/api/cases/${flow.caseId}/evidence`)).body.find(
      (item: { artifactId: string | null }) => item.artifactId,
    );
    expect((await stranger.get(`/api/artifacts/${evidenceArtifact.artifactId}`)).status).toBe(404);
    expect(
      (
        await stranger.post(`/api/admin/operations/${approval.operationId}/cleanup`, {
          expectedClaimGeneration: 0,
        })
      ).status,
    ).toBe(403);
  });

  it("retires only observed terminal resources of archived, idle cases, and never touches the transition", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const operation = (await operationOf(flow.caseId, "replacement_create"))!;
    const cleanup = (expectedClaimGeneration = operation.claimGeneration) =>
      flow.browser.post(`/api/admin/operations/${operation.id}/cleanup`, { expectedClaimGeneration });

    expect((await cleanup()).body.error).toBe("not_archived");
    await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    await app.runJobs();
    expect((await cleanup()).body.error).toBe("not_terminal");

    app.paypal.approve(approval.subscriptionId, { withoutTransaction: true });
    expect((await cleanup()).body.error).toBe("not_terminal");
    expect(app.paypal.subscriptions.get(approval.subscriptionId)!.status).toBe("ACTIVE");
  });

  it("retires an expired, idle resource while leaving the receipt, evidence and closed transition as they were", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    app.paypal.subscriptions.get(approval.subscriptionId)!.status = "EXPIRED";
    await reconcile(flow);

    const operation = (await operationOf(flow.caseId, "replacement_create"))!;
    const before = {
      transition: (await app.ctx.db.select().from(transitions).where(eq(transitions.caseId, flow.caseId)))[0],
      evidence: (await snapshotOf(flow.browser, flow.caseId)).receipt,
    };
    const cleanup = (expectedClaimGeneration: number) =>
      flow.browser.post(`/api/admin/operations/${operation.id}/cleanup`, { expectedClaimGeneration });

    expect((await cleanup(operation.claimGeneration + 1)).body.error).toBe("stale_claim");
    await flow.browser.post(`/api/cases/${flow.caseId}/reconcile`);
    expect((await cleanup(operation.claimGeneration)).body.error).toBe("job_active");
    await app.runJobs();

    const retired = await cleanup(operation.claimGeneration);
    expect(retired.status).toBe(200);
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.id, operation.id)))[0]!.retiredAt,
    ).not.toBeNull();
    expect(
      (await app.ctx.db.select().from(transitions).where(eq(transitions.caseId, flow.caseId)))[0],
    ).toEqual(before.transition);
    expect((await snapshotOf(flow.browser, flow.caseId)).receipt).toEqual(before.evidence);
    expect(cancelCallsFor(app, approval.subscriptionId)).toHaveLength(0);

    const unresolved = (await flow.browser.get("/api/admin/operations")).body as { id: string }[];
    expect(unresolved.some((item) => item.id === operation.id)).toBe(false);
    await app.runJobs();
    expect(
      await app.ctx.db
        .select()
        .from(jobs)
        .where(and(eq(jobs.caseId, flow.caseId), eq(jobs.status, "RUNNING"))),
    ).toEqual([]);
  });

  it("includes the archived case's open transition in background reconciliation", async () => {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    app.paypal.approve(approval.subscriptionId);
    await flow.browser.post(
      `/api/cases/${flow.caseId}/checkout/return`,
      await returnCommandFor(app, approval.operationId),
    );
    await app.runJobs();
    expect((await caseState(flow)).state).toBe("COMPLETE");
    const [account] = await app.ctx.db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, (await snapshotOf(flow.browser, flow.caseId)).case.initialAccountId));
    expect(account!.accessStatus).toBe("EXIT_SCHEDULED");
  });
});
