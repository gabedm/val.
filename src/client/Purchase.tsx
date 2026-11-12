import { useEffect, useRef, useState } from "react";
import type { CaseSnapshot, Consent, ExitReview, PurchasePreview } from "../shared/contracts.types";
import { api } from "./api";
import {
  BackLine,
  Icon,
  Notice,
  Row,
  capabilityNames,
  checkedFeatures,
  fullDate,
  go,
  handoverFacts,
  longDate,
  planName,
  pounds,
  supportedChoice,
  useCommand,
  useExpired,
} from "./ui";

interface CaseProps {
  snapshot: CaseSnapshot;
  refresh: () => Promise<void>;
}

export function reviewBenefit(snapshot: CaseSnapshot, terms: PurchasePreview["materialTerms"] | undefined) {
  const { policy, recommendation, currentAccount, currentOutput, receipt } = snapshot;
  const checks = checkedFeatures(policy?.requiredCapabilities, currentOutput?.capabilityResults);
  const currentMatches =
    !!policy &&
    !policy.requiredCapabilities.includes("speaker_labels") &&
    recommendation?.policyRevision === policy.revision &&
    checks.complete &&
    !!currentAccount?.planId &&
    currentOutput?.planId === currentAccount.planId;
  const missing =
    currentMatches && supportedChoice(snapshot)
      ? checks.missing.map((item) => capabilityNames[item].toLowerCase())
      : [];
  const oldRenewal = terms?.overlap.possibleOldRenewal?.amountMinor;
  const increase =
    missing.length > 0 &&
    terms &&
    oldRenewal !== undefined &&
    oldRenewal !== null &&
    Number.isSafeInteger(oldRenewal) &&
    oldRenewal >= 0 &&
    Number.isSafeInteger(terms.recurring.amountMinor) &&
    terms.recurring.amountMinor >= 0 &&
    receipt.oldBilling === "ACTIVE"
      ? terms.recurring.amountMinor - oldRenewal
      : null;
  return { missing, increase };
}

export function reviewValue(snapshot: CaseSnapshot, terms: PurchasePreview["materialTerms"] | undefined) {
  const { policy, recommendation, currentAccount, currentOutput } = snapshot;
  const checks = checkedFeatures(policy?.requiredCapabilities, currentOutput?.capabilityResults);
  const currentMatches =
    !!policy &&
    !policy.requiredCapabilities.includes("speaker_labels") &&
    recommendation?.policyRevision === policy.revision &&
    checks.complete &&
    checks.missing.length === 0 &&
    !!currentAccount?.planId &&
    currentOutput?.planId === currentAccount.planId;
  const choice = supportedChoice(snapshot);
  return snapshot.case.scenario === "value_offer" &&
    currentMatches &&
    !!terms &&
    !!choice &&
    choice.quote.candidateId === terms.candidateId &&
    choice.quote.revision === terms.quoteRevision &&
    choice.quote.comparison?.assessedAt === terms.comparison?.assessedAt &&
    (!terms.offer || terms.offer.eligibility === "ELIGIBLE") &&
    terms.comparison?.basis === "AUTHORED_NOTICE_PROJECTION"
    ? terms.comparison
    : null;
}

