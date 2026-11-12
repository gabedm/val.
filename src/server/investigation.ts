import { randomUUID } from "node:crypto";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  validate,
  type AsyncCommandResult,
  type ModelRecommendation,
  type ScenarioCommand,
} from "../shared/contracts";
import {
  agentTools,
  agentVersion,
  investigationInstructions,
  valueInvestigationInstructions,
  recommendationOutputSchema,
} from "./agent-contract";
import { investigationTools, type InvestigationObservations } from "./agent-tools";
import { latestPolicy, openTransition, setCaseState } from "./cases";
import type { AppContext } from "./context";
import type { Executor } from "./db";
import { agentRuns, cases, evaluations, jobs, providerAccounts, recommendations } from "./db/schema";
import { HttpError } from "./http";
import { modelForOwner, type BudgetContext } from "./judge-budget";
import { queueJob, type Commit, type JobRow } from "./jobs";
import type { CaseRow } from "./operations";
import { applyScenarioEvent, providerNotice } from "./providers";
import { checkRecommendation, evaluationsFrom, type Outcome } from "./recommendation";
import { runModelTask, type ModelUsage, type ReviewReason, type TraceStep } from "./responses-loop";
import type { Capability } from "./validation";

/** Quotes, samples and account reads older than this cannot support a purchase. */
export const evidenceMaxAgeMs = 5 * 60 * 1000;

type PolicyRow = NonNullable<Awaited<ReturnType<typeof latestPolicy>>>;

const mayInvestigateFrom: CaseRow["state"][] = ["MONITORING", "STAY", "NEEDS_REVIEW", "INVESTIGATING"];

async function requireCurrentPolicy(db: Executor, caseId: string, revision: number): Promise<PolicyRow> {
  const policy = await latestPolicy(db, caseId);
  if (!policy || policy.revision !== revision)
    throw new HttpError(409, "stale_policy", "The policy changed; load the current revision first.");
  return policy;
}

/** Queues an explicit check. A check during an existing investigation returns that investigation's job. */
export async function requestCheck(
  ctx: AppContext,
  caseRow: CaseRow,
  expectedPolicyRevision: number,
): Promise<AsyncCommandResult> {
  const policy = await requireCurrentPolicy(ctx.db, caseRow.id, expectedPolicyRevision);
  if (!mayInvestigateFrom.includes(caseRow.state))
    throw new HttpError(409, "not_monitoring", "A check can run only while the case is monitoring.");
  if (caseRow.state === "INVESTIGATING") {
    const [running] = await ctx.db
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(
          eq(jobs.caseId, caseRow.id),
          eq(jobs.policyRevision, policy.revision),
          like(jobs.eventId, "check:%"),
          inArray(jobs.status, ["QUEUED", "RUNNING"]),
        ),
      );
    if (running) return { jobId: running.id, caseId: caseRow.id };
  }
  const job = await queueJob(ctx.db, caseRow.id, `check:${randomUUID()}`, policy.revision);
  await setCaseState(ctx.db, caseRow.id, "INVESTIGATING");
  return { jobId: job.id, caseId: caseRow.id };
}

/** Applies the case's chosen entitlement event once, then queues the investigation that its permission allows. */
export async function applyScenario(
  ctx: AppContext,
  caseRow: CaseRow,
  command: ScenarioCommand,
): Promise<AsyncCommandResult> {
  if (command.scenario !== caseRow.scenario)
    throw new HttpError(409, "scenario_mismatch", "This case was created for a different event.");
  const policy = await latestPolicy(ctx.db, caseRow.id);
  if (!policy || !mayInvestigateFrom.includes(caseRow.state))
    throw new HttpError(
      409,
      "not_monitoring",
      "Confirm a policy and keep the case monitoring before applying an event.",
    );
  const job = await ctx.db.transaction(async (tx) => {
    if (!(await applyScenarioEvent(tx, caseRow)))
      throw new HttpError(
        409,
        "event_already_applied",
        "The merchant change is already recorded; run a fresh check instead.",
      );
    await setCaseState(tx, caseRow.id, "INVESTIGATING");
    return queueJob(tx, caseRow.id, `event:${caseRow.scenario}`, policy.revision);
  });
  return { jobId: job.id, caseId: caseRow.id };
}

/**
 * The investigation job. With permission withdrawn it records only the permission notice and makes no model or provider
 * call. Otherwise the model investigates through the five read-only tools, and only a recommendation the deterministic
 * checks accept moves the case on.
 */
export async function investigateCase(ctx: AppContext, job: JobRow, commit: Commit) {
  const [caseRow] = await ctx.db.select().from(cases).where(eq(cases.id, job.caseId));
  const policy = await latestPolicy(ctx.db, job.caseId);
  if (!caseRow || !policy || policy.revision !== job.policyRevision) return;
  if ((await openTransition(ctx.db, caseRow.id)) || caseRow.state === "COMPLETE") return;
  if (!policy.allowInvestigation)
    return commit((tx) => setCaseState(tx, caseRow.id, "NEEDS_REVIEW", "permission_required"));

  const investigation = await runInvestigation(ctx, caseRow, policy);
  await commit((tx) => recordInvestigation(tx, caseRow, policy, investigation));
}

/** `recommendation` is the model's raw answer; `citedEvidenceIds` are the stored evidence IDs behind its references. */
export type InvestigationVerdict =
  | { kind: "accepted"; recommendation: ModelRecommendation; citedEvidenceIds: string[]; outcome: Outcome }
  | {
      kind: "rejected";
      recommendation: ModelRecommendation;
      citedEvidenceIds: string[];
      outcome: Outcome;
      problem: string;
    }
  | { kind: "review"; reason: ReviewReason; detail: string };

