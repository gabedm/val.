import type { Config, Merchant, MerchantConfig } from "./config";
import { HttpError } from "./http";

/** The only API and approval hosts this application will talk to or follow. */
export const sandboxApiOrigin = "https://api-m.sandbox.paypal.com";
export const sandboxApprovalOrigin = "https://www.sandbox.paypal.com";

const requestTimeoutMs = 20_000;
const maxTransactionPages = 10;

export interface PaypalMoney {
  currency_code: string;
  value: string;
}

interface PaypalLink {
  rel: string;
  href: string;
}

export interface PaypalSubscription {
  id: string;
  plan_id: string;
  custom_id?: string;
  plan_overridden?: boolean;
  quantity?: string;
  plan?: Omit<PaypalPlan, "id" | "status"> & { id?: string; status?: string };
  status: string;
  start_time?: string;
  shipping_amount?: PaypalMoney;
  billing_info?: {
    outstanding_balance?: PaypalMoney;
    cycle_executions?: {
      tenure_type: string;
      sequence: number;
      cycles_completed: number;
      cycles_remaining?: number;
      total_cycles?: number;
    }[];
    next_billing_time?: string;
    last_payment?: { amount: PaypalMoney; time: string };
  };
  subscriber?: unknown;
  links?: PaypalLink[];
}

export interface PaypalPlan {
  id: string;
  product_id: string;
  name?: string;
  status: string;
  billing_cycles?: {
    tenure_type: string;
    sequence?: number;
    total_cycles: number;
    frequency: { interval_unit: string; interval_count: number };
    pricing_scheme?: { fixed_price?: PaypalMoney; pricing_model?: string };
  }[];
  payment_preferences?: { setup_fee?: PaypalMoney };
  taxes?: { percentage: string; inclusive?: boolean };
  quantity_supported?: boolean;
}

export interface PaypalProduct {
  id: string;
  name: string;
}

export interface PaypalTransaction {
  id: string;
  status?: string;
  time: string;
  amount_with_breakdown?: { gross_amount?: PaypalMoney };
}

export interface WebhookHeaders {
  authAlgo: string;
  certUrl: string;
  transmissionId: string;
  transmissionSig: string;
  transmissionTime: string;
}

/** The request timed out or the connection failed, so a write may or may not have happened. */
export class UnknownOutcomeError extends Error {}

export class PaypalApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly responseName: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface PaypalClient {
  createProduct(body: object, requestId: string): Promise<{ id: string }>;
  createPlan(body: object, requestId: string): Promise<{ id: string }>;
  createSubscription(body: object, requestId: string): Promise<PaypalSubscription>;
  getPlan(planId: string): Promise<PaypalPlan>;
  getProduct?(productId: string): Promise<PaypalProduct>;
  getSubscription(subscriptionId: string, options?: { includePlan: boolean }): Promise<PaypalSubscription>;
  listTransactions(subscriptionId: string, start: Date, end: Date): Promise<PaypalTransaction[]>;
  cancelSubscription(subscriptionId: string, reason: string): Promise<void>;
  verifyWebhookSignature(headers: WebhookHeaders, rawBody: string, webhookId: string): Promise<boolean>;
}

export type PaypalClients = Record<Merchant, PaypalClient | null>;

export function createPaypalClients(
  merchants: Config["merchants"],
  fetchImpl: typeof fetch = fetch,
  retryDelaysMs = [1000, 3000, 10_000],
): PaypalClients {
  const clientFor = (credentials: MerchantConfig | null) =>
    credentials ? createPaypalClient(credentials, fetchImpl, retryDelaysMs) : null;
  return { A: clientFor(merchants.A), B: clientFor(merchants.B) };
}

/** Missing sandbox credentials are an unavailable state, not a crash. */
export function paypalFor(clients: PaypalClients, merchant: Merchant): PaypalClient {
  const client = clients[merchant];
  if (!client)
    throw new HttpError(503, "paypal_unavailable", `PayPal sandbox merchant ${merchant} is not configured.`);
  return client;
}

