import type { CaseSnapshot } from "../shared/contracts.types";
import { api } from "./api";
import { BackLine, Notice, Row, fullDate, go, useCommand } from "./ui";

/** Retained setup records are payment history/recovery, never an invitation to buy the retired demo. */
export function SavedSetupPayment({
  snapshot,
  refresh,
}: {
  snapshot: CaseSnapshot;
  refresh: () => Promise<void>;
}) {
  const command = useCommand(refresh);
  const { receipt, handover } = snapshot;
  const recorded = !!handover || !!receipt.oldSubscriptionId;
  return (
    <main className="page narrow has-nav">
      <BackLine to="activity" step="Saved payment" />
      <h1>{recorded ? "Your saved payment" : "No payment recorded."}</h1>
      <p className="lead">
        {recorded ? "This is an earlier payment record." : "This earlier setup has no payment to resume."}
      </p>
      {recorded && (
        <section className="card below">
          <Row
            label="Billing"
            value={
              receipt.oldBilling === "ACTIVE"
                ? "Verified active"
                : receipt.oldBilling === "CANCELLED"
                  ? "Cancelled"
                  : "Not verified"
            }
          />
          <Row label="Paid through" value={fullDate(receipt.oldAccessEndsAt)} />
          {handover?.approvalUrl && (
            <button className="button below" onClick={() => location.assign(handover.approvalUrl!)}>
              Resume existing PayPal approval
            </button>
          )}
          <button
            className="text-button below"
            disabled={command.pending}
            onClick={() => command.run(() => api.reconcile(snapshot.case.id), "Payment status checked.")}
          >
            Check existing payment
          </button>
          <Notice text={command.message} />
        </section>
      )}
      <button className="button light below" onClick={() => go("subscriptions")}>
        View subscriptions
      </button>
    </main>
  );
}
