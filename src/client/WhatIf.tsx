import { useEffect, useRef, useState, type FormEvent } from "react";
import type { CaseSnapshot, Policy, PolicyFields, WhatIfResult } from "../shared/contracts.types";
import { api } from "./api";
import {
  Icon,
  capabilityNames,
  checkedFeatures,
  errorText,
  fitReason,
  planName,
  pounds,
  useExpired,
} from "./ui";

type Capability = PolicyFields["requiredCapabilities"][number];
const allCapabilities: Capability[] = ["editable_text"];

interface WhatIfProps {
  snapshot: CaseSnapshot;
  policy: Policy;
  onClose: () => void;
  onPropose: (fields: PolicyFields) => void;
}

/**
 * An advisory re-run of the same investigation with a different budget or requirement. The server keeps its evidence
 * apart from real recommendations; closing discards the answer and the edited values.
 */
export function WhatIf({ snapshot, policy, onClose, onPropose }: WhatIfProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const open = useRef(true);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const [ceiling, setCeiling] = useState((policy.recurringCeiling.amountMinor / 100).toFixed(2));
  const [capabilities, setCapabilities] = useState<Capability[]>([...policy.requiredCapabilities]);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [failure, setFailure] = useState("");
  const expired = useExpired(result?.evidenceExpiresAt);

  useEffect(() => {
    open.current = true;
    dialog.current?.showModal();
    return () => {
      open.current = false;
      clearTimeout(closeTimer.current);
    };
  }, []);

  function dismiss() {
    if (!open.current) return;
    open.current = false; // Discard a late advisory reply during dismissal.
    const finish = () => {
      dialog.current?.close();
      onClose();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return finish();
    setClosing(true);
    closeTimer.current = setTimeout(finish, 220);
  }

  const amountMinor = Math.round(Number(ceiling) * 100);
  const validCeiling =
    ceiling.trim() !== "" && Number.isFinite(amountMinor) && amountMinor >= 0 && amountMinor <= 100_000;
  const fields = (answer: WhatIfResult): PolicyFields => ({
    purpose: policy.purpose,
    requiredCapabilities: [...answer.proposed.requiredCapabilities],
    recurringCeiling: { ...answer.proposed.recurringCeiling },
    preserveHistory: policy.preserveHistory,
    allowInvestigation: policy.allowInvestigation,
  });
  const clearResult = () => {
    setResult(null);
    setFailure("");
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!open.current || pending || !validCeiling || capabilities.length === 0) return;
    setPending(true);
    clearResult();
    try {
      const answer = await api.whatIf(snapshot.case.id, {
        expectedPolicyRevision: policy.revision,
        overrides: {
          recurringCeiling: { currency: "GBP", amountMinor },
          requiredCapabilities: capabilities as PolicyFields["requiredCapabilities"],
        },
      });
      if (open.current) setResult(answer);
    } catch (error) {
      if (open.current) setFailure(errorText(error));
    } finally {
      if (open.current) setPending(false);
    }
  }

  const toggle = (name: Capability) => {
    clearResult();
    setCapabilities((current) =>
      current.includes(name)
        ? current.filter((item) => item !== name)
        : allCapabilities.filter((item) => item === name || current.includes(item)),
    );
  };
  const stale =
    result !== null &&
    (result.status === "stale" ||
      expired ||
      result.caseId !== snapshot.case.id ||
      result.baseline.policyRevision !== policy.revision ||
      result.baseline.entitlementRevision !== snapshot.currentAccount?.entitlementRevision ||
      result.baseline.caseState !== snapshot.case.state);
  const recommended = result?.candidates.find(
    (candidate) => candidate.candidateId === result.outcome?.candidateId,
  );
  const currentChecks = checkedFeatures(
    result?.proposed.requiredCapabilities,
    result?.current?.capabilityResults,
  );
  const currentMatched =
    !!snapshot.currentAccount?.planId && result?.current?.planId === snapshot.currentAccount.planId;
  const candidateChecks = checkedFeatures(
    result?.proposed.requiredCapabilities,
    recommended?.capabilityResults,
  );
  const action = result?.outcome?.action;
  const kept =
    action === "stay" && currentMatched && currentChecks.complete && currentChecks.missing.length === 0;
  const pricedValue =
    snapshot.case.scenario === "value_offer" &&
    recommended?.comparison?.basis === "AUTHORED_NOTICE_PROJECTION" &&
    recommended.comparison.netSavingMinor > 0 &&
    (!recommended.offer || recommended.offer.eligibility === "ELIGIBLE");
  const changed =
    (action === "switch" || action === "change_plan") &&
    currentMatched &&
    currentChecks.complete &&
    (currentChecks.missing.length > 0 || pricedValue) &&
    recommended?.tested &&
    recommended.eligible &&
    recommended.withinCeiling &&
    Number.isSafeInteger(recommended.recurringTotal.amountMinor) &&
    recommended.recurringTotal.amountMinor >= 0 &&
    candidateChecks.complete &&
    candidateChecks.missing.length === 0;
  const noMatch =
    action === "investigate" &&
    result?.outcome?.reason === "no_candidate" &&
    currentMatched &&
    currentChecks.complete &&
    currentChecks.missing.length > 0 &&
    result.candidates.every(
      (candidate) =>
        Number.isSafeInteger(candidate.recurringTotal.amountMinor) &&
        candidate.recurringTotal.amountMinor >= 0,
    ) &&
    result.candidates
      .filter((candidate) => candidate.withinCeiling)
      .every((candidate) => candidate.tested && !candidate.eligible);
  const trusted = result?.verdict === "accepted" && !stale && (kept || changed || noMatch);

  return (
    <dialog
      className={`dialog what-if${closing ? " is-closing" : ""}`}
      ref={dialog}
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        dismiss();
      }}
      aria-labelledby="what-if-title"
      aria-describedby="what-if-description"
    >
      <div className="dialog-scroll" tabIndex={0}>
        <div className="what-if-heading">
          <div>
            <span className="advisor-mark" aria-hidden="true">
              v.
            </span>
            <h2 id="what-if-title">What if?</h2>
          </div>
          <button className="round" onClick={dismiss} aria-label="Close What if">
            <Icon name="close" />
          </button>
        </div>
        <p className="note" id="what-if-description">
          Explore another budget. Your saved preferences stay as they are.
        </p>
        <form onSubmit={submit} aria-busy={pending}>
          <label className="field-label" htmlFor="what-if-budget">
            Monthly budget
          </label>
          <div className="money-input">
            <span>£</span>
            <input
              id="what-if-budget"
              type="number"
              min="0"
              max="1000"
              step="0.01"
              inputMode="decimal"
              value={ceiling}
              disabled={pending}
              onChange={(event) => {
                clearResult();
                setCeiling(event.target.value);
              }}
            />
            <span>/ month</span>
          </div>
          <p className="note">Include the full monthly renewal after any introductory offer.</p>
          <fieldset className="what-if-needs" disabled={pending}>
            <legend className="field-label">What you need</legend>
            {allCapabilities.map((name) => (
              <label key={name} className="permission">
                <input type="checkbox" checked={capabilities.includes(name)} onChange={() => toggle(name)} />
                <span>{capabilityNames[name]}</span>
              </label>
            ))}
          </fieldset>
          {!validCeiling && (
            <p className="note" role="alert">
              Enter a budget between £0 and £1,000.
            </p>
          )}
          {capabilities.length === 0 && (
            <p className="note" role="alert">
              Keep at least one feature.
            </p>
          )}
          <button
            className="button"
            type="submit"
            disabled={pending || !validCeiling || capabilities.length === 0}
          >
            {pending ? "Checking plans…" : "Compare plans"}
          </button>
        </form>
        {failure && (
          <p className="note below" role="alert">
            {failure}
          </p>
        )}

        {result && (
          <section className="what-if-result below" aria-live="polite">
            {stale && (
              <p className="price-caveat">
                This preview changed or expired. Check again before relying on it.
              </p>
            )}
            <p className="finding-label">Val’s finding</p>
            <h3>{headline(result, !!trusted, stale)}</h3>
            {trusted && pricedValue && recommended?.offer && (
              <p className="note below">
                {pounds(recommended.offer.introductoryAmount.amountMinor)} for{" "}
                {recommended.offer.introductoryCycles} paid monthly cycles, then{" "}
                {pounds(recommended.recurringTotal.amountMinor)} each month. Original service’s announced
                renewal is a forecast, not a billed charge.
              </p>
            )}
            {!trusted && !stale && (
              <p className="note">
                Val couldn’t verify a choice for these settings. Nothing was saved or bought.
              </p>
            )}
            {result.candidates
              .filter((candidate) => !trusted || candidate.candidateId !== result.outcome?.candidateId)
              .map((candidate) => {
                const amount =
                  Number.isSafeInteger(candidate.recurringTotal.amountMinor) &&
                  candidate.recurringTotal.amountMinor >= 0
                    ? candidate.recurringTotal.amountMinor
                    : undefined;
                const reason =
                  !candidate.tested && candidate.withinCeiling
                    ? "Not tested"
                    : fitReason(
                        candidate,
                        amount,
                        result.proposed.recurringCeiling.amountMinor,
                        result.proposed.requiredCapabilities,
                      );
                const year =
                  candidate.comparison && candidate.eligible && candidate.tested && trusted
                    ? ` · ${pounds(candidate.comparison.candidateTotal.amountMinor)} / 12 months`
                    : "";
                return (
                  <p key={candidate.candidateId} className="row">
                    <span>
                      {planName(candidate.candidateId)} ·{" "}
                      {amount === undefined ? "Price unknown" : `${pounds(amount)} / month`}
                      {year}
                    </span>
                    <strong>{reason}</strong>
                  </p>
                );
              })}
            {trusted && (
              <div className="action">
                <button className="button light" onClick={() => onPropose(fields(result))}>
                  Use these preferences
                </button>
                <p className="note">Confirm any change first. A purchase still needs separate approval.</p>
              </div>
            )}
          </section>
        )}
      </div>
    </dialog>
  );
}

function headline(result: WhatIfResult, trusted: boolean, stale: boolean) {
  if (stale) return "This preview needs another check.";
  if (!trusted || !result.outcome) return "Val couldn’t verify a choice.";
  if (result.outcome.action === "stay")
    return result.candidates.some((candidate) => candidate.comparison)
      ? "Original service remains the better verified choice."
      : "Original service would still meet your needs.";
  if (result.outcome.action === "investigate")
    return result.candidates.some((candidate) => candidate.withinCeiling)
      ? "No tested plan met these needs."
      : "No plan was within this budget.";
  const candidate = result.candidates.find((item) => item.candidateId === result.outcome?.candidateId);
  if (candidate?.comparison?.netSavingMinor && candidate.comparison.netSavingMinor > 0)
    return `${planName(candidate.candidateId)} could save ${pounds(candidate.comparison.netSavingMinor)} over 12 months.`;
  return candidate
    ? `${planName(candidate.candidateId)} could meet your needs for ${pounds(candidate.recurringTotal.amountMinor)} a month.`
    : "Val couldn’t verify a choice.";
}
