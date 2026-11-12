import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { CandidateQuote, CapabilityResult, CaseSnapshot, Receipt } from "../shared/contracts.types";
import { api } from "./api";

const glyphs = {
  chat: <path d="M4 4h16v12H9l-5 4V4Z" />,
  search: (
    <>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m16 16 5 5" />
    </>
  ),
  arrow: <path d="M19 12H5m6-6-6 6 6 6" />,
  next: <path d="m9 5 7 7-7 7" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  check: <path d="m5 12 4 4L19 6" />,
  shield: <path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6l-8-3Z" />,
  home: (
    <>
      <path d="m3 10 9-7 9 7v10H3Z" />
      <path d="M9 20v-7h6v7" />
    </>
  ),
  activity: (
    <>
      <rect x="5" y="3" width="14" height="18" rx="3" />
      <path d="M9 8h6M9 12h6M9 16h3" />
    </>
  ),
  person: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21v-2a8 8 0 0 1 16 0v2" />
    </>
  ),
  discover: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m16 8-2 6-6 2 2-6Z" />
    </>
  ),
  close: <path d="m6 6 12 12M6 18 18 6" />,
  alert: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6m0 3v.1" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H5v18h14V8Z" />
      <path d="M14 3v5h5M9 12h6m-6 4h6" />
    </>
  ),
};

export function Icon({ name }: { name: keyof typeof glyphs }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {glyphs[name]}
    </svg>
  );
}

export const go = (route: string) => {
  location.hash = route;
};

export function BackLine({ to, step }: { to: string; step?: string }) {
  return (
    <div className="backline">
      <button className="back" onClick={() => go(to)}>
        <Icon name="arrow" />
        <span>Back</span>
      </button>
      {step && <span className="step">{step}</span>}
    </div>
  );
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="row">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export const pounds = (minor: number) => `£${minor % 100 === 0 ? minor / 100 : (minor / 100).toFixed(2)}`;
export function money(minor: number, currency = "GBP") {
  if (currency === "GBP") return pounds(minor);
  const format = new Intl.NumberFormat("en-GB", { style: "currency", currency });
  const precision = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** precision);
}
export const longDate = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long" }) : "not verified";
export const fullDate = (iso: string | null | undefined) =>
  iso && Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })
    : "not verified";
export const dateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/** Customer-facing plan names; server plan IDs and historical fixture output are retained separately. */
export const planNames: Record<string, string> = {
  a_01: "Original service",
  a_02: "Original service Plus",
  b_01: "Margin Basic",
  b_02: "Margin Plus",
  b_03: "Margin Value",
};
export const planName = (planId: string | null | undefined) =>
  planId ? (planNames[planId] ?? planId) : "No plan";
export const capabilityNames = {
  editable_text: "Editable work",
  speaker_labels: "Earlier requirement",
} as const;

export function checkedFeatures(
  required: readonly CapabilityResult["capability"][] | undefined,
  results: readonly CapabilityResult[] | null | undefined,
) {
  if (!required?.length || new Set(required).size !== required.length)
    return { complete: false, missing: [] as CapabilityResult["capability"][] };
  const checks = required.map((name) => results?.filter((result) => result.capability === name) ?? []);
  return {
    complete: checks.every((rows) => rows.length === 1),
    missing: checks.flatMap((rows) => (rows.length === 1 && !rows[0]!.passes ? [rows[0]!.capability] : [])),
  };
}

export function freshQuote(quote: CandidateQuote | null | undefined, now = Date.now()) {
  const observed = Date.parse(quote?.observedAt ?? "");
  return quote &&
    Number.isSafeInteger(quote.recurringTotal.amountMinor) &&
    quote.recurringTotal.amountMinor >= 0 &&
    Number.isFinite(observed) &&
    now >= observed &&
    now - observed <= 5 * 60_000
    ? quote
    : null;
}

