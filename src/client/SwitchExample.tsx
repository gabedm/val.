import { useCallback, useEffect, useRef, useState } from "react";
import type { SwitchExampleView } from "../shared/switch-example";
import { isCurrentSubscription, type SubscriptionPortfolio } from "../shared/subscriptions";
import { api } from "./api";
import { useDeployment } from "./deployment";
import { SubscriptionSwitch } from "./SubscriptionSwitch";
import { errorText, go, money } from "./ui";

const client = { subscriptionSwitch: api.exampleSubscriptionSwitch, switchAction: api.exampleSwitchAction };
export function SwitchExampleEntry() {
  const { switchExample } = useDeployment();
  const [preview, setPreview] = useState<SwitchExampleView | null>(null);
  useEffect(() => {
    if (!switchExample) return;
    const controller = new AbortController();
    void api
      .switchExample(controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setPreview(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [switchExample?.company]);
  if (!switchExample) return null;
  return (
    <section className="switch-example-entry" aria-label="Sandbox switching example">
      <div>
        <h2>{switchExample.company}</h2>
        <p>
          {preview?.sourceName
            ? `${preview.sourceName} → ${switchExample.company}`
            : "Sandbox switching example"}
        </p>
        {preview?.sourceName && <small>Sandbox{preview.phase === "completed" ? " · Complete" : ""}</small>}
      </div>
      <button className="button" onClick={() => go("switch-example")}>
        {preview?.switchId ? "View switch" : "Try switch"}
      </button>
    </section>
  );
}
export function SwitchExample({ portfolio }: { portfolio: SubscriptionPortfolio }) {
  const { switchExample } = useDeployment();
  const [item, setItem] = useState<SwitchExampleView | null>(null),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [selected, setSelected] = useState("");
  const eligible = portfolio.subscriptions.filter((row) => isCurrentSubscription(row) && row.purpose.trim());
  const starting = useRef(false),
    mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const value = await api.switchExample(signal);
      if (!signal?.aborted) {
        setItem(value);
        setError("");
      }
    } catch (issue) {
      if (!signal?.aborted) setError(errorText(issue));
    }
  }, []);
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      await load(stop.signal);
      if (!stop.signal.aborted && item?.phase === "setup") timer = setTimeout(() => void read(), 3000);
    };
    void read();
    return () => {
      stop.abort();
      clearTimeout(timer);
    };
  }, [load, item?.phase]);
  const act = async (start: boolean, serviceId = selected) => {
    if (starting.current) return;
    starting.current = true;
    setPending(true);
    setError("");
    try {
      let next = await (start
        ? api.startSwitchExample()
        : api.setupSwitchExample(serviceId, portfolio.revision));
      if (mounted.current) setItem(next);
      if (!start && next.phase === "ready") next = await api.startSwitchExample();
      if (mounted.current) setItem(next);
    } catch (issue) {
      if (mounted.current) setError(errorText(issue));
    } finally {
      starting.current = false;
      if (mounted.current) setPending(false);
    }
  };
  if (!switchExample)
    return (
      <main className="page has-nav">
        <h1>Example unavailable</h1>
        <button className="button" onClick={() => go("subscriptions")}>
          Subscriptions
        </button>
      </main>
    );
  if (item?.switchId)
    return (
      <SubscriptionSwitch
        id={item.switchId}
        client={client}
        sandboxLabel={item.company}
        onReload={() => void load()}
      />
    );
  return (
    <main className="page narrow has-nav">
      <button className="text-button" onClick={() => go("subscriptions")}>
        Back to subscriptions
      </button>
      <p className="note">PayPal Sandbox · test funds only</p>
      <h1>
        {item?.sourceName ? `${item.sourceName} → ${item.company}` : (item?.company ?? switchExample.company)}
      </h1>
      {item && (
        <section className="switch-example-summary">
          <p className="switch-example-price">
            {money(item.oldPriceMinor)} <span>→</span> {money(item.newPriceMinor)}
            <small> / month</small>
          </p>
          {item.phase !== "not_started" && <p>{item.purpose}</p>}
          <p className="note">Your own subscriptions stay unchanged.</p>
          {item.phase === "not_started" &&
            (eligible.length ? (
              <label className="switch-example-selection">
                Replace
                <select
                  aria-label="Subscription to replace"
                  value={selected}
                  disabled={pending}
                  onChange={(event) => {
                    setSelected(event.target.value);
                    if (event.target.value) void act(false, event.target.value);
                  }}
                >
                  <option value="">Choose a subscription</option>
                  {eligible.map((row) => (
                    <option key={row.serviceId} value={row.serviceId}>
                      {row.name}
                    </option>
                  ))}
                </select>
                {pending && <span role="status">Preparing your switch…</span>}
              </label>
            ) : (
              <button className="button" onClick={() => go("home")}>
                Tell Val what matters first
              </button>
            ))}
          {item.phase === "setup" && item.setupUrl && (
            <>
              <a className="button" href={item.setupUrl} target="_blank" rel="noreferrer">
                Approve {money(item.oldPriceMinor)} Sandbox setup
              </a>
              <button className="text-button below" onClick={() => void load()}>
                Check setup
              </button>
            </>
          )}
          {item.phase === "ready" && (
            <button className="button" disabled={pending} onClick={() => void act(true)}>
              Review switch
            </button>
          )}
          {item.phase === "unavailable" && <p>This example is no longer available for this session.</p>}
        </section>
      )}
      {error && <p role="alert">{error}</p>}
      {!item &&
        (error ? (
          <button className="text-button" onClick={() => void load()}>
            Try again
          </button>
        ) : (
          <p role="status">Loading…</p>
        ))}
    </main>
  );
}
