import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { WhatIfCommand, WhatIfResult } from "../shared/contracts";
import { agentVersion } from "./agent-contract";
import { latestPolicy, openTransition } from "./cases";
import type { AppContext } from "./context";
import { agentRuns, cases, providerAccounts } from "./db/schema";
import { HttpError } from "./http";
import { evidenceMaxAgeMs, runInvestigation } from "./investigation";
import type { CaseRow } from "./operations";
import { evaluationsFrom, outcomeFromObservations } from "./recommendation";
import { listPlans } from "./providers";

const eligibleStates: CaseRow["state"][] = ["MONITORING", "STAY", "NEEDS_REVIEW", "AWAITING_CONSENT"];
const pendingCases = new Set<string>();

export async function runWhatIf(
  ctx: AppContext,
  caseRow: CaseRow,
  command: WhatIfCommand,
): Promise<WhatIfResult> {
  if (pendingCases.has(caseRow.id))
    throw new HttpError(409, "what_if_pending", "A What-if comparison is already running for this case.");
  pendingCases.add(caseRow.id);
  try {
    if (caseRow.archivedAt)
      throw new HttpError(409, "case_archived", "An archived case cannot run a What-if comparison.");
    if (await openTransition(ctx.db, caseRow.id))
      throw new HttpError(409, "handover_open", "Finish the current handover first.");
    if (!eligibleStates.includes(caseRow.state))
      throw new HttpError(409, "what_if_unavailable", "A What-if comparison cannot run in this case state.");
    const policy = await latestPolicy(ctx.db, caseRow.id);
    if (!policy || policy.revision !== command.expectedPolicyRevision)
      throw new HttpError(409, "stale_policy", "The policy changed; load the current revision first.");
    if (!policy.allowInvestigation)
      throw new HttpError(409, "permission_required", "Investigation permission is required.");
    const [account] = await ctx.db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, caseRow.initialAccountId));
    const version = agentVersion(ctx.model);
    const baseline = {
      policyRevision: policy.revision,
      entitlementRevision: account!.entitlementRevision,
      caseState: caseRow.state,
      agentFingerprint: version.fingerprint,
    };
    const hypothetical = {
      ...policy,
      recurringCeilingMinor: command.overrides.recurringCeiling?.amountMinor ?? policy.recurringCeilingMinor,
      requiredCapabilities: command.overrides.requiredCapabilities ?? policy.requiredCapabilities,
    };
    const investigation = await runInvestigation(ctx, caseRow, hypothetical, { advisory: true });
    const [currentCase] = await ctx.db.select().from(cases).where(eq(cases.id, caseRow.id));
    const currentPolicy = await latestPolicy(ctx.db, caseRow.id);
    const [currentAccount] = await ctx.db
      .select({ entitlementRevision: providerAccounts.entitlementRevision })
      .from(providerAccounts)
      .where(eq(providerAccounts.id, caseRow.initialAccountId));
    const staleReasons = [
      currentCase?.archivedAt ? "The case was archived while the comparison was running." : null,
      currentCase?.state !== baseline.caseState
        ? "The case state changed while the comparison was running."
        : null,
      currentPolicy?.revision !== baseline.policyRevision
        ? "The policy changed while the comparison was running."
        : null,
      currentAccount?.entitlementRevision !== baseline.entitlementRevision ||
      (investigation.observations.account &&
        investigation.observations.account.entitlementRevision !== baseline.entitlementRevision)
        ? "The account entitlement changed while the comparison was running."
        : null,
      (await openTransition(ctx.db, caseRow.id))
        ? "A handover opened while the comparison was running."
        : null,
    ].filter((reason): reason is string => reason !== null);
    const staleReason = staleReasons[0] ?? null;
    const verdict = investigation.verdict;
    const outcome =
      verdict.kind === "review"
        ? investigation.observations.account
          ? outcomeFromObservations(investigation.observations, hypothetical.recurringCeilingMinor)
          : null
        : verdict.outcome;
    const recommendation = verdict.kind === "review" ? null : verdict.recommendation;
    const problem =
      verdict.kind === "rejected" ? verdict.problem : verdict.kind === "review" ? verdict.detail : null;
    const plans = await listPlans(ctx.db, caseRow);
    const planById = new Map(plans.map((plan) => [plan.planId, plan]));
    const candidates = evaluationsFrom(investigation.observations, hypothetical).map((evaluation) => {
      const quote = investigation.observations.quotes.get(evaluation.candidateId)!;
      const test = investigation.observations.tests.get(evaluation.candidateId);
      return {
        candidateId: evaluation.candidateId,
        providerId: quote.providerId,
        label: planById.get(evaluation.candidateId)?.label ?? evaluation.candidateId,
        recurringTotal: quote.recurringTotal,
        dueNowTotal: quote.dueNowTotal,
        ...(quote.offer ? { offer: quote.offer } : {}),
        ...(quote.comparison ? { comparison: quote.comparison } : {}),
        withinCeiling: quote.recurringTotal.amountMinor <= hypothetical.recurringCeilingMinor,
        tested: Boolean(test),
        eligible: evaluation.eligible,
        capabilityResults: evaluation.capabilityResults,
        artifactId: test?.artifactId ?? null,
        rejectionReasons: evaluation.rejectionReasons,
      };
    });
    const observedAt = [
      investigation.observations.account?.observedAt,
      ...[...investigation.observations.quotes.values()].map((quote) => quote.observedAt),
      ...[...investigation.observations.tests.values()].map((test) => test.observedAt),
    ].filter((value): value is string => value !== undefined);
    const evidenceExpiresAt = observedAt.length
      ? new Date(Math.min(...observedAt.map((value) => Date.parse(value))) + evidenceMaxAgeMs).toISOString()
      : null;
    const id = randomUUID();
    const createdAt = new Date();
    await ctx.db.insert(agentRuns).values({
      id,
      caseId: caseRow.id,
      task: "what_if",
      policyRevision: policy.revision,
      input: { baseline, overrides: command.overrides },
      version: investigation.version,
      outcome: verdict.kind,
      detail: problem,
      trace: investigation.trace,
      output: recommendation,
      usage: investigation.usage,
      elapsedMs: investigation.elapsedMs,
      createdAt,
    });
    return {
      advisory: true,
      id,
      caseId: caseRow.id,
      createdAt: createdAt.toISOString(),
      baseline,
      proposed: {
        recurringCeiling: { currency: "GBP", amountMinor: hypothetical.recurringCeilingMinor },
        requiredCapabilities:
          hypothetical.requiredCapabilities as WhatIfResult["proposed"]["requiredCapabilities"],
      },
      status: staleReason ? "stale" : "current",
      staleReason,
      verdict: verdict.kind,
      outcome: outcome
        ? { action: outcome.action, candidateId: outcome.candidateId, reason: outcome.reason }
        : null,
      modelRecommendation: recommendation,
      problem,
      current: investigation.observations.account
        ? {
            planId: investigation.observations.account.planId,
            artifactId: investigation.observations.account.artifactId,
            capabilityResults: investigation.observations.account.capabilityResults,
          }
        : null,
      candidates,
      evidenceExpiresAt,
      usage: investigation.usage,
      elapsedMs: investigation.elapsedMs,
      version: {
        model: investigation.version.model,
        promptVersion: investigation.version.promptVersion,
        fingerprint: investigation.version.fingerprint,
      },
    };
  } finally {
    pendingCases.delete(caseRow.id);
  }
}
