import { useEffect, useState } from "react";
import type { CatalogueResponse } from "../shared/contracts.types";
import {
  monthlyPortfolioTotals,
  billingCycleLabel,
  isCurrentSubscription,
  type SubscriptionEntry,
  type SubscriptionPortfolio,
} from "../shared/subscriptions";
import { api } from "./api";
import { newestPortfolio } from "./monitoring";
import { errorText, go, Icon, money } from "./ui";
import { useSubscriptionInsights, type InsightState } from "./use-subscription-insights";
import { InsightNotice } from "./SubscriptionInsights";
import { comparisonOutcome, comparisonAlternatives } from "../shared/subscription-insights";
import { comparisonSaving } from "./ValConversation";
import { subscriptionPath } from "./navigation";
import { SwitchButton } from "./SubscriptionSwitch";
import { SwitchExampleEntry } from "./SwitchExample";

export interface PortfolioData {
  portfolio: SubscriptionPortfolio;
  catalogue: CatalogueResponse;
}

export function SubscriptionSwitchAction({
  row,
  revision,
  insights,
}: {
  row: SubscriptionEntry;
  revision: number;
  insights?: InsightState;
}) {
  if (
    !row.purpose.trim() ||
    !isCurrentSubscription(row) ||
    insights?.phase !== "ready" ||
    insights.value.revision !== revision
  )
    return null;
  const review = insights.value.reviews.find((item) => item.serviceId === row.serviceId);
  if (!review) return null;
  const options = comparisonAlternatives(review.advice);
  const option = options
    .map((choice) => review.advice.comparisons?.find((item) => item.serviceId === choice.serviceId))
    .find((item) => item && !item.owned);
  if (!option) return null;
  const period =
    option.priceUnit === "30_days" ? "30 days" : option.priceUnit === "prepaid" ? "term" : option.priceUnit;
  return (
    <div className="subscription-row-offer">
      <div className="subscription-row-offer-copy">
        <strong>{option.name}</strong>
        <span>
          {review.historical ? "Previous price · " : ""}
          {option.priceEstimated ? "≈ " : ""}
          {money(option.priceMinor, option.currency)} / {period}
          {option.prepaid ? " · paid upfront" : ""}
        </span>
        {option.fit === "conditional" && option.fitCondition && <p>{option.fitCondition}</p>}
      </div>
      <SwitchButton serviceId={row.serviceId} option={option} revision={revision} />
    </div>
  );
}
export function usePortfolio(ownerId?: string) {
  const [saved, setSaved] = useState<{ ownerId: string; data: PortfolioData } | null>(null);
  const [failure, setFailure] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setFailure("");
    if (!ownerId) setSaved(null);
    else
      void Promise.all([api.subscriptions(controller.signal), api.catalogue(controller.signal)])
        .then(([portfolio, catalogue]) => {
          if (current)
            setSaved((previous) => ({
              ownerId,
              data: {
                portfolio:
                  previous?.ownerId === ownerId
                    ? newestPortfolio(previous.data.portfolio, portfolio)
                    : portfolio,
                catalogue,
              },
            }));
        })
        .catch((error) => {
          if (current) setFailure(errorText(error));
        });
    return () => {
      current = false;
      controller.abort();
    };
  }, [ownerId, attempt]);
  useEffect(() => {
    if (!ownerId) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    const read = async () => {
      if (reading || controller.signal.aborted || document.visibilityState === "hidden") return;
      reading = true;
      try {
        const portfolio = await api.subscriptions(controller.signal);
        if (controller.signal.aborted) return;
        setSaved((previous) => {
          if (!previous || previous.ownerId !== ownerId) return previous;
          const next = newestPortfolio(previous.data.portfolio, portfolio);
          return next === previous.data.portfolio
            ? previous
            : { ...previous, data: { ...previous.data, portfolio: next } };
        });
      } catch {
        // Keep the last confirmed portfolio during a transient read failure.
      } finally {
        reading = false;
        if (!controller.signal.aborted) timer = setTimeout(() => void read(), 30_000);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void read();
    };
    timer = setTimeout(() => void read(), 30_000);
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [ownerId, attempt]);
  const data = saved?.ownerId === ownerId ? (saved?.data ?? null) : null;
  const load = () => setAttempt((previous) => previous + 1);
  const update = (portfolio: SubscriptionPortfolio) =>
    setSaved((previous) =>
      previous && previous.ownerId === ownerId
        ? {
            ...previous,
            data: { ...previous.data, portfolio: newestPortfolio(previous.data.portfolio, portfolio) },
          }
        : previous,
    );
  return { data, failure, load, update };
}

const price = (row: SubscriptionEntry) =>
  row.amountMinor === null
    ? "Add cost"
    : `${money(row.amountMinor, row.currency)} / ${billingCycleLabel(row.cycle)}`;

export function Subscriptions({
  data,
  ownerId,
  onReload,
  finding,
  ingestionFailed,
}: {
  data: PortfolioData;
  ownerId: string;
  onReload: () => void;
  finding?: boolean;
  ingestionFailed?: boolean;
}) {
  const { state, retry } = useSubscriptionInsights(ownerId, data.portfolio.revision);
  return (
    <SubscriptionsDashboard
      data={data}
      finding={finding}
      ingestionFailed={ingestionFailed}
      insights={state}
      onRetry={retry}
      onReload={onReload}
    />
  );
}

function CheckSummary({ row, state }: { row: SubscriptionEntry; state?: InsightState }) {
  if (!row.purpose.trim() || !state || state.phase !== "ready") return null;
  const review = state.value.reviews.find((item) => item.serviceId === row.serviceId);
  if (!review)
    return (
      <small className="subscription-check-summary">
        {state.value.batch &&
        ["queued", "running"].includes(state.value.batch.status) &&
        state.value.batch.serviceIds.includes(row.serviceId)
          ? "Checking prices…"
          : "No saved comparison yet"}
      </small>
    );
  const options = comparisonAlternatives(review.advice);
  const first = review.advice.comparisons?.find((item) => item.serviceId === options[0]?.serviceId);
  return (
    <small className={`subscription-check-summary${first ? " has-alternative" : ""}`}>
      {first
        ? comparisonSaving(first, review.historical)
        : comparisonOutcome(review.advice) === "incomplete"
          ? "Check incomplete · review details"
          : `${review.historical ? "Previous check" : "Checked"} · no cheaper match established`}
    </small>
  );
}

export function SubscriptionsDashboard({
  data,
  finding = false,
  ingestionFailed = false,
  insights,
  onRetry = () => {},
  onReload = () => {},
}: {
  data: PortfolioData;
  finding?: boolean;
  ingestionFailed?: boolean;
  insights?: InsightState;
  onRetry?: () => void;
  onReload?: () => void;
}) {
  const rows = data.portfolio.subscriptions.filter(isCurrentSubscription);
  const hasCosts = rows.some((row) => row.amountMinor !== null);
  const incomplete = rows.some((row) => row.amountMinor === null);
  const totals = monthlyPortfolioTotals(rows);
  const annual = rows.some((row) => row.cycle === "year");
  const thirtyDays = rows.some((row) => row.cycle === "30_days");
  const periodNotes = [
    ...(annual ? ["Yearly plans spread over 12 months"] : []),
    ...(thirtyDays
      ? ["30-day plans budgeted as thirteen payments over 365 days, starting with a charge"]
      : []),
  ];
  return (
    <main className="page has-nav dashboard-page portfolio-dashboard">
      <div className="dashboard-heading">
        <h1>Your subscriptions</h1>
      </div>
      <SwitchExampleEntry />
      {ingestionFailed && (
        <p className="note" role="alert">
          Import interrupted. Showing subscriptions found so far. Retry with Val.
        </p>
      )}
      <section className="portfolio-total" aria-busy={finding}>
        <span>{annual || thirtyDays ? "Average monthly cost" : "Monthly spend"}</span>
        <strong>
          {hasCosts ? totals.map((total) => money(total.amountMinor, total.currency)).join(" + ") : "—"}
          <small>/ month</small>
        </strong>
        {(finding ||
          (!hasCosts && rows.length > 0) ||
          incomplete ||
          periodNotes.length > 0 ||
          rows.some((row) => row.paypalEvidence)) && (
          <p>
            {finding
              ? "Finding subscriptions…"
              : hasCosts
                ? [
                    incomplete ? "Known costs only." : "",
                    ...periodNotes.map((note) => `${note}.`),
                    rows.some((row) => row.paypalEvidence) ? "Past payments; future charges may differ." : "",
                  ]
                    .filter(Boolean)
                    .join(" ")
                : "Add costs to see your total."}
          </p>
        )}
      </section>
      {insights && <InsightNotice state={insights} onRetry={onRetry} onReload={onReload} />}
      <div className="portfolio-list">
        {rows.map((row) => (
          <article className="portfolio-subscription" key={row.serviceId} aria-label={row.name}>
            <button className="portfolio-row" onClick={() => go(subscriptionPath(row.serviceId))}>
              <span className="portfolio-row-copy">
                <strong>{row.name}</strong>
                {row.paypalProduct?.planName && row.paypalProduct.planName !== row.name && (
                  <small>{row.paypalProduct.planName}</small>
                )}
                {!row.purpose && <small>Tell Val what matters</small>}
                <CheckSummary row={row} state={insights} />
                {row.paypalEvidence && row.paypalEvidence.agreementStatus !== "active" && (
                  <small>
                    {row.paypalEvidence.agreementStatus === "inactive"
                      ? "Inactive payment"
                      : "Recurrence inferred"}
                  </small>
                )}
                {row.paypalBilling &&
                  (row.amountMinor !== row.paypalBilling.amountMinor ||
                    row.cycle !== row.paypalBilling.cycle) && (
                    <small>
                      PayPal shows {money(row.paypalBilling.amountMinor, row.currency)} /{" "}
                      {billingCycleLabel(row.paypalBilling.cycle)}; using your saved cost.
                    </small>
                  )}
              </span>
              <span className="portfolio-row-price">
                {price(row)}
                <Icon name="next" />
              </span>
            </button>
            <SubscriptionSwitchAction row={row} revision={data.portfolio.revision} insights={insights} />
          </article>
        ))}
      </div>
      <div className="subscription-secondary-actions">
        <button className="text-button" onClick={() => go("activity")}>
          Check activity
          <Icon name="next" />
        </button>
      </div>
      {!rows.length && !finding && (
        <section className="dashboard-empty">
          <h2>No subscriptions yet.</h2>
          <button className="button" onClick={() => go("home")}>
            Talk to Val
          </button>
        </section>
      )}
      {!!rows.length && rows.some((row) => !row.purpose) && (
        <button className="button below" onClick={() => go("home")}>
          Tell Val what matters
        </button>
      )}
    </main>
  );
}