/** Exact costs, then two separate permissions; checkout uses the recorded consent once. */
export function ReviewSwitch({ snapshot, refresh }: CaseProps) {
  const { case: caseRow, recommendation, receipt } = snapshot;
  const [preview, setPreview] = useState<PurchasePreview | null>(null);
  const [consent, setConsent] = useState<Consent | null>(null);
  const [openingPayPal, setOpeningPayPal] = useState(false);
  const [agreed, setAgreed] = useState({ purchase: false, exit: false });
  const approvals = useRef<HTMLFieldSetElement>(null);
  const returnToApproval = useRef(false);
  const expired = useExpired(preview?.expiresAt);
  const command = useCommand(refresh);
  const olderRequirements = snapshot.policy?.requiredCapabilities.includes("speaker_labels") ?? false;
  const ready =
    caseRow.state === "AWAITING_CONSENT" && recommendation?.action === "switch" && !olderRequirements;

  const loadPreview = (returnFocus = false) =>
    command.run(async () => {
      setPreview(await api.preview(caseRow.id, recommendation!.id));
      returnToApproval.current = returnFocus;
      setConsent(null);
      setAgreed({ purchase: false, exit: false });
    });
  useEffect(() => {
    if (ready) void loadPreview();
  }, [ready]);
  useEffect(() => {
    if (command.pending || !returnToApproval.current) return;
    returnToApproval.current = false;
    if (document.activeElement === document.body)
      approvals.current?.querySelector("input")?.focus({ preventScroll: true });
  }, [preview, command.pending]);

  if (!ready)
    return (
      <main className="page narrow">
        <BackLine to="home" step="Review your switch" />
        <h1>{olderRequirements ? "Earlier needs require review." : "Nothing to review."}</h1>
        <p className="lead">
          {olderRequirements
            ? "An earlier saved requirement cannot be shown or approved safely here. Original service stays in place; request a separate case review."
            : "There’s no recommended switch waiting for your approval."}
        </p>
      </main>
    );
  const terms = preview?.materialTerms;
  const name = planName(recommendation.candidateId);
  const { missing, increase } = reviewBenefit(snapshot, terms);
  const value = missing.length > 0;
  const valueComparison = reviewValue(snapshot, terms);

  const proceed = () =>
    command.run(async () => {
      setOpeningPayPal(true);
      try {
        const recorded =
          consent ??
          (await api.consent(caseRow.id, {
            previewId: preview!.id,
            previewHash: preview!.previewHash,
            approvePurchase: true,
            approveOldExitAfterReadiness: true,
          }));
        setConsent(recorded);
        const result = await api.checkout(caseRow.id, recorded.id);
        if ("approvalUrl" in result) location.assign(result.approvalUrl);
        else go("recovery");
      } finally {
        setOpeningPayPal(false);
      }
    });

  return (
    <main className="page narrow payment-review">
      <BackLine to="options" step="Review your switch" />
      <h1>Review the switch.</h1>
      <p className="lead">
        {valueComparison
          ? `Original service announced ${pounds(valueComparison.announcedRenewal.amountMinor)} from ${fullDate(valueComparison.renewalEffectiveAt)}, not yet billed. ${name} passed your editable-work check; Val verifies payment and service readiness before ending Original service.`
          : value
            ? `${name} kept ${missing.join(" and ")} in Val’s check. Val verifies payment and service readiness before stopping Original service.`
            : "Review costs and both approvals. Val verifies payment and required features before stopping Original service."}
      </p>
      {!terms && (
        <section className="payment-loading" role="status">
          <Icon name="activity" />
          <p>
            {command.pending
              ? "Getting the exact costs…"
              : command.message || "Costs unavailable. No purchase is possible here."}
          </p>
          {!command.pending && (
            <button className="text-button" onClick={() => loadPreview(true)}>
              Try again
            </button>
          )}
        </section>
      )}
      {terms && (
        <>
          <section className="summary-card">
            <div className="service">
              <div className="service-mark margin">m</div>
              <div>
                <h3>{name}</h3>
                <div className="service-sub">
                  {snapshot.policy?.requiredCapabilities
                    .map((item) => capabilityNames[item].toLowerCase())
                    .join(" and ") ?? "Saved features need checking"}
                </div>
              </div>
            </div>
            <div className="review-due">
              <p className="finding-label">Due at PayPal</p>
              <div className="summary-amount">{pounds(terms.dueNow.amountMinor)}</div>
              <p className="summary-caption">
                {terms.offer
                  ? `Due on PayPal approval; ${pounds(terms.offer.introductoryAmount.amountMinor)} for each of ${terms.offer.introductoryCycles} paid monthly cycles, then ${pounds(terms.recurring.amountMinor)} monthly`
                  : `Due now, then ${pounds(terms.recurring.amountMinor)} every month`}
              </p>
            </div>
            {terms.offer && (
              <>
                <Row label="Offer started" value={fullDate(terms.offer.validFrom)} />
                <Row
                  label="Offer available until"
                  value={`${fullDate(terms.offer.eligibleUntil)} ${new Date(terms.offer.eligibleUntil).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC`}
                />
                <Row
                  label="Offer eligibility"
                  value={
                    terms.offer.eligibility === "ELIGIBLE" ? "Eligible for this account" : "Needs checking"
                  }
                />
                <Row label="Setup fee" value={pounds(terms.offer.setupFee.amountMinor)} />
              </>
            )}
            {valueComparison && (
              <>
                <Row
                  label="Keep Original service · 12 months"
                  value={`${pounds(valueComparison.currentTotal.amountMinor)} projected`}
                />
                <Row
                  label={`${name} · 12 months`}
                  value={`${pounds(valueComparison.candidateTotal.amountMinor)} projected`}
                />
                <p className="note below">
                  {pounds(valueComparison.netSavingMinor)} less if Original service’s announced renewal takes
                  effect. Today’s paid Original service period is not counted again.
                </p>
              </>
            )}
            {value && increase !== null && increase > 0 && (
              <p className="note below">{pounds(increase)} more per month than Original service’s plan.</p>
            )}
          </section>
          <section className="cost-note">
            <h3>Before you leave Original service</h3>
            <p className="below">
              Your last Original service payment won’t be refunded. Access remains until{" "}
              <b>{fullDate(terms.oldAccessEndsAt)}</b>.
            </p>
            <p className="below">
              You pay {pounds(terms.overlap.newDueNow.amountMinor)} to Margin now while Original service stays
              paid through {fullDate(terms.overlap.oldPaidThrough)}.
              {terms.overlap.possibleOldRenewal &&
                ` If Original service billing weren’t stopped before ${fullDate(terms.overlap.oldNextBillingTime ?? terms.overlap.oldPaidThrough)}, it could charge ${pounds(terms.overlap.possibleOldRenewal.amountMinor)} again.`}
            </p>
          </section>
          <fieldset className="permissions" ref={approvals}>
            <legend>Your approval</legend>
            <label className="permission">
              <input
                type="checkbox"
                checked={agreed.purchase}
                disabled={command.pending}
                onChange={(event) => setAgreed({ ...agreed, purchase: event.target.checked })}
              />
              <span>
                Subscribe to {name}
                <small>
                  {terms.offer
                    ? `${pounds(terms.offer.introductoryAmount.amountMinor)} for the first ${terms.offer.introductoryCycles} paid monthly cycles, starting on approval; then ${pounds(terms.recurring.amountMinor)} monthly. ${pounds(terms.offer.setupFee.amountMinor)} setup fee. No minimum commitment.`
                    : `${pounds(terms.dueNow.amountMinor)} now and ${pounds(terms.recurring.amountMinor)} every month.`}{" "}
                  Approved through PayPal.
                </small>
              </span>
            </label>
            <label className="permission">
              <input
                type="checkbox"
                checked={agreed.exit}
                disabled={command.pending}
                onChange={(event) => setAgreed({ ...agreed, exit: event.target.checked })}
              />
              <span>
                End Original service after the switch
                <small>
                  Only after the new payment and required features are checked. Stop billing, then end access
                  on {fullDate(terms.oldAccessEndsAt)}.
                </small>
              </span>
            </label>
          </fieldset>
          {expired && (
            <p className="price-caveat">
              These costs are more than five minutes old.{" "}
              <button className="text-button" disabled={command.pending} onClick={() => loadPreview(true)}>
                Refresh costs
              </button>
            </p>
          )}
          <p className="permission-feedback" role="status">
            {expired
              ? "Refresh costs before continuing."
              : agreed.purchase && agreed.exit
                ? "Ready to continue to PayPal."
                : "Select both choices to continue."}
          </p>
          <div className="action">
            <button
              className="button"
              disabled={!agreed.purchase || !agreed.exit || expired || command.pending}
              onClick={proceed}
            >
              {command.pending ? (openingPayPal ? "Opening PayPal…" : "Please wait…") : "Continue to PayPal"}
            </button>
            <Notice text={command.message} />
          </div>
        </>
      )}
      <button
        className="text-button below"
        disabled={command.pending}
        onClick={() =>
          command.run(async () => {
            await api.decline(caseRow.id);
            go("home");
          })
        }
      >
        Not now — keep Original service
      </button>
      {receipt.oldBilling === "UNKNOWN" && (
        <p className="note below">Original service’s paid period isn’t verified.</p>
      )}
    </main>
  );
}

