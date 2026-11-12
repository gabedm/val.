import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validate } from "../src/shared/contracts";
import catalogue from "../docs/build-pack/catalogue/catalogue.json";
import {
  agentRuns,
  artifacts,
  cases,
  consents,
  evaluations,
  evidence,
  jobs,
  operations,
  policies,
  quotes,
  recommendations,
} from "../src/server/db/schema";
import { getQuote, ProviderError } from "../src/server/providers";
import { newCase, reviewerLogin, startSetup, startTestApp, type TestApp } from "./helpers";
import { caseAwaitingConsent, putPolicy, snapshotOf, verifiedSetupCase } from "./scenarios";

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

const money = (amountMinor: number) => ({ currency: "GBP", amountMinor });
const command = (expectedPolicyRevision: number, overrides: object) => ({
  expectedPolicyRevision,
  overrides,
});

async function compare(
  browser: Awaited<ReturnType<typeof newCase>>["browser"],
  caseId: string,
  overrides: object,
) {
  const response = await browser.post(`/api/cases/${caseId}/what-if`, command(1, overrides));
  expect(response.status).toBe(200);
  expect(validate.whatIfResult(response.body)).toBe(true);
  return response.body;
}

describe("advisory What-if and read-only catalogue", () => {
  it("reuses actual observations for isolated outcomes without changing authoritative state", async () => {
    const flow = await caseAwaitingConsent(app, {
      allowInvestigation: true,
      requiredCapabilities: ["speaker_labels"],
      recurringCeiling: money(1500),
    });
    const before = await snapshotOf(flow.browser, flow.caseId);
    expect(before.activeFaults).toEqual([]);
    expect(before.currentOutput).not.toBeNull();
    const counts = await Promise.all([
      app.ctx.db.select().from(policies).where(eq(policies.caseId, flow.caseId)),
      app.ctx.db.select().from(recommendations).where(eq(recommendations.caseId, flow.caseId)),
      app.ctx.db.select().from(evaluations).where(eq(evaluations.caseId, flow.caseId)),
      app.ctx.db.select().from(consents).where(eq(consents.caseId, flow.caseId)),
      app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId)),
      app.ctx.db.select().from(jobs).where(eq(jobs.caseId, flow.caseId)),
    ]);

    const switched = await compare(flow.browser, flow.caseId, { recurringCeiling: money(1500) });
    expect(switched).toMatchObject({
      advisory: true,
      status: "current",
      verdict: "accepted",
      outcome: { action: "switch", candidateId: "b_02" },
    });
    const upgrade = await compare(flow.browser, flow.caseId, { recurringCeiling: money(2000) });
    expect(upgrade.outcome).toMatchObject({ action: "change_plan", candidateId: "a_02" });
    const stay = await compare(flow.browser, flow.caseId, { requiredCapabilities: ["editable_text"] });
    expect(stay.outcome).toMatchObject({ action: "stay", candidateId: null });
    const noCandidate = await compare(flow.browser, flow.caseId, {
      recurringCeiling: money(1000),
      requiredCapabilities: ["speaker_labels"],
    });
    expect(noCandidate.outcome).toMatchObject({ action: "investigate", candidateId: null });
    await app.ctx.db
      .update(cases)
      .set({
        evaluation: {
          notice: "Test workspace",
          plans: { a_01: { marketingText: "Editable", editableText: false, speakerLabels: false } },
        },
      })
      .where(eq(cases.id, flow.caseId));
    expect(
      (
        await compare(flow.browser, flow.caseId, {
          recurringCeiling: money(2000),
          requiredCapabilities: ["editable_text"],
        })
      ).outcome.action,
    ).not.toBe("stay");

    const after = await snapshotOf(flow.browser, flow.caseId);
    const afterCounts = await Promise.all([
      app.ctx.db.select().from(policies).where(eq(policies.caseId, flow.caseId)),
      app.ctx.db.select().from(recommendations).where(eq(recommendations.caseId, flow.caseId)),
      app.ctx.db.select().from(evaluations).where(eq(evaluations.caseId, flow.caseId)),
      app.ctx.db.select().from(consents).where(eq(consents.caseId, flow.caseId)),
      app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId)),
      app.ctx.db.select().from(jobs).where(eq(jobs.caseId, flow.caseId)),
    ]);
    expect(afterCounts.map((rows) => rows.length)).toEqual(counts.map((rows) => rows.length));
    expect(after).toMatchObject({
      case: { state: before.case.state },
      policy: before.policy,
      recommendation: before.recommendation,
      currentAccount: before.currentAccount,
      currentQuote: before.currentQuote,
      evaluations: before.evaluations,
    });
    expect(after.evaluationQuotes.map((quote) => quote.id)).toEqual(
      before.evaluationQuotes.map((quote) => quote.id),
    );
    expect(after.currentOutput).toMatchObject({
      planId: "a_01",
      capabilityResults: [{ capability: "speaker_labels", passes: false }],
    });
    expect(after.investigationRun).toMatchObject({ id: expect.any(String), usage: expect.any(Object) });
    expect(
      await app.ctx.db
        .select()
        .from(agentRuns)
        .where(and(eq(agentRuns.task, "what_if"), eq(agentRuns.caseId, flow.caseId))),
    ).toHaveLength(5);
    expect(
      (await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, flow.caseId))).filter(
        (row) => row.advisory,
      ),
    ).not.toHaveLength(0);
    expect(
      (await app.ctx.db.select().from(artifacts).where(eq(artifacts.caseId, flow.caseId))).filter(
        (row) => row.advisory,
      ),
    ).not.toHaveLength(0);
    expect(
      (await app.ctx.db.select().from(quotes).where(eq(quotes.caseId, flow.caseId))).filter(
        (row) => row.advisory,
      ),
    ).not.toHaveLength(0);
    expect(
      (await flow.browser.get(`/api/cases/${flow.caseId}/evidence`)).body.every(
        (item: { advisory?: boolean }) => item.advisory !== true,
      ),
    ).toBe(true);
    const [caseRow] = await app.ctx.db.select().from(cases).where(eq(cases.id, flow.caseId));
    await app.ctx.db
      .update(cases)
      .set({ faults: { ...caseRow!.faults, timeout: true } })
      .where(eq(cases.id, flow.caseId));
    expect((await snapshotOf(flow.browser, flow.caseId)).activeFaults).toEqual(["timeout"]);
  });

  it("hides archived advisory evidence from case evidence and rejects another owner's What-if", async () => {
    const flow = await caseAwaitingConsent(app, { allowInvestigation: true });
    await compare(flow.browser, flow.caseId, { requiredCapabilities: ["editable_text"] });
    expect(
      await app.ctx.db
        .select()
        .from(evidence)
        .where(and(eq(evidence.caseId, flow.caseId), eq(evidence.advisory, true))),
    ).not.toHaveLength(0);

    const reset = await flow.browser.post(`/api/cases/${flow.caseId}/reset`, {
      acknowledgeEarlierTransitionContinues: true,
    });
    expect(reset.status).toBe(201);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.archivedAt).not.toBeNull();
    const visibleEvidence = await flow.browser.get(`/api/cases/${flow.caseId}/evidence`);
    expect(visibleEvidence.status).toBe(200);
    expect(visibleEvidence.body.every((item: { advisory?: boolean }) => item.advisory !== true)).toBe(true);

    const stranger = app.browser();
    await stranger.login(reviewerLogin);
    expect(
      (
        await stranger.post(
          `/api/cases/${flow.caseId}/what-if`,
          command(1, { requiredCapabilities: ["editable_text"] }),
        )
      ).status,
    ).toBe(404);
    expect((await stranger.get(`/api/cases/${flow.caseId}/evidence`)).status).toBe(404);
  });

  it("rejects unauthorized, stale, malformed and handover-blocked requests before investigating", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await putPolicy(browser, caseId, 0, { allowInvestigation: false });
    const calls = app.model.requests.length;
    const foreign = app.browser();
    await foreign.login(reviewerLogin);
    expect(
      (
        await foreign.post(
          `/api/cases/${caseId}/what-if`,
          command(1, { requiredCapabilities: ["editable_text"] }),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await browser.post(
          `/api/cases/${caseId}/what-if`,
          command(1, { requiredCapabilities: ["editable_text"] }),
          { csrf: null },
        )
      ).status,
    ).toBe(403);
    const invalid = [
      { recurringCeiling: money(-1) },
      { recurringCeiling: money(1.5) },
      { requiredCapabilities: [] },
      { requiredCapabilities: ["editable_text", "editable_text"] },
      { requiredCapabilities: ["editable_text"], permission: true },
      { requiredCapabilities: ["editable_text"], ownerId: "x" },
    ];
    for (const overrides of invalid)
      expect((await browser.post(`/api/cases/${caseId}/what-if`, command(1, overrides))).status).toBe(400);
    expect(
      (
        await browser.post(
          `/api/cases/${caseId}/what-if`,
          command(2, { requiredCapabilities: ["editable_text"] }),
        )
      ).body.error,
    ).toBe("stale_policy");
    expect(
      (
        await browser.post(
          `/api/cases/${caseId}/what-if`,
          command(1, { requiredCapabilities: ["editable_text"] }),
        )
      ).body.error,
    ).toBe("permission_required");
    expect(app.model.requests.length).toBe(calls);

    const flow = await caseAwaitingConsent(app);
    const preview = await flow.browser.post(`/api/cases/${flow.caseId}/preview`, {
      recommendationId: flow.recommendationId,
    });
    const consent = await flow.browser.post(`/api/cases/${flow.caseId}/consents`, {
      previewId: preview.body.id,
      previewHash: preview.body.previewHash,
      approvePurchase: true,
      approveOldExitAfterReadiness: true,
    });
    await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.body.id });
    expect(
      (
        await flow.browser.post(
          `/api/cases/${flow.caseId}/what-if`,
          command(1, { recurringCeiling: money(1500) }),
        )
      ).body.error,
    ).toBe("handover_open");
    const [purchase] = await app.ctx.db
      .select()
      .from(operations)
      .where(and(eq(operations.caseId, flow.caseId), eq(operations.kind, "replacement_create")));
    await app.ctx.db.update(operations).set({ status: "FAILED" }).where(eq(operations.id, purchase!.id));
    expect((await snapshotOf(flow.browser, flow.caseId)).handover).toMatchObject({
      operationId: purchase!.id,
      status: "FAILED",
      billingStatus: "APPROVAL_PENDING",
      approvalUrl: expect.any(String),
      retryable: true,
    });
  });

  it("guards concurrent comparisons and reports a baseline that changed during the model run", async () => {
    const flow = await caseAwaitingConsent(app);
    const model = app.model;
    const originalCreate = model.responses.create;
    let entered!: () => void;
    let release!: () => void;
    const firstCall = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    model.responses.create = async (request, options) => {
      entered();
      await held;
      return originalCreate(request, options);
    };
    try {
      const first = flow.browser.post(
        `/api/cases/${flow.caseId}/what-if`,
        command(1, { recurringCeiling: money(1500) }),
      );
      await firstCall;
      const concurrent = await flow.browser.post(
        `/api/cases/${flow.caseId}/what-if`,
        command(1, { recurringCeiling: money(1500) }),
      );
      expect(concurrent).toMatchObject({ status: 409, body: { error: "what_if_pending" } });
      await app.ctx.db.update(cases).set({ state: "STAY" }).where(eq(cases.id, flow.caseId));
      release();
      const result = await first;
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        status: "stale",
        staleReason: "The case state changed while the comparison was running.",
      });
    } finally {
      release();
      model.responses.create = originalCreate;
    }
  });

  it("exposes the authenticated catalogue and setup handover while refusing catalogue IDs as financial candidates", async () => {
    const anonymous = app.browser();
    expect((await anonymous.get("/api/catalogue")).status).toBe(401);
    const { browser, caseId } = await newCase(app);
    expect((await snapshotOf(browser, caseId)).currentOutput).toBeNull();
    const response = await browser.get("/api/catalogue");
    expect(response.status).toBe(200);
    expect(response.body.catalogue.services).toHaveLength(202);
    expect(response.body.catalogue.categories).toHaveLength(11);
    expect(
      response.body.catalogue.categories
        .filter((category: { id: string }) => category.id !== "mobile")
        .every((category: { count: number }) => category.count === 20),
    ).toBe(true);
    expect(
      response.body.catalogue.services.find((service: { id: string }) => service.id === "voxi").execution
        .purchase_supported,
    ).toBe(false);
    expect(response.body.logos).toEqual({});
    expect((await browser.get("/logos/provider.svg")).status).toBe(404);
    const [caseRow] = await app.ctx.db.select().from(cases).where(eq(cases.id, caseId));
    const catalogueId = (catalogue.services[0] as { id: string }).id;
    await expect(getQuote(app.ctx.db, caseRow!, catalogueId)).rejects.toThrow(ProviderError);

    const setup = await startSetup(browser, caseId);
    const snapshot = await snapshotOf(browser, caseId);
    expect(snapshot.handover).toMatchObject({
      operationId: expect.any(String),
      billingStatus: "APPROVAL_PENDING",
      approvalUrl: setup.approvalUrl,
      retryable: false,
    });
  });
});
