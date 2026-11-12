import { eq } from "drizzle-orm";
import { afterEach, beforeAll, afterAll, describe, expect, it } from "vitest";
import { validate, validatorFor } from "../src/shared/contracts";
import { agentModel, recommendationOutputSchema } from "../src/server/agent-contract";
import {
  agentRuns,
  cases,
  evaluations,
  evidence,
  operations,
  policyDrafts,
  quotes,
  recommendations,
} from "../src/server/db/schema";
import { newCase, reviewerLogin, startSetup, startTestApp, type TestApp } from "./helpers";
import {
  applyEventAndInvestigate,
  caseAwaitingConsent,
  previewAndConsent,
  putPolicy,
  snapshotOf,
  standardPolicy,
  valueAwaitingConsent,
  verifiedSetupCase,
} from "./scenarios";

// Policy drafting, permission and the agent's investigation through the real tools and deterministic checks. Real
// PostgreSQL; PayPal and the OpenAI model are local stand-ins, so none of this is evidence about the real model.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());
afterEach(() => {
  app.model.script = null;
});

const runsOf = (caseId: string) => app.ctx.db.select().from(agentRuns).where(eq(agentRuns.caseId, caseId));
const recommendationsOf = (caseId: string) =>
  app.ctx.db.select().from(recommendations).where(eq(recommendations.caseId, caseId));
const evaluationOf = (snapshot: Awaited<ReturnType<typeof snapshotOf>>, candidateId: string) =>
  snapshot.evaluations.find((evaluation) => evaluation.candidateId === candidateId);

/** A verified case with a confirmed policy, investigated after its entitlement event. */
async function investigatedCase(overrides: object = {}, scenario?: "grandfathered") {
  const setup = await verifiedSetupCase(app);
  if (scenario) await app.ctx.db.update(cases).set({ scenario }).where(eq(cases.id, setup.caseId));
  await putPolicy(setup.browser, setup.caseId, 0, overrides);
  await applyEventAndInvestigate(app, setup.browser, setup.caseId);
  return { ...setup, snapshot: await snapshotOf(setup.browser, setup.caseId) };
}