const stepWords = {
  NOT_STARTED: "Not started",
  PENDING: "Waiting",
  VERIFIED: "Verified",
  FAILED: "Needs another try",
  UNKNOWN: "Not confirmed",
} as const;
const stepWord = (status: keyof typeof stepWords, evidenced: boolean) =>
  status === "VERIFIED" && !evidenced ? "Needs checking" : stepWords[status];
const billingWords = {
  NONE: "Not created",
  APPROVAL_PENDING: "Awaiting PayPal",
  APPROVED: "Approved; checking activation",
  ACTIVE: "Active",
  SUSPENDED: "Suspended",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  UNKNOWN: "Not confirmed",
} as const;
const retryNames: Record<string, [string, string]> = {
  replacement_create: ["The new plan isn’t confirmed yet.", "Retry confirming the new plan"],
  activate_account: ["The new plan isn’t ready yet.", "Retry activating the new plan"],
  import: ["An earlier handover check needs review.", "Retry the recorded check"],
  cancel_old_billing: [
    "Original service billing hasn’t stopped yet.",
    "Retry stopping Original service billing",
  ],
  exit_old_service: ["Original service’s service exit is pending.", "Retry ending Original service access"],
};

/** Resumes the same persisted handover: the unfinished step leads, with one action that never buys again. */
export function Recovery({ snapshot, refresh }: CaseProps) {
  const { case: caseRow, transition, receipt, handover } = snapshot;
  const command = useCommand(refresh);
  const [review, setReview] = useState<ExitReview | null>(null);
  const [agreed, setAgreed] = useState(false);
  const exitExpired = useExpired(review?.expiresAt);

  if (!transition)
    return (
      <main className="page narrow has-nav">
        <BackLine to="activity" step="Your switch" />
        <h1>No switch in progress.</h1>
        <p className="lead">
          There is no switch to resume here. Open Activity to see your saved subscription reviews.
        </p>
      </main>
    );
  const progress = handoverFacts(receipt);
  const closed = transition.state === "COMPLETE";
  const complete = closed && progress.handoverComplete;
  const terms = transition.acceptedPurchaseTerms;
  const plan = planName(terms.planId);
  let title = "Completing the switch.";
  let lead = progress.ready
    ? "The new payment and features passed. The Original service exit still needs to finish."
    : "Val is checking your new payment and subscription. See each status below.";
  if (closed) {
    title = complete ? `${plan} is ready. Original service billing stopped.` : "Some steps need checking.";
    lead = !complete
      ? "Some checks or Original service’s exit are incomplete. See each status below."
      : progress.accessEnded
        ? "Original service access has ended; the new payment and service readiness are verified."
        : `Original service access is scheduled to end on ${fullDate(receipt.oldAccessEndsAt)}. It has not ended yet.`;
  }
  const stage = !closed
    ? "Switch in progress"
    : !complete
      ? "Checks incomplete"
      : progress.accessEnded
        ? "Access ended"
        : "Access end scheduled";
  let action: { label: string; run: () => Promise<unknown>; note: string } | null = null;
  if (!closed && handover?.approvalUrl) {
    title = `Approve ${plan} with PayPal.`;
    action = {
      label: "Continue to PayPal",
      run: async () => location.assign(handover.approvalUrl!),
      note: "This resumes the same purchase, not a new one.",
    };
  } else if (!closed && handover?.retryable) {
    const [heading, label] = retryNames[handover.kind] ?? [
      "This step needs another try.",
      "Try this step again",
    ];
    title = heading;
    action = {
      label,
      run: () => api.retry(caseRow.id, handover.operationId),
      note: "This won’t buy another subscription.",
    };
  } else if (!closed && (receipt.duePayment === "PENDING" || receipt.duePayment === "UNKNOWN")) {
    title = "Checking the new payment.";
    action = {
      label: "Check with PayPal now",
      run: () => api.reconcile(caseRow.id),
      note: "Val reads PayPal’s record; it never charges again to check.",
    };
  } else if (
    !closed &&
    !transition.exitAuthorizationId &&
    progress.ready &&
    receipt.oldBilling === "ACTIVE"
  ) {
    title = "Original service billing is still active.";
  }

  return (
    <main className="page narrow has-nav payment-outcome">
      <BackLine to="activity" step="Your switch" />
      <header
        className={`outcome-heading ${complete ? "is-complete" : handover?.retryable || closed ? "needs-attention" : "is-pending"}`}
      >
        <span className="payment-symbol" aria-hidden="true">
          <Icon name={complete ? "check" : handover?.retryable || closed ? "alert" : "activity"} />
        </span>
        <p className="eyebrow">{stage}</p>
        <h1>{title}</h1>
        <p className="lead">{lead}</p>
      </header>
      {action && (
        <div className="action">
          <button
            className="button"
            disabled={command.pending}
            onClick={() => command.run(action.run, "Done. Val is checking the result.")}
          >
            {action.label}
          </button>
          <p className="note">{action.note}</p>
          <Notice text={command.message} />
        </div>
      )}

      <section className="card receipt-group">
        <h2>{complete ? "Outcome receipt" : "Switch status"}</h2>
        <div className="receipt-plan">
          <span className="finding-monogram is-margin" aria-hidden="true">
            M
          </span>
          <div>
            <h3>{plan}</h3>
            <p>{progress.paid ? "Payment verified" : "Payment not yet verified"}</p>
          </div>
          <strong>
            {pounds(terms.dueNow.amountMinor)}
            <small>First payment</small>
          </strong>
        </div>
        <Row
          label={`${plan} subscription`}
          value={
            receipt.newBillingStatus === "ACTIVE" && !receipt.newSubscriptionId
              ? "Not confirmed"
              : billingWords[receipt.newBillingStatus]
          }
        />
        <Row
          label="First payment"
          value={
            progress.paid
              ? `${pounds(terms.dueNow.amountMinor)} completed and verified`
              : stepWord(receipt.duePayment, false)
          }
        />
        {terms.offer && (
          <Row
            label="Introductory billing"
            value={`${pounds(terms.offer.introductoryAmount.amountMinor)} for ${terms.offer.introductoryCycles} paid monthly cycles`}
          />
        )}
        <Row
          label={terms.offer ? "After the paid offer" : "Monthly renewal"}
          value={`${pounds(terms.recurring.amountMinor)} / month · agreed terms`}
        />
        <Row
          label="Required work"
          value={progress.output ? "Verified on the subscribed plan" : stepWord(receipt.capability, false)}
        />
        <div className="receipt-previous">
          <h3>Original service</h3>
          <Row
            label="Original service billing"
            value={
              progress.billingStopped
                ? "Stopped"
                : receipt.oldBilling === "ACTIVE"
                  ? "Still active"
                  : "Not confirmed"
            }
          />
          <Row
            label="Original service access"
            value={
              progress.accessEnded
                ? "Ended"
                : progress.accessScheduled
                  ? "End scheduled"
                  : receipt.oldService === "ACTIVE"
                    ? "Still active"
                    : "Not confirmed"
            }
          />
          <Row
            label={
              progress.accessScheduled
                ? "Access end scheduled for"
                : progress.accessEnded
                  ? "Previously paid through"
                  : "Paid through"
            }
            value={fullDate(receipt.oldAccessEndsAt)}
          />
        </div>
        <p className="note below">
          Val does not refund Original service’s last payment. Check PayPal for final charges.
        </p>
      </section>

      {!closed && !transition.exitAuthorizationId && progress.ready && (
        <section className="form-card">
          <h2>Remaining exits</h2>
          {!review && (
            <button
              className="text-button"
              disabled={command.pending}
              onClick={() =>
                command.run(async () => {
                  setReview(await api.exitReview(caseRow.id, transition.id));
                  setAgreed(false);
                })
              }
            >
              Review remaining exits
            </button>
          )}
          {review && (
            <>
              <Row
                label="What remains"
                value={
                  review.materialTerms.remainingExits
                    .map((step) =>
                      step === "old_billing"
                        ? "Stop Original service billing"
                        : "End Original service access",
                    )
                    .join("; ") || "No exits remain"
                }
              />
              <Row
                label={plan}
                value={`${pounds(review.materialTerms.effectiveRecurring.amountMinor)} / month`}
              />
              {review.materialTerms.offer && (
                <Row
                  label="Paid offer terms"
                  value={`${pounds(review.materialTerms.offer.introductoryAmount.amountMinor)} for ${review.materialTerms.offer.introductoryCycles} paid cycles, then ${pounds(review.materialTerms.effectiveRecurring.amountMinor)} monthly`}
                />
              )}
              <Row
                label="If approved, Original service access ends"
                value={longDate(review.materialTerms.oldAccessEndsAt)}
              />
              <label className="permission">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(event) => setAgreed(event.target.checked)}
                />
                <span>
                  End Original service as listed
                  <small>This authorizes only these exits and buys nothing.</small>
                </span>
              </label>
              {exitExpired && (
                <p className="price-caveat">These exit terms expired. Read new terms before authorizing.</p>
              )}
              {exitExpired && (
                <button
                  className="text-button"
                  disabled={command.pending}
                  onClick={() =>
                    command.run(async () => {
                      setReview(await api.exitReview(caseRow.id, transition.id));
                      setAgreed(false);
                    })
                  }
                >
                  Refresh exit terms
                </button>
              )}
              <button
                className="button"
                disabled={!agreed || command.pending || exitExpired}
                onClick={() =>
                  command.run(async () => {
                    await api.authorizeExits(caseRow.id, review);
                    setReview(null);
                  }, "Exits authorized.")
                }
              >
                Authorize remaining exits
              </button>
            </>
          )}
        </section>
      )}
      {!closed && (
        <details className="disclosure">
          <summary>Pause the remaining changes</summary>
          <div>
            <p className="note">
              Pause steps that haven’t started. This can’t undo a completed step or end Margin.
            </p>
            <button
              className="text-button"
              disabled={command.pending}
              onClick={() =>
                command.run(() => api.pauseExits(caseRow.id, transition.id), "Remaining changes paused.")
              }
            >
              Pause remaining changes
            </button>
          </div>
        </details>
      )}
    </main>
  );
}
