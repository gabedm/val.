import type { CaseSnapshot } from "../shared/contracts.types";
import { api } from "./api";
import {
  Icon,
  Notice,
  Row,
  capabilityNames,
  checkedFeatures,
  freshQuote,
  fullDate,
  go,
  handoverFacts,
  longDate,
  monthlyDifference,
  planName,
  pounds,
  supportedChoice,
  useCommand,
} from "./ui";

interface HomeProps {
  snapshot: CaseSnapshot | null;
  failure: string;
  loading: boolean;
  refresh: () => Promise<void>;
}

const inHandover = new Set(["AWAITING_PAYPAL", "VERIFYING_NEW", "EXITING_OLD", "ATTENTION_REQUIRED"]);

/** Payment verification uses the same persisted setup boundary as preference admission. */
export function dashboardStatus(snapshot: CaseSnapshot): {
  label: string;
  tone: "neutral" | "waiting" | "positive" | "attention";
} {
  const { case: record, receipt, handover } = snapshot;
  if (record.state === "SETUP") {
    if (receipt.oldBilling === "ACTIVE" && receipt.oldAccessEndsAt)
      return { label: "Payment verified", tone: "positive" };
    if (
      handover?.status === "FAILED" ||
      handover?.paymentStatus === "FAILED" ||
      ["CANCELLED", "EXPIRED"].includes(handover?.billingStatus ?? "")
    )
      return { label: "Needs attention", tone: "attention" };
    if (handover?.approvalUrl) return { label: "Approval needed", tone: "waiting" };
    if (handover) return { label: "Checking payment", tone: "waiting" };
    return { label: "Ready to start", tone: "neutral" };
  }
  if (record.state === "AWAITING_CONSENT") return { label: "For your review", tone: "attention" };
  if (record.state === "NEEDS_REVIEW" || record.state === "ATTENTION_REQUIRED")
    return { label: "Needs attention", tone: "attention" };
  if (inHandover.has(record.state) || record.state === "INVESTIGATING")
    return { label: "In progress", tone: "waiting" };
  if (record.state === "COMPLETE")
    return handoverFacts(receipt).handoverComplete && snapshot.transition
      ? { label: "Switch complete", tone: "positive" }
      : { label: "Needs checking", tone: "attention" };
  return { label: "Current plan", tone: "neutral" };
}

