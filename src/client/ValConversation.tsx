import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent } from "react";
import type {
  SubscriptionAdvice,
  SubscriptionEntry,
  SubscriptionPortfolio,
  SubscriptionReviewBatch,
  ValChatReply,
  ValChatCommand,
  ValChatRequest,
} from "../shared/subscriptions";
import { billingCycleLabel, portfolioLimit, reviewPauseMessage } from "../shared/subscriptions";
import { api, ApiError } from "./api";
import { SwitchButton } from "./SubscriptionSwitch";
import type { PortfolioData } from "./Subscriptions";
import { errorText, go, Icon, money, pounds } from "./ui";
import {
  reviewCompletionMessage,
  conversationHistory,
  historyWithReviewQuestions,
  restoreReviewFindings,
  setupComplete,
} from "./onboarding-review";
import { IngestionBubble } from "./IngestionBubble";
import { recoverAIRateLimit, recoverBusyRead } from "./ai-recovery";
import type { PortfolioIngestion } from "./portfolio-progress";
import { cadenceLabel, type PriceCheckSchedule } from "../shared/price-checks";
import { useDeployment } from "./deployment";
import { SearchAttributions } from "./SearchAttributions";
import { useConversationWork } from "./use-conversation-work";
import type { ConversationTask } from "./conversation-work";
import { subscriptionReadiness } from "../shared/subscription-workflow";
import { comparisonOutcome } from "../shared/subscription-insights";
import {
  recoverCommittedWrite,
  memoryWriteMatches,
  memoryAlreadySaved,
  scheduleWriteMatches,
} from "./confirmed-write";
import { MonitoringPanel } from "./MonitoringPanel";
import { researchOrbs, researchSceneVisible } from "./research-scene";
import { monitoringStatus, newPayPalSubscriptions, paymentImportOnly } from "./monitoring";
import type { ChatIntent } from "./navigation";
import {
  conversationProposal,
  proposalMatchesPortfolio,
  type ConversationProposal,
} from "./conversation-proposal";

type Turn = { from: "you" | "val"; text: string; searchAttributions?: string[]; context?: "confirmation" };
type Request = { message: string | null; history: Turn[]; id?: string; command?: ValChatCommand };
type FailedAction =
  | { kind: "restore" }
  | { kind: "chat"; request: Request; opening: boolean }
  | { kind: "memory" }
  | { kind: "schedule" }
  | { kind: "comparison" }
  | { kind: "findings"; serviceIds: string[]; researchQuery?: string };

export function ChatReplyProgress({ delayed = false }: { delayed?: boolean }) {
  return (
    <div className="chat-message from-val val-typing" role="status">
      <span className="chat-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className={delayed ? "reply-progress-copy" : "sr-only"}>
        {delayed ? "I’m still working on your reply…" : "Val is replying"}
      </span>
    </div>
  );
}

function PendingReply() {
  const [delayed, setDelayed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setDelayed(true), 5_000);
    return () => clearTimeout(timer);
  }, []);
  return <ChatReplyProgress delayed={delayed} />;
}

export function ResearchProgress({
  waiting,
  progress,
}: {
  waiting: boolean;
  progress: { name: string; checked: number; total: number } | null;
}) {
  return (
    <div className="portfolio-work" role="status">
      <span className="chat-dots" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span className="portfolio-work-copy">
        {waiting
          ? "Taking a short pause, then continuing…"
          : progress
            ? `Checking ${progress.name}…`
            : "Checking provider offers…"}
      </span>
    </div>
  );
}
export function comparisonSaving(
  value: NonNullable<SubscriptionAdvice["comparisons"]>[number],
  historical = false,
) {
  const text = value.owned
    ? "No additional subscription cost"
    : value.savingAnnualMinor === null
      ? "GBP cost and savings unverified; payment conversion and fees apply"
      : `${value.priceEstimated ? "Estimated" : "Potential"} ${pounds(value.savingAnnualMinor)} less over 12 months`;
  return historical ? `At this check: ${text}` : text;
}