describe("policy confirmation and drafting (T01)", () => {
  it("needs Provider A's verified paid period before a policy can be confirmed", async () => {
    const { browser, caseId } = await newCase(app);
    await startSetup(browser, caseId);
    expect((await putPolicy(browser, caseId, 0)).body.error).toBe("setup_incomplete");
  });

  it("records a new revision that grants no purchase or exit authority, and rejects stale or malformed edits", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const confirmed = await putPolicy(browser, caseId, 0);
    expect(confirmed.body).toMatchObject({ revision: 1, recurringCeiling: { amountMinor: 1500 } });
    const snapshot = await snapshotOf(browser, caseId);
    expect(validate.caseSnapshot(snapshot)).toBe(true);
    expect(snapshot).toMatchObject({
      case: { state: "MONITORING" },
      transition: null,
      receipt: { newBillingStatus: "NONE" },
    });

    expect((await putPolicy(browser, caseId, 0)).status).toBe(409);
    expect(
      (await putPolicy(browser, caseId, 1, { requiredCapabilities: ["editable_text", "editable_text"] }))
        .status,
    ).toBe(400);
    expect((await putPolicy(browser, caseId, 1, { purpose: "   " })).status).toBe(400);
    expect((await putPolicy(browser, caseId, 1, { purpose: "x".repeat(2001) })).status).toBe(400);
  });

  it("drafts requirements from the person's words, records the run and grants nothing", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const purpose = "Editable transcripts with speaker names, keep my old calls, up to £15 a month.";
    const drafted = await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose });
    expect(drafted.status).toBe(200);
    expect(validate.policyDraft(drafted.body)).toBe(true);
    expect(drafted.body).toMatchObject({
      purpose,
      requiredCapabilities: ["editable_text", "speaker_labels"],
      recurringCeiling: { amountMinor: 1500 },
      allowInvestigation: null,
    });

    expect((await snapshotOf(browser, caseId)).policy).toBeNull();
    const [run] = await runsOf(caseId);
    expect(run).toMatchObject({
      task: "policy_draft",
      outcome: "accepted",
      version: { model: agentModel, reasoningEffort: "low" },
    });
    expect(app.model.requests.at(-1)!.text!.format).toMatchObject({
      type: "json_schema",
      name: "PolicyDraft",
      strict: true,
    });
    expect(await app.ctx.db.select().from(policyDrafts).where(eq(policyDrafts.caseId, caseId))).toHaveLength(
      1,
    );
  });

  it("keeps an unsupported requirement in review until the purpose no longer asks for it", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const purpose = "Editable transcripts with speaker labels, translated into French, up to £15 a month.";
    const drafted = await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose });
    expect(drafted.body.unsupportedRequirements).toEqual(["Translation of each call"]);

    const blocked = await putPolicy(browser, caseId, 0, { purpose });
    expect(blocked.status).toBe(409);
    expect(blocked.body.error).toBe("unsupported_requirements");
    expect((await snapshotOf(browser, caseId)).policy).toBeNull();

    const revised = "Editable transcripts with speaker labels, up to £15 a month.";
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: revised })).body
        .unsupportedRequirements,
    ).toEqual([]);
    expect((await putPolicy(browser, caseId, 0, { purpose: revised })).status).toBe(200);
  });

  const unsupportedPurpose =
    "Editable transcripts with speaker labels, translated into French, up to £15 a month.";
  const accentedPurpose = unsupportedPurpose.replace("transcripts", "transcripts of café calls");
  const cosmeticPurposes = [
    { name: "the UI trims a trailing space", drafted: `${unsupportedPurpose} `, saved: unsupportedPurpose },
    {
      name: "surrounding Unicode whitespace changes",
      drafted: unsupportedPurpose,
      saved: `\u00a0${unsupportedPurpose}\u202f`,
    },
    {
      name: "internal whitespace and line endings change",
      drafted: unsupportedPurpose,
      saved: unsupportedPurpose.replaceAll(" ", " \r\n\t"),
    },
    { name: "capitalization changes", drafted: unsupportedPurpose, saved: unsupportedPurpose.toUpperCase() },
    {
      name: "terminal punctuation changes",
      drafted: unsupportedPurpose,
      saved: `${unsupportedPurpose.slice(0, -1)}!?`,
    },
    {
      name: "Unicode uses a decomposed form",
      drafted: accentedPurpose,
      saved: accentedPurpose.normalize("NFD"),
    },
  ];

  it.each(cosmeticPurposes)("keeps unsupported review when $name", async ({ drafted, saved }) => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const response = await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: drafted });
    expect(response.status).toBe(200);
    expect(response.body.purpose).toBe(drafted);
    expect(response.body.unsupportedRequirements).toEqual(["Translation of each call"]);
    const confirmed = await putPolicy(browser, caseId, 0, { purpose: saved });
    expect(confirmed).toMatchObject({ status: 409, body: { error: "unsupported_requirements" } });
    expect((await snapshotOf(browser, caseId)).policy).toBeNull();
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId))).map(
        (operation) => operation.kind,
      ),
    ).toEqual(["setup_create"]);
  });

  it("requires a matching redraft to resolve known unsupported review, without overriding manual choices", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unsupportedPurpose });
    const revised = "Editable transcripts with speaker labels, keep my old calls, up to £15 a month.";
    expect((await putPolicy(browser, caseId, 0, { purpose: revised })).body.error).toBe("draft_required");
    const unrelated = "Editable notes of internal meetings; keep my earlier notes; up to £12 a month.";
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unrelated })).body
        .unsupportedRequirements,
    ).toEqual([]);
    expect((await putPolicy(browser, caseId, 0, { purpose: revised })).body.error).toBe("draft_required");
    expect((await snapshotOf(browser, caseId)).policy).toBeNull();
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: revised })).body
        .unsupportedRequirements,
    ).toEqual([]);
    const manual = {
      purpose: ` ${revised} `,
      requiredCapabilities: ["editable_text"],
      recurringCeiling: { currency: "GBP", amountMinor: 2000 },
      preserveHistory: false,
      allowInvestigation: false,
    };
    const saved = await putPolicy(browser, caseId, 0, manual);
    expect(saved).toMatchObject({ status: 200, body: { revision: 1, ...manual } });
    expect((await putPolicy(browser, caseId, 1, { purpose: unsupportedPurpose })).body.error).toBe(
      "unsupported_requirements",
    );
    expect((await snapshotOf(browser, caseId)).policy).toMatchObject({ revision: 1, ...manual });
  });

  it("does not erase known unsupported review when a later draft silently omits it", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unsupportedPurpose });
    const draft = app.model.draft;
    app.model.draft = (purpose) => ({ ...draft(purpose), unsupportedRequirements: [] });
    try {
      const cosmetic = ` ${unsupportedPurpose.toUpperCase()} `;
      expect(
        (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: cosmetic })).body
          .unsupportedRequirements,
      ).toEqual([]);
      const saved = await putPolicy(browser, caseId, 0, { purpose: cosmetic.trim() });
      expect(saved).toMatchObject({ status: 409, body: { error: "unsupported_requirements" } });
      expect((await snapshotOf(browser, caseId)).policy).toBeNull();
    } finally {
      app.model.draft = draft;
    }
  });

  it("keeps unsupported review through a failed redraft", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unsupportedPurpose });
    app.model.script = () => ({ text: "not json" });
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unsupportedPurpose.trim() })).body
        .error,
    ).toBe("draft_review");
    expect((await putPolicy(browser, caseId, 0, { purpose: unsupportedPurpose })).body.error).toBe(
      "unsupported_requirements",
    );
    expect(
      (await putPolicy(browser, caseId, 0, { purpose: "Only editable call transcripts." })).body.error,
    ).toBe("draft_required");
    expect((await snapshotOf(browser, caseId)).policy).toBeNull();
  });

  it("allows explicit manual preferences without drafting and preserves an unchanged confirmed purpose", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const model = app.ctx.model;
    const calls = app.model.requests.length;
    const purpose = "Editable notes of meetings.";
    app.ctx.model = null;
    try {
      expect(
        (
          await putPolicy(browser, caseId, 0, {
            purpose,
            requiredCapabilities: ["editable_text"],
            allowInvestigation: false,
          })
        ).status,
      ).toBe(200);
      expect(app.model.requests.length).toBe(calls);
    } finally {
      app.ctx.model = model;
    }
    await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: unsupportedPurpose });
    const manual = {
      purpose: ` ${purpose.toUpperCase()} `,
      requiredCapabilities: ["editable_text"],
      recurringCeiling: { currency: "GBP", amountMinor: 1700 },
      preserveHistory: false,
      allowInvestigation: false,
    };
    expect(await putPolicy(browser, caseId, 1, manual)).toMatchObject({
      status: 200,
      body: { revision: 2, ...manual },
    });
  });

  it("reports drafting as unavailable without a model, and invalid drafts as review (induced)", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    const model = app.ctx.model;
    app.ctx.model = null;
    try {
      expect(
        (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: "Editable transcripts." })).body
          .error,
      ).toBe("model_unavailable");
    } finally {
      app.ctx.model = model;
    }

    app.model.script = () => ({
      answer: {
        purpose: "x",
        requiredCapabilities: ["editable_text", "editable_text"],
        recurringCeiling: null,
        preserveHistory: null,
        allowInvestigation: null,
        interpretationNotes: [],
        unsupportedRequirements: [],
      },
    });
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: "Editable transcripts." })).body
        .error,
    ).toBe("draft_review");
    app.model.script = () => ({ text: "not json" });
    expect(
      (await browser.post(`/api/cases/${caseId}/policy-draft`, { purpose: "Editable transcripts." })).body
        .error,
    ).toBe("draft_review");
    expect((await runsOf(caseId)).map((run) => run.outcome).sort()).toEqual(["rejected", "review"]);
  });

  it("makes no model or provider call at all while investigation is not permitted", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await putPolicy(browser, caseId, 0, { allowInvestigation: false });
    const modelCalls = app.model.requests.length;
    const evidenceBefore = (await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, caseId)))
      .length;

    expect((await browser.post(`/api/cases/${caseId}/check`, { expectedPolicyRevision: 1 })).status).toBe(
      200,
    );
    expect((await applyEventAndInvestigate(app, browser, caseId)).status).toBe(200);

    expect((await snapshotOf(browser, caseId)).case).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: "permission_required",
    });
    expect(app.model.requests.length).toBe(modelCalls);
    expect((await app.ctx.db.select().from(evidence).where(eq(evidence.caseId, caseId))).length).toBe(
      evidenceBefore,
    );
    expect(await runsOf(caseId)).toEqual([]);
  });

  it("withdraws unconsumed consent when a new revision is confirmed", async () => {
    const flow = await caseAwaitingConsent(app);
    const { consent } = await previewAndConsent(flow.browser, flow.caseId, flow.recommendationId);
    await putPolicy(flow.browser, flow.caseId, 1);
    expect(
      (await flow.browser.post(`/api/cases/${flow.caseId}/checkout`, { consentId: consent.id })).status,
    ).toBe(409);
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId))).map(
        (operation) => operation.kind,
      ),
    ).toEqual(["setup_create"]);
  });
});

