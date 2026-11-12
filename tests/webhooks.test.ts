import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs, operations, webhookEvents } from "../src/server/db/schema";
import { newCase, startSetup, startTestApp, type TestApp } from "./helpers";

// Signature checks go through the PayPal stand-in's verify endpoint, so these tests prove Val's handling
// of verification results. Genuine PayPal signature delivery is a separate sandbox check.

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

interface Delivery {
  providerId?: "provider_a" | "provider_b";
  eventId?: string;
  eventType?: string;
  resource?: object;
  signature?: string;
  withoutHeaders?: boolean;
  rawBody?: string;
}

async function deliver({
  providerId = "provider_a",
  eventId = `WH-EVT-${randomUUID()}`,
  eventType = "BILLING.SUBSCRIPTION.ACTIVATED",
  resource = {},
  signature = "valid-signature",
  withoutHeaders = false,
  rawBody,
}: Delivery) {
  const headers: Record<string, string> = withoutHeaders
    ? {}
    : {
        "paypal-auth-algo": "SHA256withRSA",
        "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
        "paypal-transmission-id": randomUUID(),
        "paypal-transmission-sig": signature,
        "paypal-transmission-time": new Date().toISOString(),
      };
  const response = await fetch(`${app.origin}/api/webhooks/paypal/${providerId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: rawBody ?? JSON.stringify({ id: eventId, event_type: eventType, resource }),
  });
  return { status: response.status, body: await response.json(), eventId };
}

const jobsFor = (caseId: string) => app.ctx.db.select().from(jobs).where(eq(jobs.caseId, caseId));

async function setupWithSubscription() {
  const { browser, caseId } = await newCase(app);
  const { operationId, subscriptionId } = await startSetup(browser, caseId);
  return { browser, caseId, operationId, subscriptionId };
}

describe("PayPal webhook intake", () => {
  it("can accept redelivery after saving the reconciliation job fails", async () => {
    const { caseId, subscriptionId } = await setupWithSubscription();
    const eventId = `WH-EVT-${randomUUID()}`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await app.ctx.db.execute(
      sql`alter table jobs add constraint webhook_queue_failure check (event_id <> ${sql.raw(`'webhook:${eventId}'`)})`,
    );
    try {
      expect((await deliver({ eventId, resource: { id: subscriptionId } })).status).toBe(500);
      expect(
        await app.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.eventId, eventId)),
      ).toHaveLength(0);
      expect(await jobsFor(caseId)).toHaveLength(0);
    } finally {
      await app.ctx.db.execute(sql`alter table jobs drop constraint webhook_queue_failure`);
      quiet.mockRestore();
    }
    expect((await deliver({ eventId, resource: { id: subscriptionId } })).body.status).toBe("queued");
    expect(await jobsFor(caseId)).toHaveLength(1);
  });

  it("queues a fresh read for a verified subscription event and deduplicates redelivery", async () => {
    const { caseId, subscriptionId } = await setupWithSubscription();
    const first = await deliver({ resource: { id: subscriptionId } });
    expect(first).toMatchObject({ status: 200, body: { status: "queued" } });
    expect((await jobsFor(caseId)).map((job) => job.eventId)).toEqual([`webhook:${first.eventId}`]);

    const redelivery = await deliver({ eventId: first.eventId, resource: { id: subscriptionId } });
    expect(redelivery.body.status).toBe("duplicate");
    expect(await jobsFor(caseId)).toHaveLength(1);
  });

  it("resolves payment events through billing_agreement_id", async () => {
    const { caseId, subscriptionId } = await setupWithSubscription();
    const event = await deliver({
      eventType: "PAYMENT.SALE.COMPLETED",
      resource: { id: "SALE-1", billing_agreement_id: subscriptionId },
    });
    expect(event.body.status).toBe("queued");
    expect(await jobsFor(caseId)).toHaveLength(1);
  });

  it("rejects an invalid signature without effect, keeping a sanitized record that cannot block the real event", async () => {
    const { caseId, subscriptionId } = await setupWithSubscription();
    const forged = await deliver({ resource: { id: subscriptionId }, signature: "forged-signature" });
    expect(forged.status).toBe(400);
    expect(await jobsFor(caseId)).toHaveLength(0);

    const [rejection] = await app.ctx.db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.rejectionReason, "invalid_signature"));
    expect(rejection).toMatchObject({ merchant: "A", verified: false, eventId: null });

    const genuine = await deliver({ eventId: forged.eventId, resource: { id: subscriptionId } });
    expect(genuine.body.status).toBe("queued");
  });

  it.each([
    ["missing transmission headers", { withoutHeaders: true }],
    ["a body that is not JSON", { rawBody: "not json" }],
    ["a body with no event ID", { rawBody: JSON.stringify({ event_type: "X" }) }],
  ])("rejects %s", async (_label, delivery) => {
    const result = await deliver(delivery);
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("malformed_delivery");
  });

  it("ignores an event whose subscription belongs to the other merchant context", async () => {
    const { caseId, subscriptionId } = await setupWithSubscription();
    const wrongMerchant = await deliver({ providerId: "provider_b", resource: { id: subscriptionId } });
    expect(wrongMerchant).toMatchObject({ status: 200, body: { status: "ignored" } });
    expect(await jobsFor(caseId)).toHaveLength(0);
  });

  it("ignores events for subscriptions Val did not create", async () => {
    expect((await deliver({ resource: { id: "I-NOT-OURS" } })).body.status).toBe("ignored");
    expect((await deliver({ resource: {} })).body.status).toBe("ignored");
  });

  it("cannot verify, and stores nothing, when no webhook ID is configured", async () => {
    const configured = app.ctx.config.merchants.A!.webhookId;
    app.ctx.config.merchants.A!.webhookId = null;
    try {
      const before = (await app.ctx.db.select().from(webhookEvents)).length;
      expect((await deliver({ resource: { id: "I-ANY" } })).status).toBe(503);
      expect((await app.ctx.db.select().from(webhookEvents)).length).toBe(before);
    } finally {
      app.ctx.config.merchants.A!.webhookId = configured;
    }
  });

  it("asks PayPal to redeliver when verification itself is unavailable", async () => {
    app.paypal.verificationFails = true;
    try {
      const result = await deliver({ resource: { id: "I-ANY" } });
      expect(result.status).toBe(503);
      const stored = await app.ctx.db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.eventId, result.eventId));
      expect(stored).toHaveLength(0);
    } finally {
      app.paypal.verificationFails = false;
    }
  });
});

describe("webhooks are signals, not authority", () => {
  it("does not mark a subscription cancelled because an event says so", async () => {
    const { browser, caseId, operationId, subscriptionId } = await setupWithSubscription();
    app.paypal.approve(subscriptionId);
    await deliver({
      eventType: "BILLING.SUBSCRIPTION.CANCELLED",
      resource: { id: subscriptionId, status: "CANCELLED" },
    });
    await app.runJobs();

    const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.id, operationId));
    expect(operation).toMatchObject({ billingStatus: "ACTIVE", paymentStatus: "VERIFIED" });
    expect((await browser.get(`/api/cases/${caseId}`)).body.receipt.oldBilling).toBe("ACTIVE");
  });

  it("lets a delayed activation event reconcile current state without regressing it", async () => {
    const { caseId, operationId, subscriptionId } = await setupWithSubscription();
    app.paypal.approve(subscriptionId);
    await deliver({ resource: { id: subscriptionId } });
    await app.runJobs();

    app.paypal.subscriptions.get(subscriptionId)!.status = "CANCELLED";
    await deliver({ eventType: "BILLING.SUBSCRIPTION.CANCELLED", resource: { id: subscriptionId } });
    await app.runJobs();
    await deliver({ eventType: "BILLING.SUBSCRIPTION.ACTIVATED", resource: { id: subscriptionId } });
    await app.runJobs();

    const [operation] = await app.ctx.db.select().from(operations).where(eq(operations.id, operationId));
    expect(operation).toMatchObject({ billingStatus: "CANCELLED", paymentStatus: "VERIFIED" });
    expect(await jobsFor(caseId)).toHaveLength(3);
  });
});
