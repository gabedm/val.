import { useEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import type { MonitoringStatus } from "./monitoring";
import type { ResearchOrb } from "./research-scene";
import { subscriptionPath } from "./navigation";
import { go } from "./ui";

export function MonitoringPanel({
  shown,
  status,
  onOpen,
  onStart,
  busy = false,
  orbs = [],
  renderMark,
  researching = false,
  interrupted = false,
  pauseText,
  onRetry,
  origin,
}: {
  shown: boolean;
  status: MonitoringStatus;
  onOpen: () => void;
  onStart?: () => void;
  busy?: boolean;
  orbs?: ResearchOrb[];
  renderMark?: (orb: ResearchOrb) => ReactNode;
  researching?: boolean;
  interrupted?: boolean;
  pauseText?: string | null;
  onRetry?: () => void;
  origin?: RefObject<HTMLDivElement | null>;
}) {
  const pulsing =
    researching || (!interrupted && (status.phase === "scheduled" || status.phase === "checking"));
  const panel = useRef<HTMLElement>(null);
  const wordmark = useRef<HTMLButtonElement>(null);
  const morph = useRef<HTMLDivElement>(null);
  const witnessedResearch = useRef(false);
  const [celebrating, setCelebrating] = useState(false);
  const complete =
    !researching &&
    !interrupted &&
    orbs.length > 0 &&
    orbs.every((orb) => orb.state === "ready" || orb.state === "no_match");
  const scheduled = status.phase === "scheduled" || status.phase === "checking";
  const checking = orbs.find((orb) => orb.state === "checking");
  useEffect(() => {
    if (researching) {
      if (checking) witnessedResearch.current = true;
      setCelebrating(false);
      return;
    }
    if (!complete) {
      setCelebrating(false);
      return;
    }
    if (!witnessedResearch.current) return;
    witnessedResearch.current = false;
    setCelebrating(true);
    const timer = setTimeout(() => setCelebrating(false), 2400);
    return () => clearTimeout(timer);
  }, [researching, complete, checking?.row.serviceId]);
  useEffect(() => {
    if (!shown || !orbs.length || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const target = wordmark.current?.getBoundingClientRect();
    const source = origin?.current
      ?.querySelectorAll<HTMLElement>(".chat-message.from-val")
      .item(origin.current.querySelectorAll(".chat-message.from-val").length - 1)
      ?.getBoundingClientRect();
    const element = morph.current;
    if (!target || !element || !source || source.width === 0 || source.height === 0) return;
    const parent = panel.current!.getBoundingClientRect();
    // Restored conversations may already be scrolled to their results. Launch
    // from the visible chat area rather than animating from an off-screen reply.
    const sourceTop =
      source.top >= parent.top && source.bottom <= parent.bottom
        ? source.top - parent.top
        : Math.max(0, parent.height - Math.min(source.height, 80) - 24);
    element.style.width = `${target.width}px`;
    element.style.height = `${target.height}px`;
    const animation = element.animate(
      [
        {
          transform: `translate(${source.left - parent.left}px, ${sourceTop}px) scale(${source.width / target.width}, ${source.height / target.height})`,
          opacity: 1,
          borderRadius: "24px",
        },
        {
          transform: `translate(${target.left - parent.left}px, ${target.top - parent.top}px) scale(1)`,
          opacity: 0.7,
          borderRadius: "44px",
          offset: 0.7,
        },
        {
          transform: `translate(${target.left - parent.left}px, ${target.top - parent.top}px) scale(1.08)`,
          opacity: 0,
          borderRadius: "50px",
        },
      ],
      { duration: 900, easing: "cubic-bezier(.22,1,.36,1)", fill: "both" },
    );
    return () => animation.cancel();
  }, [shown]);
  useEffect(() => {
    if (shown) panel.current?.focus({ preventScroll: true });
  }, [shown]);
  return (
    <section
      ref={panel}
      tabIndex={-1}
      className="monitoring-panel"
      aria-label={researching ? "Subscription research" : "Price-check monitoring"}
      aria-hidden={!shown}
      inert={!shown}
      data-status={status.phase}
      data-pulsing={pulsing}
      data-researching={researching}
      data-orbit={orbs.length > 0}
      data-completing={celebrating}
    >
      <div className="research-morph" ref={morph} aria-hidden="true" />
      <div className="monitoring-centre">
        {orbs.length > 0 && (
          <ol className="research-journey" aria-label="Your journey">
            <li data-state="done">
              <button type="button" onClick={onOpen}>
                <span aria-hidden="true">✓</span>Your needs
              </button>
            </li>
            <li
              data-state={!researching && (complete || scheduled) ? "done" : "current"}
              aria-current={researching || (!complete && !scheduled) ? "step" : undefined}
            >
              <button
                type="button"
                disabled={!orbs.some((orb) => orb.available)}
                onClick={() => go("subscriptions")}
              >
                <span aria-hidden="true">{!researching && (complete || scheduled) ? "✓" : "2"}</span>Compare
              </button>
            </li>
            <li
              data-state={scheduled && !researching ? "current" : "next"}
              aria-current={scheduled && !researching ? "step" : undefined}
            >
              <span>
                <span aria-hidden="true">3</span>Monitor
              </span>
            </li>
          </ol>
        )}
        <div className={`research-orbit${orbs.length > 6 ? " is-dense" : ""}`} data-count={orbs.length}>
          <button
            ref={wordmark}
            className="monitoring-wordmark"
            type="button"
            onClick={onOpen}
            aria-label="Talk to Val"
          >
            <span aria-hidden="true">val.</span>
            <svg className="research-completion" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="20" cy="20" r="18" />
              <path d="m11 20 6 6 12-13" />
            </svg>
          </button>
          {orbs.length > 0 && (
            <ul className="research-subscriptions" aria-label="Your subscription checks">
              {orbs.map((orb, index) => {
                const angle = (index / orbs.length) * Math.PI * 2 - Math.PI / 2;
                return (
                  <li
                    key={orb.row.serviceId}
                    className="research-orbit-slot"
                    style={
                      {
                        "--orb-x": Math.cos(angle),
                        "--orb-y": Math.sin(angle),
                        "--orb-order": index,
                      } as CSSProperties
                    }
                  >
                    <button
                      className="research-subscription"
                      type="button"
                      data-state={orb.state}
                      disabled={!orb.available}
                      onClick={() => go(subscriptionPath(orb.row.serviceId))}
                      aria-label={`${orb.row.name}: ${orb.label}`}
                      title={`${orb.row.name} · ${orb.label}`}
                    >
                      {renderMark ? (
                        renderMark(orb)
                      ) : (
                        <span className="portfolio-mark provider-name" aria-hidden="true">
                          {orb.row.name}
                        </span>
                      )}
                      {(orb.state === "ready" || orb.state === "no_match") && (
                        <span className="research-orb-done" aria-hidden="true">
                          ✓
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="monitoring-caption" role="status" aria-live={shown ? "polite" : "off"}>
          <h2>
            {researching
              ? "Comparing options"
              : interrupted
                ? "Your results so far"
                : orbs.length && status.phase === "unset"
                  ? complete
                    ? "Comparisons ready"
                    : "Your comparisons"
                  : status.heading}
          </h2>
          {researching && (
            <p>{checking ? `Checking ${checking.row.name}…` : "Preparing your comparisons…"}</p>
          )}
          {complete && !scheduled && <p>Choose a subscription to see what fits.</p>}
          {!researching && (pauseText || interrupted || !orbs.length || status.phase !== "unset") && (
            <p>{pauseText || (interrupted ? "Some checks need another try." : status.detail)}</p>
          )}
          {status.next && !researching && pulsing && (
            <div className="monitoring-next">
              <span>Next check</span>
              <time dateTime={status.next.at}>
                {new Date(status.next.at).toLocaleString("en-GB", {
                  weekday: "short",
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  timeZone: "Europe/London",
                })}
              </time>
              <span className="monitoring-next-provider">{status.next.name}</span>
            </div>
          )}
        </div>
        <div className="monitoring-actions">
          {onRetry && (
            <button className="button" type="button" disabled={busy} onClick={onRetry}>
              Try remaining checks
            </button>
          )}
          {onStart && !researching && !onRetry && (
            <button className="button" type="button" disabled={busy} onClick={onStart}>
              {busy ? "Starting…" : "Start weekly checks"}
            </button>
          )}
          <button
            className={orbs.length || onStart ? "text-button" : "button"}
            type="button"
            onClick={onOpen}
          >
            Open chat
          </button>
          {!orbs.length && (
            <button className="text-button" type="button" onClick={() => go("subscriptions")}>
              View alternatives
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
