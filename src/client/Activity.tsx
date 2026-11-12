import { useEffect, useState, type ReactNode } from "react";
import type {
  PayPalWalletStatus,
  PayPalWalletCandidate,
  WalletCandidateChoice,
} from "../shared/paypal-wallet";
import type { CaseSnapshot, CaseSummary, SessionView } from "../shared/contracts.types";
import type { SubscriptionPortfolio } from "../shared/subscriptions";
import { api } from "./api";
import { RecoveryForm } from "./SessionPanel";
import { useDeployment } from "./deployment";
import { WalletPaymentReview } from "./WalletPaymentReview";
import {
  Icon,
  Notice,
  errorText,
  fullDate,
  go,
  handoverFacts,
  longDate,
  planName,
  pounds,
  useCommand,
} from "./ui";

const stateWords: Record<CaseSummary["state"], [string, string]> = {
  SETUP: ["Original service setup", "Check payment and set preferences"],
  MONITORING: ["Original service", "Ready for a price and fit check"],
  INVESTIGATING: ["Checking full value", "Price and required work · nothing bought"],
  STAY: ["Original service still fits", "Last check: no replacement needed"],
  NEEDS_REVIEW: ["Original service needs a look", "No plan bought or ended"],
  AWAITING_CONSENT: ["Plan change to review", "Your approval is needed · nothing bought"],
  AWAITING_PAYPAL: ["Waiting for PayPal", "New payment is not verified yet"],
  VERIFYING_NEW: ["Checking the new plan", "Checking payment and service readiness"],
  EXITING_OLD: ["Finishing Original service exit", "Check billing and access"],
  COMPLETE: ["Switch recorded", "Open for payment, features and access status"],
  ATTENTION_REQUIRED: ["Switch needs attention", "Open for the failed or paused step"],
};
const handoverStates = new Set([
  "AWAITING_PAYPAL",
  "VERIFYING_NEW",
  "EXITING_OLD",
  "ATTENTION_REQUIRED",
  "COMPLETE",
]);

