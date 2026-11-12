import { and, count, eq } from "drizzle-orm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Home, dashboardStatus } from "../src/client/Home";
import { Options } from "../src/client/Options";
import { ReviewSwitch, reviewBenefit, reviewValue } from "../src/client/Purchase";
import {
  checkedFeatures,
  fitReason,
  freshQuote,
  handoverFacts,
  monthlyDifference,
  shouldPollCase,
  supportedChoice,
} from "../src/client/ui";
import {
  validate,
  validatorFor,
  type CandidateQuote,
  type CapabilityResult,
  type CaseSnapshot,
  type Receipt,
} from "../src/shared/contracts";
import { evidence, jobs, operations } from "../src/server/db/schema";
import { dispatchCreation } from "../src/server/operations";
import { reconcileSubscription } from "../src/server/reconcile";
import type { Commit } from "../src/server/jobs";
import type { ApprovalOptions } from "./paypal-standin";
import {
  adminLogin,
  newCase,
  reviewerLogin,
  startSetup,
  startTestApp,
  type Browser,
  type TestApp,
} from "./helpers";
import { caseAwaitingConsent, valueAwaitingConsent } from "./scenarios";

// These tests run the real application and PostgreSQL against a local PayPal stand-in (tests/paypal-standin.ts).
// They prove Val's contracts and fault handling; they are not PayPal sandbox evidence.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

async function loadOperation(operationId: string) {
  const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.id, operationId));
  return operation!;
}

/** What PayPal would append to the return URL: Val's token plus PayPal's own subscription_id hint. */
async function returnCommand(
  operationId: string,
  outcome: "approved" | "cancelled" = "approved",
  hint?: string | null,
) {
  const operation = await loadOperation(operationId);
  const returnUrl = new URL(JSON.parse(operation.requestBody!).application_context.return_url);
  return {
    operationId,
    returnToken: returnUrl.searchParams.get("return_token")!,
    subscriptionId: hint === undefined ? operation.remoteId : hint,
    outcome,
  };
}

const jobCount = async (caseId: string) =>
  (await app.ctx.db.select({ total: count() }).from(jobs).where(eq(jobs.caseId, caseId)))[0]!.total;

/** Buyer approves and pays at PayPal, the browser returns, and Val reconciles. */
async function approveAndReturn(setup: { browser: Browser; caseId: string }, options?: ApprovalOptions) {
  const { operationId, subscriptionId } = await startSetup(setup.browser, setup.caseId);
  app.paypal.approve(subscriptionId, options);
  const response = await setup.browser.post(
    `/api/cases/${setup.caseId}/setup-subscription/return`,
    await returnCommand(operationId),
  );
  expect(response.status).toBe(200);
  await app.runJobs();
  return { operationId, subscriptionId };
}

const snapshotOf = async (browser: Browser, caseId: string) =>
  (await browser.get(`/api/cases/${caseId}`)).body;
const renderHome = (snapshot: CaseSnapshot) =>
  renderToStaticMarkup(
    createElement(Home, { snapshot, loading: false, failure: "", refresh: async () => undefined }),
  );

describe("A setup subscription creation", () => {
  it("creates one subscription from the stored plan, with a case/operation custom_id and Val's return URLs", async () => {
    const { browser, caseId } = await newCase(app);
    const approval = await startSetup(browser, caseId);

    expect(validatorFor("ApprovalResult")(approval)).toBe(true);
    expect(new URL(approval.approvalUrl).origin).toBe("https://www.sandbox.paypal.com");

    const request = app.paypal.createRequests.find(
      (candidate) => candidate.body.custom_id === `${caseId}.${approval.operationId}`,
    )!;
    expect(request.merchant).toBe("A");
    expect(request.body.plan_id).toBe("P-A_01");
    expect(request.body.application_context).toMatchObject({
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
      locale: "en-GB",
    });
    const returnUrl = new URL(request.body.application_context.return_url);
    expect(returnUrl.origin + returnUrl.pathname).toBe(`${app.origin}/paypal/setup/return`);
    expect(returnUrl.searchParams.get("caseId")).toBe(caseId);
    expect(returnUrl.searchParams.get("operationId")).toBe(approval.operationId);
    expect(new URL(request.body.application_context.cancel_url).pathname).toBe("/paypal/setup/cancel");

    const operation = await loadOperation(approval.operationId);
    expect(operation).toMatchObject({
      status: "SUCCEEDED",
      merchant: "A",
      planId: "a_01",
      remoteId: approval.subscriptionId,
      billingStatus: "APPROVAL_PENDING",
      paymentStatus: "NOT_STARTED",
    });
    expect(operation.returnTokenHash).toMatch(/^[a-f0-9]{64}$/);
    expect(operation.returnTokenHash).not.toContain(returnUrl.searchParams.get("return_token")!);
  });

  it("returns the same operation to simultaneous and repeated clicks and creates one remote subscription", async () => {
    const { browser, caseId } = await newCase(app);
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => browser.post(`/api/cases/${caseId}/setup-subscription`)),
    );
    expect(responses.map((response) => response.status)).toEqual(Array(6).fill(200));

    const operationIds = new Set(
      responses.filter((response) => response.body.operationId).map((response) => response.body.operationId),
    );
    const queuedJobIds = new Set(
      responses.filter((response) => response.body.jobId).map((response) => response.body.jobId),
    );
    expect(operationIds.size).toBeLessThanOrEqual(1);
    expect(queuedJobIds.size).toBeLessThanOrEqual(1);

    const repeat = await startSetup(browser, caseId);
    expect(operationIds.size === 0 || operationIds.has(repeat.operationId)).toBe(true);
    expect(
      app.paypal.createRequests.filter((request) => request.body.custom_id.startsWith(caseId)),
    ).toHaveLength(1);
    const [operationRows] = await app.ctx.db
      .select({ total: count() })
      .from(operations)
      .where(eq(operations.caseId, caseId));
    expect(operationRows!.total).toBe(1);
  });

  it("does not offer an approval link outside the sandbox approval host", async () => {
    const { browser, caseId } = await newCase(app);
    app.paypal.approvalOrigin = "https://www.sandbox.paypal.com.evil.example";
    try {
      const response = await browser.post(`/api/cases/${caseId}/setup-subscription`);
      expect(response.body.approvalUrl).toBeUndefined();
      expect(response.body.jobId).toBeTruthy();
    } finally {
      app.paypal.approvalOrigin = "https://www.sandbox.paypal.com";
    }
  });

  it("reports PayPal as unavailable, and creates nothing, when the merchant has no credentials", async () => {
    const { browser, caseId } = await newCase(app);
    const configured = app.ctx.paypal.A;
    app.ctx.paypal.A = null;
    try {
      expect((await browser.post(`/api/cases/${caseId}/setup-subscription`)).status).toBe(503);
    } finally {
      app.ctx.paypal.A = configured;
    }
    expect(await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId))).toHaveLength(0);
  });
});

