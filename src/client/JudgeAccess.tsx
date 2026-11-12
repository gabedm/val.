import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "./api";
import { SessionArrival } from "./SessionPanel";
import { capturePrivateLink, redeemPrivateLink } from "./private-link";

/** The invitation gate is independent of PayPal identity and never replaces an existing owner. */
export function JudgeAccess({ children }: { children: ReactNode }) {
  const ownerAccess = new URLSearchParams(location.search).get("access") === "owner";
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [failure, setFailure] = useState("");
  const [pending, setPending] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const busy = useRef(false);
  const load = async () => {
    setFailure("");
    try {
      const link = capturePrivateLink(location, history);
      if (!ownerAccess && link) {
        setLinkMode(true);
        try {
          const result = await redeemPrivateLink(link, api.session, api.enterPrivateLink);
          setAllowed(result.allowed);
        } catch {
          setAllowed(false);
          setFailure("This private link is unavailable or has expired. Open a current Val link.");
        }
        return;
      }
      const [access] = await Promise.all([
        ownerAccess ? api.ownerAccess() : api.judgeAccess(),
        api.session(),
      ]);
      setLinkMode(!ownerAccess && !!("privateLink" in access && access.privateLink));
      setAllowed(access.allowed);
    } catch {
      setFailure("Val couldn’t check your access. Please try again.");
    }
  };
  useEffect(() => {
    void load();
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailure("");
    const form = new FormData(event.currentTarget);
    try {
      const login = ownerAccess ? api.enterOwnerAccess : api.enterJudgeDemo;
      const access = await login(String(form.get("username")), String(form.get("password")));
      setAllowed(access.allowed);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-in failed. Please try again.");
    } finally {
      busy.current = false;
      setPending(false);
    }
  }
  if (allowed === null) return <SessionArrival failure={failure} onRetry={() => void load()} />;
  if (allowed) return children;
  if (linkMode)
    return (
      <main className="entry">
        <section className="judge-entry-card">
          <span className="entry-wordmark" aria-hidden="true">
            val.
          </span>
          <h1>Open your private Val link</h1>
          <p>{failure || "Use the full link you were given to continue. There’s no password to enter."}</p>
          {failure && (
            <button className="button" onClick={() => void load()}>
              Try again
            </button>
          )}
        </section>
      </main>
    );
  return (
    <main className="entry judge-entry">
      <section className="judge-entry-card">
        <span className="entry-wordmark" aria-hidden="true">
          val.
        </span>
        <h1>{ownerAccess ? "Owner access" : "Judge access"}</h1>
        <p>{ownerAccess ? "Your private testing access." : "Log in to try Val."}</p>
        <form onSubmit={submit} aria-busy={pending}>
          <label className="field-label" htmlFor="judge-username">
            Username
          </label>
          <input
            className="text-input"
            id="judge-username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={100}
            required
            readOnly={pending}
          />
          <label className="field-label" htmlFor="judge-password">
            Password
          </label>
          <input
            className="text-input"
            id="judge-password"
            name="password"
            type="password"
            autoComplete="current-password"
            maxLength={256}
            required
            readOnly={pending}
          />
          <button className="button below" type="submit" disabled={pending}>
            {pending ? "Logging in…" : "Log in"}
          </button>
          {failure && (
            <p className="note below" role="alert">
              {failure}
            </p>
          )}
        </form>
      </section>
    </main>
  );
}
