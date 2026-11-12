import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { transitions } from "../src/server/db/schema";
import { startTestApp } from "./helpers";
import {
  approvePurchaseAndReturn,
  cancelCallsFor,
  caseAwaitingConsent,
  snapshotOf,
  startPurchase,
} from "./scenarios";

it("honours a completed pause while the exit readiness read is still in flight", async () => {
  const app = await startTestApp();
  try {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const client = app.ctx.paypal.B!;
    const getPlan = client.getPlan.bind(client);
    let paused = false;

    // Pause after the gate has read consent, but before its live plan read completes.
    client.getPlan = async (planId) => {
      const [transition] = await app.ctx.db
        .select()
        .from(transitions)
        .where(eq(transitions.caseId, flow.caseId));
      if (!paused && transition?.capabilityStatus === "VERIFIED" && transition.historyStatus === "VERIFIED") {
        paused = true;
        const response = await flow.browser.post(`/api/cases/${flow.caseId}/pause-exits`, {
          transitionId: transition.id,
        });
        expect(response.status).toBe(200);
      }
      return getPlan(planId);
    };

    await approvePurchaseAndReturn(app, flow, approval);
    expect(paused).toBe(true);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    const snapshot = await snapshotOf(flow.browser, flow.caseId);
    expect(snapshot.receipt.oldBilling).toBe("ACTIVE");
    expect(snapshot.receipt.oldService).toBe("ACTIVE");
  } finally {
    await app.close();
  }
});

it("keeps Provider A when the live replacement plan changes its billing interval", async () => {
  const app = await startTestApp();
  try {
    const flow = await caseAwaitingConsent(app);
    const { approval } = await startPurchase(app, flow);
    const client = app.ctx.paypal.B!;
    const getPlan = client.getPlan.bind(client);
    let changed = false;

    // Initial payment verifies first; the exit gate then observes different future terms at the same price.
    client.getPlan = async (planId) => {
      const plan = await getPlan(planId);
      const [transition] = await app.ctx.db
        .select()
        .from(transitions)
        .where(eq(transitions.caseId, flow.caseId));
      if (transition?.capabilityStatus === "VERIFIED" && transition.historyStatus === "VERIFIED") {
        changed = true;
        plan.billing_cycles![0]!.frequency.interval_unit = "WEEK";
      }
      return plan;
    };

    await approvePurchaseAndReturn(app, flow, approval);
    expect(changed).toBe(true);
    expect(cancelCallsFor(app, flow.setupSubscriptionId)).toHaveLength(0);
    expect((await snapshotOf(flow.browser, flow.caseId)).receipt.oldBilling).toBe("ACTIVE");
  } finally {
    await app.close();
  }
});
