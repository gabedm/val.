import type { SavedSubscriptionReview } from "../shared/subscriptions";
import { comparisonAlternatives, comparisonOutcome } from "../shared/subscription-insights";
import { cadenceLabel, type PriceCheckSchedule } from "../shared/price-checks";
import type { PortfolioData } from "./Subscriptions";
import type { InsightState } from "./use-subscription-insights";
import { comparisonSaving, SubscriptionMark, ValueComparison } from "./ValConversation";
import { go, Icon } from "./ui";
import { subscriptionChatPath } from "./navigation";
import type { SubscriptionCheckEvent } from "../shared/subscription-insights";

export const insightDate = (value: string) =>
  new Date(value).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Europe/London",
  });

export function InsightNotice({
  state,
  onRetry,
  onReload,
}: {
  state: InsightState;
  onRetry: () => void;
  onReload: () => void;
}) {
  if (state.phase === "loading")
    return (
      <p className="note" role="status">
        Loading checks…
      </p>
    );
  const message = state.phase === "error" ? state.message : state.refreshError;
  if (!message) return null;
  return (
    <div className="insight-notice" role="alert">
      <p>{message}</p>
      <button className="text-button" onClick={state.needsReload ? onReload : onRetry}>
        {state.needsReload ? "Reload subscriptions" : "Try again"}
      </button>
    </div>
  );
}

export function SavedReviewCard({ review, data }: { review: SavedSubscriptionReview; data: PortfolioData }) {
  const row = data.portfolio.subscriptions.find(
    (item) => item.serviceId === review.serviceId && item.purpose.trim(),
  );
  if (!row) return null;
  const options = comparisonAlternatives(review.advice);
  const names = [
    ...new Set(
      options.map(
        (option) => review.advice.comparisons!.find((item) => item.serviceId === option.serviceId)!.name,
      ),
    ),
  ];
  const outcome = comparisonOutcome(review.advice);
  const first = review.advice.comparisons?.find((value) => value.serviceId === options[0]?.serviceId);
  return (
    <article className="insight-card">
      <header className="insight-heading">
        <SubscriptionMark row={row} data={data} />
        <div>
          <h3>{row.name}</h3>
          <p className="note">
            {review.historical ? "Previous check" : "Checked"} · {insightDate(review.checkedAt)}
          </p>
        </div>
      </header>
      <p className="insight-summary">
        {names.length
          ? names.join(" · ")
          : outcome === "incomplete"
            ? "This check couldn’t finish"
            : "No cheaper match found"}
      </p>
      {first && <p className="insight-payoff">{comparisonSaving(first, review.historical)}</p>}
      <p className="insight-need">
        <strong>Your needs</strong> {review.advice.basedOn?.purpose ?? row.purpose}
      </p>
      {options[0] && (
        <p className="insight-fit">
          {first?.fit === "conditional" && first.fitCondition
            ? `Conditional fit: ${first.fitCondition}`
            : options[0].reason}
        </p>
      )}
      {outcome === "incomplete" && <p className="note">A cheaper match may still exist.</p>}
      <details className="insight-result">
        <summary>
          View comparison <Icon name="next" />
        </summary>
        <ValueComparison
          advice={review.advice}
          serviceId={row.serviceId}
          data={data}
          pending={false}
          showNeeds={false}
          showCheckedAt={false}
          historicalCheckedAt={review.historical ? review.checkedAt : undefined}
          onRefresh={() => go(`val/${encodeURIComponent(row.serviceId)}`)}
        />
      </details>
    </article>
  );
}

const scheduleNotes: Record<PriceCheckSchedule["status"], string> = {
  scheduled: "Scheduled",
  paused: "Paused",
  checking: "Checking prices",
  needs_details: "Needs your details",
  retrying: "Waiting to retry",
  access_needed: "Access needed",
  budget_reached: "AI allowance reached",
};
export function ScheduleCard({ schedule, data }: { schedule: PriceCheckSchedule; data: PortfolioData }) {
  const row = data.portfolio.subscriptions.find((item) => item.serviceId === schedule.serviceId);
  if (!row) return null;
  return (
    <article className="insight-card">
      <div className="insight-heading">
        <SubscriptionMark row={row} data={data} />
        <div>
          <h3>{row.name}</h3>
          <p className="note">
            {schedule.cadence ? cadenceLabel(schedule.cadence) : "Paused"}
            {schedule.status !== "scheduled" &&
              (schedule.cadence || schedule.status !== "paused") &&
              ` · ${scheduleNotes[schedule.status]}`}
          </p>
        </div>
      </div>
      {schedule.nextCheckAt && (
        <p className="note">
          {schedule.status === "retrying" ? "Retry" : "Next check"} · {insightDate(schedule.nextCheckAt)}
        </p>
      )}
      {schedule.lastCheckedAt && (
        <p className="note">Last completed · {insightDate(schedule.lastCheckedAt)}</p>
      )}
      {schedule.status === "needs_details" && <p className="note">Confirm usage and billing with Val.</p>}
      <button className="text-button" onClick={() => go(subscriptionChatPath(row.serviceId, "monitoring"))}>
        Edit schedule <Icon name="next" />
      </button>
    </article>
  );
}

export function CheckHistory({ events, more = false }: { events: SubscriptionCheckEvent[]; more?: boolean }) {
  return (
    <div className="subscription-check-history">
      <h3>Check history</h3>
      <ol className="insight-timeline">
        {events.map((event) => (
          <li key={event.id}>
            <span
              className={`insight-event-dot${event.outcome === "incomplete" ? " is-incomplete" : ""}`}
              aria-hidden="true"
            />
            <div>
              <p>
                {event.outcome === "incomplete"
                  ? "This check couldn’t finish"
                  : event.outcome === "alternatives"
                    ? `${event.alternatives} ${event.alternatives === 1 ? "alternative" : "alternatives"} found`
                    : "Checked · no cheaper match established"}
              </p>
              <time dateTime={event.checkedAt}>{insightDate(event.checkedAt)}</time>
            </div>
          </li>
        ))}
      </ol>
      {more && <p className="note">Older checks may be outside this history.</p>}
    </div>
  );
}
