import { randomUUID } from "node:crypto";
import { sandboxApiOrigin } from "../src/server/paypal";
import { fixturePlans } from "../src/server/plans";

// Preserve PayPal's one-decimal cases without rounding bills that contain pennies.
const decimalPrice = (minor: number) => (minor / 100).toFixed(minor % 10 ? 2 : 1);

/**
 * A local stand-in for the PayPal sandbox HTTP API, used only by contract tests. It follows the
 * original-plan behaviours observed in the sandbox probe (one-decimal plan prices, two-decimal gross,
 * transactions 404 before approval, merchant isolation and idempotent PayPal-Request-Id). Its paid-intro
 * cycle is authored from the official API format, not proof of a live offer. Results are never sandbox evidence.
 */

interface StoredSubscription {
  id: string;
  merchant: "A" | "B";
  planId: string;
  customId: string;
  status: string;
  createdAt: Date;
  paidAt: Date | null;
  paidMinor: number;
  transactions: object[];
}

export interface ApprovalOptions {
  /** Gross value the buyer is charged, e.g. "12.00". Defaults to the first paid cycle. */
  gross?: string;
  currency?: string;
  transactionStatus?: string;
  outstanding?: string;
  /** Approved and ACTIVE, but with no transaction recorded (ACTIVE alone must not pass). */
  withoutTransaction?: boolean;
  duplicateTransaction?: boolean;
}

export class PaypalStandIn {
  readonly calls: { merchant: string | null; method: string; path: string }[] = [];
  readonly subscriptions = new Map<string, StoredSubscription>();
  readonly planPriceMinor = new Map<string, number>();
  readonly planNames = new Map<string, string>();
  readonly planProducts = new Map<string, string>();
  readonly productNames = new Map<string, string>();
  private readonly introductory: Map<string, { minor: number; cycles: number }> = new Map(
    fixturePlans.flatMap((plan) =>
      plan.introductoryMinor !== undefined && plan.introductoryCycles !== undefined
        ? [
            [
              `P-${plan.planId.toUpperCase()}`,
              { minor: plan.introductoryMinor, cycles: plan.introductoryCycles },
            ] as const,
          ]
        : [],
    ),
  );
  readonly createRequests: { merchant: string; requestId: string; body: any }[] = [];
  loseNextCreateResponse = false;
  approvalOrigin = "https://www.sandbox.paypal.com";
  verificationFails = false;
  /** Every cancel request is answered with an HTTP 500, as if PayPal were unavailable. */
  cancelsFail = false;
  private readonly renewals = new Map<string, number>();
  private readonly requestIds = new Map<string, string>();
  private readonly outstanding = new Map<string, string>();
  private nextId = 1;
  /** Distinguishes subscriptions from other stand-in instances sharing one test database. */
  private readonly prefix = randomUUID().slice(0, 8).toUpperCase();

  constructor(
    planPrices: Record<string, number>,
    private readonly webhookIds: Record<"A" | "B", string> = { A: "WH-A", B: "WH-B" },
  ) {
    for (const [planId, price] of Object.entries(planPrices)) this.planPriceMinor.set(planId, price);
  }

  approve(subscriptionId: string, options: ApprovalOptions = {}) {
    const subscription = this.subscriptions.get(subscriptionId)!;
    const paidAt = new Date();
    subscription.status = "ACTIVE";
    subscription.paidAt = paidAt;
    subscription.paidMinor =
      this.introductory.get(subscription.planId)?.minor ?? this.planPriceMinor.get(subscription.planId)!;
    const transaction = {
      id: `TXN-${subscriptionId}`,
      status: options.transactionStatus ?? "COMPLETED",
      time: paidAt.toISOString().replace(/\.\d+Z$/, ".000Z"),
      amount_with_breakdown: {
        gross_amount: {
          currency_code: options.currency ?? "GBP",
          value: options.gross ?? (subscription.paidMinor / 100).toFixed(2),
        },
      },
    };
    if (!options.withoutTransaction)
      subscription.transactions = options.duplicateTransaction
        ? [transaction, { ...transaction, id: `${transaction.id}-2` }]
        : [transaction];
    this.outstanding.set(subscriptionId, options.outstanding ?? "0.0");
  }

