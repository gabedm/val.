import type { SubscriptionAdvice } from "../shared/subscriptions";
import { comparisonOutcome } from "../shared/subscription-insights";
import type { PortfolioData } from "./Subscriptions";
import { SwitchButton } from "./SubscriptionSwitch";
import { comparisonSaving, SubscriptionMark } from "./ValConversation";
import { Icon, money } from "./ui";

/** A saved comparison is a decision summary; the switch flow checks the current terms before approval. */
export function SubscriptionAlternatives({
  advice,
  serviceId,
  data,
  historical,
  onRetry,
}: {
  advice: SubscriptionAdvice;
  serviceId: string;
  data: PortfolioData;
  historical: boolean;
  onRetry: () => void;
}) {
  const outcome = comparisonOutcome(advice);
  if (outcome !== "alternatives")
    return (
      <div className="detail-empty">
        <p>{outcome === "incomplete" ? "This check couldn’t finish." : "No cheaper match found."}</p>
        {outcome === "incomplete" && (
          <button className="text-button" onClick={onRetry}>
            Try again <Icon name="next" />
          </button>
        )}
      </div>
    );
  return (
    <div className="subscription-alternatives">
      {advice.options.map((option) => {
        const value = advice.comparisons?.find((item) => item.serviceId === option.serviceId);
        if (!value) return null;
        const price = (amount: number) => money(amount, value.currency ?? "GBP");
        const prepaid = value.priceUnit === "prepaid" ? value.prepaid : undefined;
        const period =
          value.priceUnit === "30_days" ? "30 days" : value.priceUnit === "year" ? "year" : "month";
        const fit = value.fit === "conditional" ? value.fitCondition : value.highlights?.[0];
        const terms = [
          prepaid &&
            `Paid upfront · then ${price(value.renewalMinor!)} every ${prepaid.renewalMonths} months`,
          value.introductoryCycles &&
            `First ${value.introductoryCycles} payments · then ${price(value.renewalMinor!)} / ${period}`,
          value.upfrontMinor && `${price(value.upfrontMinor)} setup fee`,
          value.minimumTermMonths && `${value.minimumTermMonths}-month minimum`,
        ].filter(Boolean);
        return (
          <article className="subscription-alternative" key={option.serviceId}>
            <div className="alternative-heading">
              <SubscriptionMark
                row={{ serviceId: value.logoServiceId ?? value.serviceId, name: value.name }}
                data={data}
              />
              <div className="alternative-provider">
                <h3>{value.name}</h3>
                {value.plan && <p>{value.plan}</p>}
              </div>
              <p className="alternative-price">
                {historical && !value.owned && <span className="sr-only">Recorded price: </span>}
                <strong>
                  {value.owned
                    ? "Already yours"
                    : `${value.priceEstimated ? "≈ " : ""}${price(value.priceMinor)}`}
                </strong>
                {!value.owned && (
                  <span>{prepaid ? `first ${prepaid.initialMonths} months` : `/ ${period}`}</span>
                )}
              </p>
            </div>
            {!value.owned && !!terms.length && <p className="alternative-billing">{terms.join(" · ")}</p>}
            {!value.owned &&
              value.scheduledChanges?.map((change) => (
                <p className="alternative-billing" key={change.on}>
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
            <div className="alternative-decision">
              <div>
                <p className="alternative-saving">{comparisonSaving(value, historical)}</p>
                {fit && <p className="alternative-fit">{fit}</p>}
              </div>
              <SwitchButton serviceId={serviceId} option={value} revision={data.portfolio.revision} />
            </div>
            <details className="alternative-details">
              <summary>
                Provider details <Icon name="next" />
              </summary>
              <div className="alternative-details-body">
                {option.reason !== fit && <p>{option.reason}</p>}
                <dl>
                  <div>
                    <dt>12-month cost</dt>
                    <dd>
                      {value.owned ? "Existing bill continues" : price(value.annualMinor)}
                      {value.priceUnit === "30_days" && " · 13 payments"}
                    </dd>
                  </div>
                  {value.feesKnown === false && (
                    <div>
                      <dt>Fees</dt>
                      <dd>Not fully confirmed</dd>
                    </div>
                  )}
                </dl>
                {value.priceEstimated && value.priceQuote && <p>{value.priceQuote}</p>}
                {value.highlights
                  ?.filter((text) => text !== fit && text !== value.fitCondition)
                  .slice(0, 3)
                  .map((text) => (
                    <p key={text}>{text}</p>
                  ))}
                <div className="alternative-provider-links">
                  {value.sources.map((url, index) => (
                    <a key={url} href={url} target="_blank" rel="noreferrer">
                      {index ? "Terms and features" : "View provider"}
                      <Icon name="next" />
                    </a>
                  ))}
                </div>
                {value.priceQuote && (
                  <p className="alternative-provenance">Price read from provider pages using AI.</p>
                )}
              </div>
            </details>
          </article>
        );
      })}
    </div>
  );
}