/** A merchant-scoped client: each merchant has its own credentials and token. */
export function createPaypalClient(
  credentials: MerchantConfig,
  fetchImpl: typeof fetch,
  retryDelaysMs: number[],
): PaypalClient {
  let cachedToken: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;
    const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString("base64");
    const token = await exchange<{ access_token: string; expires_in: number }>(
      `${sandboxApiOrigin}/v1/oauth2/token`,
      {
        method: "POST",
        headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: "grant_type=client_credentials",
      },
    );
    cachedToken = { value: token.access_token, expiresAt: Date.now() + token.expires_in * 1000 };
    return cachedToken.value;
  }

  async function exchange<T>(url: string, init: RequestInit): Promise<T> {
    const { pathname } = new URL(url);
    let response: Response;
    let text: string;
    try {
      response = await fetchImpl(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      text = await response.text();
    } catch (error) {
      throw new UnknownOutcomeError(`PayPal ${init.method} ${pathname} did not complete`, { cause: error });
    }
    if (!response.ok) {
      const failure = errorBody(text);
      const issues = (failure.details ?? []).map((detail) => detail.issue).join(", ");
      throw new PaypalApiError(
        response.status,
        failure.name,
        `PayPal HTTP ${response.status} at ${pathname}: ${failure.name ?? "ERROR"} ${issues}`.trim(),
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async function send<T>(
    path: string,
    method: "GET" | "POST",
    body?: object,
    requestId?: string,
  ): Promise<T> {
    const url = new URL(path, sandboxApiOrigin);
    if (url.origin !== sandboxApiOrigin) throw new Error("Only the PayPal sandbox API is allowed.");
    try {
      return await exchange<T>(url.href, {
        method,
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Type": "application/json",
          Prefer: "return=representation",
          ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (error) {
      if (error instanceof PaypalApiError && error.httpStatus === 401) cachedToken = null;
      throw error;
    }
  }

  /** Reads are safe to repeat, so transient failures are retried; writes never are. */
  async function read<T>(path: string): Promise<T> {
    let refreshed = false;
    const attempt = async (): Promise<T> => {
      try {
        return await send<T>(path, "GET");
      } catch (error) {
        if (error instanceof PaypalApiError && error.httpStatus === 401 && !refreshed) {
          refreshed = true;
          return send<T>(path, "GET");
        }
        throw error;
      }
    };
    for (const delayMs of retryDelaysMs) {
      try {
        return await attempt();
      } catch (error) {
        const transient =
          error instanceof UnknownOutcomeError ||
          (error instanceof PaypalApiError && error.httpStatus >= 500);
        if (!transient) throw error;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return attempt();
  }

  return {
    createProduct: (body, requestId) => send("/v1/catalogs/products", "POST", body, requestId),
    createPlan: (body, requestId) => send("/v1/billing/plans", "POST", body, requestId),
    createSubscription: (body, requestId) => send("/v1/billing/subscriptions", "POST", body, requestId),
    getPlan: (planId) => read(`/v1/billing/plans/${encodeURIComponent(planId)}`),
    getProduct: (productId) => read(`/v1/catalogs/products/${encodeURIComponent(productId)}`),
    getSubscription: (subscriptionId, options) =>
      read(
        `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}${options?.includePlan ? "?fields=plan" : ""}`,
      ),

    async listTransactions(subscriptionId, start, end) {
      const basePath = `/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/transactions`;
      let nextPath: string | null =
        `${basePath}?${new URLSearchParams({ start_time: start.toISOString(), end_time: end.toISOString() })}`;
      const transactions: PaypalTransaction[] = [];
      for (let page = 0; nextPath; page++) {
        if (page === maxTransactionPages) throw new Error("Transaction pagination exceeded its limit.");
        const result: { transactions?: PaypalTransaction[]; links?: PaypalLink[] } = await read(nextPath);
        transactions.push(...(result.transactions ?? []));
        nextPath = nextPageLink(result.links, basePath);
      }
      return transactions;
    },

    async cancelSubscription(subscriptionId, reason) {
      await send(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, "POST", {
        reason,
      });
    },

    async verifyWebhookSignature(headers, rawBody, webhookId) {
      const result = await send<{ verification_status: string }>(
        "/v1/notifications/verify-webhook-signature",
        "POST",
        {
          auth_algo: headers.authAlgo,
          cert_url: headers.certUrl,
          transmission_id: headers.transmissionId,
          transmission_sig: headers.transmissionSig,
          transmission_time: headers.transmissionTime,
          webhook_id: webhookId,
          webhook_event: JSON.parse(rawBody),
        },
      );
      return result.verification_status === "SUCCESS";
    },
  };
}

function errorBody(text: string): { name?: string; details?: { issue: string }[] } {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const item = value as { name?: unknown; details?: unknown };
    return {
      ...(typeof item.name === "string" ? { name: item.name } : {}),
      details: Array.isArray(item.details)
        ? item.details.flatMap((detail) =>
            detail && typeof detail === "object" && typeof detail.issue === "string"
              ? [{ issue: detail.issue }]
              : [],
          )
        : [],
    };
  } catch {
    return {};
  }
}

/** Follows pagination only within the same sandbox API and subscription. */
function nextPageLink(links: PaypalLink[] | undefined, expectedPath: string): string | null {
  const href = links?.find((link) => link.rel === "next")?.href;
  if (!href) return null;
  const url = new URL(href, sandboxApiOrigin);
  if (url.origin !== sandboxApiOrigin || url.pathname !== expectedPath)
    throw new Error("Unexpected transaction pagination link.");
  return url.pathname + url.search;
}

/** Only an HTTPS link on the sandbox approval host may be shown to a buyer. */
export function approvalLink(subscription: PaypalSubscription): string | null {
  const href = subscription.links?.find((link) => link.rel === "approve")?.href;
  const url = href ? URL.parse(href) : null;
  return url && url.origin === sandboxApprovalOrigin ? url.href : null;
}
