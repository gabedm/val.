import { useEffect, useState, type ReactNode } from "react";
import type { AsyncCommandResult } from "../shared/contracts.types";
import { ApiError, api } from "./api";
import { LoginForm, RecoveryForm, useSession } from "./SessionPanel";
import { Icon } from "./ui";

function ReturnScreen({
  title,
  attention = false,
  children,
}: {
  title: string;
  attention?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="shell">
      <header className="masthead">
        <a className="wordmark" href="/" aria-label="Val home">
          val.
        </a>
      </header>
      <main className="page narrow payment-return">
        <span className={`payment-symbol ${attention ? "needs-attention" : ""}`} aria-hidden="true">
          <Icon name={attention ? "alert" : "activity"} />
        </span>
        <h1>{title}</h1>
        <div className="return-content">{children}</div>
      </main>
    </div>
  );
}

/**
 * Landing page for PayPal's return and cancel redirects (/paypal/setup|transition/return|cancel).
 * Arriving here changes nothing: only the authenticated POST below queues a reconciliation, and
 * Val's own reads of PayPal decide what actually happened.
 */
export function ReturnBridge() {
  const [session, setSession, sessionFailure, refreshSession] = useSession();
  const [result, setResult] = useState<AsyncCommandResult | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const [, , flow, step] = location.pathname.split("/");
  const params = new URLSearchParams(location.search);
  const caseId = params.get("caseId");
  const operationId = params.get("operationId");
  const returnToken = params.get("return_token");
  const complete = (flow === "setup" || flow === "transition") && caseId && operationId && returnToken;

  useEffect(() => {
    if (!session?.authenticated || !complete) return;
    setFailure(null);
    api
      .returnFromPaypal(flow, caseId, {
        operationId,
        returnToken,
        subscriptionId: params.get("subscription_id"),
        outcome: step === "cancel" ? "cancelled" : "approved",
      })
      .then(setResult, setFailure);
  }, [session?.authenticated, session?.ownerId]);

  if (!complete)
    return (
      <ReturnScreen title="Let’s find your payment." attention>
        <p role="alert">This PayPal return link is incomplete.</p>
        <a className="button" href="/">
          Back to Val
        </a>
      </ReturnScreen>
    );
  if (!session)
    return sessionFailure ? (
      <ReturnScreen title="Reconnect to Val." attention>
        <p role="alert">{sessionFailure}</p>
        <button className="button" onClick={() => void refreshSession()}>
          Try again
        </button>
      </ReturnScreen>
    ) : (
      <ReturnScreen title="Returning to Val.">
        <p role="status">Loading your account…</p>
      </ReturnScreen>
    );
  if (!session.authenticated) {
    return (
      <ReturnScreen title="Welcome back.">
        <p>Log in to check your payment status.</p>
        <LoginForm onSession={setSession} />
      </ReturnScreen>
    );
  }
  if (failure) {
    return (
      <ReturnScreen title="Your return needs a check." attention>
        <p role="alert">{failure.message}</p>
        <p>If you began this subscription on another browser, enter its recovery code to continue.</p>
        <RecoveryForm onSession={setSession} />
      </ReturnScreen>
    );
  }
  if (!result)
    return (
      <ReturnScreen title="Checking PayPal.">
        <p role="status">Confirming your payment status…</p>
      </ReturnScreen>
    );
  return (
    <ReturnScreen title="Checking your payment.">
      <p>
        {step === "cancel" ? "You closed the PayPal approval page. " : ""}I’m confirming the subscription and
        payment with PayPal.
      </p>
      <a
        className="button"
        href={`/?case=${encodeURIComponent(caseId)}#${flow === "transition" ? "recovery" : "case"}`}
      >
        View payment status
      </a>
    </ReturnScreen>
  );
}