  private nextBillingOf(subscription: StoredSubscription): Date {
    const paidAt = subscription.paidAt!;
    const months = 1 + (this.renewals.get(subscription.id) ?? 0);
    return new Date(
      Date.UTC(paidAt.getUTCFullYear(), paidAt.getUTCMonth() + months, paidAt.getUTCDate(), 10),
    );
  }

  /** The next monthly charge is taken: the billing boundary moves on a month and, unless omitted, its transaction appears. */
  renew(subscriptionId: string, options: { withoutTransaction?: boolean } = {}) {
    const subscription = this.subscriptions.get(subscriptionId)!;
    const boundary = this.nextBillingOf(subscription);
    const completed = this.renewals.get(subscriptionId) ?? 0;
    this.renewals.set(subscriptionId, completed + 1);
    if (options.withoutTransaction) return;
    const offer = this.introductory.get(subscription.planId);
    const minor =
      offer && completed + 1 < offer.cycles ? offer.minor : this.planPriceMinor.get(subscription.planId)!;
    subscription.transactions.push({
      id: `TXN-${subscriptionId}-renewal${completed ? `-${completed + 1}` : ""}`,
      status: "COMPLETED",
      time: boundary.toISOString().replace(/\.\d+Z$/, ".000Z"),
      amount_with_breakdown: { gross_amount: { currency_code: "GBP", value: (minor / 100).toFixed(2) } },
    });
  }

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const merchant = headers.get("authorization")?.startsWith("Bearer token-")
      ? (headers.get("authorization")!.slice(-1) as "A" | "B")
      : null;
    this.calls.push({ merchant, method, path: url.pathname });
    if (url.origin !== sandboxApiOrigin) throw new Error(`Stand-in refused non-sandbox origin ${url.origin}`);

    if (url.pathname === "/v1/oauth2/token") {
      const client = Buffer.from(headers.get("authorization")!.slice("Basic ".length), "base64")
        .toString()
        .split(":")[0]!;
      return json(200, { access_token: `token-${client.slice(-1)}`, expires_in: 32000 });
    }
    if (!merchant) return json(401, { name: "AUTHENTICATION_FAILURE" });

    const body = init.body ? JSON.parse(String(init.body)) : {};
    const [, , , resource, id, action] = url.pathname.split("/");
    if (url.pathname === "/v1/notifications/verify-webhook-signature")
      return this.verifyWebhook(merchant, body);
    if (resource === "plans" && id) return this.planResponse(id);
    if (resource === "products" && id && method === "GET") {
      const name = this.productNames.get(id);
      return name ? json(200, { id, name }) : json(404, { name: "RESOURCE_NOT_FOUND" });
    }
    if (resource === "subscriptions" && method === "POST" && !id)
      return this.createSubscription(merchant, headers.get("paypal-request-id")!, body);