describe("accepted investigations follow the evidence and 04's order (T02-T08)", () => {
  it("stays on a healthy account after reading only its own output", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await putPolicy(browser, caseId, 0);
    await browser.post(`/api/cases/${caseId}/check`, { expectedPolicyRevision: 1 });
    await app.runJobs();
    const snapshot = await snapshotOf(browser, caseId);
    expect(snapshot.case.state).toBe("STAY");
    expect(snapshot.recommendation).toMatchObject({ action: "stay", candidateId: null });
    const [run] = await runsOf(caseId);
    expect(run!.trace.map((step) => step.tool)).toEqual(["read_account"]);
  });

  it("switches to the GBP 14 plan after rejecting the GBP 19 upgrade on price and the basic plan on its output", async () => {
    const { browser, caseId, snapshot } = await investigatedCase();
    expect(snapshot.case.state).toBe("AWAITING_CONSENT");
    expect(snapshot.recommendation).toMatchObject({
      action: "switch",
      candidateId: "b_02",
      policyRevision: 1,
    });
    expect(evaluationOf(snapshot, "a_02")).toMatchObject({
      eligible: false,
      capabilityResults: [],
      rejectionReasons: [expect.stringMatching(/GBP 19\.00 a month, above the GBP 15\.00 ceiling/)],
    });
    expect(evaluationOf(snapshot, "b_01")).toMatchObject({
      eligible: false,
      rejectionReasons: [expect.stringMatching(/^speaker_labels:/)],
    });
    expect(evaluationOf(snapshot, "b_02")).toMatchObject({ eligible: true, rejectionReasons: [] });

    const [run] = await runsOf(caseId);
    expect(run).toMatchObject({ task: "investigation", outcome: "accepted", policyRevision: 1 });
    expect(run!.trace.map((step) => step.tool)).toEqual([
      "read_account",
      "list_plans",
      "get_quote",
      "get_quote",
      "get_quote",
      "test_candidate",
      "test_candidate",
    ]);
    const [stored] = await recommendationsOf(caseId);
    expect(stored).toMatchObject({ source: "agent", agentRunId: run!.id });
    const caseEvidence = new Set(
      (await app.ctx.db.select({ id: evidence.id }).from(evidence).where(eq(evidence.caseId, caseId))).map(
        (row) => row.id,
      ),
    );
    expect(stored!.evidenceIds.every((id) => caseEvidence.has(id))).toBe(true);
    expect((await browser.get(`/api/cases/${caseId}`)).status).toBe(200);
  });

  it("treats an eligible Provider A upgrade as advice only, with no preview (T07)", async () => {
    const { browser, caseId, snapshot } = await investigatedCase({
      recurringCeiling: { currency: "GBP", amountMinor: 2000 },
    });
    expect(snapshot.case).toMatchObject({ state: "NEEDS_REVIEW", reason: "advice_only" });
    expect(snapshot.recommendation).toMatchObject({ action: "change_plan", candidateId: "a_02" });
    expect(
      (await browser.post(`/api/cases/${caseId}/preview`, { recommendationId: snapshot.recommendation!.id }))
        .status,
    ).toBe(409);
  });

  it("reviews rather than relaxing a requirement when nothing qualifies (T06)", async () => {
    const { snapshot } = await investigatedCase({ recurringCeiling: { currency: "GBP", amountMinor: 500 } });
    expect(snapshot.case).toMatchObject({ state: "NEEDS_REVIEW", reason: "no_candidate" });
    expect(snapshot.recommendation).toMatchObject({ action: "investigate", candidateId: null });
    expect(snapshot.evaluations.every((evaluation) => !evaluation.eligible)).toBe(true);
  });

  it("stays with a grandfathered account whose output still passes, with no purchase or cancellation (T08)", async () => {
    const { caseId, snapshot, setupSubscriptionId } = await investigatedCase({}, "grandfathered");
    expect(snapshot.case.state).toBe("STAY");
    expect(snapshot.currentAccount).toMatchObject({ entitlementRevision: 2 });
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.caseId, caseId))).map(
        (operation) => operation.kind,
      ),
    ).toEqual(["setup_create"]);
    expect(app.paypal.calls.some((call) => call.path.endsWith(`${setupSubscriptionId}/cancel`))).toBe(false);
  });

  it("stays when the person only needs editable text, even after speaker labels are removed", async () => {
    const { snapshot } = await investigatedCase({ requiredCapabilities: ["editable_text"] });
    expect(snapshot.case.state).toBe("STAY");
  });
});