export function Home({ snapshot, failure, loading, refresh }: HomeProps) {
  const command = useCommand(refresh);
  if (!snapshot) {
    if (loading)
      return (
        <main className="page has-nav dashboard-page" aria-busy="true">
          <h1>Your subscriptions</h1>
          <div className="dashboard-skeleton" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <p className="note" role="status">
            Loading your subscriptions…
          </p>
        </main>
      );
    return (
      <main className="page has-nav dashboard-page">
        <div className="dashboard-heading">
          <h1>Your subscriptions</h1>
          <button className="text-button" onClick={() => go("activity")}>
            Activity <Icon name="next" />
          </button>
        </div>
        <section className="dashboard-empty">
          <div className="empty-plan-icon" aria-hidden="true">
            <Icon name="file" />
            <span>+</span>
          </div>
          <h2>Add your first subscription.</h2>
          <p className="lead">Better value starts with what you already pay for.</p>
          {failure && (
            <p className="note below" role="alert">
              {failure}
            </p>
          )}
          <div className="action">
            <button className="button" onClick={() => go("home")}>
              Talk to Val
            </button>
            <Notice text={command.message} />
          </div>
        </section>
      </main>
    );
  }

  const { case: caseRow, policy, receipt, recommendation } = snapshot;
  const archived = caseRow.archivedAt !== null;
  const view = heroFor(snapshot);
  const terms = snapshot.transition?.acceptedPurchaseTerms;
  const status = dashboardStatus(snapshot);
  const initialPayment =
    caseRow.state === "SETUP" && !(receipt.oldBilling === "ACTIVE" && receipt.oldAccessEndsAt);
  const latestQuote = freshQuote(snapshot.currentQuote);
  const currentPrice =
    latestQuote && snapshot.currentAccount && latestQuote.planId === snapshot.currentAccount.planId
      ? `${pounds(latestQuote.recurringTotal.amountMinor)} / month · last quote`
      : snapshot.currentAccount?.planId === "a_02"
        ? "Monthly price not checked"
        : "£12 / month at setup";
  const shownPrice = view.margin
    ? terms
      ? terms.offer
        ? `${pounds(terms.offer.introductoryAmount.amountMinor)} for ${terms.offer.introductoryCycles} paid months · then ${pounds(terms.recurring.amountMinor)} / month`
        : `${pounds(terms.recurring.amountMinor)} / month · agreed terms`
      : "Monthly cost not confirmed"
    : currentPrice;

  return (
    <main className="page has-nav dashboard-page">
      <div className="dashboard-heading">
        <h1>Your subscriptions</h1>
        <button className="text-button" onClick={() => go("activity")}>
          Activity <Icon name="next" />
        </button>
      </div>
      {archived && <p className="pill warning">Archived case · shown for its history</p>}
      <section className={`plan-panel ${initialPayment ? "initial-payment-panel" : ""}`} key={caseRow.id}>
        <div className="subscription-row">
          <div className="service">
            <div className={`service-mark ${view.margin ? "margin" : "current-service"}`}>
              {view.margin ? "m" : "v"}
            </div>
            <div>
              <h2>
                {view.margin
                  ? terms
                    ? planName(terms.planId)
                    : "Replacement plan"
                  : planName(snapshot.currentAccount?.planId ?? "a_01")}
              </h2>
              <p className="service-sub">{initialPayment ? "Monthly subscription" : "Your plan"}</p>
            </div>
          </div>
          {!initialPayment && <p className="subscription-price">{shownPrice}</p>}
          {initialPayment && <span className={`dashboard-status ${status.tone}`}>{status.label}</span>}
        </div>
        <div className="plan-decision">
          {!initialPayment && <span className={`dashboard-status ${status.tone}`}>{status.label}</span>}
          {initialPayment && (
            <p className="initial-payment-amount">
              <span>£12</span>
              <small>
                {snapshot.handover ? "First payment · then £12 / month" : "Due now · then £12 / month"}
              </small>
            </p>
          )}
          <h2 className="hero-title">{view.title}</h2>
          <p className="lead">{view.lead}</p>
          <div className="plan-action">
            {view.action && !archived && (
              <button
                className="button"
                disabled={command.pending}
                onClick={() =>
                  typeof view.action!.run === "string"
                    ? go(view.action!.run)
                    : command.run(view.action!.run, view.action!.done)
                }
              >
                {view.action.label}
              </button>
            )}
            <Notice text={command.message} />
          </div>
        </div>
      </section>

      {policy && (
        <details className="dashboard-preferences">
          <summary>
            Your preferences <Icon name="next" />
          </summary>
          <div className="dashboard-preference-content">
            <Row
              label="Required work"
              value={
                policy.requiredCapabilities.includes("speaker_labels")
                  ? "Earlier requirements need separate review"
                  : "Editable work"
              }
            />
            <Row
              label="New plan budget"
              value={`${pounds(policy.recurringCeiling.amountMinor)} / month, including renewal after any offer`}
            />
            <p className="note below">
              {policy.allowInvestigation
                ? "Val may check plans and prices when asked."
                : "Val won’t check plans until you allow it."}
            </p>
            {!archived && (
              <button className="text-button" onClick={() => go("preferences")}>
                Edit preferences
              </button>
            )}
          </div>
        </details>
      )}
      {recommendation?.action === "change_plan" && (
        <p className="note below">
          Upgrading through Original service is advice only. Val won’t buy or end a plan for it.
        </p>
      )}
      {receipt.oldBilling === "UNKNOWN" && caseRow.state !== "SETUP" && (
        <p className="note below">Original service’s paid period isn’t verified yet.</p>
      )}
    </main>
  );
}