describe("setup progress in Home and snapshot polling", () => {
  it("keeps an unpaid or ACTIVE-without-payment setup pending even after its return job completes", async () => {
    const setup = await newCase(app);
    const unpaid = await snapshotOf(setup.browser, setup.caseId);
    expect(renderHome(unpaid)).toContain("Start your Original service subscription.");
    expect(renderHome(unpaid)).not.toContain("Set preferences");
    expect(shouldPollCase(unpaid)).toBe(false);
    expect(dashboardStatus(unpaid)).toMatchObject({ label: "Ready to start", tone: "neutral" });

    const { subscriptionId } = await approveAndReturn(setup, { withoutTransaction: true });
    const pending = await snapshotOf(setup.browser, setup.caseId);
    expect(pending).toMatchObject({
      case: { state: "SETUP" },
      policy: null,
      pendingJobId: null,
      receipt: { oldBilling: "UNKNOWN", oldAccessEndsAt: null },
      handover: {
        kind: "setup_create",
        status: "SUCCEEDED",
        billingStatus: "ACTIVE",
        paymentStatus: "PENDING",
        approvalUrl: null,
      },
    });
    expect(renderHome(pending)).toContain("Checking your first payment.");
    expect(renderHome(pending)).not.toContain("Set preferences");
    expect(dashboardStatus(pending)).toMatchObject({ label: "Checking payment", tone: "waiting" });
    expect(renderHome(pending)).toContain("then £12 / month");
    expect(shouldPollCase(pending)).toBe(true);
    expect(app.paypal.subscriptions.get(subscriptionId)!.transactions).toEqual([]);
  });

  it("offers preferences after verified payment while SETUP has no policy or handover, without another creation", async () => {
    const setup = await newCase(app);
    await approveAndReturn(setup);
    const paid = await snapshotOf(setup.browser, setup.caseId);
    expect(paid).toMatchObject({
      case: { state: "SETUP" },
      policy: null,
      handover: null,
      pendingJobId: null,
      receipt: { oldBilling: "ACTIVE", oldAccessEndsAt: expect.any(String) },
    });
    const creations = app.paypal.createRequests.length;
    const html = renderHome(paid);
    expect(html).toContain("Set preferences");
    expect(html).not.toContain("Continue to PayPal");
    expect(html).not.toContain("Start your Original service subscription.");
    expect(dashboardStatus(paid)).toMatchObject({ label: "Payment verified", tone: "positive" });
    expect(shouldPollCase(paid)).toBe(false);
    expect(app.paypal.createRequests.length).toBe(creations);
    expect(
      app.paypal.createRequests.filter((request) => request.body.custom_id.startsWith(setup.caseId)),
    ).toHaveLength(1);
    expect(
      await app.ctx.db.select().from(operations).where(eq(operations.caseId, setup.caseId)),
    ).toHaveLength(1);
  });

  it("requires both verified billing and the paid-through boundary before offering preferences", async () => {
    const setup = await newCase(app);
    await approveAndReturn(setup);
    const paid: CaseSnapshot = await snapshotOf(setup.browser, setup.caseId);
    for (const receipt of [
      { ...paid.receipt, oldBilling: "UNKNOWN" as const },
      { ...paid.receipt, oldAccessEndsAt: null },
    ]) {
      expect(renderHome({ ...paid, receipt })).not.toContain("Set preferences");
    }
  });

  const terminalSetups: { name: string; changes: Partial<NonNullable<CaseSnapshot["handover"]>> }[] = [
    {
      name: "creation failed before payment started",
      changes: { status: "FAILED", paymentStatus: "NOT_STARTED", billingStatus: "UNKNOWN" },
    },
    { name: "payment failed", changes: { paymentStatus: "FAILED" } },
    { name: "billing was cancelled", changes: { billingStatus: "CANCELLED" } },
    { name: "approval expired", changes: { billingStatus: "EXPIRED" } },
  ];
  it.each(terminalSetups)("stops setup polling when $name", async ({ changes }) => {
    const { browser, caseId } = await newCase(app);
    await startSetup(browser, caseId);
    const pending: CaseSnapshot = await snapshotOf(browser, caseId);
    expect(shouldPollCase(pending)).toBe(true);
    expect(dashboardStatus(pending)).toMatchObject({ label: "Approval needed", tone: "waiting" });
    const terminal = { ...pending, pendingJobId: null, handover: { ...pending.handover!, ...changes } };
    expect(shouldPollCase(terminal)).toBe(false);
    expect(renderHome(terminal)).not.toContain("Set preferences");
    expect(dashboardStatus(terminal)).toMatchObject({ label: "Needs attention", tone: "attention" });
    expect(renderHome(terminal)).not.toContain("Continue to PayPal");
  });

  it("preserves polling for queued work and later handovers, but not settled monitoring", async () => {
    const { browser, caseId } = await newCase(app);
    const settled: CaseSnapshot = await snapshotOf(browser, caseId);
    expect(shouldPollCase(null)).toBe(false);
    expect(shouldPollCase(settled)).toBe(false);
    expect(shouldPollCase({ ...settled, pendingJobId: "queued-job" })).toBe(true);
    for (const state of ["INVESTIGATING", "AWAITING_PAYPAL", "VERIFYING_NEW", "EXITING_OLD"] as const) {
      expect(shouldPollCase({ ...settled, case: { ...settled.case, state } })).toBe(true);
    }
    expect(shouldPollCase({ ...settled, case: { ...settled.case, state: "MONITORING" } })).toBe(false);
  });
});