describe("authored value notice and paid offer (local stand-ins)", () => {
  it("keeps the plan when every replacement exceeds the confirmed ceiling and cannot reapply the notice", async () => {
    const flow = await verifiedSetupCase(app, undefined, "value_offer");
    expect(
      (
        await putPolicy(flow.browser, flow.caseId, 0, {
          purpose: "Keep editable work, preserve saved work, and ask before buying a plan over £8 monthly.",
          requiredCapabilities: ["editable_text"],
          recurringCeiling: { currency: "GBP", amountMinor: 800 },
        })
      ).status,
    ).toBe(200);
    await applyEventAndInvestigate(app, flow.browser, flow.caseId);
    const stayed = await snapshotOf(flow.browser, flow.caseId);
    expect(stayed.case.state).toBe("STAY");
    expect(stayed.currentAccount?.entitlementRevision).toBe(2);
    expect(stayed.recommendation?.action).toBe("stay");
    const repeated = await flow.browser.post(`/api/cases/${flow.caseId}/scenario`, {
      scenario: "value_offer",
    });
    expect(repeated.status).toBe(409);
    expect((await snapshotOf(flow.browser, flow.caseId)).case.state).toBe("STAY");
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId))).map(
        (operation) => operation.kind,
      ),
    ).toEqual(["setup_create"]);
  });

  it("stays before the notice, then chooses the suitable offer on its own full-year cost without buying", async () => {
    const flow = await valueAwaitingConsent(app);
    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.policy?.requiredCapabilities).toEqual(["editable_text"]);
    expect(snapshot.currentOutput?.capabilityResults).toMatchObject([
      { capability: "editable_text", passes: true },
    ]);
    expect(snapshot.currentAccount).toMatchObject({ entitlementRevision: 2, billingStatus: "ACTIVE" });
    expect(snapshot.recommendation).toMatchObject({ action: "switch", candidateId: "b_03" });
    const current = snapshot.currentQuote!;
    const offer = snapshot.evaluationQuotes.find((quote) => quote.candidateId === "b_03")!;
    const cheaper = snapshot.evaluationQuotes.find((quote) => quote.candidateId === "b_01")!;
    expect(current.recurringTotal.amountMinor).toBe(1200);
    expect(offer).toMatchObject({
      dueNowTotal: { amountMinor: 600 },
      recurringTotal: { amountMinor: 900 },
      offer: {
        introductoryAmount: { amountMinor: 600 },
        introductoryCycles: 3,
        regularAmount: { amountMinor: 900 },
        eligibility: "ELIGIBLE",
      },
      comparison: { horizonMonths: 12, candidateTotal: { amountMinor: 9900 } },
    });
    expect(cheaper.comparison?.candidateTotal.amountMinor).toBe(10800);
    expect(offer.comparison?.currentTotal.amountMinor).toBeGreaterThan(
      offer.comparison!.candidateTotal.amountMinor,
    );
    expect(app.paypal.subscriptions.get(flow.setupSubscriptionId)?.paidMinor).toBe(1200);
    expect(
      (await app.ctx.db.select().from(operations).where(eq(operations.caseId, flow.caseId))).map(
        (operation) => operation.kind,
      ),
    ).toEqual(["setup_create"]);
    const [run] = (await runsOf(flow.caseId)).filter(
      (item) =>
        item.task === "investigation" &&
        item.outcome === "accepted" &&
        item.trace.some(
          (step) =>
            step.tool === "get_quote" && (step.arguments as { candidateId?: string }).candidateId === "b_03",
        ),
    );
    expect(run?.output).toMatchObject({ action: "switch", candidateId: "b_03" });
  });
});

