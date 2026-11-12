import { useState, type CSSProperties } from "react";
import type { CaseSnapshot } from "../shared/contracts.types";

const artworkBrands = [
  "Netflix",
  "Spotify",
  "Disney+",
  "Apple Music",
  "YouTube Music",
  "Prime",
  "Adobe Creative Cloud",
  "Notion",
];
const welcomeBrands = [
  "Apple TV+",
  "Audible",
  "Xbox Game Pass",
  "PlayStation Plus",
  "HBO Max",
  "Canva",
  "Microsoft 365",
  "Paramount+",
];

/** Decorative subscription-brand artwork, not a list of owned or connected subscriptions. */
export function BrandScene({
  settled = false,
  variant = "boot",
}: {
  settled?: boolean;
  variant?: "boot" | "welcome";
}) {
  const brands = variant === "welcome" ? welcomeBrands : artworkBrands;
  // Sample once per scene. CSS moves between bounded waypoints without timers or re-renders.
  const [drift] = useState(() =>
    brands.map((_, index) => {
      const starts = [62.5, 87.5, 12.5, 37.5, 75, 25, 50, 0];
      const path: Record<string, string> = {
        "--orbit-start": `${starts[index]}%`,
        "--drift-duration": `${18 + Math.random() * 12}s`,
        "--drift-phase": `${-Math.random() * 30}s`,
      };
      for (let point = 1; point <= 4; point++) {
        path[`--float-x${point}`] = `${(Math.random() * 2 - 1).toFixed(3)}`;
        path[`--float-y${point}`] = `${(Math.random() * 2 - 1).toFixed(3)}`;
      }
      return path as CSSProperties;
    }),
  );
  return (
    <div className={`brand-scene${settled ? " brand-scene-settled" : ""}`} aria-hidden="true">
      <div className="subscription-glow" />
      <span className="scene-val">
        val<span>.</span>
      </span>
      {brands.map((brand, index) => (
        <span key={brand} className="brand-orbit" style={drift[index]}>
          <span className={`brand-orb brand-orb-${index}`}>
            <span
              className={
                variant === "boot" ? "brand-orb-face brand-orb-neutral" : "brand-orb-face provider-name"
              }
            >
              {variant === "welcome" ? brand : null}
            </span>
          </span>
        </span>
      ))}
    </div>
  );
}

export interface ActiveSubscription {
  id: "current-service" | "margin";
  name: string;
  mark: string;
}

/** Only the selected owner's verified records supply branded bubbles; catalogue listings are not subscriptions. */
export function activeSubscriptions(snapshot: CaseSnapshot | null, now = Date.now()): ActiveSubscription[] {
  if (!snapshot) return [];
  const { receipt, currentAccount, transition } = snapshot;
  const active: ActiveSubscription[] = [];
  const currentBound =
    !currentAccount ||
    (currentAccount.caseId === snapshot.case.id &&
      currentAccount.providerId === "provider_a" &&
      currentAccount.subscriptionId === receipt.oldSubscriptionId &&
      currentAccount.billingStatus === "ACTIVE" &&
      currentAccount.accessStatus === "ACTIVE");
  if (
    currentBound &&
    receipt.oldSubscriptionId &&
    receipt.oldBilling === "ACTIVE" &&
    receipt.oldService === "ACTIVE" &&
    receipt.oldAccessEndsAt &&
    Date.parse(receipt.oldAccessEndsAt) > now
  ) {
    active.push({ id: "current-service", name: "Original service", mark: "v" });
  }
  if (
    transition?.acceptedPurchaseTerms.providerId === "provider_b" &&
    transition.caseId === snapshot.case.id &&
    transition.newSubscriptionId &&
    transition.newSubscriptionId === receipt.newSubscriptionId &&
    receipt.newBillingStatus === "ACTIVE" &&
    receipt.duePayment === "VERIFIED" &&
    receipt.paymentEvidenceId &&
    receipt.capability === "VERIFIED" &&
    receipt.capabilityEvidenceId
  ) {
    active.push({ id: "margin", name: "Margin", mark: "m" });
  }
  return active;
}

/** Original CSS artwork: real active services, plus unbranded glass shapes. No private data persists outside this session. */
export function SubscriptionScene({ subscriptions }: { subscriptions: ActiveSubscription[] }) {
  return (
    <div className={`subscription-scene scene-count-${subscriptions.length}`} aria-hidden="true">
      <div className="subscription-glow" />
      <span className="glass-orb glass-orb-one" />
      <span className="glass-orb glass-orb-two" />
      <span className="glass-orb glass-orb-three" />
      <span className="scene-val">
        val<span>.</span>
      </span>
      {subscriptions.map((service, index) => (
        <span key={service.id} className={`subscription-orb subscription-orb-${index} ${service.id}`}>
          <span className="orb-face">{service.mark}</span>
          <span className="orb-name">{service.name}</span>
        </span>
      ))}
    </div>
  );
}

export function SubscriptionArrival({
  subscriptions,
  onDone,
}: {
  subscriptions: ActiveSubscription[];
  onDone: () => void;
}) {
  return (
    <div
      className="subscription-arrival"
      aria-hidden="true"
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onDone();
      }}
    >
      <SubscriptionScene subscriptions={subscriptions} />
    </div>
  );
}
