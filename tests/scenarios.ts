import { eq } from "drizzle-orm";
import { expect } from "vitest";
import type { CaseSnapshot } from "../src/shared/contracts";
import { operations } from "../src/server/db/schema";
import { adminLogin, newCase, startSetup, type Browser, type TestApp } from "./helpers";

/** The policy a user confirms in the main scenario: editable text with speakers, up to GBP 15, keep history. */
export const standardPolicy = {
  purpose: "Editable call transcripts with who said what, keeping my earlier calls.",
  requiredCapabilities: ["editable_text", "speaker_labels"],
  recurringCeiling: { currency: "GBP", amountMinor: 1500 },
  preserveHistory: true,
  allowInvestigation: true,
};

/** What PayPal appends to a return URL: Val's token plus the PayPal subscription hint. */
export async function returnCommandFor(
  app: TestApp,
  operationId: string,
  outcome: "approved" | "cancelled" = "approved",
) {
  const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.id, operationId));
  const returnUrl = new URL(JSON.parse(operation!.requestBody!).application_context.return_url);
  return {
    operationId,
    returnToken: returnUrl.searchParams.get("return_token")!,
    subscriptionId: operation!.remoteId,
    outcome,
  };
}

export async function loadOperation(app: TestApp, operationId: string) {
  const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.id, operationId));
  return operation!;
}

/** A case whose Provider A subscription the buyer approved and Val verified through PayPal. */
export async function verifiedSetupCase(
  app: TestApp,
  login = adminLogin,
  scenario: "feature_removed" | "grandfathered" | "value_offer" = "feature_removed",
) {
  const { browser, caseId } = await newCase(app, login, scenario);
  const { operationId, subscriptionId } = await startSetup(browser, caseId);
  app.paypal.approve(subscriptionId);
  expect(
    (
      await browser.post(
        `/api/cases/${caseId}/setup-subscription/return`,
        await returnCommandFor(app, operationId),
      )
    ).status,
  ).toBe(200);
  await app.runJobs();
  return { browser, caseId, setupOperationId: operationId, setupSubscriptionId: subscriptionId };
}

export const putPolicy = (
  browser: Browser,
  caseId: string,
  expectedRevision: number,
  overrides: object = {},
) =>
  browser.request("PUT", `/api/cases/${caseId}/policy`, {
    policy: { ...standardPolicy, ...overrides },
    expectedRevision,
  });

export const snapshotOf = async (browser: Browser, caseId: string): Promise<CaseSnapshot> =>
  (await browser.get(`/api/cases/${caseId}`)).body;

/** Applies the case's entitlement event and lets the investigation job run. */
export async function applyEventAndInvestigate(app: TestApp, browser: Browser, caseId: string) {
  const scenario = (await snapshotOf(browser, caseId)).case.scenario;
  const queued = await browser.post(`/api/cases/${caseId}/scenario`, { scenario });
  await app.runJobs();
  return queued;
}

/**
 * The main scenario up to the point where the user is asked to consent to the Provider B switch. The investigation is
 * run by the stand-in model through the real tools and deterministic checks.
 */
export async function caseAwaitingConsent(app: TestApp, overrides: object = {}) {
  const setup = await verifiedSetupCase(app);
  expect((await putPolicy(setup.browser, setup.caseId, 0, overrides)).status).toBe(200);
  await applyEventAndInvestigate(app, setup.browser, setup.caseId);
  const snapshot = await snapshotOf(setup.browser, setup.caseId);
  expect(snapshot.case.state).toBe("AWAITING_CONSENT");
  expect(snapshot.recommendation).toMatchObject({ action: "switch", candidateId: "b_02" });
  return { ...setup, recommendationId: snapshot.recommendation!.id };
}

export async function valueAwaitingConsent(app: TestApp) {
  const setup = await verifiedSetupCase(app, adminLogin, "value_offer");
  expect(
    (
      await putPolicy(setup.browser, setup.caseId, 0, {
        purpose:
          "I need editable work and my saved work kept. A new plan may cost up to £15 each month. Ask before buying.",
        requiredCapabilities: ["editable_text"],
      })
    ).status,
  ).toBe(200);
  expect(
    (await setup.browser.post(`/api/cases/${setup.caseId}/check`, { expectedPolicyRevision: 1 })).status,
  ).toBe(200);
  await app.runJobs();
  expect((await snapshotOf(setup.browser, setup.caseId)).case.state).toBe("STAY");
  await applyEventAndInvestigate(app, setup.browser, setup.caseId);
  const snapshot = await snapshotOf(setup.browser, setup.caseId);
  expect(snapshot.case.state).toBe("AWAITING_CONSENT");
  expect(snapshot.recommendation).toMatchObject({ action: "switch", candidateId: "b_03" });
  return { ...setup, recommendationId: snapshot.recommendation!.id };
}

/** A preview of the exact terms and the user's two consents to it. */
export async function previewAndConsent(browser: Browser, caseId: string, recommendationId: string) {
  const previewed = await browser.post(`/api/cases/${caseId}/preview`, { recommendationId });
  expect(previewed.status).toBe(200);
  const preview = previewed.body;
  const consented = await browser.post(`/api/cases/${caseId}/consents`, {
    previewId: preview.id,
    previewHash: preview.previewHash,
    approvePurchase: true,
    approveOldExitAfterReadiness: true,
  });
  expect(consented.status).toBe(201);
  return { preview, consent: consented.body };
}

/** Consent, checkout and nothing else: Provider B's subscription exists and waits for the buyer. */
export async function startPurchase(
  _app: TestApp,
  flow: { browser: Browser; caseId: string; recommendationId: string },
) {
  const { preview, consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
  const checkout = await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id });
  expect(checkout.status).toBe(200);
  return {
    preview,
    consent,
    approval: checkout.body as { operationId: string; subscriptionId: string; approvalUrl: string },
  };
}

/** The buyer approves and pays Provider B at PayPal, the browser returns, and the queued work runs. */
export async function approvePurchaseAndReturn(
  app: TestApp,
  flow: { browser: Browser; caseId: string },
  approval: { operationId: string; subscriptionId: string },
) {
  app.paypal.approve(approval.subscriptionId);
  const returned = await flow.browser.post(
    `/api/cases/${flow.caseId}/checkout/return`,
    await returnCommandFor(app, approval.operationId),
  );
  expect(returned.status).toBe(200);
  await app.runJobs();
}

export const cancelCallsFor = (app: TestApp, subscriptionId: string) =>
  app.paypal.calls.filter((call) => call.method === "POST" && call.path.endsWith(`${subscriptionId}/cancel`));
