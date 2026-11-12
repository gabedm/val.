import type {
  CandidateEvaluation,
  CaseRecord,
  ModelRecommendation,
  PlanSummary,
  ValueComparison,
} from "../shared/contracts";
import type { InvestigationObservations } from "./agent-tools";
import { formatGbp } from "./validation";

// Server-side checks determine which recommendation the observed evidence supports.

export interface Outcome {
  action: ModelRecommendation["action"];
  candidateId: string | null;
  /** The case reason this outcome sets when it leads to review. */
  reason: CaseRecord["reason"];
  /** For an incomplete investigation, what was missing. */
  missing: string | null;
}

export interface CandidateFacts {
  candidateId: string;
  providerId: PlanSummary["providerId"];
  recurringMinor: number;
  dueNowMinor: number;
  /** null when the plan was not tested, which is acceptable only above the ceiling. */
  passes: boolean | null;
}

export function projectValue(input: {
  assessedAt: string;
  oldNextBillingAt: string;
  renewalEffectiveAt: string;
  currentMinor: number;
  announcedMinor: number;
  candidateMinor: number;
  introductoryMinor: number;
  introductoryCycles: number;
  feesMinor: number;
}): ValueComparison | null {
  const start = new Date(input.assessedAt);
  const next = new Date(input.oldNextBillingAt);
  const effective = new Date(input.renewalEffectiveAt);
  if (
    ![start, next, effective].every((date) => Number.isFinite(date.getTime())) ||
    next <= start ||
    effective <= start ||
    next.getUTCDate() > 28
  )
    return null;
  if (
    [
      input.currentMinor,
      input.announcedMinor,
      input.candidateMinor,
      input.introductoryMinor,
      input.feesMinor,
    ].some((amount) => !Number.isSafeInteger(amount) || amount < 0) ||
    !Number.isInteger(input.introductoryCycles) ||
    input.introductoryCycles < 0 ||
    input.introductoryCycles > 12
  )
    return null;
  const end = new Date(start);
  end.setUTCFullYear(start.getUTCFullYear() + 1, start.getUTCMonth(), 1);
  end.setUTCDate(
    Math.min(
      start.getUTCDate(),
      new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate(),
    ),
  );
  let currentTotal = 0;
  for (const billing = new Date(next); billing < end; billing.setUTCMonth(billing.getUTCMonth() + 1))
    currentTotal += billing < effective ? input.currentMinor : input.announcedMinor;
  const candidateTotal =
    input.introductoryMinor * input.introductoryCycles +
    input.candidateMinor * (12 - input.introductoryCycles) +
    input.feesMinor;
  return {
    assessedAt: start.toISOString(),
    horizonMonths: 12,
    oldNextBillingAt: next.toISOString(),
    renewalEffectiveAt: effective.toISOString(),
    announcedRenewal: { currency: "GBP", amountMinor: input.announcedMinor },
    currentTotal: { currency: "GBP", amountMinor: currentTotal },
    candidateTotal: { currency: "GBP", amountMinor: candidateTotal },
    netSavingMinor: currentTotal - candidateTotal,
    basis: "AUTHORED_NOTICE_PROJECTION",
  };
}

/**
 * Stay if the current account passes; otherwise an eligible plan from the current provider (advice only); otherwise the
 * eligible replacement with the lowest monthly then due-now price; otherwise no candidate. The ceiling limits only plans
 * the person would newly buy, never the current one.
 */
export function preferredOutcome(input: {
  currentProviderId: string;
  currentPasses: boolean;
  candidates: CandidateFacts[];
  ceilingMinor: number;
}): Outcome {
  if (input.currentPasses) return { action: "stay", candidateId: null, reason: null, missing: null };
  const eligible = input.candidates.filter(
    (candidate) => candidate.recurringMinor <= input.ceilingMinor && candidate.passes === true,
  );
  const upgrade = eligible.find((candidate) => candidate.providerId === input.currentProviderId);
  if (upgrade)
    return { action: "change_plan", candidateId: upgrade.candidateId, reason: "advice_only", missing: null };
  const [replacement] = eligible
    .filter((candidate) => candidate.providerId !== input.currentProviderId)
    .sort(
      (first, second) =>
        first.recurringMinor - second.recurringMinor || first.dueNowMinor - second.dueNowMinor,
    );
  if (replacement)
    return { action: "switch", candidateId: replacement.candidateId, reason: null, missing: null };
  return { action: "investigate", candidateId: null, reason: "no_candidate", missing: null };
}

const incomplete = (missing: string): Outcome => ({
  action: "investigate",
  candidateId: null,
  reason: "evidence_missing",
  missing,
});

/**
 * The outcome supported by what this investigation actually observed. After the current output fails, every other plan
 * needs a fresh quote and every plan within the ceiling a test; without them no comparison is complete.
 */