describe("what the model is given (T22, F11)", () => {
  it("sends the confirmed policy and notice as data, with only the five strict read-only tools and no owner, case or scenario identifiers", async () => {
    const before = app.model.requests.length;
    const { snapshot } = await investigatedCase();
    const requests = app.model.requests
      .slice(before)
      .filter((request) => (request.text?.format as { name: string }).name === "ModelRecommendation");
    const first = requests[0]!;
    expect(first).toMatchObject({
      model: agentModel,
      reasoning: { effort: "low" },
      parallel_tool_calls: false,
      store: false,
      include: ["reasoning.encrypted_content"],
      text: { format: { strict: true } },
    });
    expect(first.tools!.map((tool) => (tool as { name: string }).name)).toEqual([
      "read_account",
      "list_plans",
      "get_quote",
      "test_candidate",
      "read_artifact",
    ]);
    const candidateTools = requests.flatMap((request) =>
      request.tools!.filter((tool) => tool.type === "function" && tool.name === "test_candidate"),
    ) as { parameters: { properties: { candidateId: { enum?: string[] } } } }[];
    expect(candidateTools.length).toBeGreaterThan(0);
    expect(
      candidateTools.every((tool) => !tool.parameters.properties.candidateId.enum?.includes("a_02")),
    ).toBe(true);
    expect(
      candidateTools.some(
        (tool) =>
          tool.parameters.properties.candidateId.enum?.includes("b_01") &&
          tool.parameters.properties.candidateId.enum.includes("b_02"),
      ),
    ).toBe(true);
    expect(first.tools!.every((tool) => (tool as { strict: boolean }).strict)).toBe(true);
    expect((first.text!.format as { schema: unknown }).schema).toEqual(recommendationOutputSchema());

    const input = JSON.parse((first.input as { content: string }[])[0]!.content);
    expect(input.providerNotice).toMatchObject({
      trusted: false,
      text: expect.stringMatching(/speaker labels/),
    });
    expect(input.confirmedPolicy).toEqual({
      revision: 1,
      purpose: standardPolicy.purpose,
      requiredCapabilities: standardPolicy.requiredCapabilities,
      replacementCeiling: standardPolicy.recurringCeiling,
      preserveHistory: true,
    });

    const everythingSent = JSON.stringify(requests.map((request) => request.input));
    for (const hidden of [
      snapshot.case.id,
      snapshot.case.ownerId,
      snapshot.case.initialAccountId,
      snapshot.case.replacementAccountId,
      "feature_removed",
      "accountSpeakerLabels",
      "speakerLabels",
    ]) {
      expect(everythingSent).not.toContain(hidden);
    }
    const storedQuotes = await app.ctx.db.select().from(quotes).where(eq(quotes.caseId, snapshot.case.id));
    expect(storedQuotes.length).toBeGreaterThan(0);
    for (const quote of storedQuotes) expect(everythingSent).not.toContain(quote.id);
    expect(everythingSent).toContain('\\"id\\":\\"quote_b_02\\"');

    // Evidence reaches the model only as short references; what Val stores and acts on are the real evidence IDs.
    const storedEvidence = await app.ctx.db
      .select({ id: evidence.id })
      .from(evidence)
      .where(eq(evidence.caseId, snapshot.case.id));
    for (const { id } of storedEvidence) expect(everythingSent).not.toContain(id);
    const toolOutputs = requests.at(-1)!.input as { type?: string; output?: string }[];
    const references = toolOutputs
      .filter((item) => item.type === "function_call_output")
      .flatMap((item) => {
        const output = JSON.parse(item.output!);
        return [...(output.evidenceIds ?? []), output.quote?.evidenceId, output.account?.evidenceId].filter(
          Boolean,
        );
      });
    expect(references.length).toBeGreaterThan(5);
    expect(references.every((reference: string) => /^E\d+$/.test(reference))).toBe(true);
    const [stored] = await recommendationsOf(snapshot.case.id);
    expect(stored!.evidenceIds.every((id) => storedEvidence.some((row) => row.id === id))).toBe(true);
  });

  it("pairs quote evidence with the confirmed ceiling and an exact inclusive price comparison", async () => {
    const acceptQuote = validatorFor("GetQuoteResult");
    for (const ceiling of [0, 899, 900, 901]) {
      const { caseId } = await investigatedCase({
        recurringCeiling: { currency: "GBP", amountMinor: ceiling },
      });
      const [run] = await runsOf(caseId);
      const result = run!.trace.find(
        (step) =>
          step.tool === "get_quote" && (step.arguments as { candidateId: string }).candidateId === "b_01",
      )!.result;
      expect(result).toMatchObject({
        quote: { candidateId: "b_01", recurringTotal: { currency: "GBP", amountMinor: 900 } },
        replacementCeiling: { currency: "GBP", amountMinor: ceiling },
        withinCeiling: 900 <= ceiling,
      });
      expect(acceptQuote(result)).toBe(true);
    }
  });

  it("returns every reasoning item and pairs each tool output with its call_id on the next request", async () => {
    const before = app.model.requests.length;
    await investigatedCase();
    const followUp = app.model.requests
      .slice(before)
      .find((request) =>
        (request.input as { type?: string }[]).some((item) => item.type === "function_call"),
      )!;
    const items = followUp.input as { type?: string; call_id?: string; encrypted_content?: string }[];
    const call = items.find((item) => item.type === "function_call")!;
    expect(items.find((item) => item.type === "function_call_output")).toMatchObject({
      call_id: call.call_id,
    });
    expect(items.some((item) => item.type === "reasoning" && item.encrypted_content === "opaque")).toBe(true);
  });
});

