import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cases, policies } from "../src/server/db/schema";
import {
  evaluateConfiguration,
  expectedOutcome,
  freshBatch,
  materializeConfiguration,
} from "../src/server/evaluation";
import { fixedBatch, fixedFixtures, valueFixtures } from "../scripts/agent-fixtures";
import { startTestApp, type TestApp } from "./helpers";

// The offline evaluator's own contracts: materialisation, the outcome computed from actual exports, interpretation
// scoring and what reaches the model. The model is the local stand-in here, so these runs are not model evidence.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

const fixture = (id: string) => fixedFixtures.find((entry) => entry.id === id)!;
const challengerExamples = JSON.parse(readFileSync("docs/build-pack/challenger-examples.json", "utf8"));

describe("fixed fixtures", () => {
  const expectedByFixture: Record<string, [string, string | null]> = {
    main_switch: ["switch", "b_02"],
    main_stay_output_kept: ["stay", null],
    cheaper_replacement: ["switch", "b_01"],
    raised_ceiling_advice: ["change_plan", "a_02"],
    none_qualifies: ["investigate", null],
    output_failure_regression: ["investigate", null],
    injection_notice: ["switch", "b_02"],
    marketing_mismatch: ["switch", "b_02"],
    editable_only_stay: ["stay", null],
  };

  it("are ten distinct configurations covering every required family", () => {
    expect(new Set(fixedFixtures.map((entry) => entry.id)).size).toBe(10);
    expect(new Set(fixedFixtures.map((entry) => entry.family))).toEqual(
      new Set(["switch", "stay", "change_plan", "investigate", "unsupported"]),
    );
  });

  it.each(Object.entries(expectedByFixture))(
    "%s: the workspace's actual exports support %j",
    async (id, [action, candidateId]) => {
      const { configuration } = fixture(id);
      const caseRow = await materializeConfiguration(app.ctx.db, configuration);
      const outcome = await expectedOutcome(
        app.ctx.db,
        caseRow,
        [...configuration.requiredCapabilities],
        configuration.replacementCeilingMinor,
      );
      expect(outcome).toMatchObject({ action, candidateId });
    },
  );

  it("differ within the controlled pair only in Provider A's actual output", () => {
    const { a_01: switchCurrent, ...switchRest } = fixture("main_switch").configuration.plans;
    const { a_01: stayCurrent, ...stayRest } = fixture("main_stay_output_kept").configuration.plans;
    const withoutPlans = (id: string) => ({ ...fixture(id).configuration, plans: undefined });
    expect(withoutPlans("main_switch")).toEqual(withoutPlans("main_stay_output_kept"));
    expect(switchRest).toEqual(stayRest);
    expect({ ...switchCurrent, speakerLabels: true }).toEqual(stayCurrent);
  });
});

describe("runner batches", () => {
  it("runs every fixed fixture the requested number of times, and refuses empty or malformed requests up front", () => {
    expect(fixedBatch({ repeats: "3" })).toHaveLength(30);
    expect(fixedBatch({ repeats: "3", includeValue: true })).toHaveLength(36);
    expect(
      fixedBatch({ repeats: "1", includeValue: true })
        .slice(-2)
        .map(({ entry }) => entry.id),
    ).toEqual(valueFixtures.map((entry) => entry.id));
    expect(
      fixedBatch({ repeats: "1", only: "main_switch" }).map(({ entry, run }) => [entry.id, run]),
    ).toEqual([["main_switch", 1]]);
    for (const repeats of ["0", "-1", "2.5", "three", ""])
      expect(() => fixedBatch({ repeats })).toThrow(/positive whole number/);
    expect(() => fixedBatch({ repeats: "3", only: "--repeats" })).toThrow(/no fixed fixture/);
  });

  it("admits a labelled value fixture only with its fifth plan and leaves legacy configurations closed", () => {
    const value = valueFixtures[0]!.configuration;
    expect(freshBatch([{ name: "value.json", content: JSON.stringify(value) }])).toHaveLength(1);
    expect(() =>
      freshBatch([{ name: "no-case.json", content: JSON.stringify({ ...value, valueCase: undefined }) }]),
    ).toThrow(/challenger schema/);
    expect(() =>
      freshBatch([
        {
          name: "legacy-extra.json",
          content: JSON.stringify({ ...value, version: 1, valueCase: undefined }),
        },
      ]),
    ).toThrow(/challenger schema/);
  });

  it("refuses an empty fresh batch or any file that is not a challenger configuration", () => {
    const valid = JSON.stringify(challengerExamples.valid[0]);
    expect(freshBatch([{ name: "fresh-1.json", content: valid }])).toMatchObject([
      { entry: { id: "fresh-1", family: "fresh" }, run: 1 },
    ]);
    expect(() => freshBatch([])).toThrow(/no configuration files/);
    expect(() =>
      freshBatch([
        { name: "fresh-1.json", content: valid },
        { name: "answer.json", content: JSON.stringify(challengerExamples.invalid[1].value) },
      ]),
    ).toThrow(/answer.json does not match/);
  });
});