export function outcomeFromObservations(
  observations: InvestigationObservations,
  ceilingMinor: number,
): Outcome {
  const { account, plans } = observations;
  if (!account) return incomplete("the current account was not read");
  const currentPasses = account.capabilityResults.every((result) => result.passes);
  if (account.valueSignal) return valueOutcome(observations, ceilingMinor, currentPasses);
  if (currentPasses)
    return preferredOutcome({
      currentProviderId: account.providerId,
      currentPasses,
      candidates: [],
      ceilingMinor,
    });
  if (!plans) return incomplete("the available plans were not listed");

  const candidates: CandidateFacts[] = [];
  for (const plan of plans.filter((listed) => listed.planId !== account.planId)) {
    const quote = observations.quotes.get(plan.candidateId);
    if (!quote) return incomplete(`there is no quote for ${plan.candidateId}`);
    const test = observations.tests.get(plan.candidateId);
    if (quote.recurringTotal.amountMinor <= ceilingMinor && !test)
      return incomplete(`${plan.candidateId} is within the ceiling but was not tested`);
    candidates.push({
      candidateId: plan.candidateId,
      providerId: plan.providerId,
      recurringMinor: quote.recurringTotal.amountMinor,
      dueNowMinor: quote.dueNowTotal.amountMinor,
      passes: test ? test.capabilityResults.every((result) => result.passes) : null,
    });
  }
  return preferredOutcome({ currentProviderId: account.providerId, currentPasses, candidates, ceilingMinor });
}

function valueOutcome(
  observations: InvestigationObservations,
  ceilingMinor: number,
  currentPasses: boolean,
): Outcome {
  const { account, plans, quotes, tests } = observations;
  if (!account || account.billingStatus !== "ACTIVE" || !account.paidThrough)
    return incomplete("the current paid period is not confirmed");
  if (!plans?.some((plan) => plan.candidateId === "b_03"))
    return incomplete("the available plans were not listed after the dated notice");
  const current = quotes.get(account.planId);
  const baseline = current?.comparison;
  if (
    !current ||
    !baseline ||
    baseline.oldNextBillingAt !== account.paidThrough ||
    baseline.netSavingMinor !== 0 ||
    baseline.currentTotal.amountMinor !== baseline.candidateTotal.amountMinor
  )
    return incomplete("the current renewal quote or paid-through boundary is missing");
  const eligible: { plan: PlanSummary; quote: NonNullable<typeof current>; annualMinor: number }[] = [];
  for (const plan of plans.filter((item) => item.planId !== account.planId)) {
    const quote = quotes.get(plan.candidateId);
    if (!quote) return incomplete(`there is no quote for ${plan.candidateId}`);
    if (quote.recurringTotal.amountMinor > ceilingMinor) continue;
    if (quote.offer?.eligibility === "UNKNOWN")
      return incomplete(`offer eligibility for ${plan.candidateId} is unknown`);
    if (quote.offer?.eligibility === "INELIGIBLE") continue;
    const test = tests.get(plan.candidateId);
    if (!test) return incomplete(`${plan.candidateId} is affordable but its required output was not checked`);
    const comparison = quote.comparison;
    if (
      !comparison ||
      comparison.assessedAt !== baseline.assessedAt ||
      comparison.renewalEffectiveAt !== baseline.renewalEffectiveAt ||
      comparison.announcedRenewal.amountMinor !== baseline.announcedRenewal.amountMinor ||
      comparison.oldNextBillingAt !== account.paidThrough ||
      comparison.currentTotal.amountMinor !== baseline.currentTotal.amountMinor
    )
      return incomplete(`the dated full-cost comparison for ${plan.candidateId} is incomplete`);
    const intro = quote.offer?.introductoryAmount.amountMinor ?? quote.recurringTotal.amountMinor;
    const fee = quote.feesMinor + quote.taxMinor + (quote.offer?.setupFee.amountMinor ?? 0);
    if (
      quote.offer &&
      (quote.offer.regularAmount.amountMinor !== quote.recurringTotal.amountMinor ||
        quote.offer.eligibility !== "ELIGIBLE")
    )
      return incomplete(`the paid schedule for ${plan.candidateId} does not match the quote`);
    if (quote.dueNowTotal.amountMinor !== intro + fee)
      return incomplete(`the initial amount for ${plan.candidateId} does not match the quote`);
    const recomputed = projectValue({
      assessedAt: comparison.assessedAt,
      oldNextBillingAt: account.paidThrough,
      renewalEffectiveAt: baseline.renewalEffectiveAt,
      currentMinor: current.recurringTotal.amountMinor,
      announcedMinor: baseline.announcedRenewal.amountMinor,
      candidateMinor: quote.recurringTotal.amountMinor,
      introductoryMinor: intro,
      introductoryCycles: quote.offer?.introductoryCycles ?? 0,
      feesMinor: fee,
    });
    if (!recomputed || JSON.stringify(recomputed) !== JSON.stringify(comparison))
      return incomplete(`the full-cost arithmetic for ${plan.candidateId} cannot be verified`);
    if (test.capabilityResults.every((result) => result.passes))
      eligible.push({ plan, quote, annualMinor: comparison.candidateTotal.amountMinor });
  }
  eligible.sort(
    (first, second) =>
      first.annualMinor - second.annualMinor ||
      first.quote.dueNowTotal.amountMinor - second.quote.dueNowTotal.amountMinor,
  );
  const best = eligible[0];
  if (!best || (currentPasses && best.annualMinor >= baseline.currentTotal.amountMinor))
    return currentPasses
      ? { action: "stay", candidateId: null, reason: null, missing: null }
      : { action: "investigate", candidateId: null, reason: "no_candidate", missing: null };
  return best.plan.providerId === account.providerId
    ? { action: "change_plan", candidateId: best.plan.candidateId, reason: "advice_only", missing: null }
    : { action: "switch", candidateId: best.plan.candidateId, reason: null, missing: null };
}