export interface Investigation {
  verdict: InvestigationVerdict;
  observations: InvestigationObservations;
  trace: TraceStep[];
  usage: ModelUsage;
  elapsedMs: number;
  version: ReturnType<typeof agentVersion>;
}

/**
 * Runs the bounded model investigation for one confirmed policy and checks its answer. The model sees the policy and
 * the provider's notice, never scenario names, expected answers, capability settings, owners or credentials.
 */
export async function runInvestigation(
  ctx: BudgetContext,
  caseRow: CaseRow,
  policy: PolicyRow,
  options: { advisory?: boolean } = {},
): Promise<Investigation> {
  const version = agentVersion(ctx.model);
  const tools = investigationTools(
    ctx.db,
    caseRow,
    policy.requiredCapabilities as Capability[],
    policy.recurringCeilingMinor,
    options,
  );
  if (!ctx.model) {
    const verdict = {
      kind: "review",
      reason: "model_unavailable",
      detail: "No model connection is configured, so no investigation ran.",
    } as const;
    return {
      verdict,
      observations: tools.observations,
      trace: [],
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 },
      elapsedMs: 0,
      version,
    };
  }

  const notice = await providerNotice(ctx.db, caseRow);
  const result = await runModelTask(modelForOwner(ctx, caseRow.ownerId), {
    instructions:
      caseRow.scenario === "value_offer" && notice
        ? valueInvestigationInstructions
        : investigationInstructions,
    input: {
      confirmedPolicy: {
        revision: policy.revision,
        purpose: policy.purpose,
        requiredCapabilities: policy.requiredCapabilities,
        replacementCeiling: { currency: "GBP", amountMinor: policy.recurringCeilingMinor },
        preserveHistory: policy.preserveHistory,
      },
      providerNotice: notice && { text: notice, source: "provider", trusted: false },
    },
    tools: agentTools,
    availableTools: tools.availableTools,
    output: {
      name: "ModelRecommendation",
      schema: recommendationOutputSchema(),
      accept: validate.modelRecommendation,
    },
    executeTool: tools.execute,
  });

  let verdict: InvestigationVerdict;
  if (!result.completed) verdict = { kind: "review", reason: result.reason, detail: result.detail };
  else {
    const citedEvidenceIds = tools.resolveCitations(result.output.evidenceIds);
    const check = checkRecommendation(policy, tools.observations, {
      ...result.output,
      evidenceIds: citedEvidenceIds,
    });
    verdict = check.accepted
      ? { kind: "accepted", recommendation: result.output, citedEvidenceIds, outcome: check.outcome }
      : {
          kind: "rejected",
          recommendation: result.output,
          citedEvidenceIds,
          outcome: check.outcome,
          problem: check.problem,
        };
  }
  return {
    verdict,
    observations: tools.observations,
    trace: result.trace,
    usage: result.usage,
    elapsedMs: result.elapsedMs,
    version,
  };
}

const stateForOutcome: Record<ModelRecommendation["action"], CaseRow["state"]> = {
  stay: "STAY",
  switch: "AWAITING_CONSENT",
  change_plan: "NEEDS_REVIEW",
  investigate: "NEEDS_REVIEW",
};

/**
 * Stores the run and, for an accepted recommendation, its evaluations and the resulting case state. A run whose policy
 * was replaced meanwhile changes nothing; one that saw the entitlement change underneath it ends in review.
 */
async function recordInvestigation(
  tx: Executor,
  caseRow: CaseRow,
  policy: PolicyRow,
  investigation: Investigation,
) {
  const { verdict, observations } = investigation;
  const agentRunId = randomUUID();
  await tx.insert(agentRuns).values({
    id: agentRunId,
    caseId: caseRow.id,
    task: "investigation",
    policyRevision: policy.revision,
    version: investigation.version,
    outcome: verdict.kind,
    detail: verdict.kind === "rejected" ? verdict.problem : verdict.kind === "review" ? verdict.detail : null,
    trace: investigation.trace,
    output: verdict.kind === "review" ? null : verdict.recommendation,
    usage: investigation.usage,
    elapsedMs: investigation.elapsedMs,
  });

  if ((await latestPolicy(tx, caseRow.id))?.revision !== policy.revision) return;
  const [account] = await tx
    .select({ entitlementRevision: providerAccounts.entitlementRevision })
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
  const entitlementMoved =
    observations.account !== null &&
    observations.account.entitlementRevision !== account!.entitlementRevision;
  if (verdict.kind !== "accepted" || entitlementMoved)
    return setCaseState(tx, caseRow.id, "NEEDS_REVIEW", "evidence_missing");

  const observedAt = new Date();
  for (const evaluation of evaluationsFrom(observations, policy)) {
    await tx.insert(evaluations).values({
      id: randomUUID(),
      caseId: caseRow.id,
      policyRevision: policy.revision,
      candidateId: evaluation.candidateId,
      entitlementRevision: account!.entitlementRevision,
      result: evaluation,
      observedAt,
    });
  }
  const { recommendation, citedEvidenceIds, outcome } = verdict;
  await tx.insert(recommendations).values({
    id: randomUUID(),
    caseId: caseRow.id,
    policyRevision: policy.revision,
    action: recommendation.action,
    candidateId: outcome.candidateId,
    evidenceIds: citedEvidenceIds,
    explanation: recommendation.explanation,
    uncertainties: recommendation.uncertainties,
    source: "agent",
    agentRunId,
  });
  await setCaseState(tx, caseRow.id, stateForOutcome[outcome.action], outcome.reason);
}
