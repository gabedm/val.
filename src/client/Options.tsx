import { useState } from "react";
import type {
  CandidateEvaluation,
  CandidateQuote,
  CaseSnapshot,
  PolicyFields,
} from "../shared/contracts.types";
import {
  BackLine,
  Icon,
  Row,
  capabilityNames,
  checkedFeatures,
  fitReason,
  freshQuote,
  fullDate,
  go,
  monthlyDifference,
  planName,
  pounds,
  supportedChoice,
  useExpired,
} from "./ui";
import { WhatIf } from "./WhatIf";

interface OptionsProps {
  snapshot: CaseSnapshot;
  refresh: () => Promise<void>;
  onPropose: (fields: PolicyFields) => void;
}

/** The authoritative fit and first-year cost comparison; historical raw provider artifacts stay in audit records. */
export function Options({ snapshot, onPropose }: OptionsProps) {
  const { case: caseRow, recommendation, evaluations, evaluationQuotes, currentOutput, policy } = snapshot;
  const [whatIf, setWhatIf] = useState(false);
  const quoteFor = (evaluation: CandidateEvaluation) =>
    evaluationQuotes.find(
      (quote) => quote.id === evaluation.quoteId && quote.candidateId === evaluation.candidateId,
    ) ?? null;
  const recommended = evaluations.find(
    (item) => item.candidateId === recommendation?.candidateId && item.policyRevision === policy?.revision,
  );
  const quote = recommended ? quoteFor(recommended) : null;
  const recentQuote = freshQuote(quote);
  useExpired(recentQuote ? new Date(Date.parse(recentQuote.observedAt) + 5 * 60_000).toISOString() : null);
  const checked = checkedFeatures(policy?.requiredCapabilities, currentOutput?.capabilityResults);
  const currentCheck =
    policy &&
    recommendation?.policyRevision === policy.revision &&
    checked.complete &&
    !!snapshot.currentAccount?.planId &&
    currentOutput?.planId === snapshot.currentAccount.planId &&
    ((caseRow.state === "STAY" && recommendation.action === "stay") ||
      (caseRow.state === "AWAITING_CONSENT" && recommendation.action === "switch") ||
      (caseRow.state === "NEEDS_REVIEW" && snapshot.investigationRun?.outcome === "accepted"));
  const missing = currentCheck ? checked.missing.map((name) => capabilityNames[name].toLowerCase()) : [];
  const choice = supportedChoice(snapshot);
  const currentQuote =
    snapshot.currentQuote?.planId === snapshot.currentAccount?.planId
      ? freshQuote(snapshot.currentQuote)
      : null;
  const difference = choice
    ? monthlyDifference(snapshot.currentQuote, choice.quote, snapshot.currentAccount?.planId ?? null)
    : null;
  const priceFor = (item: CandidateQuote | null) =>
    item && Number.isSafeInteger(item.recurringTotal.amountMinor) && item.recurringTotal.amountMinor >= 0
      ? pounds(item.recurringTotal.amountMinor)
      : null;
  const alternatives = evaluations
    .filter((item) => item !== recommended)
    .sort(
      (first, second) =>
        (quoteFor(first)?.recurringTotal.amountMinor ?? Infinity) -
        (quoteFor(second)?.recurringTotal.amountMinor ?? Infinity),
    );
  const olderRequirements = policy?.requiredCapabilities.includes("speaker_labels") ?? false;
  const switchable =
    caseRow.state === "AWAITING_CONSENT" && recommendation?.action === "switch" && !olderRequirements;
  const valueChoice =
    caseRow.scenario === "value_offer" &&
    currentCheck &&
    !missing.length &&
    choice?.quote.comparison?.basis === "AUTHORED_NOTICE_PROJECTION";
  if (olderRequirements)
    return (
      <main className="page narrow">
        <BackLine to="home" step="Plan checks" />
        <h1>Earlier needs require review.</h1>
        <p className="lead">
          This case uses an older saved requirement that cannot be explained or approved safely in this view.
          Your subscription remains in place.
        </p>
      </main>
    );

  return (
    <main className="page narrow findings-page">
      <BackLine to="home" step="Plan checks" />
      <header className="findings-heading">
        <span className="advisor-mark" aria-hidden="true">
          v.
        </span>
        <h1>What Val found.</h1>
      </header>
      <section className="finding-message">
        <h2>
          {valueChoice
            ? "Original service announced a higher renewal."
            : currentCheck
              ? missing.length
                ? `Original service no longer provides ${missing.join(" and ")}.`
                : "Original service still has what you need."
              : "Val needs another check."}
        </h2>
        <p className="lead">
          {valueChoice
            ? `${planName(choice.quote.planId)} meets your saved needs at a lower forecast cost over the next 12 months.`
            : choice
              ? `${planName(choice.quote.planId)} kept every saved need in Val’s check. Any purchase still needs approval.`
              : recommendation?.candidateId
                ? "A cost or required-work check is missing or out of date. No replacement has been approved."
                : currentCheck && !missing.length
                  ? "Val found no worthwhile change."
                  : caseRow.state === "INVESTIGATING"
                    ? "Val is checking fit and costs."
                    : "No new plan is confirmed yet."}
        </p>
      </section>
      <section className="card decision-card">
        {recommendation?.candidateId ? (
          <div className="finding-plan">
            <span
              className={`finding-monogram ${recommendation.candidateId.startsWith("b_") ? "is-margin" : ""}`}
              aria-hidden="true"
            >
              {recommendation.candidateId.startsWith("b_") ? "M" : "D"}
            </span>
            <div>
              <p className="finding-label">{choice ? "Suggested plan" : "Plan to review"}</p>
              <h2>{planName(recommendation.candidateId)}</h2>
            </div>
          </div>
        ) : (
          <div className="finding-plan">
            <span className="finding-monogram" aria-hidden="true">
              D
            </span>
            <div>
              <p className="finding-label">Current plan</p>
              <h2>{planName(snapshot.currentAccount?.planId ?? "a_01")}</h2>
            </div>
          </div>
        )}
        {choice && (
          <div className="finding-price">
            <p>
              <strong>
                {pounds(
                  choice.quote.offer?.introductoryAmount.amountMinor ??
                    choice.quote.recurringTotal.amountMinor,
                )}
              </strong>
              <span> / month</span>
            </p>
            <span>
              {choice.quote.offer
                ? `For ${choice.quote.offer.introductoryCycles} paid months, then ${pounds(choice.quote.recurringTotal.amountMinor)} / month`
                : "Standard monthly renewal"}
            </span>
          </div>
        )}
        {valueChoice && (
          <div className="finding-forecast">
            <div>
              <span>Next 12 months</span>
              <strong>
                {pounds(choice.quote.comparison!.candidateTotal.amountMinor)}{" "}
                <small>vs {pounds(choice.quote.comparison!.currentTotal.amountMinor)} staying</small>
              </strong>
            </div>
            <p>{pounds(choice.quote.comparison!.netSavingMinor)} less if the announced rise takes effect.</p>
          </div>
        )}
        {recommendation?.candidateId && (
          <div className="decision-costs">
            <Row
              label={planName(snapshot.currentAccount?.planId ?? "a_01")}
              value={
                currentQuote && priceFor(currentQuote)
                  ? `${priceFor(currentQuote)} / month`
                  : snapshot.currentAccount?.planId === "a_01" && snapshot.receipt.oldBilling === "ACTIVE"
                    ? "£12 / month at setup · current rate unknown"
                    : "Current price unknown"
              }
            />
            {valueChoice && (
              <Row
                label="Announced Original service renewal"
                value={`${pounds(choice.quote.comparison!.announcedRenewal.amountMinor)} / month from ${fullDate(choice.quote.comparison!.renewalEffectiveAt)} · not yet billed`}
              />
            )}
            {!choice && (
              <Row
                label={planName(recommendation.candidateId)}
                value={
                  priceFor(quote)
                    ? `${priceFor(quote)} / month${recentQuote ? "" : " · recheck price"}`
                    : "Price unknown"
                }
              />
            )}
            {valueChoice && (
              <Row
                label="First charge if approved"
                value={
                  choice.quote.offer
                    ? `${pounds(choice.quote.dueNowTotal.amountMinor)} · ${choice.quote.offer.introductoryCycles} paid cycles, then full renewal`
                    : `${pounds(choice.quote.dueNowTotal.amountMinor)} · standard monthly plan`
                }
              />
            )}
            {difference !== null && difference > 0 && !valueChoice && (
              <p className="note below">{pounds(difference)} more per month for the needed features.</p>
            )}
          </div>
        )}
        {choice && (
          <p className="finding-fit">
            <Icon name="check" />
            Your saved needs passed Val’s checks.
          </p>
        )}
        {recommendation?.action === "change_plan" && (
          <p className="note below">
            A Original service upgrade is advice only. Val will not change or buy that plan for you.
          </p>
        )}
        {switchable && (
          <button className="button below" onClick={() => go("review")}>
            Review switch terms
          </button>
        )}
        {switchable && (
          <div className="finding-links">
            <button className="text-button" onClick={() => go("home")}>
              Not now
            </button>
          </div>
        )}
      </section>
      {alternatives.length > 0 && (
        <section className="finding-alternatives">
          <h2>Other plans Val checked</h2>
          {alternatives.map((evaluation) => {
            const alternativeQuote = quoteFor(evaluation);
            const amount = priceFor(alternativeQuote);
            const yearly =
              valueChoice &&
              evaluation.eligible &&
              alternativeQuote?.comparison &&
              freshQuote(alternativeQuote)
                ? alternativeQuote.comparison.candidateTotal.amountMinor
                : null;
            const gap =
              yearly !== null ? yearly - choice!.quote.comparison!.candidateTotal.amountMinor : null;
            const yearReason =
              gap === null
                ? ""
                : gap > 0
                  ? ` · ${pounds(yearly!)} in 12 months (${pounds(gap)} more than ${planName(choice!.quote.planId)})`
                  : gap === 0
                    ? ` · ${pounds(yearly!)} in 12 months, same as ${planName(choice!.quote.planId)}`
                    : " · Lower first-year quote; the decision needs another check";
            return (
              <article key={evaluation.candidateId} className="candidate option-row">
                <div className="spread">
                  <h3>{planName(evaluation.candidateId)}</h3>
                  <span className="candidate-price">
                    {amount ?? "Price unavailable"}
                    {amount && <span> / month</span>}
                  </span>
                </div>
                <p className="note">
                  {fitReason(
                    evaluation,
                    amount === null ? undefined : alternativeQuote!.recurringTotal.amountMinor,
                    policy?.recurringCeiling.amountMinor ?? 0,
                    policy?.requiredCapabilities ?? [],
                  )}
                  {yearReason}
                  {alternativeQuote && !freshQuote(alternativeQuote) ? " · Quote needs rechecking" : ""}
                </p>
              </article>
            );
          })}
        </section>
      )}
      {!currentOutput && evaluations.length === 0 && (
        <p className="note below">
          No plan checks are available yet. Save your preferences before asking Val to check.
        </p>
      )}
      {policy && (
        <aside className="finding-explore">
          <div>
            <h2>A different budget?</h2>
            <p>Explore the options before changing your preferences.</p>
          </div>
          <button className="button light" onClick={() => setWhatIf(true)}>
            What if?
          </button>
        </aside>
      )}
      {whatIf && policy && (
        <WhatIf snapshot={snapshot} policy={policy} onClose={() => setWhatIf(false)} onPropose={onPropose} />
      )}
    </main>
  );
}