/** Setup placeholders are not activity. Retain every started review and payment handover, including archived ones. */
export function Activity({
  cases,
  selected,
  snapshot,
  onOpen,
  embedded = false,
}: {
  cases: CaseSummary[] | null;
  selected: string | null;
  snapshot: CaseSnapshot | null;
  onOpen: (caseId: string, to?: string) => void;
  embedded?: boolean;
}) {
  const Container = embedded ? "section" : "main";
  const started = cases?.filter((item) => item.state !== "SETUP");
  const groups = [
    { title: "Current reviews", rows: started?.filter((item) => !item.archivedAt) ?? [] },
    { title: "Previous reviews", rows: started?.filter((item) => item.archivedAt) ?? [] },
  ];
  return (
    <Container
      className={
        embedded
          ? "activity-page account-activity"
          : "page has-nav activity-page dashboard-page account-activity"
      }
    >
      {embedded ? <h2>Previous payment workflows</h2> : <h1>Your activity</h1>}
      <p className="lead">Follow your saved payment workflows.</p>
      {cases === null && (
        <p className="note account-empty" role="status">
          Loading your activity…
        </p>
      )}
      {started?.length === 0 && (
        <section className="account-empty">
          <span className="settings-icon" aria-hidden="true">
            <Icon name="activity" />
          </span>
          <h2>No activity yet.</h2>
          <p>Your subscription changes will appear here.</p>
          <button className="button light" onClick={() => go("subscriptions")}>
            View subscriptions
          </button>
        </section>
      )}
      {groups
        .filter((group) => group.rows.length > 0)
        .map((group) => (
          <section className="activity-section" key={group.title} aria-label={group.title}>
            <h2>{group.title}</h2>
            <div className="activity-list">
              {group.rows.map((item) => {
                let [title, note] = stateWords[item.state];
                const current =
                  item.id === selected && snapshot?.case.id === item.id && snapshot.case.state === item.state
                    ? snapshot
                    : null;
                if (
                  current &&
                  item.state === "SETUP" &&
                  current.receipt.oldBilling === "ACTIVE" &&
                  current.receipt.oldAccessEndsAt
                )
                  note = "Payment verified · set your preferences";
                if (current && item.state === "AWAITING_PAYPAL" && handoverFacts(current.receipt).paid)
                  note = "New payment passed · service checks still to finish";
                if (current && item.state === "VERIFYING_NEW") {
                  const progress = handoverFacts(current.receipt);
                  if (!progress.paid) note = "Payment not verified · Original service exit must wait";
                  else if (progress.output && progress.history)
                    note = "Payment and service checks passed · Original service exit pending";
                  else if (progress.output) note = "Payment and features passed · completing handover checks";
                  else note = "Payment passed · checking service readiness";
                }
                if (current && item.state === "EXITING_OLD") {
                  const progress = handoverFacts(current.receipt);
                  if (!progress.ready) note = "Some handover checks still need to finish";
                  else if (!progress.billingStopped)
                    note = "New plan ready · Original service billing still active";
                  else if (progress.accessEnded) note = "Original service billing stopped · access ended";
                  else if (progress.accessScheduled)
                    note = `Original service billing stopped · exit scheduled ${longDate(current.receipt.oldAccessEndsAt)}`;
                  else note = "Original service billing stopped · access still needs checking";
                }
                if (current && item.state === "COMPLETE") {
                  const progress = handoverFacts(current.receipt);
                  if (current.transition && progress.handoverComplete) {
                    title = `${planName(current.transition.acceptedPurchaseTerms.planId)} ready`;
                    const first = pounds(current.transition.acceptedPurchaseTerms.dueNow.amountMinor);
                    note = progress.accessEnded
                      ? `${first} paid · Original service billing and access ended`
                      : `${first} paid · Original service billing stopped; access end scheduled ${fullDate(current.receipt.oldAccessEndsAt)}`;
                  } else {
                    title = "Switch needs review";
                    note = "Some handover or exit checks are incomplete";
                  }
                }
                return (
                  <button
                    key={item.id}
                    className={`activity-row ${item.id === selected ? "selected" : ""}`}
                    aria-current={item.id === selected ? "true" : undefined}
                    onClick={() => onOpen(item.id, handoverStates.has(item.state) ? "recovery" : "case")}
                  >
                    <span className="activity-mark" aria-hidden="true">
                      <Icon
                        name={
                          current?.transition && handoverFacts(current.receipt).handoverComplete
                            ? "check"
                            : "file"
                        }
                      />
                    </span>
                    <span className="activity-copy">
                      <strong>{title}</strong>
                      <span className="note">
                        {note}
                        {item.archivedAt ? " · archived" : ""}
                      </span>
                    </span>
                    <span className="activity-date">
                      <span className="note">
                        {new Date(item.createdAt).toLocaleDateString("en-GB", {
                          day: "numeric",
                          month: "short",
                        })}
                      </span>
                      <Icon name="next" />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ))}
    </Container>
  );
}

function SettingButton({
  icon,
  title,
  note,
  onClick,
  disabled = false,
}: {
  icon: ReactNode;
  title: string;
  note?: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="settings-row" onClick={onClick} disabled={disabled}>
      <span className="settings-icon" aria-hidden="true">
        {icon}
      </span>
      <span className="settings-copy">
        <strong>{title}</strong>
        {note && <small>{note}</small>}
      </span>
      <Icon name="next" />
    </button>
  );
}

function PayPalConnectionSetting({
  onPortfolio,
}: {
  onPortfolio?: (portfolio: SubscriptionPortfolio) => void;
}) {
  const [status, setStatus] = useState<PayPalWalletStatus | null>(null);
  const [failure, setFailure] = useState("");
  const [removing, setRemoving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let alive = true,
      timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      void api
        .paypalWallet(controller.signal)
        .then((next) => {
          if (!alive) return;
          setStatus(next);
          if (next.phase === "disconnecting") timer = setTimeout(load, 2000);
        })
        .catch((error) => {
          if (alive) setFailure(errorText(error));
        });
    load();
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [removing]);
  const disconnect = async () => {
    setRemoving(true);
    setFailure("");
    try {
      setStatus(await api.disconnectPayPalWallet());
      window.dispatchEvent(new Event("val-wallet-changed"));
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setRemoving(false);
    }
  };
  const review = async (candidate: PayPalWalletCandidate, choice: WalletCandidateChoice) => {
    if (!status?.checkedAt || reviewing || removing) return;
    setReviewing(true);
    setFailure("");
    try {
      const next = await api.reviewPayPalPayment({
        key: candidate.key,
        checkedAt: status.checkedAt,
        expectedRevision: status.portfolio.revision,
        expectedReviewRevision: candidate.reviewRevision,
        choice,
      });
      setStatus(next);
      onPortfolio?.(next.portfolio);
      window.dispatchEvent(new Event("val-wallet-changed"));
    } catch (error) {
      setFailure(errorText(error));
      try {
        const next = await api.paypalWallet();
        setStatus(next);
        onPortfolio?.(next.portfolio);
      } catch {}
    } finally {
      setReviewing(false);
    }
  };
  return (
    <div className="settings-expanded">
      <p>
        {status?.phase === "disconnected"
          ? "Disconnected. Your saved subscriptions and needs remain."
          : "Disconnecting deletes your saved KERNEL session. Your needs and payment choices remain."}
      </p>
      {status && status.phase !== "disconnected" && (
        <button
          className="text-button"
          disabled={removing || reviewing || status.phase === "disconnecting"}
          onClick={() => void disconnect()}
        >
          {removing || status.phase === "disconnecting" ? "Disconnecting PayPal…" : "Disconnect PayPal"}
        </button>
      )}
      {status?.phase === "disconnected" && (
        <button className="text-button" onClick={() => go("home")}>
          Connect PayPal
        </button>
      )}
      <Notice text={failure} />
      {status?.phase === "complete" &&
        status.candidates?.map((candidate) => (
          <WalletPaymentReview
            key={candidate.key}
            candidate={candidate}
            busy={reviewing || removing}
            onChoose={(choice) => void review(candidate, choice)}
          />
        ))}
    </div>
  );
}

export function Account({
  session,
  onSession,
  onPortfolio,
}: {
  session: SessionView;
  onSession: (session: SessionView) => void;
  onPortfolio?: (portfolio: SubscriptionPortfolio) => void;
}) {
  const { passwordAccess, financialTools, paypalWallet, paypalSandboxDemo } = useDeployment();
  const command = useCommand(async () => {});
  return (
    <main className="page narrow has-nav account-page">
      <h1>Your account</h1>
      <section className="settings-section" aria-labelledby="account-settings">
        <h2 id="account-settings">Connection and access</h2>
        <div className="settings-group">
          {paypalSandboxDemo && !paypalWallet && (
            <div className="account-connection-status">
              <Icon name="shield" />
              <div>
                <strong>PayPal</strong>
                <p>Connected</p>
              </div>
            </div>
          )}
          {paypalWallet && (
            <details className="settings-disclosure">
              <summary>
                <span className="settings-icon" aria-hidden="true">
                  <Icon name="shield" />
                </span>
                <span className="settings-copy">
                  <strong>PayPal connection</strong>
                </span>
                <Icon name="next" />
              </summary>
              <PayPalConnectionSetting onPortfolio={onPortfolio} />
            </details>
          )}
          {passwordAccess && !paypalWallet && !paypalSandboxDemo && (
            <details className="settings-disclosure">
              <summary>
                <span className="settings-icon" aria-hidden="true">
                  <Icon name="shield" />
                </span>
                <span className="settings-copy">
                  <strong>Restore on this browser</strong>
                  <small>Use your recovery code</small>
                </span>
                <Icon name="next" />
              </summary>
              <div className="settings-expanded">
                <RecoveryForm onSession={onSession} />
              </div>
            </details>
          )}
          <SettingButton
            icon={<Icon name="arrow" />}
            title="Log out"
            onClick={() => void command.run(async () => onSession(await api.logout()))}
            disabled={command.pending}
          />
        </div>
      </section>
      <section className="settings-section" aria-labelledby="privacy-settings">
        <h2 id="privacy-settings">Privacy</h2>
        <div className="settings-group">
          <a
            className="settings-row account-privacy-link"
            href="/privacy.html"
            target="_blank"
            rel="noopener noreferrer"
          >
            <span className="settings-icon" aria-hidden="true">
              <Icon name="shield" />
            </span>
            <span className="settings-copy">
              <strong>Privacy and data</strong>
            </span>
            <Icon name="next" />
          </a>
        </div>
      </section>
      {session.role === "admin" && financialTools && (
        <section className="settings-section">
          <h2>Workspace</h2>
          <div className="settings-group">
            <SettingButton icon={<Icon name="shield" />} title="Review tools" onClick={() => go("tools")} />
          </div>
        </section>
      )}
      <Notice text={command.message} />
    </main>
  );
}
