import type { PayPalWalletCandidate, WalletCandidateChoice } from "../shared/paypal-wallet";
import { billingCycles, billingCycleLabel } from "../shared/subscriptions";
import { money } from "./ui";

export function WalletPaymentReview({
  candidate,
  busy = false,
  onChoose,
}: {
  candidate: PayPalWalletCandidate;
  busy?: boolean;
  onChoose: (choice: WalletCandidateChoice) => void;
}) {
  return (
    <section
      className="wallet-payment-review"
      aria-label={`Review ${candidate.merchant} payment`}
      aria-busy={busy}
    >
      <h2>{candidate.merchant}</h2>
      <p>
        Last PayPal payment: <strong>{money(candidate.lastPaymentMinor, candidate.currency)}</strong> on{" "}
        {new Date(candidate.lastPaidOn + "T00:00:00Z").toLocaleDateString("en-GB", {
          timeZone: "UTC",
          day: "numeric",
          month: "short",
          year: "numeric",
        })}
        .
      </p>
      <p>
        {candidate.historyCycle
          ? `History suggests payments every ${billingCycleLabel(candidate.historyCycle)}.`
          : "Not enough payment history to confirm a recurring bill."}
      </p>
      <p>How often do you pay this?</p>
      <div className="wallet-review-actions">
        {billingCycles.map((cycle) => (
          <button
            key={cycle}
            className="button"
            disabled={busy}
            aria-pressed={candidate.choice === cycle}
            onClick={() => onChoose(cycle)}
          >
            Every {billingCycleLabel(cycle)}
          </button>
        ))}
        <button
          className="text-button"
          disabled={busy}
          aria-pressed={candidate.choice === "not_recurring"}
          onClick={() => onChoose("not_recurring")}
        >
          Not a subscription
        </button>
        <button
          className="text-button"
          disabled={busy}
          aria-pressed={candidate.choice === "later"}
          onClick={() => onChoose("later")}
        >
          Skip for now
        </button>
      </div>
      <p className="wallet-privacy">
        For another frequency or an uncertain amount, skip for now. Review it later in Account.
      </p>
    </section>
  );
}
