import type { ReactNode } from "react";
import { reviewPauseMessage } from "../shared/subscriptions";
import type { PortfolioData } from "./Subscriptions";
import type { InsightState } from "./use-subscription-insights";
import { useSubscriptionInsights } from "./use-subscription-insights";
import { InsightNotice, SavedReviewCard, ScheduleCard, insightDate } from "./SubscriptionInsights";
import { go } from "./ui";

export function SubscriptionActivity({
  data,
  ownerId,
  onReload,
  legacy,
}: {
  data: PortfolioData;
  ownerId: string;
  onReload: () => void;
  legacy?: ReactNode;
}) {
  const { state, retry } = useSubscriptionInsights(ownerId, data.portfolio.revision);
  return <ActivityContent data={data} state={state} onRetry={retry} onReload={onReload} legacy={legacy} />;
}

export function ActivityContent({
  data,
  state,
  onRetry,
  onReload,
  legacy,
}: {
  data: PortfolioData;
  state: InsightState;
  onRetry: () => void;
  onReload: () => void;
  legacy?: ReactNode;
}) {
  const value = state.phase === "ready" ? state.value : null;
  const reviews =
    value?.reviews.filter((review) =>
      data.portfolio.subscriptions.some((row) => row.serviceId === review.serviceId && row.purpose.trim()),
    ) ?? [];
  const busy = value?.batch && ["queued", "running"].includes(value.batch.status);
  return (
    <main className="page has-nav insight-page activity-page">
      <h1>Your activity</h1>
      <InsightNotice state={state} onRetry={onRetry} onReload={onReload} />
      {busy && (
        <section className="insight-status" role="status">
          <h2>Checking your subscriptions</h2>
          <p>
            {value!.batch!.completed.length} of {value!.batch!.serviceIds.length} checked.
          </p>
        </section>
      )}
      {value?.batch?.status === "failed" && (
        <section className="insight-status">
          <h2>Some checks need another try</h2>
          <p>{value.batch.failed.length} checks couldn’t finish.</p>
          <button className="text-button" onClick={() => go("home")}>
            Continue with Val
          </button>
        </section>
      )}
      {value?.batch?.status === "paused" && (
        <section className="insight-status" role="status">
          <h2>Research paused</h2>
          <p>{reviewPauseMessage(value.batch)}</p>
        </section>
      )}
      {!!value?.schedules.length && (
        <section aria-label="Recurring price checks">
          <h2>Price checks</h2>
          <div className="insight-grid">
            {value.schedules.map((schedule) => (
              <ScheduleCard key={schedule.serviceId} schedule={schedule} data={data} />
            ))}
          </div>
        </section>
      )}
      {!!reviews.length && (
        <section aria-label="Latest comparisons">
          <h2>Latest comparisons</h2>
          <div className="insight-grid">
            {reviews.map((review) => (
              <SavedReviewCard key={review.serviceId} review={review} data={data} />
            ))}
          </div>
        </section>
      )}
      {!!value?.activity.length && (
        <section aria-label="Check history">
          <h2>Check history</h2>
          <ol className="insight-timeline">
            {value.activity.map((event) => (
              <li key={event.id}>
                <span
                  className={`insight-event-dot${event.outcome === "incomplete" ? " is-incomplete" : ""}`}
                  aria-hidden="true"
                />
                <div>
                  <h3>{event.name}</h3>
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
          {value.moreActivity && <p className="note">Showing your 100 most recent checks.</p>}
        </section>
      )}
      {value && !busy && !value.activity.length && !value.schedules.length && (
        <section className="dashboard-empty">
          <h2>No checks yet.</h2>
          <button className="button" onClick={() => go("home")}>
            Start with Val
          </button>
        </section>
      )}
      {legacy && (
        <details className="insight-legacy">
          <summary>Previous payment workflows</summary>
          {legacy}
        </details>
      )}
    </main>
  );
}