/** Runs one investigation of the main scenario with the stand-in told how to misbehave, and returns what was stored. */
async function investigateWith(script: NonNullable<TestApp["model"]["script"]>, overrides: object = {}) {
  const setup = await verifiedSetupCase(app);
  await putPolicy(setup.browser, setup.caseId, 0, overrides);
  app.model.script = script;
  await applyEventAndInvestigate(app, setup.browser, setup.caseId);
  app.model.script = null;
  const [run] = await runsOf(setup.caseId);
  return {
    ...setup,
    run: run!,
    snapshot: await snapshotOf(setup.browser, setup.caseId),
    stored: await recommendationsOf(setup.caseId),
  };
}

const investigationTurns = (request: { text?: unknown }) =>
  (request.text as { format: { name: string } }).format.name === "ModelRecommendation";

describe("induced model failures end in visible review with no recommendation (T09, T23)", () => {
  const cases: [string, NonNullable<TestApp["model"]["script"]>, string][] = [
    ["a refusal", () => ({ refusal: "I can't help with that." }), "refusal"],
    ["an incomplete response", () => ({ incomplete: "max_output_tokens" }), "incomplete"],
    ["a final answer that is not JSON", () => ({ text: "Switch to b_02." }), "invalid_output"],
    [
      "a final answer that breaks the schema",
      () => ({ answer: { action: "buy", candidateId: "b_02" } }),
      "invalid_output",
    ],
    [
      "a call to a tool it was not given",
      () => ({ call: "cancel_subscription", arguments: { subscriptionId: "anything" } }),
      "unknown_tool",
    ],
    [
      "arguments outside the strict schema",
      () => ({ call: "get_quote", arguments: { candidateId: "b_02", ownerId: "someone" } }),
      "tool_refused",
    ],
    [
      "a plan that does not exist",
      () => ({ call: "test_candidate", arguments: { candidateId: "c_01" } }),
      "tool_refused",
    ],
    [
      "reading an artifact it was never given",
      () => ({ call: "read_artifact", arguments: { artifactId: "4b1c6c0e-0000-4000-8000-000000000000" } }),
      "tool_refused",
    ],
    ["more than twelve tool calls", () => ({ call: "list_plans" }), "tool_budget"],
    [
      "a call_id reused for a second call",
      (_request, index) =>
        index === 0
          ? { call: "read_account", callId: "same" }
          : index === 1
            ? { call: "list_plans", callId: "same" }
            : undefined,
      "invalid_call",
    ],
  ];

  it.each(cases)("%s", async (_name, script, reason) => {
    const { snapshot, run, stored, caseId } = await investigateWith(script);
    expect(snapshot.case).toMatchObject({ state: "NEEDS_REVIEW", reason: "evidence_missing" });
    expect(stored).toEqual([]);
    expect(snapshot.recommendation).toBeNull();
    expect(await app.ctx.db.select().from(evaluations).where(eq(evaluations.caseId, caseId))).toEqual([]);
    expect(run).toMatchObject({ outcome: "review", detail: expect.any(String) });
    if (reason === "tool_budget") expect(run.trace).toHaveLength(12);
    if (reason === "invalid_call") expect(run.detail).toMatch(/call_id/);
  });

  it("executes two calls returned together, each answered under its own call_id", async () => {
    const { run } = await investigateWith((_request, index) =>
      index > 0 ? undefined : { calls: [{ call: "read_account" }, { call: "list_plans" }] },
    );
    expect(run.outcome).toBe("accepted");
    expect(run.trace.slice(0, 2).map((step) => step.tool)).toEqual(["read_account", "list_plans"]);
  });

  it("ends in review when no model is configured", async () => {
    const setup = await verifiedSetupCase(app);
    await putPolicy(setup.browser, setup.caseId, 0);
    const model = app.ctx.model;
    app.ctx.model = null;
    try {
      await applyEventAndInvestigate(app, setup.browser, setup.caseId);
    } finally {
      app.ctx.model = model;
    }
    expect((await snapshotOf(setup.browser, setup.caseId)).case).toMatchObject({
      state: "NEEDS_REVIEW",
      reason: "evidence_missing",
    });
    expect((await runsOf(setup.caseId))[0]).toMatchObject({
      outcome: "review",
      detail: expect.stringMatching(/No model connection/),
    });
  });
});