describe("evidence-backed display facts", () => {
  const required = ["editable_text", "speaker_labels"] as const;
  const checked: CapabilityResult[] = [
    { capability: "editable_text", passes: true, reason: "Editable text available" },
    { capability: "speaker_labels", passes: true, reason: "Names present" },
  ];

  it("cannot claim a fit from absent, partial or conflicting output checks", () => {
    expect(checkedFeatures(required, checked)).toEqual({ complete: true, missing: [] });
    expect(checkedFeatures(required, [checked[0]!])).toEqual({ complete: false, missing: [] });
    expect(checkedFeatures(required, [])).toEqual({ complete: false, missing: [] });
    expect(checkedFeatures(required, [...checked, checked[1]!])).toEqual({ complete: false, missing: [] });
    const failed = [
      checked[0]!,
      { capability: "speaker_labels" as const, passes: false, reason: "No names" },
    ];
    expect(checkedFeatures(required, failed)).toEqual({ complete: true, missing: ["speaker_labels"] });
    const candidate = {
      eligible: true,
      capabilityResults: [] as CapabilityResult[],
      rejectionReasons: [] as string[],
    };
    expect(fitReason(candidate, 1400, 1500, required)).toBe("Required work not fully checked");
    expect(fitReason({ ...candidate, capabilityResults: failed }, 900, 1500, required)).toBe(
      "An older saved requirement is unmet",
    );
    expect(fitReason({ ...candidate, capabilityResults: checked }, 1900, 1500, required)).toBe(
      "£4 over budget",
    );
    expect(fitReason(candidate, undefined, 1500, required)).toBe("Price not confirmed");
  });

  it("only calculates the change in monthly cost from two fresh quotes including the current plan", () => {
    const now = Date.UTC(2026, 9, 11, 14);
    const currentService: CandidateQuote = {
      id: "quote-a",
      caseId: "test-case",
      candidateId: "a_01",
      providerId: "provider_a",
      planId: "a_01",
      revision: 1,
      recurringTotal: { currency: "GBP", amountMinor: 1200 },
      dueNowTotal: { currency: "GBP", amountMinor: 1200 },
      interval: "MONTH",
      intervalCount: 1,
      taxMinor: 0,
      feesMinor: 0,
      observedAt: new Date(now - 1000).toISOString(),
      evidenceId: "ev-a",
    };
    const margin: CandidateQuote = {
      ...currentService,
      id: "quote-b",
      candidateId: "b_02",
      providerId: "provider_b",
      planId: "b_02",
      recurringTotal: { currency: "GBP", amountMinor: 1400 },
    };
    expect(monthlyDifference(currentService, margin, "a_01", now)).toBe(200);
    expect(monthlyDifference(null, margin, "a_01", now)).toBeNull();
    expect(monthlyDifference(currentService, margin, "a_02", now)).toBeNull();
    expect(
      monthlyDifference(currentService, { ...margin, observedAt: "not a date" }, "a_01", now),
    ).toBeNull();
    expect(
      monthlyDifference(
        { ...currentService, observedAt: new Date(now - 6 * 60_000).toISOString() },
        margin,
        "a_01",
        now,
      ),
    ).toBeNull();
    expect(freshQuote({ ...margin, observedAt: new Date(now + 1000).toISOString() }, now)).toBeNull();
    expect(freshQuote({ ...margin, recurringTotal: { currency: "GBP", amountMinor: NaN } }, now)).toBeNull();
  });

  it("withholds a claimed fit if the accepted plan's quote, checks or policy binding are missing or stale", async () => {
    const flow = await caseAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(supportedChoice(snapshot)?.quote.recurringTotal.amountMinor).toBe(1400);
    expect(supportedChoice({ ...snapshot, evaluationQuotes: [] })).toBeNull();
    expect(
      supportedChoice({
        ...snapshot,
        evaluations: snapshot.evaluations.map((item) => ({ ...item, capabilityResults: [] })),
      }),
    ).toBeNull();
    expect(supportedChoice({ ...snapshot, policy: { ...snapshot.policy!, revision: 2 } })).toBeNull();
    expect(
      supportedChoice({
        ...snapshot,
        evaluationQuotes: snapshot.evaluationQuotes.map((item) => ({
          ...item,
          observedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        })),
      }),
    ).toBeNull();
    expect(
      supportedChoice({
        ...snapshot,
        evaluationQuotes: snapshot.evaluationQuotes.map((item) => ({
          ...item,
          recurringTotal: { currency: "GBP", amountMinor: 1600 },
        })),
      }),
    ).toBeNull();
  });

  it("keeps historical fit results internally without presenting unavailable legacy needs or approval in customer views", async () => {
    const flow = await caseAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.recommendation).toMatchObject({ action: "switch", candidateId: "b_02" });
    const home = renderHome(snapshot);
    const review = renderToStaticMarkup(
      createElement(ReviewSwitch, { snapshot, refresh: async () => undefined }),
    );
    expect(home).toContain("Earlier saved needs require review");
    expect(review).toContain("Earlier needs require review");
    expect(home + review).not.toMatch(/speaker names|demo sample|transcript comparison/i);
    expect(review).not.toContain("Continue to PayPal");
    expect(reviewBenefit(snapshot, undefined)).toEqual({ missing: [], increase: null });
  });

  it("withholds a dated-value claim when current output, account plan, policy or quote binding is incomplete", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    const title = (row: CaseSnapshot) =>
      renderHome(row).match(/<h2 class="hero-title">([^<]*)<\/h2>/)?.[1] ?? "";
    expect(title(snapshot)).toContain("Original service announced a higher renewal");
    const partial = { ...snapshot, currentOutput: { ...snapshot.currentOutput!, capabilityResults: [] } };
    const otherPlan = { ...snapshot, currentAccount: { ...snapshot.currentAccount!, planId: "a_02" } };
    const olderPolicy = {
      ...snapshot,
      policy: { ...snapshot.policy!, revision: snapshot.policy!.revision + 1 },
    };
    const absentQuote = { ...snapshot, evaluationQuotes: [] };
    for (const candidate of [partial, otherPlan, olderPolicy, absentQuote])
      expect(title(candidate)).not.toContain("Original service announced a higher renewal");
  });

  it("keeps a checked fit repair available even when it costs more over the value horizon", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    const selected = snapshot.recommendation!.candidateId;
    const repair: CaseSnapshot = {
      ...snapshot,
      currentOutput: {
        ...snapshot.currentOutput!,
        capabilityResults: [{ capability: "editable_text", passes: false, reason: "Editable work missing." }],
      },
      evaluationQuotes: snapshot.evaluationQuotes.map((quote) =>
        quote.candidateId === selected
          ? {
              ...quote,
              comparison: {
                ...quote.comparison!,
                candidateTotal: { currency: "GBP", amountMinor: 20000 },
                netSavingMinor: -800,
              },
            }
          : quote,
      ),
    };
    expect(supportedChoice(repair)?.quote.candidateId).toBe(selected);
    const options = renderToStaticMarkup(
      createElement(Options, {
        snapshot: repair,
        refresh: async () => undefined,
        onPropose: () => undefined,
      }),
    );
    expect(options).toContain("Review switch terms");
    expect(options).not.toContain("£-8");
    expect(supportedChoice({ ...repair, currentOutput: snapshot.currentOutput })).toBeNull();
  });

  it("shows conditional paid value on ordinary screens without a historical output lesson", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    const options = renderToStaticMarkup(
      createElement(Options, { snapshot, refresh: async () => undefined, onPropose: () => undefined }),
    );
    expect(options).toContain("£99");
    expect(options).toContain("£108");
    expect(options).toContain("£6");
    expect(options).toContain("£9");
    expect(options).toContain("£18");
    expect(options).not.toMatch(
      /speaker names|sample transcript|demo sample|no name|model explanation|View details/i,
    );
    expect(options).not.toContain(snapshot.recommendation!.explanation);
  });

  it("withdraws the suggested price and savings when its quote expires or its policy changes", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    const render = (row: CaseSnapshot) =>
      renderToStaticMarkup(
        createElement(Options, { snapshot: row, refresh: async () => undefined, onPropose: () => undefined }),
      );
    expect(render(snapshot)).toContain("£93 less if the announced rise takes effect");
    const expired = {
      ...snapshot,
      evaluationQuotes: snapshot.evaluationQuotes.map((quote) => ({
        ...quote,
        observedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
      })),
    };
    const revised = { ...snapshot, policy: { ...snapshot.policy!, revision: snapshot.policy!.revision + 1 } };
    for (const row of [expired, revised]) {
      const html = render(row);
      expect(html).not.toContain("Suggested plan");
      expect(html).not.toContain("£93 less");
      expect(html).not.toContain("Your saved needs passed Val’s checks");
      expect(html).toContain("No replacement has been approved");
    }
  });

  it("explains the ordinary suitable plan when an introductory offer is unavailable", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot: CaseSnapshot = await snapshotOf(flow.browser, flow.caseId);
    const ordinary = snapshot.evaluations.find((item) => item.candidateId === "b_01")!;
    const projected: CaseSnapshot = {
      ...snapshot,
      recommendation: { ...snapshot.recommendation!, action: "switch", candidateId: "b_01" },
      evaluations: snapshot.evaluations.map((item) =>
        item.candidateId === "b_03"
          ? { ...item, eligible: false, rejectionReasons: ["Offer not available to this account."] }
          : item,
      ),
      evaluationQuotes: snapshot.evaluationQuotes.map((item) =>
        item.candidateId === "b_03"
          ? { ...item, offer: { ...item.offer!, eligibility: "INELIGIBLE" } }
          : item,
      ),
    };
    expect(ordinary).toMatchObject({ eligible: true, candidateId: "b_01" });
    expect(
      projected.evaluationQuotes.find((item) => item.candidateId === "b_01")?.comparison?.candidateTotal
        .amountMinor,
    ).toBe(10800);
    const home = renderHome(projected);
    const options = renderToStaticMarkup(
      createElement(Options, {
        snapshot: projected,
        refresh: async () => undefined,
        onPropose: () => undefined,
      }),
    );
    expect(home).toContain("Margin Basic");
    expect(home).toContain("£108");
    expect(home).not.toContain("cannot show what the current plan lost");
    expect(options).toContain("Original service announced a higher renewal");
    expect(options).toContain("£108");
    expect(options).not.toContain("Original service still has what you need");
    expect(options).not.toContain("paid cycles, then full renewal");
    const previewed = await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
      recommendationId: flow.recommendationId,
    });
    expect(previewed.status).toBe(200);
    const { offer: _introOnly, ...approved } = previewed.body.materialTerms;
    const quote = projected.evaluationQuotes.find((item) => item.candidateId === "b_01")!;
    const ordinaryTerms = {
      ...approved,
      candidateId: "b_01",
      planId: "b_01",
      quoteRevision: quote.revision,
      dueNow: quote.dueNowTotal,
      recurring: quote.recurringTotal,
      overlap: { ...approved.overlap, newDueNow: quote.dueNowTotal },
      comparison: quote.comparison,
    };
    expect(reviewValue(projected, ordinaryTerms)).toMatchObject({
      candidateTotal: { amountMinor: 10800 },
      currentTotal: { amountMinor: 19200 },
      netSavingMinor: 8400,
    });
    expect(
      reviewValue(
        { ...projected, currentOutput: { ...projected.currentOutput!, capabilityResults: [] } },
        ordinaryTerms,
      ),
    ).toBeNull();
    expect(
      reviewValue({ ...projected, policy: { ...projected.policy!, revision: 2 } }, ordinaryTerms),
    ).toBeNull();
    expect(reviewValue(projected, { ...ordinaryTerms, quoteRevision: 99 })).toBeNull();
  });

  it("distinguishes paid, tested, copied, stopped billing and scheduled versus ended access", () => {
    const empty: Receipt = {
      newSubscriptionId: null,
      newBillingStatus: "NONE",
      duePayment: "NOT_STARTED",
      paymentEvidenceId: null,
      capability: "NOT_STARTED",
      capabilityEvidenceId: null,
      history: "NOT_STARTED",
      historyEvidenceId: null,
      oldSubscriptionId: null,
      oldBilling: "ACTIVE",
      oldService: "ACTIVE",
      oldAccessEndsAt: null,
      message: "Checking",
    };
    expect(handoverFacts({ ...empty, newBillingStatus: "ACTIVE", duePayment: "PENDING" }).paid).toBe(false);
    expect(handoverFacts({ ...empty, newBillingStatus: "ACTIVE", duePayment: "VERIFIED" }).paid).toBe(false);
    expect(
      handoverFacts({ ...empty, newBillingStatus: "ACTIVE", duePayment: "FAILED" }).handoverComplete,
    ).toBe(false);
    expect(
      handoverFacts({ ...empty, newBillingStatus: "ACTIVE", duePayment: "UNKNOWN" }).handoverComplete,
    ).toBe(false);
    expect(
      handoverFacts({
        ...empty,
        newBillingStatus: "ACTIVE",
        duePayment: "VERIFIED",
        paymentEvidenceId: "paid",
        capability: "VERIFIED",
      }).ready,
    ).toBe(false);
    const verified: Receipt = {
      ...empty,
      newSubscriptionId: "I-TEST",
      newBillingStatus: "ACTIVE",
      duePayment: "VERIFIED",
      paymentEvidenceId: "paid",
      capability: "VERIFIED",
      capabilityEvidenceId: "sample",
      history: "VERIFIED",
      historyEvidenceId: "import",
      oldBilling: "CANCELLED",
      oldService: "EXIT_SCHEDULED",
      oldAccessEndsAt: "2026-11-11T10:00:00.000Z",
    };
    expect(handoverFacts(verified)).toMatchObject({
      paid: true,
      output: true,
      history: true,
      billingStopped: true,
      accessScheduled: true,
      accessEnded: false,
      ready: true,
      handoverComplete: true,
    });
    for (const newSubscriptionId of [null, "", "   "]) {
      expect(handoverFacts({ ...verified, newSubscriptionId })).toMatchObject({
        paid: false,
        ready: false,
        handoverComplete: false,
      });
    }
    expect(handoverFacts({ ...verified, oldService: "ACTIVE" }).handoverComplete).toBe(false);
    expect(handoverFacts({ ...verified, oldAccessEndsAt: null }).handoverComplete).toBe(false);
    expect(handoverFacts({ ...verified, history: "FAILED" }).handoverComplete).toBe(false);
    expect(handoverFacts({ ...verified, capabilityEvidenceId: null }).ready).toBe(false);
    expect(handoverFacts({ ...verified, oldService: "ENDED" })).toMatchObject({
      accessScheduled: false,
      accessEnded: true,
      handoverComplete: true,
    });
  });
});

