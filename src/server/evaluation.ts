import { randomUUID } from "node:crypto";
import Ajv2020 from "ajv/dist/2020.js";
import { eq } from "drizzle-orm";
import challengerSchema from "../shared/challenger.schema.json";
import fixtures from "../../fixtures/scenario-fixtures.json";
import type { UrnValChallenger06 as ChallengerConfiguration } from "../shared/challenger.types";
import type { ModelRecommendation, PolicyDraft } from "../shared/contracts";
import { agentVersion } from "./agent-contract";
import { createCase } from "./cases";
import type { AppContext } from "./context";
import type { Database, Executor } from "./db";
import { cases, owners, policies, providerAccounts } from "./db/schema";
import { runInvestigation, type Investigation } from "./investigation";
import type { CaseRow } from "./operations";
import { fixturePlans } from "./plans";
import { runPolicyDraft } from "./policy-draft";
import { applyScenarioEvent, benchmarkTurns, renderSample } from "./providers";
import { preferredOutcome, projectValue, type Outcome } from "./recommendation";
import type { TaskResult } from "./responses-loop";
import { checkSample, type Capability } from "./validation";

// The offline evaluator: materialises a fixed or challenger configuration in its own workspace, runs the same agent the
// app runs, and scores it against the outcome computed from the workspace's actual output. Never part of a customer flow.

export type { ChallengerConfiguration };

export interface EvaluationEntry {
  id: string;
  family: string;
  configuration: ChallengerConfiguration;
}

const acceptConfiguration = new Ajv2020({ strict: true }).compile<ChallengerConfiguration>(challengerSchema);

/** Rejects, rather than repairs, anything that is not a closed challenger configuration. */
export function assertChallengerConfiguration(
  value: unknown,
  name = "The configuration",
): asserts value is ChallengerConfiguration {
  if (!acceptConfiguration(value))
    throw new Error(
      `${name} does not match the challenger schema: ${JSON.stringify(acceptConfiguration.errors)}`,
    );
}

/** The admitted fresh configurations, one run each. Refuses an empty batch or any malformed file before anything runs. */
export function freshBatch(
  files: { name: string; content: string }[],
): { entry: EvaluationEntry; run: number }[] {
  if (files.length === 0) throw new Error("There are no configuration files to run.");
  return files.map(({ name, content }) => {
    const configuration: unknown = JSON.parse(content);
    assertChallengerConfiguration(configuration, name);
    return { entry: { id: name.replace(/\.json$/, ""), family: "fresh", configuration }, run: 1 };
  });
}

/** A new owner and case whose plans behave exactly as the configuration says. Nothing else is touched. */
export async function materializeConfiguration(
  db: Database,
  configuration: ChallengerConfiguration,
): Promise<CaseRow> {
  assertChallengerConfiguration(configuration);
  const ownerId = randomUUID();
  await db.insert(owners).values({ id: ownerId });
  // Evaluation workspaces alone may materialise the authored value case; no PayPal customer or payment is created.
  const created = await createCase(db, ownerId, configuration.valueCase ? "value_offer" : "feature_removed");
  const paidThrough = new Date(created.createdAt);
  paidThrough.setUTCMonth(paidThrough.getUTCMonth() + 1);
  const evaluation = {
    notice: configuration.notice,
    plans: configuration.plans,
    ...(configuration.valueCase
      ? { valueCase: { source: "AUTHORED_EVALUATION" as const, paidThrough: paidThrough.toISOString() } }
      : {}),
  };
  await db.update(cases).set({ evaluation }).where(eq(cases.id, created.id));
  if (configuration.valueCase) {
    await db
      .update(providerAccounts)
      .set({ paidThrough })
      .where(eq(providerAccounts.id, created.initialAccountId));
    await applyScenarioEvent(db, { ...created, evaluation });
  }
  return { ...created, evaluation };
}

