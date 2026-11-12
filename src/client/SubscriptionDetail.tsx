import { isCurrentSubscription, billingCycleLabel, reviewPauseMessage } from "../shared/subscriptions";
import type { PortfolioData } from "./Subscriptions";
import { useSubscriptionInsights, type InsightState } from "./use-subscription-insights";
import { InsightNotice, insightDate } from "./SubscriptionInsights";
import { SubscriptionMark } from "./ValConversation";
import { SubscriptionAlternatives } from "./SubscriptionAlternatives";
import { cadenceLabel } from "../shared/price-checks";
import { subscriptionChatPath } from "./navigation";
import { BackLine, go, Icon, money } from "./ui";

export function SubscriptionDetail({
  id,
  data,
  ownerId,
  onReload,
}: {
  id: string;
  data: PortfolioData;
  ownerId: string;
  onReload: () => void;
}) {
  const { state, retry } = useSubscriptionInsights(ownerId, data.portfolio.revision);
  return <SubscriptionDetailContent id={id} data={data} state={state} onRetry={retry} onReload={onReload} />;
}

/** Opening a bill reads saved evidence only. New research and changes stay behind a deliberate chat action. */
export function SubscriptionDetailContent({
  id,
  data,
  state,
  onRetry,
  onReload,
}: {
  id: string;
  data: PortfolioData;
  state: InsightState;
  onRetry: () => void;
  onReload: () => void;
}) {
  const row = data.portfolio.subscriptions.find(
    (item) => item.serviceId === id && isCurrentSubscription(item),
  );
  if (!row)
    return (
      <main className="page narrow has-nav subscription-detail">
        <BackLine to="subscriptions" />
        <h1>Subscription unavailable</h1>
        <p>This subscription is no longer in your current list.</p>
      </main>
    );
  const value = state.phase === "ready" ? state.value : null;
  const review = row.purpose.trim() ? value?.reviews.find((item) => item.serviceId === id) : undefined;
  const schedule = value?.schedules.find((item) => item.serviceId === id);
  const batch = value?.batch?.serviceIds.includes(id) ? value.batch : null;
  const scheduleStatus =
    schedule &&
    {
      scheduled: "",
      paused: "Paused",
      checking: "Checking prices",
      needs_details: "Needs your details",
      retrying: "Waiting to retry",
      access_needed: "Access needed",
      budget_reached: "AI allowance reached",
    }[schedule.status];
  const discussing = (intent?: "needs" | "monitoring") => go(subscriptionChatPath(id, intent));
  return (
    <main className="page narrow has-nav subscription-detail">
      <BackLine to="subscriptions" />
      <header className="subscription-detail-heading">
        <SubscriptionMark row={row} data={data} />
        <div>
          <h1>{row.name}</h1>
          {row.paypalProduct?.planName && row.paypalProduct.planName !== row.name && (
            <p>{row.paypalProduct.planName}</p>
          )}
        </div>
        <p className="subscription-detail-cost">
          {row.amountMinor === null ? "Cost not added" : money(row.amountMinor, row.currency)}
          {row.amountMinor !== null && <span> / {billingCycleLabel(row.cycle)}</span>}
        </p>
      </header>
      <section className="detail-section" aria-labelledby="subscription-alternatives">
        <div className="detail-section-heading">
          <h2 id="subscription-alternatives">Alternatives</h2>
          {review && (
            <span className="note">
              {review.historical ? "Previous check" : "Checked"} · {insightDate(review.checkedAt)}
            </span>
          )}
        </div>
        <InsightNotice state={state} onRetry={onRetry} onReload={onReload} />
        {review ? (
          <SubscriptionAlternatives
            advice={review.advice}
            serviceId={id}
            data={data}
            historical={review.historical}
            onRetry={() => discussing()}
          />
        ) : (
          value && (
            <div className="detail-empty">
              <p>
                {!row.purpose.trim()
                  ? "Tell Val what you need to start comparing."
                  : row.amountMinor === null
                    ? "Add your cost to compare prices."
                    : batch?.status === "paused"
                      ? reviewPauseMessage(batch)
                      : batch?.failed.includes(id)
                        ? "This check couldn’t finish. A suitable alternative may still exist."
                        : batch &&
                            ["queued", "running"].includes(batch.status) &&
                            !batch.completed.includes(id)
                          ? "Checking offers…"
                          : "No comparison yet."}
              </p>
              {!(batch && ["queued", "running"].includes(batch.status)) && (
                <button
                  className="text-button"
                  onClick={() => discussing(row.purpose.trim() ? undefined : "needs")}
                >
                  {row.purpose.trim() ? "Check with Val" : "Tell Val what matters"}
                  <Icon name="next" />
                </button>
              )}
            </div>
          )
        )}
      </section>
      <details className="subscription-context detail-section">
        <summary>
          Your subscription <Icon name="next" />
        </summary>
        <section className="subscription-context-section" aria-labelledby="subscription-needs">
          <div className="detail-section-heading">
            <h2 id="subscription-needs">Your needs</h2>
            <button className="text-button" onClick={() => discussing("needs")}>
              {row.purpose.trim() ? "Edit needs" : "Tell Val"}
              <Icon name="next" />
            </button>
          </div>
          <p>{row.purpose || "No needs saved yet."}</p>
        </section>
        <section className="subscription-context-section" aria-labelledby="subscription-monitoring">
          <div className="detail-section-heading">
            <h2 id="subscription-monitoring">Monitoring</h2>
            <button className="text-button" onClick={() => discussing("monitoring")}>
              {schedule ? "Edit schedule" : "Set schedule"}
              <Icon name="next" />
            </button>
          </div>
          <p>
            {schedule
              ? [schedule.cadence && cadenceLabel(schedule.cadence), scheduleStatus]
                  .filter(Boolean)
                  .join(" · ")
              : value
                ? "No schedule yet."
                : state.phase === "loading"
                  ? "Loading schedule…"
                  : "Schedule unavailable."}
          </p>
          {schedule?.nextCheckAt && (
            <p className="note">
              {schedule.status === "retrying" ? "Retry" : "Next check"} · {insightDate(schedule.nextCheckAt)}
            </p>
          )}
        </section>
        <section className="subscription-context-section" aria-labelledby="subscription-billing">
          <h2 id="subscription-billing">Payment details</h2>
          <dl className="subscription-facts">
            <div>
              <dt>Source</dt>
              <dd>{row.source === "paypal" ? "PayPal" : "Added by you"}</dd>
            </div>
            <div>
              <dt>Billing</dt>
              <dd>
                {row.cycle === "year" ? "Yearly" : row.cycle === "30_days" ? "Every 30 days" : "Monthly"}
              </dd>
            </div>
            {row.paypalEvidence && (
              <>
                <div>
                  <dt>Payment evidence</dt>
                  <dd>
                    {row.paypalEvidence.agreementStatus === "active"
                      ? "Active automatic payment"
                      : "Recurring pattern · agreement unverified"}
                  </dd>
                </div>
                <div>
                  <dt>Observed payments</dt>
                  <dd>{row.paypalEvidence.paymentCount}</dd>
                </div>
                <div>
                  <dt>Last paid</dt>
                  <dd>{row.paypalEvidence.lastPaidOn}</dd>
                </div>
              </>
            )}
          </dl>
          {row.paypalEvidence?.cycleBasis === "owner_confirmation" && (
            <p className="note">Billing frequency confirmed by you.</p>
          )}
          {row.paypalBilling &&
            (row.amountMinor !== row.paypalBilling.amountMinor || row.cycle !== row.paypalBilling.cycle) && (
              <p className="note">
                PayPal shows {money(row.paypalBilling.amountMinor, row.currency)} /{" "}
                {billingCycleLabel(row.paypalBilling.cycle)}; comparisons use your saved cost above.
              </p>
            )}
        </section>
      </details>
    </main>
  );
}