const describe = (outcome: { action: string; candidateId: string | null }) =>
  outcome.candidateId ? `${outcome.action} ${outcome.candidateId}` : outcome.action;

export type RecommendationCheck =
  { accepted: true; outcome: Outcome } | { accepted: false; outcome: Outcome; problem: string };

/**
 * Accepts the model's recommendation only if it cites this investigation's evidence for the right policy revision and
 * proposes exactly the outcome that evidence supports. A schema-valid answer is not enough.
 */
export function checkRecommendation(
  policy: { revision: number; recurringCeilingMinor: number },
  observations: InvestigationObservations,
  proposed: ModelRecommendation,
): RecommendationCheck {
  const outcome = outcomeFromObservations(observations, policy.recurringCeilingMinor);
  const reject = (problem: string): RecommendationCheck => ({ accepted: false, outcome, problem });

  if (proposed.policyRevision !== policy.revision)
    return reject(`It cites policy revision ${proposed.policyRevision}, not ${policy.revision}.`);
  const foreign = proposed.evidenceIds.filter((id) => !observations.evidenceIds.has(id));
  if (foreign.length > 0) return reject("It cites evidence this investigation did not return.");

  const currentPlanId = observations.account?.planId ?? null;
  const candidateId =
    proposed.action === "stay" && proposed.candidateId === currentPlanId ? null : proposed.candidateId;
  if (proposed.action !== outcome.action || candidateId !== outcome.candidateId)
    return reject(
      `It recommends ${describe({ action: proposed.action, candidateId })}, but the observed evidence supports ${describe(outcome)}.`,
    );

  const cited = new Set(proposed.evidenceIds);
  const uncited = requiredCitations(observations, outcome).some(
    (group) => !group.some((id) => cited.has(id)),
  );
  if (uncited) return reject("It does not cite the evidence its recommendation rests on.");
  return { accepted: true, outcome };
}

/**
 * Evidence groups of which at least one ID must be cited. Stay rests on the current account read (its account and sample
 * evidence come together); a plan change or switch also rests on the chosen plan's quote and its test.
 */
function requiredCitations(observations: InvestigationObservations, outcome: Outcome): string[][] {
  if (outcome.action === "investigate" || !observations.account) return [];
  const current = [observations.account.evidenceIds];
  if (observations.account.valueSignal)
    current.push([observations.quotes.get(observations.account.planId)!.evidenceId]);
  if (outcome.action === "stay") return current;
  return [
    ...current,
    [observations.quotes.get(outcome.candidateId!)!.evidenceId],
    [observations.tests.get(outcome.candidateId!)!.evidenceId],
  ];
}

/** Stored evaluations for every plan this investigation quoted: eligibility from its quote and, within the ceiling, its test. */
export function evaluationsFrom(
  observations: InvestigationObservations,
  policy: { revision: number; recurringCeilingMinor: number },
): CandidateEvaluation[] {
  return [...observations.quotes.values()]
    .filter((quote) => quote.candidateId !== observations.account?.planId)
    .map((quote) => {
      const test = observations.tests.get(quote.candidateId);
      const rejectionReasons = (test?.capabilityResults ?? [])
        .filter((result) => !result.passes)
        .map((result) => `${result.capability}: ${result.reason}`);
      const overCeiling =
        quote.recurringTotal.amountMinor > policy.recurringCeilingMinor &&
        quote.candidateId !== observations.account?.planId;
      if (overCeiling)
        rejectionReasons.push(
          `Costs ${formatGbp(quote.recurringTotal.amountMinor)} a month, above the ${formatGbp(policy.recurringCeilingMinor)} ceiling.`,
        );
      if (quote.offer?.eligibility !== undefined && quote.offer.eligibility !== "ELIGIBLE")
        rejectionReasons.push(
          quote.offer.eligibility === "UNKNOWN"
            ? "Offer eligibility not verified."
            : "Offer not available to this account.",
        );
      if (observations.account?.valueSignal && !quote.comparison)
        rejectionReasons.push("The first-year costs cannot be confirmed.");
      if (!test && !overCeiling && !quote.offer) rejectionReasons.push("Not tested.");
      if (!test && quote.offer?.eligibility === "ELIGIBLE" && !overCeiling)
        rejectionReasons.push("Not tested.");
      return {
        candidateId: quote.candidateId,
        quoteId: quote.id,
        policyRevision: policy.revision,
        evidenceIds: [quote.evidenceId, ...(test ? [test.evidenceId] : [])],
        capabilityResults: test?.capabilityResults ?? [],
        eligible: rejectionReasons.length === 0,
        rejectionReasons,
      };
    });
}
