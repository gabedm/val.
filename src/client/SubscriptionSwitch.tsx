import { useEffect, useRef, useState } from "react";
import type { SubscriptionAdvice } from "../shared/subscriptions";
import { switchPhaseLabels, type SubscriptionSwitchView } from "../shared/subscription-switch";
import { api } from "./api";
import { useDeployment } from "./deployment";
import { errorText, go, money } from "./ui";

export function SwitchButton({
  serviceId,
  option,
  revision,
}: {
  serviceId: string;
  option: NonNullable<SubscriptionAdvice["comparisons"]>[number];
  revision: number;
}) {
  const { kernelSwitching } = useDeployment();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const starting = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  if (option.owned) return null;
  if (!kernelSwitching) {
    const destination = option.sources.find((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      } catch {
        return false;
      }
    });
    return destination ? (
      <div className="subscription-switch-action">
        <a className="button" href={destination} target="_blank" rel="noreferrer">
          View provider
        </a>
      </div>
    ) : null;
  }
  return (
    <div className="subscription-switch-action">
      <button
        className="button"
        aria-label={`Switch to ${option.name}`}
        disabled={pending}
        onClick={async () => {
          if (starting.current) return;
          starting.current = true;
          setPending(true);
          setError("");
          try {
            const result = await api.startSwitch(serviceId, option.serviceId, revision);
            if (mounted.current) go(`switch/${result.id}`);
          } catch (e) {
            if (mounted.current) setError(errorText(e));
          } finally {
            starting.current = false;
            if (mounted.current) setPending(false);
          }
        }}
      >
        {pending ? "Starting…" : "Switch"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}

export function SubscriptionSwitch({
  id,
  onReload,
  client = api,
  sandboxLabel,
}: {
  id: string;
  onReload: () => void;
  client?: Pick<typeof api, "subscriptionSwitch" | "switchAction">;
  sandboxLabel?: string;
}) {
  const [item, setItem] = useState<SubscriptionSwitchView | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [refresh, setRefresh] = useState(0);
  const observed = useRef("");
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const next = await client.subscriptionSwitch(id, controller.signal);
        if (controller.signal.aborted) return;
        setItem(next);
        setError("");
        const signature = `${next.id}:${next.newActive}:${next.oldCancelled}`;
        if (next.newActive && observed.current !== signature) {
          observed.current = signature;
          onReload();
        }
        if (!["completed", "stopped"].includes(next.phase)) timer = setTimeout(() => void read(), 2000);
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(errorText(e));
          timer = setTimeout(() => void read(), 5000);
        }
      }
    };
    void read();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [id, refresh]);
  const act = async (action: "approve" | "resume" | "stop") => {
    if (!item || pending) return;
    setPending(true);
    setError("");
    try {
      setItem(await client.switchAction(item.id, action, item.revision, item.approvalDigest ?? undefined));
      setRefresh((n) => n + 1);
      onReload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setPending(false);
    }
  };
  const terms = item?.terms;
  return (
    <main className="page narrow has-nav">
      <button className="text-button" onClick={() => go("subscriptions")}>
        Back to subscriptions
      </button>
      {sandboxLabel && <p className="note">{sandboxLabel} · PayPal Sandbox · test funds only</p>}
      <h1>{item ? switchPhaseLabels[item.phase] : "Your subscription switch"}</h1>
      {item && (
        <>
          <p>
            {item.oldName} → {item.newName}
          </p>
          <p role="status">{item.message}</p>
          {item.phase === "stopped" && item.unresolved && (
            <button className="button below" disabled={pending} onClick={() => void act("resume")}>
              Check the previous action
            </button>
          )}
          {item.newActive && (
            <p>
              <strong>{item.newName} is active.</strong>{" "}
              {item.oldCancelled
                ? "The old renewal is cancelled."
                : "The old subscription has not been confirmed cancelled yet."}
            </p>
          )}
          {terms && (
            <section className="below" aria-label="Exact purchase terms">
              <h2>
                {terms.name} · {terms.plan}
              </h2>
              <p>
                <strong>{money(terms.chargeMinor, terms.currency)} due now</strong>
              </p>
              <p>
                Renews at {money(terms.renewalMinor, terms.currency)} /{" "}
                {terms.cycle === "30_days" ? "30 days" : terms.cycle}.{" "}
                {terms.upfrontMinor > 0 ? (
                  <>{money(terms.upfrontMinor, terms.currency)} setup fee, included above.</>
                ) : (
                  "No setup fee."
                )}{" "}
                {terms.minimumTermMonths > 0
                  ? `${terms.minimumTermMonths}-month minimum term.`
                  : "No minimum term."}
              </p>
              <details>
                <summary>Provider checkout wording</summary>
                <p>{terms.quote}</p>
              </details>
            </section>
          )}
          {item.cancellation && (
            <section className="below">
              <h2>Old subscription</h2>
              <p>
                Cancellation effective {item.cancellation.effectiveOn}. Fee:{" "}
                {money(item.cancellation.feeMinor, item.cancellation.currency)}.
              </p>
              <details>
                <summary>Provider cancellation wording</summary>
                <p>{item.cancellation.quote}</p>
              </details>
            </section>
          )}
          {item.phase === "awaiting_approval" && !item.preparationOnly && (
            <section className="below">
              <p>
                {item.newActive
                  ? "Approve cancelling the old renewal on these terms."
                  : "Switch authorises the charges above. I’ll confirm the new plan is active before cancelling the old renewal."}
              </p>
              <p className="note">
                Approval expires{" "}
                {item.approvalExpiresAt && new Date(item.approvalExpiresAt).toLocaleTimeString()}.
              </p>
              <button className="button below" disabled={pending} onClick={() => void act("approve")}>
                {item.newActive ? "Approve cancellation" : "Switch"}
              </button>
              <button className="text-button below" disabled={pending} onClick={() => void act("resume")}>
                Refresh terms
              </button>
            </section>
          )}
          {item.phase === "awaiting_approval" && item.preparationOnly && (
            <section className="below">
              <p>Purchases and cancellations are disabled for this connection.</p>
              {item.handoff && (
                <a className="button" href={item.handoff.url} target="_blank" rel="noreferrer">
                  View provider checkout
                </a>
              )}
              <button className="text-button below" disabled={pending} onClick={() => void act("resume")}>
                Recheck terms
              </button>
            </section>
          )}
          {item.phase === "needs_user" && (
            <section className="below">
              {item.handoff && (
                <p>
                  <a className="button" href={item.handoff.url} target="_blank" rel="noreferrer">
                    Open {item.handoff.provider}
                  </a>
                </p>
              )}
              <button className="button" disabled={pending} onClick={() => void act("resume")}>
                Continue checking
              </button>
            </section>
          )}
          {!["completed", "stopped"].includes(item.phase) && (
            <button className="text-button below" disabled={pending} onClick={() => void act("stop")}>
              Stop this switch
            </button>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
