import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import express, { Router, type Request } from "express";
import type { Merchant } from "./config";
import type { AppContext } from "./context";
import { operations, webhookEvents } from "./db/schema";
import { HttpError } from "./http";
import { queueJob } from "./jobs";
import { PaypalApiError, paypalFor, type WebhookHeaders } from "./paypal";
import { merchantForProvider } from "./plans";

interface PaypalEvent {
  id: string;
  event_type: string;
  resource?: { id?: string; billing_agreement_id?: string };
}

function transmissionHeaders(req: Request): WebhookHeaders | null {
  const headers = {
    authAlgo: req.get("paypal-auth-algo"),
    certUrl: req.get("paypal-cert-url"),
    transmissionId: req.get("paypal-transmission-id"),
    transmissionSig: req.get("paypal-transmission-sig"),
    transmissionTime: req.get("paypal-transmission-time"),
  };
  return Object.values(headers).every(Boolean) ? (headers as WebhookHeaders) : null;
}

function parseEvent(rawBody: string): PaypalEvent | null {
  try {
    const event = JSON.parse(rawBody);
    return typeof event?.id === "string" && typeof event.event_type === "string" ? event : null;
  } catch {
    return null;
  }
}

/**
 * Receives PayPal webhooks for one merchant context. The raw body must be verified with PayPal
 * against that merchant's webhook ID before anything is stored. A verified event only queues a
 * fresh read of the subscription; it never changes local status itself.
 */
export function webhookRoutes(ctx: AppContext): Router {
  const router = Router();

  router.post(
    "/webhooks/paypal/:providerId",
    express.raw({ type: () => true, limit: "64kb" }),
    async (req, res) => {
      const merchant = merchantForProvider(req.params.providerId);
      if (!merchant) throw new HttpError(404, "unknown_provider", "Unknown provider.");
      const webhookId = ctx.config.merchants[merchant]?.webhookId;
      if (!webhookId)
        throw new HttpError(
          503,
          "webhook_unconfigured",
          `No webhook ID is configured for merchant ${merchant}, so events cannot be verified.`,
        );

      const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      const headers = transmissionHeaders(req);
      const event = parseEvent(rawBody);
      if (!headers || !event) return rejectDelivery(ctx, merchant, "malformed_delivery");

      if (!(await signatureVerified(ctx, merchant, headers, rawBody, webhookId)))
        return rejectDelivery(ctx, merchant, "invalid_signature");

      // Receipt and job must commit together so a failed queue write can be safely redelivered.
      const status = await ctx.db.transaction(async (tx) => {
        const [stored] = await tx
          .insert(webhookEvents)
          .values({
            id: randomUUID(),
            merchant,
            eventId: event.id,
            eventType: event.event_type,
            verified: true,
          })
          .onConflictDoNothing()
          .returning();
        if (!stored) return "duplicate";

        // Payment events reference the subscription through billing_agreement_id.
        const subscriptionIds = [event.resource?.id, event.resource?.billing_agreement_id].filter(
          (id): id is string => typeof id === "string",
        );
        const [operation] = subscriptionIds.length
          ? await tx
              .select({ caseId: operations.caseId })
              .from(operations)
              .where(and(eq(operations.merchant, merchant), inArray(operations.remoteId, subscriptionIds)))
          : [];
        if (!operation) return "ignored";

        await queueJob(tx, operation.caseId, `webhook:${event.id}`);
        return "queued";
      });
      res.json({ status });
    },
  );

  return router;
}

async function signatureVerified(
  ctx: AppContext,
  merchant: Merchant,
  headers: WebhookHeaders,
  rawBody: string,
  webhookId: string,
): Promise<boolean> {
  try {
    return await paypalFor(ctx.paypal, merchant).verifyWebhookSignature(headers, rawBody, webhookId);
  } catch (error) {
    // PayPal refusing the verification request counts as unverified; an outage asks PayPal to redeliver.
    if (error instanceof PaypalApiError && error.httpStatus < 500) return false;
    throw new HttpError(503, "verification_unavailable", "Webhook verification is temporarily unavailable.");
  }
}

/** Keeps a sanitized record of the refusal, without the body or any claimed event ID. */
async function rejectDelivery(
  ctx: AppContext,
  merchant: Merchant,
  reason: "malformed_delivery" | "invalid_signature",
): Promise<never> {
  await ctx.db
    .insert(webhookEvents)
    .values({ id: randomUUID(), merchant, verified: false, rejectionReason: reason });
  throw new HttpError(400, reason, "Webhook delivery rejected.");
}