/** Computes the expected outcome from the provider exports and shared validation rules. */
export async function expectedOutcome(
  db: Executor,
  caseRow: CaseRow,
  requiredCapabilities: Capability[],
  ceilingMinor: number,
): Promise<Outcome> {
  const [current] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
  const [replacement] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.replacementAccountId));
  const passes = (account: typeof current, planId: string) =>
    checkSample(renderSample(caseRow, account!, planId), benchmarkTurns, requiredCapabilities).every(
      (result) => result.passes,
    );
  if (caseRow.scenario === "value_offer") {
    const event = fixtures.scenarios.find((item) => item.id === "value_offer");
    if (
      !event ||
      !("renewalMinor" in event) ||
      typeof event.renewalMinor !== "number" ||
      !("noticeOffsetDays" in event) ||
      typeof event.noticeOffsetDays !== "number" ||
      !current?.paidThrough
    )
      return {
        action: "investigate",
        candidateId: null,
        reason: "evidence_missing",
        missing: "dated merchant or paid-through evidence",
      };
    const assessed = new Date();
    const at = new Date(
      Date.UTC(assessed.getUTCFullYear(), assessed.getUTCMonth(), assessed.getUTCDate()),
    ).toISOString();
    const renewalEffectiveAt = new Date(
      caseRow.createdAt.getTime() + event.noticeOffsetDays * 86_400_000,
    ).toISOString();
    const projection = (plan: (typeof fixturePlans)[number]) =>
      projectValue({
        assessedAt: at,
        oldNextBillingAt: current.paidThrough!.toISOString(),
        renewalEffectiveAt,
        currentMinor: fixturePlans.find((item) => item.planId === current.planId)!.recurringMinor,
        announcedMinor: event.renewalMinor,
        candidateMinor: plan.recurringMinor,
        introductoryMinor: plan.introductoryMinor ?? plan.recurringMinor,
        introductoryCycles: plan.introductoryCycles ?? 0,
        feesMinor: 0,
      });
    if (!projection(fixturePlans.find((item) => item.planId === "b_01")!))
      return {
        action: "investigate",
        candidateId: null,
        reason: "evidence_missing",
        missing: "the billing calendar cannot support a dated comparison",
      };
    const suitable = fixturePlans
      .filter(
        (plan) =>
          plan.planId !== current.planId &&
          plan.recurringMinor <= ceilingMinor &&
          passes(plan.providerId === "provider_a" ? current : replacement, plan.planId),
      )
      .map((plan) => ({ plan, comparison: projection(plan) }))
      .filter((item) => item.comparison !== null)
      .sort(
        (first, second) =>
          first.comparison!.candidateTotal.amountMinor - second.comparison!.candidateTotal.amountMinor,
      );
    const best = suitable[0];
    const currentPasses = passes(current, current!.planId!);
    if (!best || (currentPasses && best.comparison!.netSavingMinor <= 0))
      return currentPasses
        ? { action: "stay", candidateId: null, reason: null, missing: null }
        : { action: "investigate", candidateId: null, reason: "no_candidate", missing: null };
    return best.plan.providerId === current!.providerId
      ? { action: "change_plan", candidateId: best.plan.planId, reason: "advice_only", missing: null }
      : { action: "switch", candidateId: best.plan.planId, reason: null, missing: null };
  }
  const candidates = fixturePlans
    .filter(
      (plan) =>
        plan.planId !== current!.planId &&
        (plan.planId !== "b_03" || caseRow.scenario === "value_offer" || !!caseRow.evaluation?.plans["b_03"]),
    )
    .map((plan) => ({
      candidateId: plan.planId,
      providerId: plan.providerId,
      recurringMinor: plan.recurringMinor,
      dueNowMinor: plan.recurringMinor,
      passes: passes(plan.providerId === "provider_a" ? current : replacement, plan.planId),
    }));
  return preferredOutcome({
    currentProviderId: current!.providerId,
    currentPasses: passes(current, current!.planId!),
    candidates,
    ceilingMinor,
  });
}

/** Differences between the drafted policy and the intent the configuration was admitted with. */
export function interpretationProblems(draft: PolicyDraft, configuration: ChallengerConfiguration): string[] {
  const problems: string[] = [];
  const listed = (capabilities: readonly string[]) => [...capabilities].sort().join(", ") || "none";
  if (listed(draft.requiredCapabilities) !== listed(configuration.requiredCapabilities))
    problems.push(
      `capabilities ${listed(draft.requiredCapabilities)} instead of ${listed(configuration.requiredCapabilities)}`,
    );
  if (draft.recurringCeiling?.amountMinor !== configuration.replacementCeilingMinor)
    problems.push(
      `ceiling ${draft.recurringCeiling?.amountMinor ?? "none"} instead of ${configuration.replacementCeilingMinor}`,
    );
  if (draft.preserveHistory !== configuration.preserveHistory)
    problems.push(`preserveHistory ${draft.preserveHistory} instead of ${configuration.preserveHistory}`);
  const expectsUnsupported = configuration.unsupportedRequirements.length > 0;
  if (expectsUnsupported && draft.unsupportedRequirements.length === 0)
    problems.push("the unsupported requirement was not reported");
  if (!expectsUnsupported && draft.unsupportedRequirements.length > 0)
    problems.push(`reported unsupported requirements: ${draft.unsupportedRequirements.join("; ")}`);
  return problems;
}

/** The harness confirms a correctly interpreted test policy. It grants investigation permission and nothing else. */
async function confirmForEvaluation(db: Database, caseRow: CaseRow, draft: PolicyDraft) {
  const [policy] = await db
    .insert(policies)
    .values({
      id: randomUUID(),
      caseId: caseRow.id,
      revision: 1,
      purpose: draft.purpose,
      requiredCapabilities: draft.requiredCapabilities,
      recurringCeilingMinor: draft.recurringCeiling!.amountMinor,
      preserveHistory: draft.preserveHistory!,
      allowInvestigation: true,
    })
    .returning();
  return policy!;
}

const taskSummary = (result: TaskResult<unknown>) => ({
  completed: result.completed,
  review: result.completed ? null : { reason: result.reason, detail: result.detail },
  usage: result.usage,
  elapsedMs: result.elapsedMs,
});