export function monthlyDifference(
  current: CandidateQuote | null,
  replacement: CandidateQuote | null,
  currentPlanId: string | null,
  now = Date.now(),
) {
  const old = freshQuote(current, now);
  const next = freshQuote(replacement, now);
  return old && next && old.planId === currentPlanId && old.planId !== next.planId
    ? next.recurringTotal.amountMinor - old.recurringTotal.amountMinor
    : null;
}

export function supportedChoice(snapshot: CaseSnapshot, now = Date.now()) {
  const { policy, recommendation, evaluations, evaluationQuotes } = snapshot;
  if (
    !policy ||
    !recommendation ||
    policy.revision !== recommendation.policyRevision ||
    !["switch", "change_plan"].includes(recommendation.action)
  )
    return null;
  const evaluation = evaluations.find(
    (item) => item.candidateId === recommendation.candidateId && item.policyRevision === policy.revision,
  );
  const quote = evaluationQuotes.find(
    (item) => item.id === evaluation?.quoteId && item.candidateId === evaluation?.candidateId,
  );
  const checks = checkedFeatures(policy.requiredCapabilities, evaluation?.capabilityResults);
  const fresh = freshQuote(quote, now);
  const validOffer =
    !fresh?.offer ||
    (fresh.offer.eligibility === "ELIGIBLE" &&
      fresh.offer.introductoryAmount.amountMinor > 0 &&
      fresh.offer.regularAmount.amountMinor === fresh.recurringTotal.amountMinor &&
      fresh.dueNowTotal.amountMinor ===
        fresh.offer.introductoryAmount.amountMinor +
          fresh.offer.setupFee.amountMinor +
          fresh.feesMinor +
          fresh.taxMinor);
  const currentChecks = checkedFeatures(
    policy.requiredCapabilities,
    snapshot.currentOutput?.capabilityResults,
  );
  const currentFailed =
    currentChecks.complete &&
    currentChecks.missing.length > 0 &&
    snapshot.currentOutput?.planId === snapshot.currentAccount?.planId;
  const valueKnown =
    snapshot.case.scenario !== "value_offer" ||
    (fresh?.comparison?.basis === "AUTHORED_NOTICE_PROJECTION" &&
      (fresh.comparison.netSavingMinor > 0 || currentFailed));
  return evaluation?.eligible &&
    checks.complete &&
    checks.missing.length === 0 &&
    fresh &&
    validOffer &&
    valueKnown &&
    fresh.recurringTotal.amountMinor <= policy.recurringCeiling.amountMinor
    ? { evaluation, quote: fresh }
    : null;
}

export function handoverFacts(receipt: Receipt) {
  const paid =
    !!receipt.newSubscriptionId?.trim() &&
    receipt.newBillingStatus === "ACTIVE" &&
    receipt.duePayment === "VERIFIED" &&
    receipt.paymentEvidenceId !== null;
  const output = receipt.capability === "VERIFIED" && receipt.capabilityEvidenceId !== null;
  const history = receipt.history === "VERIFIED" && receipt.historyEvidenceId !== null;
  const billingStopped = receipt.oldBilling === "CANCELLED";
  const accessScheduled = receipt.oldService === "EXIT_SCHEDULED" && receipt.oldAccessEndsAt !== null;
  return {
    paid,
    output,
    history,
    billingStopped,
    accessScheduled,
    accessEnded: receipt.oldService === "ENDED",
    ready: paid && output && history,
    handoverComplete:
      paid && output && history && billingStopped && (accessScheduled || receipt.oldService === "ENDED"),
  };
}