describe("schema-valid recommendations the evidence does not support are rejected (T03-T06, T09)", () => {
  /** Lets the stand-in investigate competently, then replaces its final answer with `answer(evidenceIds)`. */
  const finalAnswerReplacedBy =
    (
      answer: (input: { evidenceIds: string[]; outputs: Record<string, any>[] }) => object,
    ): NonNullable<TestApp["model"]["script"]> =>
    (request) => {
      const items = request.input as { type?: string; output?: string }[];
      const outputs = items
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output!));
      if (outputs.length < 7) return undefined;
      const evidenceIds = outputs.flatMap(
        (output) => output.evidenceIds ?? (output.quote ? [output.quote.evidenceId] : []),
      );
      return {
        answer: {
          policyRevision: 1,
          explanation: "Altered.",
          uncertainties: [],
          ...answer({ evidenceIds, outputs }),
        },
      };
    };

  const rejected: [string, NonNullable<TestApp["model"]["script"]>][] = [
    [
      "switching to the cheaper plan whose output failed",
      finalAnswerReplacedBy(({ evidenceIds }) => ({ action: "switch", candidateId: "b_01", evidenceIds })),
    ],
    [
      "staying although the current output fails",
      finalAnswerReplacedBy(({ evidenceIds }) => ({ action: "stay", candidateId: null, evidenceIds })),
    ],
    [
      "advising the over-ceiling upgrade",
      finalAnswerReplacedBy(({ evidenceIds }) => ({
        action: "change_plan",
        candidateId: "a_02",
        evidenceIds,
      })),
    ],
    [
      "citing another policy revision",
      finalAnswerReplacedBy(({ evidenceIds }) => ({
        action: "switch",
        candidateId: "b_02",
        evidenceIds,
        policyRevision: 2,
      })),
    ],
    [
      "citing evidence it never received",
      finalAnswerReplacedBy(({ evidenceIds }) => ({
        action: "switch",
        candidateId: "b_02",
        evidenceIds: [...evidenceIds, "invented-evidence"],
      })),
    ],
    [
      "citing the chosen quote's own id instead of its evidenceId",
      finalAnswerReplacedBy(({ evidenceIds, outputs }) => {
        const chosen = outputs.find((output) => output.quote?.candidateId === "b_02")!.quote;
        return {
          action: "switch",
          candidateId: "b_02",
          evidenceIds: evidenceIds.map((id) => (id === chosen.evidenceId ? chosen.id : id)),
        };
      }),
    ],
    [
      "leaving out the chosen plan's test evidence",
      finalAnswerReplacedBy(({ outputs }) => ({
        action: "switch",
        candidateId: "b_02",
        evidenceIds: outputs[0]!.evidenceIds,
      })),
    ],
  ];

  it.each(rejected)("%s", async (_name, script) => {
    const { snapshot, run, stored } = await investigateWith(script);
    expect(run).toMatchObject({ outcome: "rejected", detail: expect.any(String) });
    expect(snapshot.case).toMatchObject({ state: "NEEDS_REVIEW", reason: "evidence_missing" });
    expect(stored).toEqual([]);
  });

  it("rejects a switch chosen before every affordable plan was tested", async () => {
    const { run, stored } = await investigateWith((request) => {
      const items = request.input as { type?: string; output?: string }[];
      const outputs = items
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output!));
      if (outputs.length < 5) return undefined;
      return {
        answer: {
          action: "switch",
          candidateId: "b_02",
          policyRevision: 1,
          evidenceIds: outputs[0].evidenceIds,
          explanation: "Guessed.",
          uncertainties: [],
        },
      };
    });
    expect(run).toMatchObject({ outcome: "rejected", detail: expect.stringMatching(/supports investigate/) });
    expect(stored).toEqual([]);
  });

  it("rejects current-provider advice when other affordable alternatives remain untested", async () => {
    const { run, stored } = await investigateWith(
      (request) => {
        const outputs = (request.input as { type?: string; output?: string }[])
          .filter((item) => item.type === "function_call_output")
          .map((item) => JSON.parse(item.output!));
        if (outputs.length < 6) return undefined;
        const quote = outputs.find((output) => output.quote?.candidateId === "a_02").quote;
        const tested = outputs.find((output) => output.candidateId === "a_02");
        return {
          answer: {
            action: "change_plan",
            candidateId: "a_02",
            policyRevision: 1,
            evidenceIds: [...outputs[0].evidenceIds, quote.evidenceId, ...tested.evidenceIds],
            explanation: "The current-provider plan passes; I stopped comparing.",
            uncertainties: [],
          },
        };
      },
      { recurringCeiling: { currency: "GBP", amountMinor: 2000 } },
    );
    expect(run).toMatchObject({
      outcome: "rejected",
      detail: expect.stringMatching(/supports investigate/),
      output: { action: "change_plan", candidateId: "a_02" },
    });
    expect(run.trace.filter((step) => step.tool === "test_candidate")).toHaveLength(1);
    expect(stored).toEqual([]);
  });

  it("accepts an honest investigate when the comparison was cut short", async () => {
    const { run, snapshot } = await investigateWith((request) => {
      const outputs = (request.input as { type?: string; output?: string }[])
        .filter((item) => item.type === "function_call_output")
        .map((item) => JSON.parse(item.output!));
      if (outputs.length < 2) return undefined;
      return {
        answer: {
          action: "investigate",
          candidateId: null,
          policyRevision: 1,
          evidenceIds: outputs[0].evidenceIds,
          explanation: "I could not compare every plan.",
          uncertainties: ["Quotes were not read."],
        },
      };
    });
    expect(run.outcome).toBe("accepted");
    expect(snapshot.case).toMatchObject({ state: "NEEDS_REVIEW", reason: "evidence_missing" });
  });
});