export function ValueComparison({
  advice,
  data,
  onRefresh,
  pending,
  historicalCheckedAt,
  serviceId,
  showNeeds = true,
  showSwitch = false,
  showCheckedAt = true,
}: {
  advice: SubscriptionAdvice;
  data: PortfolioData;
  onRefresh: () => void;
  pending: boolean;
  historicalCheckedAt?: string;
  serviceId?: string;
  showNeeds?: boolean;
  showSwitch?: boolean;
  showCheckedAt?: boolean;
}) {
  const checkedAt = historicalCheckedAt ?? advice.discovery?.checkedAt;
  const historical = !!historicalCheckedAt || (!!checkedAt && Date.parse(checkedAt) < Date.now() - 900_000);
  const outcome = comparisonOutcome(advice);
  const purpose =
    advice.basedOn?.purpose ??
    data.portfolio.subscriptions.find((row) => row.serviceId === serviceId)?.purpose;
  return (
    <section className="portfolio-advice" aria-label="Your value comparison">
      {showNeeds && purpose && (
        <div className="portfolio-remembered-need">
          <strong>Your needs</strong>
          <p>{purpose}</p>
        </div>
      )}
      {historical && (
        <p className="note">
          {showCheckedAt && (
            <>
              Previous check ·{" "}
              {new Date(checkedAt!).toLocaleDateString("en-GB", { timeZone: "Europe/London" })}.{" "}
            </>
          )}
          Prices may have changed.
        </p>
      )}
      {outcome !== "alternatives" && (
        <p>
          {outcome === "incomplete"
            ? "This check is incomplete. A cheaper match may still exist."
            : advice.summary}
        </p>
      )}
      {outcome === "alternatives" && !!advice.discovery?.coverage?.incomplete.length && (
        <p className="note">Based on the providers checked so far.</p>
      )}
      {advice.discovery?.status === "fallback" && (
        <p className="note">Couldn’t refresh prices. Showing saved comparisons.</p>
      )}
      {advice.options.map((option) => {
        const value = advice.comparisons?.find((row) => row.serviceId === option.serviceId);
        const service = data.catalogue.catalogue.services.find((row) => row.id === option.serviceId);
        const name = value?.name ?? service?.service;
        if (!name) return null;
        const thirtyDays = value?.priceUnit === "30_days";
        const prepaid = value?.priceUnit === "prepaid" ? value.prepaid : undefined;
        const period = thirtyDays
          ? "30 days"
          : value?.priceUnit === "year"
            ? "year"
            : value?.priceUnit === "prepaid"
              ? "prepaid term"
              : "month";
        const currency = value?.currency ?? "GBP";
        const price = (amount: number) =>
          currency === "GBP"
            ? pounds(amount)
            : new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "code" }).format(
                amount / 100,
              );
        return (
          <article className="portfolio-value-option" key={option.serviceId}>
            <div className="portfolio-value-heading">
              <SubscriptionMark
                row={{ serviceId: value?.logoServiceId ?? service?.id ?? option.serviceId, name }}
                data={data}
              />
              <span>
                <strong>{name}</strong>
                <small>{value?.plan}</small>
              </span>
              {value && (
                <strong className="portfolio-value-price">
                  {historical && !value.owned && (
                    <small className="portfolio-value-price-label">Recorded price</small>
                  )}
                  {value.owned ? (
                    "Already yours"
                  ) : (
                    <>
                      {value.priceEstimated ? "≈ " : ""}
                      {price(value.priceMinor)}
                      <small>
                        {prepaid ? `for the first ${prepaid.initialMonths} months` : `/ ${period}`}
                      </small>
                    </>
                  )}
                </strong>
              )}
              {showSwitch && value && serviceId && (
                <SwitchButton serviceId={serviceId} option={value} revision={data.portfolio.revision} />
              )}
            </div>
            {prepaid && !value?.owned && (
              <p className="note">
                Paid upfront. Then {price(value!.renewalMinor!)} every {prepaid.renewalMonths} months.
              </p>
            )}
            {!value?.owned && typeof value?.upfrontMinor === "number" && value.upfrontMinor > 0 && (
              <p className="note">Additional {price(value.upfrontMinor)} setup fee.</p>
            )}
            {!!value?.introductoryCycles && !value.owned && (
              <p className="note">
                First {value.introductoryCycles} payments, then {price(value.renewalMinor!)} / {period}
              </p>
            )}
            {!!value?.minimumTermMonths && !value.owned && (
              <p className="note">{value.minimumTermMonths}-month minimum term</p>
            )}
            {!value?.owned &&
              value?.scheduledChanges?.map((change) => (
                <p className="note" key={change.on}>
                  From{" "}
                  {new Date(`${change.on}T00:00:00Z`).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                    timeZone: "Europe/London",
                  })}
                  : {price(change.priceMinor)} / {period}
                </p>
              ))}
            {value?.fit === "conditional" && (
              <p className="portfolio-fit-note">
                <strong>Conditional fit</strong>
                {value.fitCondition && <span>{value.fitCondition}</span>}
              </p>
            )}
            {value && <p className="portfolio-value-saving">{comparisonSaving(value, historical)}</p>}
            <p>{option.reason}</p>
            {value && (
              <>
                <details>
                  <summary>Details</summary>
                  {value.owned ? (
                    <p>
                      Your existing {value.name} bill continues. Savings depend on ending the subscription you
                      no longer need.
                    </p>
                  ) : value.annualMinor > 0 ? (
                    <p>
                      12-month cost: {price(value.annualMinor)}
                      {thirtyDays ? " · 13 payments" : ""}
                      {currency !== "GBP" ? " · not a GBP comparison" : ""}.
                    </p>
                  ) : null}
                  {value.feesKnown === false && <p>Some fees are still unconfirmed.</p>}
                  {value.priceEstimated && value.priceQuote && <p>{value.priceQuote}</p>}
                  {value.highlights
                    ?.filter((condition) => condition !== value.fitCondition)
                    .slice(0, 3)
                    .map((condition, index) => (
                      <p key={index}>{condition}</p>
                    ))}
                  {value.sources.map((url, index) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {index ? "Provider terms and features" : "Provider details"}
                      <Icon name="next" />
                    </a>
                  ))}
                </details>
              </>
            )}
          </article>
        );
      })}
      {(!!advice.uncertainties.length || advice.options.length > 0) && (
        <details className="comparison-notes">
          <summary>What to check</summary>
          {outcome === "alternatives" && <p className="note">{advice.summary}</p>}
          {advice.uncertainties.map((text, index) => (
            <p className="note" key={index}>
              {text}
            </p>
          ))}
          {advice.options.length > 0 && (
            <p className="note">Exit costs and overlapping bills can change the saving.</p>
          )}
        </details>
      )}
      {(advice.comparisons?.some((value) => !!value.priceQuote) ||
        ["live", "cached"].includes(advice.discovery?.status ?? "")) && (
        <p className="note">
          AI-read prices, not independently verified. Confirm provider terms before switching.
        </p>
      )}
      {checkedAt && (
        <div className="portfolio-search-again">
          {showCheckedAt && (
            <span className="note">
              Checked · {new Date(checkedAt).toLocaleDateString("en-GB", { timeZone: "Europe/London" })}
            </span>
          )}
          <button className="text-button" disabled={pending} onClick={onRefresh}>
            {historical ? "Refresh prices" : "Search again"}
          </button>
        </div>
      )}
    </section>
  );
}
export function SubscriptionMark({
  row,
}: {
  row: Pick<SubscriptionEntry, "serviceId" | "name" | "productServiceId" | "paypalProduct">;
  data: PortfolioData;
}) {
  return (
    <span className="portfolio-mark provider-name" aria-hidden="true">
      {row.name}
    </span>
  );
}

/** Subscription circles emerge from the wordmark, then travel gently around it. */
function PortfolioScene({
  data,
  subscriptions,
}: {
  data: PortfolioData;
  subscriptions: SubscriptionEntry[];
}) {
  const rows = subscriptions.slice(0, 9);
  // Stable slots keep existing bubbles on their path when another subscription is saved.
  const slots = [1 / 9, 4 / 9, 7 / 9, 0, 3 / 9, 6 / 9, 2 / 9, 5 / 9, 8 / 9];
  return (
    <div className="portfolio-scene" aria-hidden="true">
      <span className="portfolio-scene-wordmark">val.</span>
      {rows.map((row, index) => {
        const slot = slots[index]!;
        const angle = slot * Math.PI * 2;
        return (
          <span
            className="portfolio-orbit"
            key={row.serviceId}
            style={
              {
                "--orbit-start": `${slot * 100}%`,
                "--orb-delay": "0ms",
                "--pop-x": Math.cos(angle) * 0.36,
                "--pop-y": Math.sin(angle) * 0.42,
              } as CSSProperties
            }
          >
            <span className="portfolio-orb">
              <SubscriptionMark row={row} data={data} />
            </span>
          </span>
        );
      })}
    </div>
  );
}

function subscriptionConversation(
  row: SubscriptionEntry,
  intent: ChatIntent | undefined,
  revisit: readonly string[],
) {
  if (intent === "needs") return `I’d like to update what you remember about how I use ${row.name}.`;
  if (intent === "monitoring")
    return `I’d like to review the price-check schedule for my ${row.name} subscription.`;
  return row.purpose && !revisit.includes(row.serviceId)
    ? `Find better value for my ${row.name} subscription using my saved needs.`
    : `I’d like to talk about what I use ${row.name} for.`;
}

