import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { SessionView } from "../shared/contracts.types";
import { api } from "./api";
import { Icon } from "./ui";
import { BrandScene } from "./SubscriptionScene";
import { entryMarker, introExitDuration } from "./startup";
import { paypalSignInDestination } from "../shared/paypal-identity";
import { useDeployment } from "./deployment";

export function useSession() {
  const [session, setSession] = useState<SessionView | null>(null);
  const [failure, setFailure] = useState("");
  const refresh = useCallback(async () => {
    setFailure("");
    try {
      setSession(await api.session());
    } catch (error) {
      setFailure(errorText(error));
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return [session, setSession, failure, refresh] as const;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "Something went wrong.");

/** Shown once, right after the first login of a new browser. */
function RecoveryCodeNotice({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const [failure, setFailure] = useState("");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setFailure("");
    } catch {
      setFailure("Copy isn’t available here. Download your code instead.");
    }
  };
  const download = () => {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([`Val recovery code: ${code}\n`], { type: "text/plain" }));
    link.download = "val-recovery-code.txt";
    link.click();
    URL.revokeObjectURL(link.href);
  };
  return (
    <section className="cost-note">
      <h3>Save your recovery code</h3>
      <p className="below">Shown once. Keep it to restore your subscriptions on another browser.</p>
      <p className="below">
        <code className="recovery-code">{code}</code>
      </p>
      <p className="below">
        <button className="text-button" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy code"}
        </button>{" "}
        <button className="text-button" onClick={download}>
          Download
        </button>
      </p>
      <p className="note" role="status">
        {failure || (copied ? "Recovery code copied." : "")}
      </p>
    </section>
  );
}

export function LoginForm({
  onSession,
  onBusy,
  restoring = false,
}: {
  onSession: (session: SessionView) => void;
  onBusy?: (busy: boolean) => void;
  restoring?: boolean;
}) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [pendingSession, setPendingSession] = useState<SessionView | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    onBusy?.(pending || !!pendingSession);
  }, [pending, pendingSession, onBusy]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    const form = new FormData(event.currentTarget);
    setPending(true);
    inFlight.current = true;
    setError("");
    try {
      const result = await api.login({
        username: String(form.get("username")),
        password: String(form.get("password")),
      });
      setError("");
      if (result.newOwnerRecoveryCode && !restoring) {
        setRecoveryCode(result.newOwnerRecoveryCode);
        setPendingSession(result.session);
      } else onSession(result.session);
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (recoveryCode && pendingSession) {
    return (
      <>
        <RecoveryCodeNotice code={recoveryCode} />
        <div className="action">
          <button className="button" onClick={() => onSession(pendingSession)}>
            Continue to Val
          </button>
        </div>
      </>
    );
  }
  return (
    <form onSubmit={submit} className="form-card" aria-busy={pending}>
      <label className="field-label" htmlFor="username">
        Username
      </label>
      <input
        className="text-input"
        id="username"
        name="username"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        readOnly={pending}
        required
      />
      <label className="field-label" htmlFor="password">
        Password
      </label>
      <div className="entry-password">
        <input
          className="text-input"
          id="password"
          name="password"
          type={showPassword ? "text" : "password"}
          autoComplete="current-password"
          readOnly={pending}
          required
        />
        <button
          type="button"
          aria-label={showPassword ? "Hide password" : "Show password"}
          aria-pressed={showPassword}
          onClick={() => setShowPassword(!showPassword)}
        >
          <Eye visible={showPassword} />
        </button>
      </div>
      <button className="button below" type="submit" disabled={pending}>
        {pending ? (
          <>
            <span className="entry-spinner" aria-hidden="true" />
            Signing in…
          </>
        ) : (
          "Log in"
        )}
      </button>
      {error && (
        <p className="note below" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

export function RecoveryForm({
  onSession,
  onBusy,
}: {
  onSession: (session: SessionView) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => {
    onBusy?.(pending);
  }, [onBusy, pending]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setError("");
    setMessage("");
    setPending(true);
    try {
      onSession(await api.recover(String(new FormData(event.currentTarget).get("recoveryCode"))));
      setMessage("Your subscriptions are restored.");
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <label className="field-label" htmlFor="recovery-code">
        Recovery code
      </label>
      <input className="text-input" id="recovery-code" name="recoveryCode" autoComplete="off" required />
      <button className="button light below" type="submit" disabled={pending}>
        {pending ? "Restoring…" : "Recover my subscriptions"}
      </button>
      {message && (
        <p className="note below" role="status">
          {message}
        </p>
      )}
      {error && (
        <p className="note below" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function Eye({ visible }: { visible: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z" />
      <circle cx="12" cy="12" r="3" />
      {!visible && <path d="m3 3 18 18" />}
    </svg>
  );
}

/** Complete the opening animation even when a saved session resolves immediately. */
/** One quiet handoff while identity and the destination data load; never replay the splash. */
export function SessionArrival({ failure = "", onRetry }: { failure?: string; onRetry: () => void }) {
  return (
    <main className="session-arrival" aria-label="Opening Val" aria-busy={!failure}>
      {failure && (
        <span className="session-arrival-mark" aria-hidden="true">
          val.
        </span>
      )}
      <div className="session-arrival-status">
        {failure ? (
          <>
            <p role="alert">{failure}</p>
            <button className="button" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          <span className="chat-wait session-arrival-wait" role="status">
            <span className="chat-dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
            <span className="sr-only">Opening Val</span>
          </span>
        )}
      </div>
    </main>
  );
}

export function Launch({
  failure,
  onRetry,
  intro = false,
  exiting = false,
}: {
  failure: string;
  onRetry: () => void;
  intro?: boolean;
  exiting?: boolean;
}) {
  return (
    <main
      className={`entry entry-launch${intro ? " entry-intro" : ""}${exiting ? " entry-intro-exiting" : ""}`}
      style={{ "--intro-exit": `${introExitDuration}ms` } as React.CSSProperties}
      aria-label="Val"
    >
      <BrandScene />
      <div className="entry-launch-status">
        {failure ? (
          <>
            <p role="alert">{failure}</p>
            <button className="entry-primary" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          !intro && (
            <p role="status">
              Opening Val
              <span className="entry-loading-dots" aria-hidden="true">
                …
              </span>
            </p>
          )
        )}
      </div>
    </main>
  );
}

function PayPalMark() {
  return (
    <img className="entry-paypal-mark" src="https://www.paypalobjects.com/webstatic/icon/pp32.png" alt="" />
  );
}

/** A demo visitor gets a private session; normal identity sign-in stays on PayPal. */
export function SignIn({
  onSession,
  existingSession,
  startWithOnboarding = false,
}: {
  onSession: (session: SessionView) => void;
  existingSession?: SessionView;
  startWithOnboarding?: boolean;
}) {
  const { passwordAccess, paypalSandboxDemo, paypalSandboxDemoEntry, paypalWallet } = useDeployment();
  const demoEntry = paypalSandboxDemoEntry && new URL(location.href).searchParams.get("paypal") !== "login";
  const localPasswordAccess = passwordAccess && !paypalSandboxDemo && !paypalWallet;
  const dialog = useRef<HTMLDialogElement>(null);
  const continueButton = useRef<HTMLButtonElement>(null);
  const loginTrigger = useRef<HTMLElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [providerMessage, setProviderMessage] = useState("");
  const paypalInFlight = useRef(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (closeTimer.current) clearTimeout(closeTimer.current);
    },
    [],
  );
  // Open only after React has rendered the selected panel at its final size.
  useLayoutEffect(() => {
    if (!dialogOpen) return;
    dialog.current?.showModal();
    dialog.current?.querySelector<HTMLElement>("h2")?.focus({ preventScroll: true });
  }, [dialogOpen]);
  useEffect(() => {
    if (!dialog.current?.open) return;
    const target =
      dialog.current.querySelector<HTMLElement>("input") ?? dialog.current.querySelector<HTMLElement>("h2");
    target?.focus({ preventScroll: true });
  }, [dialogOpen]);
  useEffect(() => {
    const url = new URL(location.href);
    const reason = url.searchParams.get("login");
    if (!reason) return;
    setProviderMessage(
      reason === "cancelled"
        ? "PayPal sign-in cancelled. Try again."
        : reason === "expired"
          ? "Sign-in link expired. Try again."
          : "PayPal sign-in couldn’t finish. Try again.",
    );
    url.searchParams.delete("login");
    history.replaceState(null, "", url);
  }, []);
  const open = () => {
    loginTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProviderMessage("");
    setClosing(false);
    setDialogOpen(true);
  };
  const paypal = async () => {
    if (paypalInFlight.current || busy) return;
    paypalInFlight.current = true;
    setBusy(true);
    setProviderMessage("");
    try {
      if (existingSession?.authenticated) onSession(await api.logout());
      if (demoEntry) {
        const session = await api.paypalDemoLogin();
        entryMarker("val-login-pending", "1");
        entryMarker("val-entry-next", startWithOnboarding ? "onboarding" : null);
        onSession(session);
        return;
      }
      const result = await api.paypalLogin();
      const destination = paypalSignInDestination(result);
      entryMarker("val-login-pending", "1");
      entryMarker("val-entry-next", startWithOnboarding ? "onboarding" : null);
      location.assign(destination.href);
    } catch (error) {
      entryMarker("val-login-pending", null);
      setProviderMessage(errorText(error));
      paypalInFlight.current = false;
      setBusy(false);
    }
  };
  const close = () => {
    if (busy || closing) return;
    setClosing(true);
    const finish = () => {
      dialog.current?.close();
      setDialogOpen(false);
      setClosing(false);
      (loginTrigger.current ?? continueButton.current)?.focus({ preventScroll: true });
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) finish();
    else closeTimer.current = setTimeout(finish, 180);
  };
  return (
    <main className="entry">
      <header className="entry-header">
        <span className="entry-wordmark" aria-label="Val">
          val.
        </span>
      </header>
      <div className="entry-welcome">
        <div className="entry-message">
          <h1>
            Make your
            <br />
            subscriptions
            <br />
            <span>
              work for <em className="entry-you">you</em>.
            </span>
          </h1>
          <div className="entry-actions">
            <button
              className="entry-provider entry-provider-paypal"
              ref={continueButton}
              disabled={busy}
              onClick={() => void paypal()}
            >
              <PayPalMark />
              {busy ? (demoEntry ? "Opening Val…" : "Opening PayPal…") : "Continue with PayPal"}
            </button>
            {localPasswordAccess && (
              <p>
                <button className="entry-link" disabled={busy} onClick={open}>
                  Sign in
                </button>
              </p>
            )}
            {providerMessage && (
              <p className="entry-provider-message" role="alert">
                {providerMessage}
              </p>
            )}
          </div>
        </div>
        <BrandScene settled variant="welcome" />
      </div>
      {localPasswordAccess && (
        <dialog
          className={`entry-dialog ${closing ? "entry-dialog-closing" : ""}`}
          ref={dialog}
          aria-labelledby="entry-dialog-title"
          onCancel={(event) => {
            event.preventDefault();
            close();
          }}
          onClick={(event) => {
            if (event.target === dialog.current) {
              const bounds = dialog.current.getBoundingClientRect();
              if (
                event.clientX < bounds.left ||
                event.clientY < bounds.top ||
                event.clientX > bounds.right ||
                event.clientY > bounds.bottom
              )
                close();
            }
          }}
        >
          <div className="entry-sheet-top">
            <button
              className="entry-icon-button"
              aria-label="Back to welcome"
              disabled={busy || closing}
              onClick={close}
            >
              <Icon name="arrow" />
            </button>
            <span className="entry-wordmark" aria-hidden="true">
              val.
            </span>
          </div>
          <div className="entry-panel">
            <div className="entry-sheet-heading">
              <h2 id="entry-dialog-title" tabIndex={-1}>
                Sign in
              </h2>
            </div>
            <LoginForm onSession={onSession} onBusy={setBusy} />
          </div>
        </dialog>
      )}
    </main>
  );
}