describe("changes during an investigation", () => {
  it("does not act on a run whose policy was replaced while the model worked", async () => {
    const { browser, caseId } = await verifiedSetupCase(app);
    await putPolicy(browser, caseId, 0);
    let replaced = false;
    app.model.script = async (request) => {
      if (!replaced && investigationTurns(request)) {
        replaced = true;
        expect(
          (await putPolicy(browser, caseId, 1, { recurringCeiling: { currency: "GBP", amountMinor: 1600 } }))
            .status,
        ).toBe(200);
      }
      return undefined;
    };
    await applyEventAndInvestigate(app, browser, caseId);

    const snapshot = await snapshotOf(browser, caseId);
    expect(await recommendationsOf(caseId)).toEqual([]);
    expect(snapshot.case.state).toBe("MONITORING");
    expect(snapshot.policy!.revision).toBe(2);
    expect((await runsOf(caseId))[0]).toMatchObject({ policyRevision: 1, outcome: "accepted" });
  });
});

describe("administrator scaffolding", () => {
  it("no longer accepts a manual recommendation, and keeps faults administrator-only", async () => {
    const flow = await verifiedSetupCase(app);
    await putPolicy(flow.browser, flow.caseId, 0);
    const body = {
      action: "switch",
      candidateId: "b_02",
      policyRevision: 1,
      evidenceIds: [],
      explanation: "x",
      uncertainties: [],
    };
    expect((await flow.browser.post(`/api/admin/cases/${flow.caseId}/recommendation`, body)).status).toBe(
      404,
    );

    const reviewer = app.browser();
    await reviewer.login(reviewerLogin);
    expect(
      (await reviewer.post(`/api/admin/cases/${flow.caseId}/fault`, { fault: "price_change", enabled: true }))
        .status,
    ).toBe(403);
    expect(
      (await reviewer.post(`/api/cases/${flow.caseId}/policy-draft`, { purpose: "Editable transcripts." }))
        .status,
    ).toBe(404);
    expect(
      (
        await flow.browser.post(`/api/admin/cases/${flow.caseId}/fault`, {
          fault: "stale_evidence",
          enabled: true,
        })
      ).body.error,
    ).toBe("fault_unavailable");
  });
});