    const subscription = id ? this.subscriptions.get(id) : undefined;
    if (!subscription || subscription.merchant !== merchant) return json(404, { name: "RESOURCE_NOT_FOUND" });
    if (action === "transactions") {
      return subscription.paidAt || subscription.status === "ACTIVE"
        ? json(200, { transactions: subscription.transactions, links: [] })
        : json(404, { name: "RESOURCE_NOT_FOUND" });
    }
    if (action === "cancel") {
      if (this.cancelsFail) return json(500, { name: "INTERNAL_SERVICE_ERROR" });
      if (!["ACTIVE", "SUSPENDED"].includes(subscription.status))
        return json(422, {
          name: "UNPROCESSABLE_ENTITY",
          details: [{ issue: "SUBSCRIPTION_STATUS_INVALID" }],
        });
      subscription.status = "CANCELLED";
      return new Response(null, { status: 204 });
    }
    return json(200, this.subscriptionBody(subscription));
  };

  private createSubscription(
    merchant: "A" | "B",
    requestId: string,
    body: { plan_id: string; custom_id: string },
  ) {
    this.createRequests.push({ merchant, requestId, body });
    const existingId = this.requestIds.get(`${merchant}:${requestId}`);
    const subscription: StoredSubscription = existingId
      ? this.subscriptions.get(existingId)!
      : {
          id: `I-${this.prefix}-${this.nextId++}`,
          merchant,
          planId: body.plan_id,
          customId: body.custom_id,
          status: "APPROVAL_PENDING",
          createdAt: new Date(),
          paidAt: null,
          paidMinor: 0,
          transactions: [],
        };
    this.subscriptions.set(subscription.id, subscription);
    this.requestIds.set(`${merchant}:${requestId}`, subscription.id);
    if (this.loseNextCreateResponse) {
      this.loseNextCreateResponse = false;
      throw new DOMException("The operation timed out.", "TimeoutError");
    }
    return json(201, this.subscriptionBody(subscription));
  }

  private subscriptionBody(subscription: StoredSubscription) {
    const base = {
      id: subscription.id,
      plan_id: subscription.planId,
      custom_id: subscription.customId,
      status: subscription.status,
      subscriber: { email_address: "buyer@example.invalid" },
      links: [
        {
          rel: "approve",
          href: `${this.approvalOrigin}/webapps/billing/subscriptions?ba_token=BA-${subscription.id}`,
        },
      ],
    };
    if (!subscription.paidAt) return base;
    const nextBilling = this.nextBillingOf(subscription);
    return {
      ...base,
      start_time: subscription.createdAt.toISOString().replace(/\.\d+Z$/, "Z"),
      billing_info: {
        outstanding_balance: { currency_code: "GBP", value: this.outstanding.get(subscription.id) ?? "0.0" },
        ...(this.introductory.has(subscription.planId)
          ? {
              cycle_executions: [
                {
                  tenure_type: "TRIAL",
                  sequence: 1,
                  total_cycles: this.introductory.get(subscription.planId)!.cycles,
                  cycles_completed: 1,
                  cycles_remaining: this.introductory.get(subscription.planId)!.cycles - 1,
                },
                {
                  tenure_type: "REGULAR",
                  sequence: 2,
                  total_cycles: 0,
                  cycles_completed: 0,
                  cycles_remaining: 0,
                },
              ],
            }
          : {}),
        next_billing_time: nextBilling.toISOString().replace(/\.\d+Z$/, "Z"),
        last_payment: {
          amount: { currency_code: "GBP", value: decimalPrice(subscription.paidMinor) },
          time: subscription.paidAt.toISOString().replace(/\.\d+Z$/, "Z"),
        },
      },
    };
  }

  private planResponse(planId: string) {
    const price = this.planPriceMinor.get(planId);
    if (price === undefined) return json(404, { name: "RESOURCE_NOT_FOUND" });
    return json(200, {
      id: planId,
      product_id: this.planProducts.get(planId) ?? "PROD-STANDIN",
      ...(this.planNames.has(planId) ? { name: this.planNames.get(planId) } : {}),
      status: "ACTIVE",
      billing_cycles: [
        ...(this.introductory.has(planId)
          ? [
              {
                tenure_type: "TRIAL",
                sequence: 1,
                total_cycles: this.introductory.get(planId)!.cycles,
                frequency: { interval_unit: "MONTH", interval_count: 1 },
                pricing_scheme: {
                  fixed_price: {
                    currency_code: "GBP",
                    value: decimalPrice(this.introductory.get(planId)!.minor),
                  },
                },
              },
            ]
          : []),
        {
          tenure_type: "REGULAR",
          sequence: this.introductory.has(planId) ? 2 : 1,
          total_cycles: 0,
          frequency: { interval_unit: "MONTH", interval_count: 1 },
          pricing_scheme: { fixed_price: { currency_code: "GBP", value: decimalPrice(price) } },
        },
      ],
      payment_preferences: { auto_bill_outstanding: true },
    });
  }

  private verifyWebhook(merchant: "A" | "B", body: { webhook_id: string; transmission_sig: string }) {
    if (this.verificationFails) return json(500, { name: "INTERNAL_SERVICE_ERROR" });
    if (body.webhook_id !== this.webhookIds[merchant]) return json(400, { name: "INVALID_RESOURCE_ID" });
    return json(200, {
      verification_status: body.transmission_sig === "valid-signature" ? "SUCCESS" : "FAILURE",
    });
  }
}

function json(status: number, body: object) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
