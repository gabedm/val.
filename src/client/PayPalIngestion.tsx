import { useEffect, useRef, useState, type ComponentProps } from "react";
import type { PayPalWalletStatus, WalletCandidateChoice } from "../shared/paypal-wallet";
import { api } from "./api";
import { useDeployment } from "./deployment";
import { IngestionBubble } from "./IngestionBubble";
import { SubscriptionChat } from "./ValConversation";
import { errorText } from "./ui";
import { WalletPaymentReview } from "./WalletPaymentReview";

export function paypalWalletDestination(value: string) {
  const url = URL.parse(value);
  if (
    !url ||
    url.protocol !== "https:" ||
    !/^prod-[a-z0-9-]+\.kernel\.sh$/.test(url.hostname) ||
    !/^\/browser\/live\/[a-zA-Z0-9_-]{6,64}$/.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search !== "?readOnly=false" ||
    url.hash
  )
    throw new Error("The PayPal connection link could not be verified.");
  return url.href;
}

/** The conversation cannot start until its owner's complete import has committed. */
export function PayPalSubscriptionChat(props: ComponentProps<typeof SubscriptionChat>) {
  const { paypalWallet } = useDeployment();
  const [status, setStatus] = useState<PayPalWalletStatus | null>(null);
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [connecting, setConnecting] = useState(false);
  const popup = useRef<Window | null>(null);
  const sentUrl = useRef<string | null>(null);
  const mounted = useRef(false);
  const connectionRequest = useRef<AbortController | null>(null);
  const currentProps = useRef(props);
  currentProps.current = props;
  function complete(next: PayPalWalletStatus) {
    currentProps.current.onUpdate(next.portfolio);
    currentProps.current.onIngestion?.({ phase: "ready", subscriptions: next.portfolio.subscriptions });
    setReady(!next.candidates?.some((item) => !item.choice));
  }
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      connectionRequest.current?.abort();
      popup.current?.close();
      popup.current = null;
    };
  }, []);
  useEffect(() => {
    const reset = () => {
      connectionRequest.current?.abort();
      popup.current?.close();
      popup.current = null;
      setReady(false);
      setStatus(null);
      setAttempt((value) => value + 1);
    };
    window.addEventListener("val-wallet-changed", reset);
    return () => window.removeEventListener("val-wallet-changed", reset);
  }, []);
  useEffect(() => {
    if (!paypalWallet) return;
    const controller = new AbortController();
    let alive = true,
      reading = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const accept = (next: PayPalWalletStatus) => {
      if (!alive) return;
      setStatus(next);
      setFailure("");
      if (next.signInUrl && next.signInUrl !== sentUrl.current && popup.current && !popup.current.closed) {
        popup.current.location.href = paypalWalletDestination(next.signInUrl);
        sentUrl.current = next.signInUrl;
      }
      if (next.phase === "complete") {
        popup.current?.close();
        popup.current = null;
        complete(next);
        timer = setTimeout(() => void check(), 60_000);
        return;
      }
      if (next.phase === "failed") {
        currentProps.current.onIngestion?.({ phase: "failed", subscriptions: next.portfolio.subscriptions });
        return;
      }
      currentProps.current.onIngestion?.(
        next.phase === "disconnected"
          ? { phase: "ready", subscriptions: next.portfolio.subscriptions }
          : { phase: "finding", subscriptions: next.portfolio.subscriptions },
      );
      if (next.phase !== "disconnected") timer = setTimeout(() => void check(), next.pollAfterMs);
    };
    const check = async () => {
      if (!alive || reading || document.visibilityState === "hidden") return;
      reading = true;
      try {
        accept(await api.paypalWallet(controller.signal));
      } catch (error) {
        if (alive) {
          setFailure(errorText(error));
          timer = setTimeout(() => void check(), 10_000);
        }
      } finally {
        reading = false;
      }
    };
    const visible = () => {
      if (timer) clearTimeout(timer);
      if (document.visibilityState !== "hidden") void check();
    };
    document.addEventListener("visibilitychange", visible);
    void api
      .openPayPalWallet(controller.signal)
      .then(accept)
      .catch((error) => {
        if (alive) setFailure(errorText(error));
      });
    return () => {
      alive = false;
      controller.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [paypalWallet, attempt]);

  async function connect() {
    if (connecting || connectionRequest.current) return;
    const controller = new AbortController();
    connectionRequest.current = controller;
    setConnecting(true);
    setFailure("");
    let opened: Window | null = null;
    try {
      opened = window.open("about:blank", "_blank");
      if (opened) {
        opened.opener = null;
        opened.document.title = "Connect PayPal";
        opened.document.body.textContent = "Preparing your secure PayPal connection…";
      }
      popup.current = opened;
      sentUrl.current = null;
      const next = await api.connectPayPalWallet(controller.signal);
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(next);
      if (next.signInUrl && opened) {
        opened.location.href = paypalWalletDestination(next.signInUrl);
        sentUrl.current = next.signInUrl;
      }
      setAttempt((value) => value + 1);
    } catch (error) {
      opened?.close();
      if (mounted.current && !controller.signal.aborted) setFailure(errorText(error));
    } finally {
      if (connectionRequest.current === controller) connectionRequest.current = null;
      if (mounted.current) setConnecting(false);
    }
  }
  async function review(choice: WalletCandidateChoice) {
    const candidate = status?.candidates?.find((item) => !item.choice);
    if (!candidate || !status?.checkedAt || connecting || connectionRequest.current) return;
    const controller = new AbortController();
    connectionRequest.current = controller;
    setConnecting(true);
    setFailure("");
    try {
      const next = await api.reviewPayPalPayment(
        {
          key: candidate.key,
          checkedAt: status.checkedAt,
          expectedRevision: status.portfolio.revision,
          expectedReviewRevision: candidate.reviewRevision,
          choice,
        },
        controller.signal,
      );
      if (!mounted.current || controller.signal.aborted) return;
      setStatus(next);
      complete(next);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) {
        setFailure(errorText(error));
        try {
          const next = await api.paypalWallet(controller.signal);
          if (mounted.current) {
            setStatus(next);
            if (next.phase === "complete") complete(next);
            else setAttempt((value) => value + 1);
          }
        } catch {}
      }
    } finally {
      if (connectionRequest.current === controller) connectionRequest.current = null;
      if (mounted.current) setConnecting(false);
    }
  }
  if (!paypalWallet || ready) return <SubscriptionChat {...props} />;
  const needsConnection = !status || ["disconnected", "failed", "reconnect"].includes(status.phase);
  const candidate = status?.phase === "complete" ? status.candidates?.find((item) => !item.choice) : null;
  return (
    <main
      className="page narrow has-nav portfolio-chat genie-chat is-opening"
      aria-busy={connecting || !status || (!needsConnection && status.phase !== "complete")}
    >
      <header className="portfolio-chat-heading">
        <h1 className="sr-only">Val</h1>
        <span className="portfolio-saved">
          {(status?.portfolio ?? props.data.portfolio).subscriptions.length} subscriptions
        </span>
      </header>
      <div className="portfolio-opening wallet-wordmark" aria-hidden="true">
        val.
      </div>
      <div
        className="portfolio-conversation"
        role="log"
        aria-live="polite"
        aria-label="Finding PayPal subscriptions"
      >
        {status?.phase !== "complete" && <IngestionBubble label="Finding subscriptions…" message={null} />}
        {candidate && (
          <WalletPaymentReview
            candidate={candidate}
            busy={connecting}
            onChoose={(choice) => void review(choice)}
          />
        )}
        <section className="wallet-connection">
          <p role="status">{status?.message ?? "Opening your PayPal connection…"}</p>
          {(needsConnection || status?.phase === "sign_in") && (
            <>
              {status?.phase === "disconnected" && (
                <p className="wallet-privacy">
                  KERNEL stores your PayPal session until you disconnect. Val reads statements and recurring
                  payments; merchant names, billing details and usage answers go to your AI service. Whole
                  statements stay out of AI requests. Passwords stay on PayPal. No email access.{" "}
                  <a href="/privacy.html" target="_blank" rel="noopener noreferrer">
                    How your data is handled
                  </a>
                  .
                </p>
              )}
              {status?.signInUrl ? (
                <a
                  className="button"
                  href={paypalWalletDestination(status.signInUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Continue with PayPal
                </a>
              ) : (
                status && (
                  <button className="button" disabled={connecting} onClick={() => void connect()}>
                    {connecting
                      ? "Opening PayPal…"
                      : status.phase === "failed"
                        ? "Try PayPal again"
                        : "Connect PayPal"}
                  </button>
                )
              )}
              {status?.signInUrl && (
                <p className="wallet-privacy">Sign in and complete verification in the PayPal window.</p>
              )}
            </>
          )}
          {failure && (
            <p className="note" role="alert">
              {failure}
            </p>
          )}
          {failure && !status && (
            <button className="text-button" onClick={() => setAttempt((value) => value + 1)}>
              Try again
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