export function SubscriptionChat({
  data,
  onUpdate,
  initialServiceId,
  initialIntent,
  active = true,
  freshStart = false,
  remainingPurposeIds,
  onMemoryConfirmed,
  onIngestion,
  onSetupComplete,
}: {
  data: PortfolioData;
  onUpdate: (portfolio: SubscriptionPortfolio) => void;
  initialServiceId?: string;
  initialIntent?: ChatIntent;
  active?: boolean;
  freshStart?: boolean;
  remainingPurposeIds?: string[];
  onMemoryConfirmed?: (serviceId: string) => void;
  onIngestion?: (progress: PortfolioIngestion) => void;
  onSetupComplete?: () => void;
}) {
  const { paypalWallet } = useDeployment();
  const revisitServiceIds = useRef<string[]>(
    freshStart ? (remainingPurposeIds ?? data.portfolio.subscriptions.map((row) => row.serviceId)) : [],
  );
  const activeServiceId = useRef<string | null>(initialServiceId ?? null);
  const requestedContext = useRef(`${initialServiceId ?? ""}:${initialIntent ?? ""}`);
  const [queuedContext, setQueuedContext] = useState<{ serviceId: string; intent?: ChatIntent } | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const openingTurn = turns[0]?.from === "val" ? turns[0] : null;
  const turnOffset = openingTurn ? 1 : 0;
  const [answer, setAnswer] = useState("");
  const [proposal, setProposal] = useState<ConversationProposal | null>(null);
  const redundantMemory =
    proposal?.kind === "memory" &&
    !revisitServiceIds.current.includes(proposal.draft.serviceId) &&
    memoryAlreadySaved(proposal, data.portfolio);
  const draft = proposal?.kind === "memory" && !redundantMemory ? proposal.draft : null;
  useEffect(() => {
    if (!redundantMemory || proposal?.kind !== "memory") return;
    if (activeServiceId.current === proposal.draft.serviceId) activeServiceId.current = null;
    setProposal(null);
  }, [redundantMemory, proposal]);
  const scheduleDraft = proposal?.kind === "schedule" ? proposal.draft : null;
  const [schedules, setSchedules] = useState<PriceCheckSchedule[]>([]);
  const [scheduleFailure, setScheduleFailure] = useState("");
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let running = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const read = async () => {
      if (cancelled || running || document.visibilityState === "hidden") return;
      running = true;
      try {
        const result = await api.priceChecks(controller.signal);
        if (!cancelled) {
          setSchedules(result.schedules);
          setScheduleFailure("");
        }
      } catch {
        if (!cancelled)
          setScheduleFailure("Checking schedules couldn’t be loaded. Your saved needs are safe.");
      } finally {
        running = false;
        if (!cancelled) timer = setTimeout(() => void read(), 60_000);
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void read();
    };
    void read();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [active, data.portfolio.revision]);
  const { work, state: workState } = useConversationWork();
  const pending = workState.phase !== "idle";
  const searching =
    workState.phase === "research" || (workState.phase === "waiting" && workState.resume === "research");
  const waitingRate = workState.phase === "waiting";
  const reviewing = workState.phase !== "idle" && workState.operation === "setup";
  const comparisonService = useRef<string | null>(null);
  const researchQueries = useRef(new Map<string, string>());
  const [introduced, setIntroduced] = useState(false);
  const [greeting, setGreeting] = useState<ValChatReply | null>(null);
  const [ingestingRows, setIngestingRows] = useState<SubscriptionEntry[]>([]);
  const [revealedCount, setRevealedCount] = useState(0);
  const [advice, setAdvice] = useState<SubscriptionAdvice | null>(null);
  const [findings, setFindings] = useState<
    { row: SubscriptionEntry; advice: SubscriptionAdvice; historicalCheckedAt?: string }[]
  >([]);
  const [reviewPause, setReviewPause] = useState<string | null>(null);
  const [reviewProgress, setReviewProgress] = useState<{
    name: string;
    checked: number;
    total: number;
  } | null>(null);
  const [reviewFailure, setReviewFailure] = useState(false);
  const [reviewBatch, setReviewBatch] = useState<SubscriptionReviewBatch | null>(null);
  const reviewedRevision = useRef<number | null>(null);
  const [failure, setFailure] = useState("");
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);
  const alive = useRef(true);
  const isActive = useRef(active);
  isActive.current = active;
  const started = useRef(false);
  const latestData = useRef(data);
  latestData.current = data;
  const log = useRef<HTMLDivElement>(null);
  const currentReply = useRef<HTMLDivElement>(null);
  const currentComparison = useRef<HTMLDivElement>(null);
  const focusOutput = useRef<"reply" | "comparison">("reply");
  const followOutput = useRef(true);
  const input = useRef<HTMLTextAreaElement>(null);
  const knownSubscriptions = useRef(new Set(data.portfolio.subscriptions.map((row) => row.serviceId)));
  const previousPortfolio = useRef(data.portfolio);
  const newSubscriptions = useRef<string[]>([]);
  const [newPaymentIds, setNewPaymentIds] = useState<string[]>([]);
  const lastInteraction = useRef(0);
  const returnFocus = useRef(false);
  const [monitoring, setMonitoring] = useState(false);
  const [manualConversation, setManualConversation] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const readiness = subscriptionReadiness(data.portfolio, revisitServiceIds.current);
  const monitorStatus = monitoringStatus(data.portfolio, schedules, !!scheduleFailure);
  const resultsReady =
    readiness.researchableServiceIds.length > 0 &&
    readiness.researchableServiceIds.every((id) =>
      findings.some(
        // Finishing a check and verifying a price are separate states. Source
        // gaps remain in the result; committed schedules govern monitoring.
        (finding) => finding.row.serviceId === id,
      ),
    );
  const settingMonitoring = monitoring && workState.phase !== "idle" && workState.operation === "schedule";
  const monitoringInterrupted = !researchSceneVisible({
    selected: true,
    introduced,
    ready: readiness.phase === "ready",
    specificService: !!initialServiceId,
    pending,
    operation: workState.phase === "idle" ? undefined : workState.operation,
    proposal: !!proposal,
    failure: !!failure,
    reviewFailure,
  });
  const showingMonitoring = monitoring && !monitoringInterrupted;
  const canReturnToMonitoring =
    !monitoringInterrupted && (resultsReady || reviewing || reviewFailure || !!reviewPause);
  const orbs = researchOrbs(data.portfolio, findings, reviewBatch, reviewing, reviewFailure || !!reviewPause);
  const canSettle =
    active &&
    pageVisible &&
    canReturnToMonitoring &&
    !manualConversation &&
    !composerFocused &&
    !detailsOpen &&
    !answer.trim();

  function openConversation() {
    setMonitoring(false);
    setManualConversation(true);
    returnFocus.current = true;
  }
  useEffect(() => {
    const visible = () => {
      lastInteraction.current = Date.now();
      setPageVisible(document.visibilityState !== "hidden");
    };
    visible();
    document.addEventListener("visibilitychange", visible);
    return () => document.removeEventListener("visibilitychange", visible);
  }, []);
  useEffect(() => {
    if (monitoringInterrupted) setMonitoring(false);
  }, [monitoringInterrupted]);
  useEffect(() => {
    if (pending) setComposerFocused(false);
  }, [pending]);
  useEffect(() => {
    const port = log.current;
    if (!port) return;
    const read = () => setDetailsOpen(!!port.querySelector("details[open]"));
    read();
    port.addEventListener("toggle", read, true);
    return () => port.removeEventListener("toggle", read, true);
  }, [introduced]);
  useEffect(() => {
    if (!canSettle || showingMonitoring) return;
    let timer: ReturnType<typeof setTimeout>;
    const settle = () => {
      const remaining = 1200 - (Date.now() - lastInteraction.current);
      if (remaining > 0) timer = setTimeout(settle, remaining);
      else setMonitoring(true);
    };
    timer = setTimeout(settle, 1200);
    return () => clearTimeout(timer);
  }, [canSettle, showingMonitoring, data.portfolio.revision]);
  useEffect(() => {
    if (returnFocus.current && !showingMonitoring && introduced && !pending && active) {
      returnFocus.current = false;
      input.current?.focus({ preventScroll: true });
    }
  }, [showingMonitoring, introduced, pending, active]);
  useEffect(() => {
    const key = `${initialServiceId ?? ""}:${initialIntent ?? ""}`;
    if (requestedContext.current === key) return;
    requestedContext.current = key;
    setQueuedContext(initialServiceId ? { serviceId: initialServiceId, intent: initialIntent } : null);
  }, [initialServiceId, initialIntent]);
  useEffect(() => {
    if (!queuedContext || !introduced || !active || pending || work.busy || proposal || answer.trim()) return;
    const selected = data.portfolio.subscriptions.find((row) => row.serviceId === queuedContext.serviceId);
    setQueuedContext(null);
    if (!selected) return;
    activeServiceId.current = selected.serviceId;
    setMonitoring(false);
    setManualConversation(true);
    returnFocus.current = true;
    void perform(
      {
        message: subscriptionConversation(selected, queuedContext.intent, revisitServiceIds.current),
        history: conversationHistory(turns),
      },
      true,
    );
  }, [queuedContext, introduced, active, pending, proposal, answer, data.portfolio.revision]);
  useEffect(() => {
    const added = newPayPalSubscriptions(knownSubscriptions.current, data.portfolio);
    knownSubscriptions.current = new Set(data.portfolio.subscriptions.map((row) => row.serviceId));
    const previous = previousPortfolio.current;
    previousPortfolio.current = data.portfolio;
    if (introduced && added.length) {
      if (monitoring && active) returnFocus.current = true;
      newSubscriptions.current.push(...added.map((row) => row.serviceId));
      setNewPaymentIds((ids) => [...new Set([...ids, ...added.map((row) => row.serviceId)])]);
      if (paymentImportOnly(previous, data.portfolio))
        setProposal((current) =>
          current?.revision === previous.revision
            ? { ...current, revision: data.portfolio.revision }
            : current,
        );
      setMonitoring(false);
      setManualConversation(false);
    }
    setNewPaymentIds((ids) => {
      const remaining = ids.filter((id) => readiness.pendingServiceIds.includes(id));
      return remaining.length === ids.length ? ids : remaining;
    });
    if (!active || !introduced || pending || work.busy || proposal || answer.trim() || initialServiceId)
      return;
    newSubscriptions.current = newSubscriptions.current.filter((id) =>
      readiness.pendingServiceIds.includes(id),
    );
    const next = newSubscriptions.current.shift();
    if (!next || activeServiceId.current === next) return;
    activeServiceId.current = next;
    // The existing agent chooses the question from the new product and retained needs.
    void perform({ message: null, history: conversationHistory(turns) }, false);
  }, [data.portfolio.revision, introduced, active, pending, proposal, answer, initialServiceId]);
  useEffect(() => {
    if (!reviewPause || pending || !active) return;
    if (reviewedRevision.current !== data.portfolio.revision) {
      setReviewPause(null);
      return;
    }
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const batch = await api.reviewBatch(data.portfolio.revision, controller.signal);
        if (controller.signal.aborted) return;
        if (batch.status !== "paused") {
          void finishSetup(latestData.current.portfolio, true);
          return;
        }
      } catch {
        if (controller.signal.aborted) return;
      }
      timer = setTimeout(poll, 5000);
    };
    timer = setTimeout(poll, 5000);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [reviewPause, pending, active, data.portfolio.revision]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      started.current = false;
    };
  }, []);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void restoreConversation();
  }, []);
  useEffect(() => {
    if (introduced || revealedCount >= ingestingRows.length) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setRevealedCount(ingestingRows.length);
      return;
    }
    const timer = setTimeout(
      () =>
        setRevealedCount((count) =>
          count >= 9 ? ingestingRows.length : Math.min(count + 1, ingestingRows.length),
        ),
      650,
    );
    return () => clearTimeout(timer);
  }, [ingestingRows, revealedCount, introduced]);
  useEffect(() => {
    if (!greeting || revealedCount < greeting.portfolio.subscriptions.length) return;
    const reveal = () => {
      setTurns([{ from: "val", text: greeting.message, searchAttributions: greeting.searchAttributions }]);
      setProposal(conversationProposal(greeting));
      setIntroduced(true);
    };
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      reveal();
      return;
    }
    const timer = setTimeout(reveal, 800);
    return () => clearTimeout(timer);
  }, [greeting, revealedCount]);
  useEffect(() => {
    if (
      introduced &&
      !initialServiceId &&
      !work.busy &&
      setupComplete(data.portfolio, revisitServiceIds.current)
    )
      void finishSetup(data.portfolio);
  }, [introduced, data.portfolio.revision, pending]);
  useEffect(() => {
    setAdvice(null);
    setFindings([]);
    setReviewFailure(false);
    setReviewBatch(null);
  }, [data.portfolio.revision]);
  useLayoutEffect(() => {
    const port = log.current;
    if (!port || !introduced || !active || !followOutput.current) return;
    const frame = requestAnimationFrame(() => {
      const reply =
        focusOutput.current === "comparison" && (advice || findings.length)
          ? currentComparison.current
          : currentReply.current;
      const top =
        turns.length <= 1 && !findings.length
          ? 0
          : reply
            ? Math.min(
                port.scrollHeight - port.clientHeight,
                port.scrollTop + reply.getBoundingClientRect().top - port.getBoundingClientRect().top - 8,
              )
            : port.scrollHeight - port.clientHeight;
      port.scrollTo({
        top: Math.max(0, top),
        behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [turns, pending, draft, advice, findings, introduced, active]);

  async function finishSetup(portfolio: SubscriptionPortfolio, retry = false) {
    const sameRevision = reviewedRevision.current === portfolio.revision;
    if (!setupComplete(portfolio, revisitServiceIds.current) || (sameRevision && !retry)) return;
    const task = work.begin("setup");
    if (!task) return;
    setManualConversation(false);
    setMonitoring(true);
    setTurns((previous) =>
      previous.at(-1)?.text === "I’ll compare your options."
        ? previous
        : [...previous, { from: "val", text: "I’ll compare your options." }],
    );
    focusOutput.current = "comparison";
    onSetupComplete?.();
    reviewedRevision.current = portfolio.revision;
    setReviewProgress(null);
    setReviewPause(null);
    setReviewFailure(false);
    setFailure("");
    setFailedAction(null);
    if (!sameRevision) {
      setAdvice(null);
      setFindings([]);
    }
    const current = () => task.current() && latestData.current.portfolio.revision === portfolio.revision;
    try {
      const saved = new Map(
        (await api.subscriptionReviews(portfolio.revision, task.signal)).reviews.map((row) => [
          row.serviceId,
          row,
        ]),
      );
      if (!current()) return;
      const restored = restoreReviewFindings(portfolio, saved);
      setFindings(restored);
      let conclusions = restored.map((finding) => finding.advice);
      const needsChecks = subscriptionReadiness(portfolio).researchableServiceIds.some(
        (id) => !saved.has(id),
      );
      let batch = await api.startReviewBatch(portfolio.revision, retry);
      let received = -1;
      while (current()) {
        if (batch.status === "superseded") throw new Error("Your subscriptions changed. Reload to continue.");
        setReviewBatch(batch);
        const row = portfolio.subscriptions.find((item) => item.serviceId === batch.currentServiceId);
        setReviewPause(batch.status === "paused" ? reviewPauseMessage(batch) : null);
        setReviewProgress(
          batch.status === "paused"
            ? null
            : {
                name: row?.name ?? "your subscriptions",
                checked: batch.completed.length,
                total: batch.serviceIds.length,
              },
        );
        if (received !== batch.completed.length) {
          const results = new Map(
            (await api.subscriptionReviews(portfolio.revision, task.signal)).reviews.map((item) => [
              item.serviceId,
              item,
            ]),
          );
          if (!current()) return;
          const findings = restoreReviewFindings(portfolio, results);
          setFindings(findings);
          conclusions = findings.map((item) => item.advice);
          received = batch.completed.length;
        }
        if (["complete", "failed"].includes(batch.status)) break;
        if (batch.status === "paused") return;
        await new Promise((resolve) => setTimeout(resolve, 2500));
        if (!current()) return;
        batch = await api.reviewBatch(portfolio.revision, task.signal);
      }
      const result = {
        failed: [
          ...new Set([
            ...batch.failed,
            ...batch.serviceIds.filter((id) => {
              const finding = conclusions.find((item) => item.basedOn?.serviceId === id);
              return !finding || comparisonOutcome(finding) === "incomplete";
            }),
          ]),
        ],
      };
      if (!current()) return;
      setReviewFailure(result.failed.length > 0);
      const missingCost = subscriptionReadiness(portfolio).unknownCostServiceIds.length > 0;
      const text = result.failed.length
        ? result.failed.length === batch.serviceIds.length
          ? "These checks couldn’t finish. I can try them again."
          : "A few checks couldn’t finish. I can try those again."
        : missingCost
          ? "Add the remaining costs whenever you’re ready, and I’ll check those too."
          : reviewCompletionMessage(
              conclusions,
              !needsChecks && [...saved.values()].some((row) => row.historical),
              retry,
            );
      if (text)
        setTurns((previous) =>
          previous.at(-1)?.from === "val" && previous.at(-1)?.text === text
            ? previous
            : [...previous, { from: "val", text }],
        );
    } catch (error) {
      if (current()) {
        setFailure(errorText(error));
        setReviewFailure(true);
      }
    } finally {
      if (task.current()) setReviewProgress(null);
      task.finish();
    }
  }

  async function restoreConversation() {
    const task = work.begin("restore");
    if (!task) return;
    setFailure("");
    setFailedAction(null);
    try {
      const saved = await api.latestChatRequest(task.signal);
      if (!task.current()) return;
      const pending = saved && ["queued", "running"].includes(saved.status);
      if (saved && saved.status !== "superseded" && (pending || !initialServiceId)) {
        const command = saved.command;
        setTurns([
          ...command.history,
          ...(command.message ? [{ from: "you" as const, text: command.message }] : []),
        ]);
        activeServiceId.current = command.activeServiceId ?? saved.reply?.activeServiceId ?? null;
        if (initialServiceId && initialServiceId !== activeServiceId.current)
          setQueuedContext({ serviceId: initialServiceId, intent: initialIntent });
        if (command.message !== null) {
          setIntroduced(true);
          setIngestingRows(data.portfolio.subscriptions);
          setRevealedCount(data.portfolio.subscriptions.length);
          onIngestion?.({ phase: "ready", subscriptions: data.portfolio.subscriptions });
        }
        task.finish();
        void perform(
          { message: command.message, history: command.history, id: saved.id, command },
          false,
          command.message === null,
          saved,
        );
        return;
      }
      // Accepted research restores independently of a new model opening.
      if (!initialServiceId && setupComplete(data.portfolio, revisitServiceIds.current)) {
        onIngestion?.({ phase: "ready", subscriptions: data.portfolio.subscriptions });
        setIngestingRows(data.portfolio.subscriptions);
        setRevealedCount(data.portfolio.subscriptions.length);
        setIntroduced(true);
        return;
      }
      const selected = data.portfolio.subscriptions.find((row) => row.serviceId === initialServiceId);
      task.finish();
      void perform(
        {
          message: selected
            ? subscriptionConversation(selected, initialIntent, revisitServiceIds.current)
            : null,
          history: [],
        },
        false,
        true,
      );
    } catch (error) {
      if (task.current()) {
        setFailure(errorText(error));
        setFailedAction({ kind: "restore" });
      }
    } finally {
      task.finish();
    }
  }

  async function perform(request: Request, appendUser = true, opening = false, resuming?: ValChatRequest) {
    const task = work.begin("chat");
    if (!task) return;
    followOutput.current = true;
    setFailure("");
    setFailedAction(null);
    setAdvice(null);
    setProposal(null);
    request = {
      ...request,
      id: request.id ?? crypto.randomUUID(),
      command: request.command ?? {
        message: request.message,
        history: request.history.map(({ from, text }) => ({ from, text })),
        expectedRevision: latestData.current.portfolio.revision,
        revisitServiceIds: [...revisitServiceIds.current],
        activeServiceId: activeServiceId.current,
      },
    };
    let retry: FailedAction = { kind: "chat", request, opening };
    if (appendUser && request.message)
      setTurns((previous) => [...previous, { from: "you", text: request.message! }]);
    let received: SubscriptionEntry[] = [];
    const ingestion = opening && request.message === null;
    try {
      if (ingestion) {
        setIngestingRows([]);
        setRevealedCount(0);
        setGreeting(null);
        onIngestion?.({ phase: "finding", subscriptions: [] });
      }
      const progress = (event: import("../shared/subscriptions").SubscriptionIngestionProgress) => {
        if (!task.current() || !ingestion) return;
        if (event.type === "subscription") {
          received = received.some((row) => row.serviceId === event.subscription.serviceId)
            ? received.map((row) =>
                row.serviceId === event.subscription.serviceId ? event.subscription : row,
              )
            : [...received, event.subscription];
          setIngestingRows(received);
          onIngestion?.({ phase: "finding", subscriptions: received });
        }
      };
      const result = await recoverBusyRead(
        () =>
          recoverAIRateLimit(
            () =>
              resuming
                ? api.resumeChatRequest(request.id!, task.signal, progress)
                : api.durableValChat(request.id!, request.command!, task.signal, progress),
            task.signal,
            task.waiting,
          ),
        task.signal,
        task.waiting,
      );
      if (!task.current()) return;
      if (result.portfolio.revision < latestData.current.portfolio.revision)
        throw new Error("Your subscriptions changed. Please review them before continuing.");
      const proposed = conversationProposal(result);
      activeServiceId.current = result.activeServiceId ?? null;
      latestData.current = { ...latestData.current, portfolio: result.portfolio };
      onUpdate(result.portfolio);
      if (opening) {
        if (freshStart) {
          const oldIds = new Set(data.portfolio.subscriptions.map((row) => row.serviceId));
          revisitServiceIds.current = result.portfolio.subscriptions
            .filter((row) => revisitServiceIds.current.includes(row.serviceId) || !oldIds.has(row.serviceId))
            .map((row) => row.serviceId);
        }
        onIngestion?.({ phase: "ready", subscriptions: result.portfolio.subscriptions });
        setIngestingRows(result.portfolio.subscriptions);
        if (!ingestion) setRevealedCount(result.portfolio.subscriptions.length);
        setGreeting(result);
      } else {
        focusOutput.current = "reply";
        setTurns((previous) => [
          ...previous,
          { from: "val", text: result.message, searchAttributions: result.searchAttributions },
        ]);
        setProposal(proposed);
      }
      const targets = result.compareServiceIds ?? (result.compareServiceId ? [result.compareServiceId] : []);
      const restoredReviews = resuming
        ? (await api.subscriptionReviews(result.portfolio.revision, task.signal)).reviews
        : [];
      if (targets.length > 1)
        setFindings((previous) => previous.filter((item) => !targets.includes(item.row.serviceId)));
      for (const [index, id] of targets.entries()) {
        retry =
          targets.length === 1
            ? { kind: "comparison" }
            : {
                kind: "findings",
                serviceIds: targets.slice(index),
                researchQuery: request.message ?? undefined,
              };
        const restoredReview = restoredReviews.find(
          (row) => row.serviceId === id && Date.parse(row.checkedAt) >= Date.parse(resuming!.createdAt),
        );
        const compared =
          restoredReview?.advice ??
          (await compare(
            task,
            id,
            result.portfolio.revision,
            !!request.message,
            request.message ?? undefined,
          ));
        if (!task.current()) return;
        if (targets.length === 1) setAdvice(compared);
        else {
          const row = result.portfolio.subscriptions.find((row) => row.serviceId === id);
          if (row)
            setFindings((previous) => [
              ...previous.filter((item) => item.row.serviceId !== id),
              { row, advice: compared },
            ]);
        }
      }
    } catch (error) {
      if (task.current()) {
        if (error instanceof ApiError && error.completedChatRequest) {
          request.id = undefined;
          request.command = undefined;
        }
        setFailure(errorText(error));
        setFailedAction(retry);
        if (ingestion) onIngestion?.({ phase: "failed", subscriptions: received });
      }
    } finally {
      const owned = task.current();
      task.finish();
      if (owned && !opening && isActive.current)
        requestAnimationFrame(() => {
          if (!work.busy && isActive.current) input.current?.focus({ preventScroll: true });
        });
    }
  }
  async function compare(
    task: ConversationTask,
    serviceId: string,
    revision: number,
    fresh = false,
    researchQuery?: string,
  ) {
    comparisonService.current = serviceId;
    task.research();
    if (researchQuery) researchQueries.current.set(serviceId, researchQuery);
    const result = await recoverBusyRead(
      () =>
        recoverAIRateLimit(
          () => api.subscriptionAdvice(serviceId, revision, fresh, researchQuery, task.signal),
          task.signal,
          task.waiting,
        ),
      task.signal,
      task.waiting,
    );
    task.signal.throwIfAborted();
    if (latestData.current.portfolio.revision !== revision)
      throw new Error("Your subscriptions changed. Please review them before checking prices again.");
    if (task.current()) focusOutput.current = "comparison";
    return result;
  }
  function acceptProposal(kind: ConversationProposal["kind"]) {
    if (!proposal || proposal.kind !== kind) return null;
    if (proposalMatchesPortfolio(proposal, latestData.current.portfolio.revision)) return proposal;
    setProposal(null);
    setFailedAction(null);
    setFailure(
      "Your subscriptions changed since that proposal. Tell me your current needs and I’ll review them again.",
    );
    return null;
  }
  async function startMonitoring() {
    if (work.busy || schedules.length) return;
    const task = work.begin("schedule");
    if (!task) return;
    const portfolio = latestData.current.portfolio;
    const ids = subscriptionReadiness(portfolio).researchableServiceIds;
    const draft = {
      serviceIds: ids,
      cadence: { every: 1, unit: "week" as const },
      expectedRevisions: Object.fromEntries(ids.map((id) => [id, 0])),
    };
    try {
      const result = await recoverCommittedWrite(
        () => api.savePriceChecks(draft, portfolio.revision),
        () => api.priceChecks(),
        (value) =>
          ids.every((id) =>
            value.schedules.some(
              (item) =>
                item.serviceId === id &&
                item.cadence?.every === 1 &&
                item.cadence.unit === "week" &&
                item.status === "scheduled",
            ),
          ),
      );
      if (!task.current()) return;
      setSchedules(result.schedules);
      setScheduleFailure("");
      setManualConversation(false);
      setMonitoring(true);
    } catch (error) {
      if (task.current()) setFailure(errorText(error));
    } finally {
      task.finish();
    }
  }
  async function confirmSchedule() {
    if (work.busy) return;
    const proposed = acceptProposal("schedule");
    if (!proposed || proposed.kind !== "schedule") return;
    const scheduleDraft = proposed.draft;
    const task = work.begin("schedule");
    if (!task) return;
    setFailure("");
    setFailedAction(null);
    try {
      const result = await recoverCommittedWrite(
        () => api.savePriceChecks(scheduleDraft, proposed.revision),
        () => api.priceChecks(),
        (value) => scheduleWriteMatches(proposed, value.schedules),
      );
      if (!task.current()) return;
      setSchedules(result.schedules);
      setManualConversation(false);
      setScheduleFailure("");
      setProposal(null);
      const selected = latestData.current.portfolio.subscriptions
        .filter((row) => scheduleDraft.serviceIds.includes(row.serviceId))
        .map((row) => row.name)
        .join(", ");
      setTurns((previous) => [
        ...previous,
        {
          from: "val",
          text: scheduleDraft.cadence
            ? `Price checks are set for ${selected}: ${cadenceLabel(scheduleDraft.cadence).toLowerCase()}. I’ll use your saved needs each time; results will appear here.`
            : `Recurring price checks are paused for ${selected}.`,
        },
      ]);
    } catch (error) {
      if (task.current()) {
        setFailure(errorText(error));
        setFailedAction({ kind: "schedule" });
      }
    } finally {
      task.finish();
    }
  }
  async function refreshComparison() {
    if (!comparisonService.current) return;
    const task = work.begin("comparison");
    if (!task) return;
    setFailure("");
    setFailedAction(null);
    try {
      const result = await compare(
        task,
        comparisonService.current,
        latestData.current.portfolio.revision,
        true,
        researchQueries.current.get(comparisonService.current),
      );
      if (task.current()) setAdvice(result);
    } catch (error) {
      if (task.current()) {
        setFailure(errorText(error));
        setFailedAction({ kind: "comparison" });
      }
    } finally {
      task.finish();
    }
  }
  async function refreshFindings(serviceIds: string[], researchQuery?: string) {
    const task = work.begin("findings");
    if (!task) return;
    setFailure("");
    setFailedAction(null);
    let remaining = serviceIds;
    try {
      const revision = latestData.current.portfolio.revision;
      for (const [index, serviceId] of serviceIds.entries()) {
        remaining = serviceIds.slice(index);
        const result = await compare(
          task,
          serviceId,
          revision,
          true,
          researchQueries.current.get(serviceId) ?? researchQuery,
        );
        if (!task.current() || latestData.current.portfolio.revision !== revision) return;
        const row = latestData.current.portfolio.subscriptions.find((item) => item.serviceId === serviceId);
        if (row)
          setFindings((previous) =>
            previous.some((finding) => finding.row.serviceId === serviceId)
              ? previous.map((finding) =>
                  finding.row.serviceId === serviceId ? { row, advice: result } : finding,
                )
              : [...previous, { row, advice: result }],
          );
      }
    } catch (error) {
      if (task.current()) {
        setFailure(errorText(error));
        setFailedAction({ kind: "findings", serviceIds: remaining, researchQuery });
      }
    } finally {
      task.finish();
    }
  }
  function send(event: FormEvent) {
    event.preventDefault();
    if (!answer.trim() || work.busy || !introduced) return;
    const message = answer.trim();
    setAnswer("");
    const selected = data.portfolio.subscriptions.find((row) => row.serviceId === comparisonService.current);
    const questions = advice && selected ? [{ row: selected, advice }] : findings;
    void perform({ message, history: historyWithReviewQuestions(turns, questions) });
  }
  async function save() {
    if (work.busy) return;
    const proposed = acceptProposal("memory");
    if (!proposed || proposed.kind !== "memory") return;
    const draft = proposed.draft;
    const task = work.begin("memory");
    if (!task) return;
    setFailure("");
    setFailedAction(null);
    const rows = data.portfolio.subscriptions;
    const next = rows.some((row) => row.serviceId === draft.serviceId)
      ? rows.map((row) => (row.serviceId === draft.serviceId ? draft : row))
      : [...rows, draft];
    try {
      const portfolio = await recoverCommittedWrite(
        () =>
          api.saveSubscriptions({
            expectedRevision: proposed.revision,
            startResearch: setupComplete(
              { ...data.portfolio, subscriptions: next },
              revisitServiceIds.current.filter((id) => id !== draft.serviceId),
            ),
            subscriptions: next.map(({ serviceId, amountMinor, cycle, purpose }) => ({
              serviceId,
              amountMinor,
              cycle,
              purpose,
            })),
          }),
        () => api.subscriptions(),
        (value) => memoryWriteMatches(proposed, value),
      );
      if (!task.current()) return;
      if (portfolio.revision < latestData.current.portfolio.revision)
        throw new Error("Your subscriptions changed after saving. Reload to see your current needs.");
      revisitServiceIds.current = revisitServiceIds.current.filter((id) => id !== draft.serviceId);
      onMemoryConfirmed?.(draft.serviceId);
      activeServiceId.current = null;
      onUpdate(portfolio);
      setProposal(null);
      const remembered: Turn[] = [
        ...turns,
        { from: "you", text: `Remember this for ${draft.name}.`, context: "confirmation" },
        { from: "val", text: `I’ll remember that for ${draft.name}.`, context: "confirmation" },
      ];
      setTurns(remembered);
      // Pass the newly saved memory into the next genuine agent turn.
      task.finish();
      latestData.current = { ...data, portfolio };
      if (setupComplete(portfolio, revisitServiceIds.current)) await finishSetup(portfolio);
      else
        await perform(
          {
            message: "What else do you need to know about my subscriptions?",
            history: conversationHistory(remembered),
          },
          false,
        );
    } catch (error) {
      if (task.current()) {
        setFailure(errorText(error));
        setFailedAction({ kind: "memory" });
      }
    } finally {
      task.finish();
    }
  }
  async function retryFailedAction() {
    if (!failedAction || work.busy) return;
    switch (failedAction.kind) {
      case "restore":
        void restoreConversation();
        break;
      case "chat": {
        // Ingestion can save bills before the reply fails. Retry against their current revision.
        const task = work.begin("restore");
        if (!task) return;
        let restored = false;
        setFailure("");
        try {
          const portfolio = await api.subscriptions(task.signal);
          if (!task.current()) return;
          latestData.current = { ...latestData.current, portfolio };
          revisitServiceIds.current = revisitServiceIds.current.filter((id) =>
            portfolio.subscriptions.some((row) => row.serviceId === id),
          );
          if (!portfolio.subscriptions.some((row) => row.serviceId === activeServiceId.current))
            activeServiceId.current = null;
          onUpdate(portfolio);
          restored = true;
        } catch (error) {
          if (task.current()) setFailure(errorText(error));
          return;
        } finally {
          task.finish();
        }
        if (!restored || !alive.current) return;
        void perform(failedAction.request, false, failedAction.opening);
        break;
      }
      case "memory":
        void save();
        break;
      case "schedule":
        void confirmSchedule();
        break;
      case "comparison":
        void refreshComparison();
        break;
      case "findings":
        void refreshFindings(failedAction.serviceIds, failedAction.researchQuery);
        break;
    }
  }
  const compact =
    !!initialServiceId ||
    newPaymentIds.length > 0 ||
    turns.some((turn) => turn.from === "you") ||
    reviewing ||
    !!advice ||
    findings.length > 0;
  const subscriptionCount = data.portfolio.subscriptions.length;
  const visibleCount = introduced ? subscriptionCount : revealedCount;
  const sceneRows = introduced ? data.portfolio.subscriptions : ingestingRows.slice(0, revealedCount);
  const researchBusy = introduced && pending && !failure && (searching || reviewing || waitingRate);
  return (
    <main
      className={`page narrow has-nav portfolio-chat genie-chat ${compact ? "has-conversation" : "is-opening"}${showingMonitoring ? " is-monitoring" : ""}`}
      data-view={showingMonitoring ? "monitoring" : "conversation"}
    >
      <header className="portfolio-chat-heading">
        <h1 className="sr-only">Val</h1>
        {canReturnToMonitoring && !showingMonitoring && (
          <button
            className="text-button monitoring-return"
            type="button"
            onClick={() => {
              setManualConversation(false);
              setMonitoring(true);
            }}
          >
            {monitorStatus.phase === "scheduled" || monitorStatus.phase === "checking"
              ? "Monitor prices"
              : "View my checks"}
          </button>
        )}
        <button
          className="portfolio-saved"
          onClick={() => go("subscriptions")}
          aria-label={
            introduced
              ? `View ${subscriptionCount} saved ${subscriptionCount === 1 ? "subscription" : "subscriptions"}`
              : `${visibleCount} subscriptions found`
          }
        >
          <span
            className="portfolio-saved-number"
            aria-hidden="true"
            style={{ minWidth: `${String(subscriptionCount).length}ch` }}
          >
            <span
              className="portfolio-saved-track"
              style={{ transform: `translateY(-${visibleCount * 1.25}em)` }}
            >
              {Array.from({ length: portfolioLimit + 1 }, (_, count) => (
                <span key={count}>{count}</span>
              ))}
            </span>
          </span>
          {visibleCount === 1 ? "subscription" : "subscriptions"}
          <Icon name="next" />
        </button>
      </header>
      <MonitoringPanel
        shown={showingMonitoring}
        status={monitorStatus}
        onOpen={openConversation}
        onStart={monitorStatus.phase === "unset" ? () => void startMonitoring() : undefined}
        busy={settingMonitoring}
        orbs={orbs}
        renderMark={(orb) => <SubscriptionMark row={orb.row} data={data} />}
        researching={reviewing}
        interrupted={reviewFailure || !!reviewPause}
        pauseText={reviewPause}
        onRetry={reviewFailure || reviewPause ? () => void finishSetup(data.portfolio, true) : undefined}
        origin={log}
      />
      <div
        className="conversation-stage"
        inert={showingMonitoring}
        aria-hidden={showingMonitoring}
        onPointerDown={() => {
          lastInteraction.current = Date.now();
        }}
        onKeyDown={() => {
          lastInteraction.current = Date.now();
        }}
      >
        <div className="portfolio-opening">
          <PortfolioScene data={data} subscriptions={sceneRows} />
        </div>
        {!!newPaymentIds.length && (
          <p className="monitoring-arrival" role="status">
            New from PayPal ·{" "}
            {data.portfolio.subscriptions
              .filter((row) => newPaymentIds.includes(row.serviceId))
              .map((row) => row.name)
              .join(", ")}
          </p>
        )}
        {queuedContext && (
          <p className="monitoring-arrival" role="status">
            Finish your current reply to discuss{" "}
            {data.portfolio.subscriptions.find((row) => row.serviceId === queuedContext.serviceId)?.name ??
              "that subscription"}
            .
          </p>
        )}
        <div
          ref={log}
          className="portfolio-conversation"
          role="log"
          aria-live="polite"
          aria-label="Conversation with Val"
          onScroll={(event) => {
            lastInteraction.current = Date.now();
            const port = event.currentTarget;
            followOutput.current = port.scrollHeight - port.scrollTop - port.clientHeight < 96;
          }}
        >
          {((!introduced && !failure) || (introduced && openingTurn)) && (
            <IngestionBubble
              label={waitingRate ? "Finishing your current check…" : "Finding subscriptions…"}
              message={introduced ? (openingTurn?.text ?? null) : null}
            />
          )}
          {turns.slice(turnOffset).map((turn, index) =>
            turn.context === "confirmation" && turn.from === "you" ? null : (
              <div
                ref={
                  index + turnOffset === turns.length - 1 && turn.from === "val" ? currentReply : undefined
                }
                className={`portfolio-current chat-message from-${turn.from}`}
                key={index + turnOffset}
              >
                <span className="chat-author sr-only">{turn.from === "val" ? "Val" : "You"}</span>
                <p>{turn.context === "confirmation" ? "Saved." : turn.text}</p>
              </div>
            ),
          )}
          <SearchAttributions items={turns.flatMap((turn) => turn.searchAttributions ?? [])} />
          {introduced &&
            !paypalWallet &&
            !activeServiceId.current &&
            openingTurn &&
            turns.length === 1 &&
            !draft &&
            !pending &&
            !!data.portfolio.subscriptions.length &&
            !setupComplete(data.portfolio, revisitServiceIds.current) && (
              <div className="val-quick-replies">
                <button
                  onClick={() =>
                    void perform({
                      message: "That’s all. Let’s go through what I use them for.",
                      history: conversationHistory(turns),
                    })
                  }
                >
                  That’s all
                </button>
              </div>
            )}
          {draft && (
            <section className="portfolio-confirm">
              <div className="portfolio-confirm-heading">
                <SubscriptionMark row={draft} data={data} />
                <div>
                  <h2>{draft.name}</h2>
                  <p>
                    {draft.amountMinor === null
                      ? "Cost not added"
                      : `${money(draft.amountMinor, draft.currency)} / ${billingCycleLabel(draft.cycle)}`}
                  </p>
                </div>
              </div>
              <p>{draft.purpose}</p>
              <div className="portfolio-confirm-actions">
                <button className="button" disabled={pending} onClick={() => void save()}>
                  Remember this
                </button>
                <button
                  className="text-button"
                  disabled={pending}
                  onClick={() => {
                    setProposal(null);
                    setAnswer(`For ${draft.name}, `);
                    input.current?.focus({ preventScroll: true });
                  }}
                >
                  Edit answer
                </button>
              </div>
            </section>
          )}
          {scheduleDraft && (
            <section className="portfolio-confirm" aria-label="Confirm recurring price checks">
              <h2>{scheduleDraft.cadence ? "Price checks" : "Pause price checks"}</h2>
              <p>
                {data.portfolio.subscriptions
                  .filter((row) => scheduleDraft.serviceIds.includes(row.serviceId))
                  .map((row) => row.name)
                  .join(", ")}
              </p>
              <p>
                {scheduleDraft.cadence
                  ? cadenceLabel(scheduleDraft.cadence)
                  : "Paused until you set another schedule"}
              </p>
              <p className="note">Runs while you’re away, within your AI allowance. Pause anytime.</p>
              <div className="portfolio-confirm-actions">
                <button className="button" disabled={pending} onClick={() => void confirmSchedule()}>
                  Confirm schedule
                </button>
                <button className="text-button" disabled={pending} onClick={() => setProposal(null)}>
                  Cancel
                </button>
              </div>
            </section>
          )}
          {introduced && advice && (
            <div ref={currentComparison}>
              <ValueComparison
                advice={advice}
                serviceId={comparisonService.current ?? undefined}
                data={data}
                onRefresh={() => void refreshComparison()}
                pending={pending}
              />
            </div>
          )}
          {findings.map(({ row, advice: result, historicalCheckedAt }, index) => (
            <div
              className="portfolio-review-result"
              key={`${row.serviceId}:${reviewedRevision.current}`}
              ref={index === findings.length - 1 ? currentComparison : undefined}
            >
              <h2>For {row.name}</h2>
              <ValueComparison
                advice={result}
                serviceId={row.serviceId}
                data={data}
                onRefresh={() => void refreshFindings([row.serviceId])}
                pending={pending}
                historicalCheckedAt={historicalCheckedAt}
              />
            </div>
          ))}
          {reviewFailure && (
            <button
              className="text-button"
              disabled={pending}
              onClick={() => {
                void finishSetup(latestData.current.portfolio, true);
              }}
            >
              Try checks again
            </button>
          )}
          {introduced && pending && !failure && !researchBusy && <PendingReply key={workState.id} />}
          {failure && (
            <div className="price-caveat" role="alert">
              <p>{failure}</p>
              {failedAction && (
                <button className="text-button" disabled={pending} onClick={retryFailedAction}>
                  Try again
                </button>
              )}
            </div>
          )}
          {introduced && !!schedules.length && (
            <section className="portfolio-advice" aria-label="Your recurring price checks">
              <h2>Price checks</h2>
              {schedules.map((schedule) => {
                const row = data.portfolio.subscriptions.find(
                  (item) => item.serviceId === schedule.serviceId,
                );
                if (!row) return null;
                const note =
                  schedule.status === "needs_details"
                    ? "Add a cost and tell Val what you use it for to enable comparisons."
                    : schedule.status === "budget_reached"
                      ? "Paused: the AI allowance has been reached."
                      : schedule.status === "access_needed"
                        ? "Renew access to continue."
                        : schedule.status === "retrying"
                          ? "The last check couldn’t finish; Val will retry after a pause."
                          : schedule.status === "checking"
                            ? "Checking provider offers…"
                            : null;
                return (
                  <article key={schedule.serviceId}>
                    <h3>{row.name}</h3>
                    <p>
                      {schedule.cadence && schedule.nextCheckAt ? cadenceLabel(schedule.cadence) : "Paused"}
                      {schedule.nextCheckAt &&
                        ` · Next ${new Date(schedule.nextCheckAt).toLocaleString("en-GB")}`}
                    </p>
                    {note && <p className="note">{note}</p>}
                    {schedule.lastCheckedAt && (
                      <p className="note">
                        Last completed {new Date(schedule.lastCheckedAt).toLocaleString("en-GB")}
                      </p>
                    )}
                    {schedule.advice && (
                      <button
                        className="text-button"
                        disabled={pending}
                        onClick={() => {
                          comparisonService.current = schedule.serviceId;
                          setAdvice(schedule.advice);
                        }}
                      >
                        View latest check
                      </button>
                    )}
                  </article>
                );
              })}
            </section>
          )}
          {introduced && scheduleFailure && <p className="note">{scheduleFailure}</p>}
        </div>
        {reviewPause && (
          <div role="status">
            <p className="note">{reviewPause}</p>
            <button
              className="text-button"
              disabled={pending}
              onClick={() => void finishSetup(data.portfolio, true)}
            >
              Resume checks
            </button>
          </div>
        )}
        {researchBusy && (
          <ResearchProgress waiting={waitingRate} progress={reviewing ? reviewProgress : null} />
        )}
        <form
          className="chat-composer is-writing"
          onSubmit={send}
          onFocusCapture={() => setComposerFocused(true)}
          onBlurCapture={(event) =>
            setComposerFocused(
              event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget),
            )
          }
        >
          <label className="sr-only" htmlFor="val-message">
            Message Val
          </label>
          <textarea
            ref={input}
            id="val-message"
            className="chat-input"
            rows={1}
            maxLength={1000}
            value={answer}
            disabled={pending || !introduced}
            placeholder={researchBusy ? "Checking provider offers…" : "Message Val…"}
            onChange={(event) => setAnswer(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                send(event);
              }
            }}
          />
          <button
            className="chat-send"
            aria-label="Send message"
            disabled={pending || !introduced || !answer.trim()}
          >
            <Icon name="send" />
          </button>
        </form>
      </div>
    </main>
  );
}