/** One plain reason a tested plan doesn't fit, from the same checks Val used. */
export function fitReason(
  candidate: { eligible: boolean; capabilityResults: CapabilityResult[]; rejectionReasons: string[] },
  priceMinor: number | undefined,
  ceilingMinor: number,
  required: readonly CapabilityResult["capability"][],
) {
  if (priceMinor === undefined || !Number.isSafeInteger(priceMinor) || priceMinor < 0)
    return "Price not confirmed";
  if (priceMinor > ceilingMinor) return `${pounds(priceMinor - ceilingMinor)} over budget`;
  const checks = checkedFeatures(required, candidate.capabilityResults);
  if (candidate.rejectionReasons.includes("Offer not available to this account."))
    return "This offer is not available for this account";
  if (candidate.rejectionReasons.includes("Offer eligibility not verified."))
    return "Offer eligibility needs checking";
  if (candidate.rejectionReasons.includes("The first-year costs cannot be confirmed."))
    return "First-year costs need checking";
  if (!checks.complete) return "Required work not fully checked";
  if (checks.missing.length)
    return checks.missing.includes("editable_text")
      ? "Editable work is unavailable"
      : "An older saved requirement is unmet";
  return candidate.eligible ? "Meets the saved work requirement" : "Not eligible for this plan";
}

export const duration = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);

export const errorText = (failure: unknown) =>
  failure instanceof Error ? failure.message : "Something went wrong. Please try again.";

/** Expiry must update an idle screen without polling the server or waiting for another user action. */
export function useExpired(deadline: string | null | undefined) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    if (!deadline || Date.parse(deadline) <= Date.now()) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      if (Date.parse(deadline) <= time) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [deadline]);
  return !!deadline && Date.parse(deadline) <= now;
}

const busyStates = new Set(["INVESTIGATING", "AWAITING_PAYPAL", "VERIFYING_NEW", "EXITING_OLD"]);

export function shouldPollCase(snapshot: CaseSnapshot | null): boolean {
  if (!snapshot) return false;
  const setup =
    snapshot.case.state === "SETUP" && snapshot.handover?.kind === "setup_create" ? snapshot.handover : null;
  const setupPending =
    !!setup &&
    setup.status !== "FAILED" &&
    setup.paymentStatus !== "FAILED" &&
    !["CANCELLED", "EXPIRED"].includes(setup.billingStatus ?? "");
  return snapshot.pendingJobId !== null || busyStates.has(snapshot.case.state) || setupPending;
}

/**
 * The selected case as the server holds it. Polls only while a job or handover step is running, and refreshes
 * when the page becomes visible again, so a reopened tab shows the persisted operation rather than stale state.
 */
export function useCaseSnapshot(caseId: string | null) {
  const [snapshot, setSnapshot] = useState<CaseSnapshot | null>(null);
  const [failure, setFailure] = useState("");
  const current = useRef(caseId);
  current.current = caseId;

  const refresh = useCallback(async () => {
    if (!caseId) return;
    try {
      const next = await api.snapshot(caseId);
      if (current.current === caseId) {
        setSnapshot(next);
        setFailure("");
      }
    } catch (error) {
      if (current.current === caseId) setFailure(errorText(error));
    }
  }, [caseId]);

  useEffect(() => {
    setSnapshot(null);
    setFailure("");
    void refresh();
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const busy = shouldPollCase(snapshot);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [busy, refresh]);

  return {
    snapshot: snapshot?.case.id === caseId ? snapshot : null,
    failure: caseId ? failure : "",
    refresh,
  };
}

/** One command at a time: disables its button while pending and reports a refusal in plain words. */
export function useCommand(refresh: () => Promise<void>) {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const trigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pending) return;
    const control = trigger.current;
    trigger.current = null;
    // Browsers drop focus when a running action disables its button. Restore it only if nothing else took focus.
    if (
      document.activeElement === document.body &&
      control?.isConnected &&
      control.matches("button:not(:disabled)")
    )
      control.focus({ preventScroll: true });
  }, [pending]);
  const run = async (command: () => Promise<unknown>, done = "") => {
    if (pending) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPending(true);
    setMessage("");
    try {
      await command();
      setMessage(done);
    } catch (failure) {
      setMessage(errorText(failure));
    } finally {
      setPending(false);
      await refresh();
    }
  };
  return { run, pending, message, setMessage };
}

export function Notice({ text }: { text: string }) {
  return text ? (
    <p className="note below" role="status" aria-live="polite">
      {text}
    </p>
  ) : null;
}
