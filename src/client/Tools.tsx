import { useEffect, useState } from "react";
import type { ApprovalResult, AsyncCommandResult, CaseSnapshot, Operation } from "../shared/contracts.types";
import { api } from "./api";
import { BackLine, Notice, useCommand } from "./ui";

const faults = ["price_change", "output_failure", "import_failure", "timeout"] as const;

/** Administrator-only controls outside the consumer journey: demo cases, harness faults and sandbox probes. */
export function ReviewTools({
  caseId,
  snapshot,
  refresh,
  onCreated,
}: {
  caseId: string | null;
  snapshot: CaseSnapshot | null;
  refresh: () => Promise<void>;
  onCreated: (caseId: string) => void;
}) {
  const command = useCommand(refresh);
  const [operations, setOperations] = useState<Operation[]>([]);
  const loadOperations = () => api.probeOperations().then(setOperations);
  useEffect(() => void loadOperations(), []);

  const start = (begin: () => Promise<ApprovalResult | AsyncCommandResult>) =>
    command.run(async () => {
      const result = await begin();
      if ("approvalUrl" in result) location.assign(result.approvalUrl);
      await loadOperations();
    });

  return (
    <main className="page narrow has-nav">
      <BackLine to="you" step="Review tools" />
      <h1>Review tools</h1>
      <p className="lead">
        Administrator controls outside the consumer journey. Faults are labelled wherever they change a case.
      </p>
      <section className="form-card screen-controls">
        <button
          onClick={() =>
            command.run(async () =>
              onCreated((await api.createCase({ scenario: "feature_removed" })).case.id),
            )
          }
        >
          New case: feature removed
        </button>
        <button
          onClick={() =>
            command.run(async () => onCreated((await api.createCase({ scenario: "grandfathered" })).case.id))
          }
        >
          New case: grandfathered
        </button>
        <button
          onClick={() =>
            command.run(async () => onCreated((await api.createCase({ scenario: "value_offer" })).case.id))
          }
        >
          New case: dated renewal and paid offer
        </button>
      </section>
      {caseId &&
        snapshot?.case.id === caseId &&
        snapshot.case.scenario === "value_offer" &&
        !snapshot.case.archivedAt &&
        snapshot.policy?.allowInvestigation &&
        ["MONITORING", "STAY"].includes(snapshot.case.state) &&
        snapshot.currentAccount?.entitlementRevision === 1 &&
        !snapshot.handover &&
        !snapshot.transition && (
          <section className="form-card">
            <h2>Controlled merchant notice</h2>
            <p className="note">
              This records an authored future renewal notice for this isolated case; it does not change or
              bill an existing PayPal subscription.
            </p>
            <button
              disabled={command.pending}
              onClick={() =>
                command.run(
                  () => api.applyEvent(caseId, "value_offer"),
                  "Notice recorded; Val is checking the new terms.",
                )
              }
            >
              Record Original service’s dated price notice
            </button>
          </section>
        )}
      {caseId && (
        <section className="form-card">
          <h2>Test faults for this case</h2>
          {faults.map((fault) => (
            <p key={fault} className="row">
              <span>{fault.replace("_", " ")}</span>
              <span>
                <button
                  className="text-button"
                  onClick={() => command.run(() => api.setFault(caseId, fault, true), `${fault} on.`)}
                >
                  On
                </button>{" "}
                <button
                  className="text-button"
                  onClick={() => command.run(() => api.setFault(caseId, fault, false), `${fault} off.`)}
                >
                  Off
                </button>
              </span>
            </p>
          ))}
        </section>
      )}
      {caseId && (
        <section className="form-card">
          <h2>Connection checks</h2>
          <p className="note">
            Disposable subscriptions for checking each merchant’s return and payment evidence.
          </p>
          <div className="screen-controls">
            <button onClick={() => start(() => api.probeSubscription(caseId, "provider_a"))}>
              Probe Original service (£12)
            </button>
            <button onClick={() => start(() => api.probeSubscription(caseId, "provider_b"))}>
              Probe Margin (£14)
            </button>
          </div>
          {operations.map((operation) => (
            <div key={operation.id} className="row">
              <span>
                {operation.kind} · {operation.status} · {operation.remoteId ?? "no subscription yet"}
              </span>
              <span>
                {operation.kind !== "probe_cancel" && operation.remoteId && (
                  <button
                    className="text-button"
                    onClick={() =>
                      command.run(async () => {
                        await api.probeCancel(operation.id);
                        await loadOperations();
                      })
                    }
                  >
                    Cancel probe
                  </button>
                )}{" "}
                {operation.remoteId && (
                  <button
                    className="text-button"
                    onClick={() =>
                      command.run(async () => {
                        await api.cleanup(operation.id, {
                          expectedClaimGeneration: operation.claimGeneration,
                        });
                        await loadOperations();
                      })
                    }
                  >
                    Retire if terminal
                  </button>
                )}
              </span>
            </div>
          ))}
        </section>
      )}
      <Notice text={command.message} />
    </main>
  );
}