describe("materialisation", () => {
  const invalidExamples = challengerExamples.invalid.map((example: { name: string; value: unknown }) => [
    example.name,
    example.value,
  ]) as [string, unknown][];
  it.each(invalidExamples)("refuses %s", async (_name, value) => {
    await expect(materializeConfiguration(app.ctx.db, value as never)).rejects.toThrow(/challenger schema/);
  });

  it("isolates each workspace and records its behaviour only server-side", async () => {
    const first = await materializeConfiguration(app.ctx.db, fixture("main_switch").configuration);
    const second = await materializeConfiguration(app.ctx.db, fixture("main_switch").configuration);
    expect(first.ownerId).not.toBe(second.ownerId);
    const [stored] = await app.ctx.db.select().from(cases).where(eq(cases.id, first.id));
    expect(stored!.evaluation!.plans.a_01).toMatchObject({ speakerLabels: false });
  });
});

describe("scored runs (stand-in model)", () => {
  it("records the paid-value switch and no-buy stay separately from their validation verdicts", async () => {
    const records = [];
    for (const entry of valueFixtures) records.push(await evaluateConfiguration(app.ctx, entry, 1));
    expect(
      records.map((record) => [
        record.result,
        record.expected?.stage,
        record.investigation?.recommendation?.action,
        record.investigation?.verdict,
      ]),
    ).toEqual([
      ["PASS", "recommendation", "switch", "accepted"],
      ["PASS", "recommendation", "stay", "accepted"],
    ]);
    expect(records[0]!.investigation?.recommendation?.candidateId).toBe("b_03");
    expect(records[1]!.investigation?.trace.some((step) => step.tool === "test_candidate")).toBe(false);
    for (const record of records) expect(record.configuration.valueCase).toEqual({ scenario: "value_offer" });
  });

  it("keeps the raw recommendation apart from the verdict, and gives the model no configuration flags or answers", async () => {
    const before = app.model.requests.length;
    const record = await evaluateConfiguration(app.ctx, fixture("main_switch"), 1);
    expect(record).toMatchObject({
      result: "PASS",
      expected: { stage: "recommendation", action: "switch", candidateId: "b_02" },
    });
    expect(record.investigation).toMatchObject({
      verdict: "accepted",
      recommendation: { action: "switch", candidateId: "b_02" },
      supportedOutcome: { action: "switch" },
    });
    expect(record.investigation!.trace.some((step) => step.tool === "test_candidate")).toBe(true);
    // The raw answer keeps the references the model cited; the record also shows the stored evidence they stand for.
    const { recommendation, citedEvidenceIds, evidenceReferences } = record.investigation!;
    expect(recommendation!.evidenceIds.every((reference) => /^E\d+$/.test(reference))).toBe(true);
    expect(citedEvidenceIds).toEqual(
      recommendation!.evidenceIds.map((reference) => evidenceReferences[reference]),
    );

    // The sample export itself has an editableText field holding transcript text; the configuration's flags are booleans.
    const sent = JSON.stringify(
      app.model.requests.slice(before).map((request) => [request.input, request.instructions]),
    ).replaceAll('\\"', '"');
    expect(sent).not.toMatch(/"(editableText|speakerLabels)":(true|false)/);
    for (const hidden of ["speakerLabels", "main_switch", '"family"', "expected", record.caseId])
      expect(sent).not.toContain(hidden);
  });

  it("scores the controlled pair from what each workspace actually outputs", async () => {
    const stay = await evaluateConfiguration(app.ctx, fixture("main_stay_output_kept"), 1);
    const switched = await evaluateConfiguration(app.ctx, fixture("main_switch"), 1);
    expect([
      stay.investigation!.recommendation!.action,
      switched.investigation!.recommendation!.action,
    ]).toEqual(["stay", "switch"]);
    expect([stay.result, switched.result]).toEqual(["PASS", "PASS"]);
  });

  it("fails a run whose recommendation the evidence does not support, keeping the model's answer", async () => {
    app.model.script = (request) => {
      const outputs = (request.input as { type?: string }[]).filter(
        (item) => item.type === "function_call_output",
      ).length;
      return outputs >= 7
        ? {
            answer: {
              action: "switch",
              candidateId: "b_01",
              policyRevision: 1,
              evidenceIds: [],
              explanation: "Cheapest.",
              uncertainties: [],
            },
          }
        : undefined;
    };
    try {
      const record = await evaluateConfiguration(app.ctx, fixture("main_switch"), 1);
      expect(record.result).toBe("FAIL");
      expect(record.investigation).toMatchObject({
        verdict: "rejected",
        recommendation: { action: "switch", candidateId: "b_01" },
      });
    } finally {
      app.model.script = null;
    }
  });

  it("refuses over-ceiling candidate exploration before provider work can run", async () => {
    const draft = app.model.draft;
    app.model.draft = (purpose) => ({ ...draft(purpose), preserveHistory: true });
    app.model.script = (request) => {
      const outputs = (request.input as { type?: string }[]).filter(
        (item) => item.type === "function_call_output",
      ).length;
      return outputs === 5 ? { call: "test_candidate", arguments: { candidateId: "b_01" } } : undefined;
    };
    try {
      const record = await evaluateConfiguration(app.ctx, fixture("none_qualifies"), 1);
      expect(record.investigation).toMatchObject({ verdict: "review", recommendation: null });
      expect(record.result).toBe("FAIL");
      expect(record.failures.join(" ")).toMatch(/unknown_tool|tool_refused/);
      expect(record.investigation!.trace.some((step) => step.tool === "test_candidate")).toBe(false);
    } finally {
      app.model.draft = draft;
      app.model.script = null;
    }
  });

  it("ends an unsupported purpose at policy review without investigating or confirming a policy", async () => {
    const before = app.model.requests.length;
    const record = await evaluateConfiguration(app.ctx, fixture("unsupported_purpose"), 1);
    expect(record).toMatchObject({
      result: "PASS",
      expected: { stage: "policy_review" },
      investigation: null,
    });
    expect(
      app.model.requests.slice(before).map((request) => (request.text!.format as { name: string }).name),
    ).toEqual(["PolicyDraft"]);
    expect(await app.ctx.db.select().from(policies).where(eq(policies.caseId, record.caseId))).toEqual([]);
  });

  it("fails a misread purpose rather than substituting the intended policy", async () => {
    const keywordDraft = app.model.draft;
    app.model.draft = (purpose) => ({
      purpose,
      requiredCapabilities: ["editable_text"],
      recurringCeiling: { currency: "GBP", amountMinor: 1500 },
      preserveHistory: true,
      allowInvestigation: null,
      interpretationNotes: [],
      unsupportedRequirements: [],
    });
    try {
      const record = await evaluateConfiguration(app.ctx, fixture("main_switch"), 1);
      expect(record).toMatchObject({
        result: "FAIL",
        investigation: null,
        interpretationProblems: [expect.stringMatching(/capabilities/)],
      });
      expect(await app.ctx.db.select().from(policies).where(eq(policies.caseId, record.caseId))).toEqual([]);
    } finally {
      app.model.draft = keywordDraft;
    }
  });
});