describe("PayPal return bridge", () => {
  it("serves return pages uncached and referrer-free, and a GET never changes state", async () => {
    const { browser, caseId } = await newCase(app);
    const { operationId } = await startSetup(browser, caseId);
    const command = await returnCommand(operationId);
    const before = { jobs: await jobCount(caseId), operation: await loadOperation(operationId) };

    for (const page of ["setup/return", "setup/cancel", "transition/return", "transition/cancel"]) {
      const query = new URLSearchParams({
        caseId,
        operationId,
        return_token: command.returnToken,
        subscription_id: command.subscriptionId!,
      });
      const response = await fetch(`${app.origin}/paypal/${page}?${query}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
    expect(await jobCount(caseId)).toBe(before.jobs);
    expect(await loadOperation(operationId)).toEqual(before.operation);
  });

  it("rejects a return that does not match the owner, case, operation, token or subscription", async () => {
    const { browser, caseId } = await newCase(app);
    const other = await newCase(app);
    const { operationId, subscriptionId } = await startSetup(browser, caseId);
    const valid = await returnCommand(operationId);
    const returnRoute = `/api/cases/${caseId}/setup-subscription/return`;
    const jobsBefore = await jobCount(caseId);

    expect((await browser.post(returnRoute, { ...valid, returnToken: "not-the-token" })).status).toBe(403);
    expect((await browser.post(returnRoute, { ...valid, operationId: "unknown-operation" })).status).toBe(
      404,
    );
    expect(
      (await browser.post(returnRoute, { ...valid, subscriptionId: "I-ANOTHER-SUBSCRIPTION" })).status,
    ).toBe(409);
    expect((await browser.post(returnRoute, valid, { csrf: null })).status).toBe(403);
    expect((await other.browser.post(returnRoute, valid)).status).toBe(404);
    expect(
      (await other.browser.post(`/api/cases/${other.caseId}/setup-subscription/return`, valid)).status,
    ).toBe(404);
    expect((await browser.post(`/api/cases/${caseId}/checkout/return`, valid)).status).toBe(404);
    expect((await browser.post(returnRoute, { ...valid, subscriptionId: undefined })).status).toBe(400);

    expect(await jobCount(caseId)).toBe(jobsBefore);
    expect((await loadOperation(operationId)).billingStatus).toBe("APPROVAL_PENDING");
    expect(app.paypal.subscriptions.get(subscriptionId)!.status).toBe("APPROVAL_PENDING");
  });

  it("resumes the same operation after the login expired, and repeated returns reuse one job", async () => {
    const { browser, caseId } = await newCase(app);
    const { operationId } = await startSetup(browser, caseId);
    const command = await returnCommand(operationId);
    const returnRoute = `/api/cases/${caseId}/setup-subscription/return`;

    await browser.request("DELETE", "/api/session", {});
    expect((await browser.post(returnRoute, command)).status).toBe(401);

    await browser.post("/api/session", reviewerLogin);
    const first = await browser.post(returnRoute, command);
    const refreshed = await browser.post(returnRoute, command);
    expect(first.status).toBe(200);
    expect(refreshed.body.jobId).toBe(first.body.jobId);
    expect(
      app.paypal.createRequests.filter((request) => request.body.custom_id.startsWith(caseId)),
    ).toHaveLength(1);
  });

  it("queues reconciliation for a cancel return but never marks anything cancelled", async () => {
    const { browser, caseId } = await newCase(app);
    const { operationId, subscriptionId } = await startSetup(browser, caseId);
    const cancelled = await browser.post(
      `/api/cases/${caseId}/setup-subscription/return`,
      await returnCommand(operationId, "cancelled"),
    );
    expect(cancelled.status).toBe(200);
    await app.runJobs();

    expect(app.paypal.subscriptions.get(subscriptionId)!.status).toBe("APPROVAL_PENDING");
    expect(app.paypal.calls.filter((call) => call.path.endsWith(`${subscriptionId}/cancel`))).toHaveLength(0);
    const operation = await loadOperation(operationId);
    expect(operation).toMatchObject({ billingStatus: "APPROVAL_PENDING", paymentStatus: "PENDING" });
    expect((await snapshotOf(browser, caseId)).receipt.message).toMatch(/Waiting for buyer approval/);
  });
});

describe("initial payment evidence", () => {
  it("does not overwrite a newer paid observation with a slower pending read", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await startSetup(setup.browser, setup.caseId);
    const operation = await loadOperation(operationId);
    const client = app.ctx.paypal.A!;
    const originalRead = client.getSubscription.bind(client);
    let release!: () => void;
    let captured!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const snapshotCaptured = new Promise<void>((resolve) => {
      captured = resolve;
    });
    const read = vi.spyOn(client, "getSubscription").mockImplementationOnce(async (id) => {
      const subscription = await originalRead(id);
      captured();
      await waiting;
      return subscription;
    });
    const commit: Commit = (write) => app.ctx.db.transaction(write);
    const slowRead = reconcileSubscription(app.ctx, operation, commit);
    try {
      await snapshotCaptured;
      app.paypal.approve(subscriptionId);
      await reconcileSubscription(app.ctx, operation, commit);
    } finally {
      release();
      await slowRead;
      read.mockRestore();
    }
    expect(await loadOperation(operationId)).toMatchObject({
      billingStatus: "ACTIVE",
      paymentStatus: "VERIFIED",
    });
  });

  it("keeps financial evidence without storing transaction buyer details", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await startSetup(setup.browser, setup.caseId);
    app.paypal.approve(subscriptionId);
    const stored = app.paypal.subscriptions.get(subscriptionId)!;
    stored.transactions = stored.transactions.map((transaction) => ({
      ...transaction,
      payer_email: "private-buyer@example.invalid",
      payer_name: { given_name: "Private" },
      extra: { address: "Private address" },
    }));
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    const [payment] = await app.ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.operationId, operationId), eq(evidence.kind, "payment")));
    const artifact = await setup.browser.get(`/api/artifacts/${payment!.artifactId}`);
    expect(JSON.stringify(artifact.body)).not.toContain("Private");
    expect(JSON.stringify(artifact.body)).not.toContain("private-buyer@example.invalid");
    expect(artifact.body.transactions[0]).toMatchObject({
      id: `TXN-${subscriptionId}`,
      status: "COMPLETED",
      amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: "12.00" } },
    });
    expect(await loadOperation(operationId)).toMatchObject({ paymentStatus: "VERIFIED" });
  });

  it("verifies the exact completed charge and records the paid-through boundary, with raw evidence and no buyer details", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await approveAndReturn(setup);

    const snapshot = await snapshotOf(setup.browser, setup.caseId);
    expect(validate.caseSnapshot(snapshot)).toBe(true);
    expect(snapshot.case.state).toBe("SETUP");
    expect(snapshot.receipt).toMatchObject({ oldSubscriptionId: subscriptionId, oldBilling: "ACTIVE" });
    expect(snapshot.receipt.message).toMatch(
      /Initial payment verified: transaction TXN-.* COMPLETED GBP 12\.00/,
    );

    const [payment] = await app.ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.operationId, operationId), eq(evidence.kind, "payment")));
    const detail = payment!.detail as {
      verdict: string;
      payments: unknown[];
      period: { paidThrough: string; periodStart: string };
    };
    expect(detail.verdict).toBe("VERIFIED");
    detail.payments.forEach((record) => expect(validatorFor("PaymentEvidence")(record)).toBe(true));
    expect(validatorFor("PaymentPeriod")(detail.period)).toBe(true);
    expect(detail.payments).toEqual([
      expect.objectContaining({
        merchantContext: "A",
        subscriptionId,
        status: "COMPLETED",
        grossAmount: { currency: "GBP", amountMinor: 1200 },
      }),
    ]);
    expect(snapshot.receipt.oldAccessEndsAt).toBe(detail.period.paidThrough);
    expect(new Date(detail.period.paidThrough).getTime()).toBeGreaterThan(
      new Date(detail.period.periodStart).getTime(),
    );

    const listed = (await setup.browser.get(`/api/cases/${setup.caseId}/evidence`)).body;
    listed.forEach((item: unknown) => expect(validate.evidence(item)).toBe(true));
    const artifact = await setup.browser.get(`/api/artifacts/${payment!.artifactId}`);
    expect(artifact.status).toBe(200);
    expect(artifact.headers.get("content-disposition")).toMatch(/attachment/);
    expect(JSON.stringify(artifact.body)).not.toContain("buyer@example.invalid");
    expect(JSON.stringify(artifact.body)).toContain(`TXN-${subscriptionId}`);
  });

  it("keeps ACTIVE-without-payment pending, then verifies when the transaction appears, recording only changes", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await approveAndReturn(setup, { withoutTransaction: true });
    expect(await loadOperation(operationId)).toMatchObject({
      billingStatus: "ACTIVE",
      paymentStatus: "PENDING",
    });
    expect((await snapshotOf(setup.browser, setup.caseId)).receipt).toMatchObject({
      oldBilling: "UNKNOWN",
      oldAccessEndsAt: null,
    });

    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    const rowsBefore = (await app.ctx.db.select().from(evidence).where(eq(evidence.operationId, operationId)))
      .length;
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    expect(
      (await app.ctx.db.select().from(evidence).where(eq(evidence.operationId, operationId))).length,
    ).toBe(rowsBefore);

    app.paypal.approve(subscriptionId);
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    expect(await loadOperation(operationId)).toMatchObject({ paymentStatus: "VERIFIED" });
  });

  it.each<[string, ApprovalOptions, "PENDING" | "FAILED"]>([
    ["a wrong amount", { gross: "14.00" }, "FAILED"],
    ["a wrong currency", { currency: "USD" }, "FAILED"],
    ["a duplicated initial transaction", { duplicateTransaction: true }, "FAILED"],
    ["a refunded initial payment", { transactionStatus: "REFUNDED" }, "FAILED"],
    ["a still-pending transaction", { transactionStatus: "PENDING" }, "PENDING"],
    ["an outstanding balance", { outstanding: "12.0" }, "PENDING"],
  ])("does not treat %s as paid, and retains what was observed", async (_label, options, expectedStatus) => {
    const setup = await newCase(app);
    const { operationId } = await approveAndReturn(setup, options);

    expect(await loadOperation(operationId)).toMatchObject({
      billingStatus: "ACTIVE",
      paymentStatus: expectedStatus,
    });
    expect((await snapshotOf(setup.browser, setup.caseId)).receipt).toMatchObject({
      oldBilling: "UNKNOWN",
      oldAccessEndsAt: null,
    });
    const [payment] = await app.ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.operationId, operationId), eq(evidence.kind, "payment")));
    expect(payment!.summary).toMatch(new RegExp(`Initial payment ${expectedStatus.toLowerCase()}`));
    expect((payment!.detail as { period: unknown }).period).toBeNull();
  });

  it("retains the wrong-currency observation instead of normalising it to GBP", async () => {
    const setup = await newCase(app);
    const { operationId } = await approveAndReturn(setup, { currency: "USD" });
    const [payment] = await app.ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.operationId, operationId), eq(evidence.kind, "payment")));
    expect((payment!.detail as { payments: { grossAmount: unknown }[] }).payments[0]!.grossAmount).toEqual({
      currency: "USD",
      amountMinor: 1200,
    });
  });

  it("refuses to verify a subscription whose custom_id names another operation", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await startSetup(setup.browser, setup.caseId);
    app.paypal.approve(subscriptionId);
    app.paypal.subscriptions.get(subscriptionId)!.customId = "another-case.another-operation";
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    const operation = await loadOperation(operationId);
    expect(operation.paymentStatus).toBe("FAILED");
    expect(operation.note).toMatch(/does not match the stored operation/);
  });

  it("cannot see the subscription from the other merchant's context", async () => {
    const setup = await newCase(app);
    const { operationId } = await startSetup(setup.browser, setup.caseId);
    await app.ctx.db.update(operations).set({ merchant: "B" }).where(eq(operations.id, operationId));
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    expect(await loadOperation(operationId)).toMatchObject({
      paymentStatus: "FAILED",
      billingStatus: "UNKNOWN",
    });
  });

  it("keeps a verified payment and its paid-through boundary when billing is later cancelled", async () => {
    const setup = await newCase(app);
    const { operationId, subscriptionId } = await approveAndReturn(setup);
    const paidThrough = (await snapshotOf(setup.browser, setup.caseId)).receipt.oldAccessEndsAt;

    app.paypal.subscriptions.get(subscriptionId)!.status = "CANCELLED";
    await setup.browser.post(`/api/cases/${setup.caseId}/reconcile`);
    await app.runJobs();
    expect(await loadOperation(operationId)).toMatchObject({
      billingStatus: "CANCELLED",
      paymentStatus: "VERIFIED",
    });
    expect((await snapshotOf(setup.browser, setup.caseId)).receipt).toMatchObject({
      oldBilling: "CANCELLED",
      oldAccessEndsAt: paidThrough,
    });
  });
});

describe("unknown outcomes and restarts", () => {
  it("replays a lost creation response with the identical request ID and body, creating one subscription", async () => {
    const { browser, caseId } = await newCase(app);
    app.paypal.loseNextCreateResponse = true;
    const first = await browser.post(`/api/cases/${caseId}/setup-subscription`);
    expect(first.body.jobId).toBeTruthy();

    const [stuck] = await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
    expect(stuck).toMatchObject({ status: "UNKNOWN", remoteId: null });
    await app.runJobs();

    const [recovered] = await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
    expect(recovered).toMatchObject({ status: "SUCCEEDED", billingStatus: "APPROVAL_PENDING", attempts: 2 });
    const attempts = app.paypal.createRequests.filter((request) => request.body.custom_id.startsWith(caseId));
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(
      [...app.paypal.subscriptions.values()].filter((subscription) =>
        subscription.customId.startsWith(caseId),
      ),
    ).toHaveLength(1);
  });

  it("finishes an interrupted in-flight creation after a restart without a second subscription", async () => {
    const { browser, caseId } = await newCase(app);
    app.paypal.loseNextCreateResponse = true;
    await browser.post(`/api/cases/${caseId}/setup-subscription`);
    // As if the process died after sending: still IN_FLIGHT, lease long expired.
    await app.ctx.db
      .update(operations)
      .set({ status: "IN_FLIGHT", leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(operations.caseId, caseId));

    const restarted = await startTestApp({ paypal: app.paypal });
    try {
      await restarted.ctx.db
        .update(jobs)
        .set({ status: "QUEUED", leaseExpiresAt: null })
        .where(eq(jobs.caseId, caseId));
      await restarted.runJobs();
    } finally {
      await restarted.close();
    }
    const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
    expect(operation).toMatchObject({ status: "SUCCEEDED", billingStatus: "APPROVAL_PENDING" });
    expect(
      [...app.paypal.subscriptions.values()].filter((subscription) =>
        subscription.customId.startsWith(caseId),
      ),
    ).toHaveLength(1);
  });

  it("does not replay a creation whose lease is still held by another sender", async () => {
    const { browser, caseId } = await newCase(app);
    app.paypal.loseNextCreateResponse = true;
    await browser.post(`/api/cases/${caseId}/setup-subscription`);
    const requestsBefore = app.paypal.createRequests.length;
    await app.ctx.db
      .update(operations)
      .set({ status: "IN_FLIGHT", leaseExpiresAt: new Date(Date.now() + 60_000) })
      .where(eq(operations.caseId, caseId));

    const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
    expect((await dispatchCreation(app.ctx, operation!)).status).toBe("IN_FLIGHT");
    expect(app.paypal.createRequests).toHaveLength(requestsBefore);
  });

  it("leaves an unresolved creation UNKNOWN once PayPal's request-ID retention has passed", async () => {
    const { browser, caseId } = await newCase(app);
    app.paypal.loseNextCreateResponse = true;
    await browser.post(`/api/cases/${caseId}/setup-subscription`);
    await app.ctx.db
      .update(operations)
      .set({ dispatchedAt: new Date(Date.now() - 73 * 60 * 60 * 1000) })
      .where(eq(operations.caseId, caseId));
    const requestsBefore = app.paypal.createRequests.length;

    await browser.post(`/api/cases/${caseId}/reconcile`);
    await app.runJobs();
    const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId));
    expect(operation).toMatchObject({ status: "UNKNOWN", remoteId: null });
    expect(app.paypal.createRequests).toHaveLength(requestsBefore);
  });
});

describe("disposable probe subscriptions", () => {
  async function approvedProbe(providerId: "provider_a" | "provider_b") {
    const { browser, caseId } = await newCase(app, adminLogin);
    const approval = (await browser.post(`/api/admin/cases/${caseId}/probe-subscription/${providerId}`)).body;
    app.paypal.approve(approval.subscriptionId);
    const route = providerId === "provider_a" ? "setup-subscription" : "checkout";
    expect(
      (await browser.post(`/api/cases/${caseId}/${route}/return`, await returnCommand(approval.operationId)))
        .status,
    ).toBe(200);
    await app.runJobs();
    return { browser, caseId, ...approval } as {
      browser: Browser;
      caseId: string;
      operationId: string;
      subscriptionId: string;
    };
  }

  it("verifies Merchant B's £14 charge through the transition bridge", async () => {
    const probe = await approvedProbe("provider_b");
    const operation = await loadOperation(probe.operationId);
    expect(operation).toMatchObject({
      kind: "replacement_create",
      merchant: "B",
      planId: "b_02",
      probe: true,
      paymentStatus: "VERIFIED",
    });
    expect(
      app.paypal.createRequests.find((request) => request.body.custom_id.endsWith(probe.operationId)),
    ).toMatchObject({ merchant: "B", body: { plan_id: "P-B_02" } });
    expect(new URL(JSON.parse(operation.requestBody!).application_context.return_url).pathname).toBe(
      "/paypal/transition/return",
    );
  });

  it("cancels only through the probe, requires a fresh CANCELLED read and keeps the paid-through evidence", async () => {
    const probe = await approvedProbe("provider_a");
    const cancel = await probe.browser.post(`/api/admin/operations/${probe.operationId}/probe-cancel`);
    expect(cancel.status).toBe(200);
    expect(validate.operation(cancel.body)).toBe(true);
    expect(cancel.body).toMatchObject({ kind: "probe_cancel", status: "SUCCEEDED" });
    expect(app.paypal.subscriptions.get(probe.subscriptionId)!.status).toBe("CANCELLED");
    expect(await loadOperation(probe.operationId)).toMatchObject({
      billingStatus: "CANCELLED",
      paymentStatus: "VERIFIED",
    });

    const [payment] = await app.ctx.db
      .select()
      .from(evidence)
      .where(and(eq(evidence.operationId, probe.operationId), eq(evidence.kind, "payment")));
    expect((payment!.detail as { period: { paidThrough: string } }).period.paidThrough).toBeTruthy();

    const again = await probe.browser.post(`/api/admin/operations/${probe.operationId}/probe-cancel`);
    expect(again.body.id).toBe(cancel.body.id);
    expect(
      app.paypal.calls.filter((call) => call.path.endsWith(`${probe.subscriptionId}/cancel`)),
    ).toHaveLength(1);
  });

  it("refuses cancellation of customer setup subscriptions, other owners' probes, unapproved probes and non-admin callers", async () => {
    const admin = await newCase(app, adminLogin);
    const customerSetup = await startSetup(admin.browser, admin.caseId);
    expect(
      (await admin.browser.post(`/api/admin/operations/${customerSetup.operationId}/probe-cancel`)).status,
    ).toBe(404);

    const unapproved = (
      await admin.browser.post(`/api/admin/cases/${admin.caseId}/probe-subscription/provider_b`)
    ).body;
    expect(
      (await admin.browser.post(`/api/admin/operations/${unapproved.operationId}/probe-cancel`)).status,
    ).toBe(409);

    const probe = await approvedProbe("provider_a");
    const otherAdmin = await newCase(app, adminLogin);
    expect(
      (await otherAdmin.browser.post(`/api/admin/operations/${probe.operationId}/probe-cancel`)).status,
    ).toBe(404);
    const reviewer = await newCase(app);
    expect(
      (await reviewer.browser.post(`/api/admin/operations/${probe.operationId}/probe-cancel`)).status,
    ).toBe(403);
    expect(
      (await reviewer.browser.post(`/api/admin/cases/${reviewer.caseId}/probe-subscription/provider_a`))
        .status,
    ).toBe(403);

    const cancelCalls = app.paypal.calls.filter(
      (call) =>
        call.path.endsWith("/cancel") &&
        [customerSetup.subscriptionId, unapproved.subscriptionId, probe.subscriptionId].some((id) =>
          call.path.includes(id),
        ),
    );
    expect(cancelCalls).toHaveLength(0);
    expect(app.paypal.subscriptions.get(customerSetup.subscriptionId)!.status).toBe("APPROVAL_PENDING");
  });
});