type Action = { label: string; run: string | (() => Promise<unknown>); done?: string };

function heroFor(snapshot: CaseSnapshot): { title: string; lead: string; margin?: boolean; action?: Action } {
  const { case: caseRow, policy, receipt, recommendation, handover } = snapshot;
  const checks = checkedFeatures(policy?.requiredCapabilities, snapshot.currentOutput?.capabilityResults);
  const currentValid =
    !!policy &&
    recommendation?.policyRevision === policy.revision &&
    checks.complete &&
    !!snapshot.currentAccount?.planId &&
    snapshot.currentOutput?.planId === snapshot.currentAccount.planId;
  const missing = currentValid ? checks.missing.map((name) => capabilityNames[name].toLowerCase()) : [];
  const choice = supportedChoice(snapshot);

  // SETUP lasts until preferences are confirmed, including after the first payment is verified.
  const setupPaid = receipt.oldBilling === "ACTIVE" && receipt.oldAccessEndsAt !== null;
  if (caseRow.state === "SETUP" && !setupPaid) {
    if (
      handover?.status === "FAILED" ||
      handover?.paymentStatus === "FAILED" ||
      ["CANCELLED", "EXPIRED"].includes(handover?.billingStatus ?? "")
    )
      return {
        title: "Your payment needs a check.",
        lead: "Original service is not confirmed. Check the existing payment before trying again.",
        action: {
          label: "Check with PayPal",
          run: () => api.reconcile(caseRow.id),
          done: "Checking with PayPal.",
        },
      };
    if (handover?.approvalUrl)
      return {
        title: "Approve Original service with PayPal.",
        lead: "Your first Original service subscription is waiting for PayPal approval.",
        action: { label: "Continue to PayPal", run: async () => location.assign(handover.approvalUrl!) },
      };
    if (handover)
      return {
        title: "Checking your first payment.",
        lead: "Val is confirming the Original service subscription with PayPal.",
        action: {
          label: "Check with PayPal now",
          run: () => api.reconcile(caseRow.id),
          done: "Checking with PayPal.",
        },
      };
    return {
      title: "Start your Original service subscription.",
      lead: "Your monthly plan starts after you approve it in PayPal.",
      action: {
        label: "Continue to PayPal",
        run: async () => {
          const result = await api.startSetup(caseRow.id);
          if ("approvalUrl" in result) location.assign(result.approvalUrl);
        },
        done: "Checking with PayPal.",
      },
    };
  }
  if (!policy)
    return {
      title: "Tell Val what you need.",
      lead: setupPaid
        ? "Tell Val what you need and your budget. Val compares suitable plans and full costs; you approve a new subscription in PayPal."
        : "Tell Val what you need and your budget. You review any change before approving a new subscription in PayPal.",
      action: { label: "Set preferences", run: "preferences" },
    };
  if (inHandover.has(caseRow.state)) {
    const progress = handoverFacts(receipt);
    const plan = snapshot.transition
      ? planName(snapshot.transition.acceptedPurchaseTerms.planId)
      : "The new plan";
    let title = "This switch needs attention.";
    let lead =
      "A step has failed or is still open. See what needs another try; Val will reuse the existing handover.";
    if (caseRow.state === "AWAITING_PAYPAL") {
      title = `${plan} awaits PayPal approval.`;
      lead =
        receipt.oldService === "ACTIVE"
          ? "Your new payment is not verified. Original service access stays active while you decide."
          : "Your new payment is not verified. Check Original service’s access before proceeding.";
    } else if (caseRow.state === "VERIFYING_NEW") {
      title = "Checking the new plan.";
      lead = progress.paid
        ? "The first payment passed. Val is checking service readiness before ending Original service."
        : "The first payment is not verified yet. Original service’s exit must wait.";
    } else if (caseRow.state === "EXITING_OLD") {
      title = "Stopping Original service safely.";
      const access = progress.accessScheduled
        ? `Access end is scheduled for ${longDate(receipt.oldAccessEndsAt)}.`
        : progress.accessEnded
          ? "Original service access has ended."
          : "Original service access has not ended.";
      lead = progress.ready
        ? `Margin payment and service checks passed. Original service billing is ${progress.billingStopped ? "stopped" : receipt.oldBilling === "ACTIVE" ? "active" : "unconfirmed"}. ${access}`
        : "Some handover checks still need to finish. Original service’s exit is not finished.";
    }
    return {
      title,
      lead,
      margin: receipt.newSubscriptionId !== null,
      action: { label: "View switch progress", run: "recovery" },
    };
  }
  if (policy.requiredCapabilities.includes("speaker_labels") && caseRow.state !== "COMPLETE")
    return {
      title: "Earlier saved needs require review.",
      lead: "This case includes an older preference that cannot be shown safely here. No new payment or billing exit is approved on this screen.",
      action: { label: "View case status", run: "activity" },
    };
  switch (caseRow.state) {
    case "COMPLETE": {
      const progress = handoverFacts(receipt);
      if (!snapshot.transition || !progress.handoverComplete)
        return {
          title: "Some switch steps need checking.",
          lead: "Some recorded handover checks or Original service’s exit are incomplete. Nothing should be treated as finished yet.",
          margin: true,
          action: { label: "View switch progress", run: "recovery" },
        };
      const terms = snapshot.transition.acceptedPurchaseTerms;
      const access = progress.accessEnded
        ? "Original service access has ended."
        : `Original service access is scheduled to end on ${fullDate(receipt.oldAccessEndsAt)}; it has not ended yet.`;
      const billing = terms.offer
        ? `${pounds(terms.dueNow.amountMinor)} first payment verified; ${pounds(terms.recurring.amountMinor)} monthly after ${terms.offer.introductoryCycles} paid cycles.`
        : `${pounds(terms.dueNow.amountMinor)} payment verified; ${pounds(terms.recurring.amountMinor)} monthly.`;
      return {
        title: `${planName(terms.planId)} is ready. Original service billing stopped.`,
        lead: `${billing} Required features and service checks passed. ${access}`,
        margin: true,
        action: { label: "View outcome receipt", run: "recovery" },
      };
    }
    case "INVESTIGATING":
      return {
        title: "Checking fit and full costs.",
        lead: "Val checks required work, price changes and eligible paid offers. You still approve any payment or old-plan exit.",
      };
    case "STAY": {
      if (recommendation?.action !== "stay" || !currentValid || missing.length) {
        return {
          title: "Original service needs another check.",
          lead: "Val cannot show whether it meets all your saved needs. No plan was bought or ended.",
          action: policy.allowInvestigation
            ? { label: "Check again", run: () => api.check(caseRow.id, policy.revision) }
            : { label: "Edit preferences", run: "preferences" },
        };
      }
      if (
        caseRow.scenario === "value_offer" &&
        snapshot.currentAccount?.entitlementRevision === 2 &&
        snapshot.currentQuote?.comparison
      ) {
        const notice = snapshot.currentQuote.comparison;
        return {
          title: "No suitable switch was verified.",
          lead: `Original service announced ${pounds(notice.announcedRenewal.amountMinor)} from ${fullDate(notice.renewalEffectiveAt)}, not billed yet. Val found no better qualifying change within your budget; nothing was bought or ended.`,
          action: { label: "See why", run: "options" },
        };
      }
      const needs = policy.requiredCapabilities
        .map((name) => capabilityNames[name].toLowerCase())
        .join(" and ");
      return {
        title: "Original service still has what you need.",
        lead: `Val found ${needs} in its last check. No change or new payment is needed.`,
        action: { label: "Compare plans", run: "options" },
      };
    }
    case "AWAITING_CONSENT": {
      if (
        caseRow.scenario === "value_offer" &&
        currentValid &&
        !missing.length &&
        choice?.quote.comparison?.basis === "AUTHORED_NOTICE_PROJECTION"
      ) {
        const { offer, comparison } = choice.quote;
        const cost = offer
          ? `${pounds(offer.introductoryAmount.amountMinor)} for ${offer.introductoryCycles} paid months, then ${pounds(choice.quote.recurringTotal.amountMinor)}`
          : `${pounds(choice.quote.recurringTotal.amountMinor)} monthly`;
        return {
          title: "Original service announced a higher renewal.",
          lead: `${planName(choice.quote.planId)} costs ${cost}. Val projects ${pounds(comparison.candidateTotal.amountMinor)} versus ${pounds(comparison.currentTotal.amountMinor)} over 12 months if Original service’s announced ${pounds(comparison.announcedRenewal.amountMinor)} renewal starts ${fullDate(comparison.renewalEffectiveAt)}; it is not billed yet.`,
          action: { label: "Review the change", run: "options" },
        };
      }
      const oldName = planName(snapshot.currentOutput?.planId ?? snapshot.currentAccount?.planId ?? "a_01");
      if (!missing.length)
        return {
          title: "Review Val’s proposed change.",
          lead: "Val needs another fit check before you decide; nothing has been bought.",
          action: { label: "Review change", run: "options" },
        };
      const increase = choice
        ? monthlyDifference(snapshot.currentQuote, choice.quote, snapshot.currentAccount?.planId ?? null)
        : null;
      const cost = choice
        ? `Val found ${planName(choice.quote.planId)}: it keeps your features for ${pounds(choice.quote.recurringTotal.amountMinor)} a month${increase !== null && increase > 0 ? `, ${pounds(increase)} more per month` : ""}.`
        : "Val needs to recheck the replacement’s features or price before you decide.";
      return {
        title: `${oldName} no longer has ${missing.join(" and ")}.`,
        lead: `${cost} You approve any purchase.`,
        action: { label: "Review change", run: "options" },
      };
    }
    case "NEEDS_REVIEW":
      if (caseRow.reason === "advice_only")
        return {
          title: "A Original service upgrade may help.",
          lead: choice
            ? `${planName(choice.quote.planId)} kept your needs at ${pounds(choice.quote.recurringTotal.amountMinor)} a month. This is advice; Val changed nothing.`
            : "The upgrade needs another check. Val has not changed or bought a plan.",
          action: { label: "Compare plans", run: "options" },
        };
      if (caseRow.reason === "no_candidate")
        return {
          title: "No replacement is ready yet.",
          lead: "Val did not find a confirmed fit within your budget. Original service remains in place; nothing was bought or ended.",
          action: { label: "Compare plans", run: "options" },
        };
      if (caseRow.reason === "permission_required" || !policy.allowInvestigation)
        return {
          title: "Val needs permission to check.",
          lead: "Allow plan checks in Preferences. You still approve any purchase or exit.",
          action: { label: "Edit preferences", run: "preferences" },
        };
      return {
        title: "Val could not verify a choice.",
        lead: "A feature or price needs another check. Original service remains in place; nothing was bought or ended.",
        action: { label: "Check again", run: () => api.check(caseRow.id, policy.revision) },
      };
    default:
      return {
        title: "Ready when you are.",
        lead: policy.allowInvestigation
          ? "Val can check your required work, price changes and suitable paid offers. You approve any payment or exit."
          : "Allow plan checks in Preferences when you’re ready. Any purchase still needs your approval.",
        action: policy.allowInvestigation
          ? { label: "Check now", run: () => api.check(caseRow.id, policy.revision) }
          : { label: "Edit preferences", run: "preferences" },
      };
  }
}