function investigationSummary(investigation: Investigation) {
  const { verdict } = investigation;
  return {
    verdict: verdict.kind,
    detail:
      verdict.kind === "rejected"
        ? verdict.problem
        : verdict.kind === "review"
          ? `${verdict.reason}: ${verdict.detail}`
          : null,
    recommendation: verdict.kind === "review" ? null : verdict.recommendation,
    citedEvidenceIds: verdict.kind === "review" ? null : verdict.citedEvidenceIds,
    supportedOutcome: verdict.kind === "review" ? null : verdict.outcome,
    evidenceReferences: Object.fromEntries(
      [...investigation.observations.references].map(([id, reference]) => [reference, id]),
    ),
    trace: investigation.trace,
    usage: investigation.usage,
    elapsedMs: investigation.elapsedMs,
  };
}

const describe = (outcome: { action: ModelRecommendation["action"]; candidateId: string | null }) =>
  outcome.candidateId ? `${outcome.action} ${outcome.candidateId}` : outcome.action;

/** One scored run. The model's raw recommendation and the deterministic verdict on it are kept apart. */
export interface EvaluationRecord {
  fixture: string;
  family: string;
  run: number;
  caseId: string;
  startedAt: string;
  configuration: ChallengerConfiguration;
  version: ReturnType<typeof agentVersion>;
  policyDraft: { output: PolicyDraft | null } & ReturnType<typeof taskSummary>;
  expected: { stage: "policy_review" } | ({ stage: "recommendation" } & Outcome) | null;
  interpretationProblems?: string[];
  investigation: ReturnType<typeof investigationSummary> | null;
  result: "PASS" | "FAIL";
  failures: string[];
  elapsedMs: number;
}

type RecordDetails = Pick<EvaluationRecord, "expected" | "investigation" | "interpretationProblems">;

/**
 * One scored run: draft the policy, compare it with the admitted intent, then (for a supported policy) investigate and
 * compare the accepted recommendation with the expected outcome. Review, rejection and wrong answers all fail.
 */
export async function evaluateConfiguration(
  ctx: Pick<AppContext, "db" | "model"> & { config: Pick<AppContext["config"], "judgeDemo"> },
  entry: EvaluationEntry,
  run: number,
): Promise<EvaluationRecord> {
  const startedAt = new Date();
  const caseRow = await materializeConfiguration(ctx.db, entry.configuration);
  const drafting = await runPolicyDraft(ctx.model!, entry.configuration.purpose);
  const record = {
    fixture: entry.id,
    family: entry.family,
    run,
    caseId: caseRow.id,
    startedAt: startedAt.toISOString(),
    configuration: entry.configuration,
    version: agentVersion(ctx.model),
    policyDraft: { output: drafting.draft, ...taskSummary(drafting.result) },
  };
  const finish = (failures: string[], details: RecordDetails): EvaluationRecord => ({
    ...record,
    ...details,
    result: failures.length === 0 ? "PASS" : "FAIL",
    failures,
    elapsedMs: Date.now() - startedAt.getTime(),
  });

  if (!drafting.draft)
    return finish([`Drafting did not produce a policy: ${drafting.problem}`], {
      expected: null,
      investigation: null,
    });
  const problems = interpretationProblems(drafting.draft, entry.configuration);
  if (entry.configuration.unsupportedRequirements.length > 0)
    return finish(
      problems.map((problem) => `Interpretation: ${problem}`),
      { expected: { stage: "policy_review" }, interpretationProblems: problems, investigation: null },
    );
  if (problems.length > 0)
    return finish(
      problems.map((problem) => `Interpretation: ${problem}`),
      { expected: null, interpretationProblems: problems, investigation: null },
    );

  const policy = await confirmForEvaluation(ctx.db, caseRow, drafting.draft);
  const expected = await expectedOutcome(
    ctx.db,
    caseRow,
    policy.requiredCapabilities as Capability[],
    policy.recurringCeilingMinor,
  );
  const investigation = await runInvestigation(ctx, caseRow, policy);
  const { verdict, observations } = investigation;
  const failures: string[] = [];
  for (const step of investigation.trace.filter((step) => step.tool === "test_candidate")) {
    const { candidateId } = step.arguments as { candidateId: string };
    const quote = observations.quotes.get(candidateId);
    if (
      candidateId !== observations.account?.planId &&
      quote &&
      quote.recurringTotal.amountMinor > policy.recurringCeilingMinor
    ) {
      failures.push(
        `Tested ${candidateId} at ${quote.recurringTotal.amountMinor} GBP minor units above the ${policy.recurringCeilingMinor} ceiling.`,
      );
    }
  }
  if (verdict.kind === "review")
    failures.push(`The investigation ended in review: ${verdict.reason}: ${verdict.detail}`);
  else if (verdict.kind === "rejected") failures.push(`The recommendation was rejected: ${verdict.problem}`);
  else if (verdict.outcome.action !== expected.action || verdict.outcome.candidateId !== expected.candidateId)
    failures.push(`Recommended ${describe(verdict.outcome)}; the workspace supports ${describe(expected)}.`);
  return finish(failures, {
    expected: { stage: "recommendation", ...expected },
    interpretationProblems: problems,
    investigation: investigationSummary(investigation),
  });
}
