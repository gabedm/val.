import { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { BackLine, Icon, go } from "./ui";
import { catalogueAmount, displayCurrencies, fxSnapshot, type DisplayCurrency } from "./catalogueCurrency";
import type { PortfolioData } from "./Subscriptions";

interface Service {
  id: string;
  service: string;
  plan: string;
  category: string;
  purpose: string;
  audience: string;
  capability_tags: string[];
  constraints: string[];
  price: {
    amount: number;
    currency: string;
    unit: string;
    kind: string;
    charge_basis: string;
    minimum_seats: number | null;
    commitment_months: number | null;
    market_country: string | null;
  };
  sources: { url: string; checked_on: string; pricing_channel: string }[];
  research_flags: { code: string }[];
}
interface Catalogue {
  researched_on: string;
  categories: { id: string; label: string }[];
  services: Service[];
}

const units: Record<string, string> = {
  month: "/ month",
  year: "/ year",
  "28_days": "/ 4 weeks",
  "30_days": "/ 30 days",
  "90_days": "/ 90 days",
  "27_months": "/ first 27 months",
  "28_months": "/ first 28 months",
  annual_month_rate: "/ mo · billed yearly",
  advertised_month: "/ mo · terms unconfirmed",
  listed_offer: "· period unconfirmed",
  serving: "/ serving",
  box: "/ box",
  bag: "/ bag",
};
const settledFlags = new Set(["annual_commitment", "exact_bill_unknown", "variable_basket"]);
const normalise = (value: string) =>
  value
    .toLowerCase()
    .replace(/_/g, " ")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");

// One load per page session; filters survive a visit to a service and back.
type CatalogueData = { catalogue: Catalogue; logos: Record<string, string> };
let loaded: Promise<CatalogueData> | null = null;
let cached: CatalogueData | null = null;
const browse = { query: "", currency: "GBP" as DisplayCurrency };

function useCatalogue() {
  const [data, setData] = useState<CatalogueData | null>(cached);
  const [failed, setFailed] = useState(false);
  const load = () => {
    setFailed(false);
    loaded ??= api.catalogue() as unknown as Promise<{ catalogue: Catalogue; logos: Record<string, string> }>;
    loaded.then(
      (value) => {
        cached = value;
        setData(value);
      },
      () => {
        loaded = null;
        cached = null;
        setFailed(true);
      },
    );
  };
  useEffect(load, []);
  return { data, failed, retry: load };
}

function publishedPrice(item: Service) {
  const { price } = item;
  if (price.kind === "unknown")
    return { amount: "Check your tariff", original: "", converted: false, term: "" };
  const amount = catalogueAmount(price.amount, price.currency, browse.currency);
  const basis =
    price.charge_basis === "per_maker_or_seat"
      ? " · per seat"
      : price.charge_basis === "per_computer"
        ? " · per computer"
        : "";
  const commitment = price.commitment_months ? ` · ${price.commitment_months}-month term` : "";
  return {
    amount: (price.kind === "advertised_floor" ? "From " : "") + amount.text,
    original: (price.kind === "advertised_floor" ? "From " : "") + amount.original,
    converted: amount.converted,
    term: (units[price.unit] ?? `/ ${price.unit.replace(/_/g, " ")}`) + basis + commitment,
  };
}

function marketName(item: Service) {
  const country = item.price.market_country
    ? ({ GB: "UK", US: "US", SE: "Sweden" }[item.price.market_country] ?? item.price.market_country)
    : null;
  const channel = item.sources[0]?.pricing_channel;
  return `${country ?? `${item.price.currency} offer`}${channel === "apple_app_store" ? " · App Store" : channel === "steam" ? " · Steam" : ""}`;
}

function BrandMark({ item }: { item: Service; logos: Record<string, string> }) {
  return (
    <span className="brand-mark provider-name" aria-hidden="true">
      {item.service}
    </span>
  );
}

function matches(catalogue: Catalogue) {
  const words = normalise(browse.query.trim()).split(/\s+/).filter(Boolean);
  const found = catalogue.services.filter((item) => {
    const text = normalise([item.service, item.plan, item.purpose, ...item.capability_tags].join(" "));
    return words.every((word) => text.includes(word));
  });
  // Interleave categories so the first page shows the range rather than one category.
  const byCategory = catalogue.categories.map((category) =>
    found.filter((item) => item.category === category.id),
  );
  return Array.from({ length: Math.max(0, ...byCategory.map((items) => items.length)) }, (_, index) =>
    byCategory.map((items) => items[index]).filter((item): item is Service => !!item),
  ).flat();
}

function CatalogueBrowse({ data }: { data: CatalogueData }) {
  const search = useRef<HTMLInputElement>(null);
  const [, redraw] = useState(0);
  const update = (change: Partial<typeof browse>) => {
    Object.assign(browse, change);
    redraw((value) => value + 1);
  };
  const items = data ? matches(data.catalogue) : [];
  return (
    <section className="catalogue-browser-content">
      <p className="note">
        Researched {data.catalogue.researched_on}. Not personalised; prices may have changed.
      </p>
      <div className="subscription-searchbar">
        <Icon name="search" />
        <label className="sr-only" htmlFor="catalogue-search">
          Search subscriptions
        </label>
        <input
          ref={search}
          className="subscription-search"
          id="catalogue-search"
          type="search"
          placeholder="Search subscriptions"
          maxLength={120}
          autoComplete="off"
          value={browse.query}
          onChange={(event) => update({ query: event.target.value })}
        />
        {browse.query && (
          <button
            className="subscription-search-clear"
            aria-label="Clear search"
            onClick={() => {
              update({ query: "" });
              search.current?.focus();
            }}
          >
            <Icon name="close" />
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {data
          ? `${items.length} ${items.length === 1 ? "subscription" : "subscriptions"}`
          : "Loading subscriptions…"}
      </p>
      {data && items.length === 0 && (
        <section className="catalogue-empty">
          <h2>No matching subscriptions.</h2>
          <p className="note">Try another name or a shorter search.</p>
        </section>
      )}
      {data && items.length > 0 && (
        <ul className="subscription-logo-grid" aria-label="Subscriptions">
          {items.map((item, index) => (
            <li key={item.id}>
              <button
                className="subscription-logo-button"
                style={{ animationDelay: `${Math.min(index, 11) * 20}ms` }}
                aria-label={`${item.service}, subscription details`}
                onClick={() => go(`service/${item.id}`)}
              >
                <BrandMark item={item} logos={data.logos} />
                <span className="subscription-logo-name">{item.service}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CatalogueBrowser({ data }: { data: PortfolioData["catalogue"] }) {
  return (
    <main className="page has-nav catalogue-page logo-catalogue">
      <BackLine to="subscriptions" />
      <h1>Reference catalogue</h1>
      <CatalogueBrowse data={data as unknown as CatalogueData} />
    </main>
  );
}

export function ServiceDetail({ id }: { id: string }) {
  const { data, failed } = useCatalogue();
  const [, redraw] = useState(0);
  if (!data)
    return (
      <main className="page narrow">
        <BackLine to="browse" />
        <h1>Subscription details</h1>
        <p className="note">
          {failed ? "Subscriptions couldn’t load. Return to the catalogue to retry." : "Loading…"}
        </p>
      </main>
    );
  const item = data.catalogue.services.find((service) => service.id === id);
  if (!item)
    return (
      <main className="page narrow">
        <BackLine to="browse" />
        <h1>Subscription not found.</h1>
      </main>
    );
  const price = publishedPrice(item);
  const caveat = item.research_flags.some((flag) => !settledFlags.has(flag.code));
  const source = item.sources[0];
  return (
    <main className="page narrow service-detail">
      <BackLine to="browse" />
      <div className={`detail-identity tone-${item.category}`}>
        <BrandMark item={item} logos={data.logos} />
        <p className="eyebrow">
          {data.catalogue.categories.find((category) => category.id === item.category)?.label}
        </p>
      </div>
      <h1>{item.service}</h1>
      <p className="note">Reference catalogue · not personalised</p>
      <p className="lead">{item.purpose}</p>
      <section className="detail-price">
        <div className="detail-price-heading">
          <h2>
            {price.amount}
            <span>{price.term}</span>
          </h2>
          <select
            aria-label="Display currency"
            value={browse.currency}
            onChange={(event) => {
              browse.currency = event.target.value as DisplayCurrency;
              redraw((value) => value + 1);
            }}
          >
            {displayCurrencies.map((currency) => (
              <option key={currency} value={currency}>
                {currency}
              </option>
            ))}
          </select>
        </div>
        <p className="note">
          {item.plan} · {marketName(item)}
        </p>
        {source && <p className="note below">Source checked {source.checked_on}.</p>}
        {price.converted && (
          <p className="note below">
            Listed price: {price.original} {price.term}. Estimate uses{" "}
            <a href={fxSnapshot.source} target="_blank" rel="noopener noreferrer">
              rates from {fxSnapshot.label}
            </a>
            .
          </p>
        )}
        {item.price.charge_basis === "per_maker_or_seat" && (
          <p className="note below">
            {item.price.minimum_seats
              ? `Minimum ${item.price.minimum_seats} ${item.price.minimum_seats === 1 ? "seat" : "seats"}`
              : "Minimum seats unconfirmed"}
          </p>
        )}
        {item.price.commitment_months && (
          <p className="note below">{item.price.commitment_months}-month commitment</p>
        )}
        {caveat && <p className="price-caveat">This published offer needs confirming.</p>}
      </section>
      <section className="detail-features">
        <h2>What it’s for</h2>
        <ul>
          {item.capability_tags.map((tag) => (
            <li key={tag}>{tag.replace(/_/g, " ")}</li>
          ))}
        </ul>
        <p className="note">Based on published descriptions, not tested by Val.</p>
      </section>
      <section className="detail-terms">
        <h2>Before you choose</h2>
        <ul>
          {item.constraints.map((text) => (
            <li key={text}>{text}</li>
          ))}
        </ul>
        {item.audience === "business_team" && <p className="note below">This is a business or team plan.</p>}
        {item.audience === "verified_student" && (
          <p className="note below">Verified student eligibility is required.</p>
        )}
        {!item.price.market_country && (
          <p className="note below">The price source doesn’t establish country eligibility.</p>
        )}
      </section>
      {source && (
        <a className="button" href={source.url} target="_blank" rel="noopener noreferrer">
          View price source <Icon name="next" />
        </a>
      )}
    </main>
  );
}
