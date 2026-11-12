import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { hashPassword } from "../src/server/auth";
import { loadConfig } from "../src/server/config";
import type { AppContext } from "../src/server/context";
import { connect, migrateDatabase } from "../src/server/db";
import { runQueuedJobs } from "../src/server/jobs";
import { runCaseJob } from "../src/server/casework";
import { createPaypalClients } from "../src/server/paypal";
import { fixturePlans } from "../src/server/plans";
import { createApp } from "../src/server/routes";
import { paypalSubscriptionLinks } from "../src/server/db/schema";
import { randomUUID } from "node:crypto";
import { ModelStandIn } from "./model-standin";
import { PaypalStandIn } from "./paypal-standin";
import type { WalletRuntime } from "../src/server/paypal-wallet-runtime";
import { subscriptionAdviceFormat } from "../src/shared/subscriptions";
import { stopChatRequests } from "../src/server/chat-requests";

export const reviewerLogin = { username: "judge", password: "judge-password" };
export const adminLogin = { username: "admin", password: "admin-password" };

/** Plan IDs the stand-in PayPal knows, derived from the same fixtures the app uses. */
export const planMapping = Object.fromEntries(
  fixturePlans.map((plan) => [
    plan.planId,
    { productId: "PROD-STANDIN", paypalPlanId: `P-${plan.planId.toUpperCase()}` },
  ]),
);

export interface TestApp {
  ctx: AppContext;
  origin: string;
  paypal: PaypalStandIn;
  model: ModelStandIn;
  browser(): Browser;
  runJobs(): Promise<number>;
  close(): Promise<void>;
}

/** Explicit trusted binding; a case by itself no longer imports the retired provider-A demo. */
export async function linkSetupSubscription(app: TestApp, browser: Browser, caseId: string) {
  const snapshot = (await browser.get(`/api/cases/${caseId}`)).body;
  const subscription = await app.ctx.paypal.A!.getSubscription(snapshot.receipt.oldSubscriptionId);
  await app.ctx.db.insert(paypalSubscriptionLinks).values({
    id: randomUUID(),
    ownerId: snapshot.case.ownerId,
    merchant: "A",
    subscriptionId: subscription.id,
    planId: subscription.plan_id,
    customId: subscription.custom_id!,
    serviceId: "netflix",
    name: "Netflix",
  });
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as { port: number };
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the real application against the real test PostgreSQL, with PayPal and the OpenAI model replaced by local
 * stand-ins. Pass an existing PayPal stand-in to start a second instance over the same remote state, as after a restart.
 */
export async function startTestApp(existing?: {
  paypal?: PaypalStandIn;
  identityFetch?: typeof fetch;
  databaseUrl?: string;
  buildProfile?: "public" | "judge" | "owner";
  httpRequestLimits?: boolean;
  trustedProxyCidrs?: string[];
  paypalIdentityEnvironment?: "sandbox" | "live";
  walletRuntime?: WalletRuntime;
  paypalWalletEnvironment?: "sandbox" | "live";
  sandboxSubscriptions?: import("../src/server/sandbox-demo").SandboxSubscriptionBinding[];
}): Promise<TestApp> {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    VAL_BUILD_PROFILE: existing?.buildProfile ?? "owner",
    DATABASE_URL: existing?.databaseUrl ?? process.env.TEST_DATABASE_URL,
    // The live route fixture uses local HTTP transport, not a claim of real TLS/provider acceptance.
    APP_ORIGIN: existing?.paypalIdentityEnvironment === "live" ? origin.replace("http:", "https:") : origin,
    SESSION_SECRET: "test-session-secret-0123456789abcdef",
    JUDGE_USERNAME: reviewerLogin.username,
    JUDGE_PASSWORD_HASH: await hashPassword(reviewerLogin.password),
    ADMIN_USERNAME: adminLogin.username,
    ADMIN_PASSWORD_HASH: await hashPassword(adminLogin.password),
    ...(existing?.walletRuntime
      ? {
          VAL_PAYPAL_WALLET: "true",
          KERNEL_API_KEY: "synthetic-wallet-key",
          PAYPAL_WALLET_ENVIRONMENT: existing.paypalWalletEnvironment ?? "sandbox",
        }
      : {}),
    ...(existing?.buildProfile === "judge" || existing?.sandboxSubscriptions?.length
      ? {
          VAL_JUDGE_DEMO: "true",
          JUDGE_DEMO_USERNAME: reviewerLogin.username,
          JUDGE_DEMO_PASSWORD_HASH: await hashPassword(reviewerLogin.password),
        }
      : {}),
    ...(existing?.paypalIdentityEnvironment === "live"
      ? {
          PAYPAL_IDENTITY_ENVIRONMENT: "live",
          PAYPAL_LIVE_LOGIN_CLIENT_ID: "live-test-client",
          PAYPAL_LIVE_LOGIN_CLIENT_SECRET: "synthetic-live-secret",
        }
      : {
          PAYPAL_A_CLIENT_ID: "client-A",
          PAYPAL_A_CLIENT_SECRET: "secret-A",
          PAYPAL_A_WEBHOOK_ID: "WH-A",
          PAYPAL_B_CLIENT_ID: "client-B",
          PAYPAL_B_CLIENT_SECRET: "secret-B",
          PAYPAL_B_WEBHOOK_ID: "WH-B",
        }),
  });
  const { pool, db } = connect(config.databaseUrl);
  config.paypalSandboxSubscriptions = existing?.sandboxSubscriptions ?? null;
  // Functional tests exercise their own bounded requests; adversarial tests explicitly enable the HTTP gate.
  config.httpRequestLimits = existing?.httpRequestLimits ?? false;
  config.trustedProxyCidrs = existing?.trustedProxyCidrs ?? [];
  await migrateDatabase(db);

  const paypal =
    existing?.paypal ??
    new PaypalStandIn(
      Object.fromEntries(fixturePlans.map((plan) => [`P-${plan.planId.toUpperCase()}`, plan.recurringMinor])),
    );
  const model = new ModelStandIn();
  const ctx: AppContext = {
    db,
    config,
    paypal: createPaypalClients(config.merchants, paypal.fetch, []),
    planMapping,
    model,
    walletRuntime: existing?.walletRuntime,
  };

  // A hidden parent checks return-page routing when the checkout itself is hidden.
  const clientDir = join(mkdtempSync(join(tmpdir(), "val-test-client-")), ".checkout", "client");
  mkdirSync(clientDir, { recursive: true });
  writeFileSync(join(clientDir, "index.html"), "<!doctype html><title>Val</title>");
  const server: Server = createApp(ctx, clientDir, existing?.identityFetch).listen(port, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));

  return {
    ctx,
    origin,
    paypal,
    model,
    browser: () => new Browser(origin, config.appOrigin),
    runJobs: () => runQueuedJobs(ctx, (job, commit) => runCaseJob(ctx, job, commit)),
    close: async () => {
      await stopChatRequests(ctx);
      await new Promise((resolve) => server.close(resolve));
      await pool.end();
    },
  };
}

/** A logged-in browser profile (its own owner) with a fresh SETUP case. */
export async function newCase(
  app: TestApp,
  login = reviewerLogin,
  scenario: "feature_removed" | "grandfathered" | "value_offer" = "feature_removed",
) {
  const browser = app.browser();
  await browser.login(login);
  const created = await browser.post("/api/cases", { scenario });
  return { browser, caseId: created.body.case.id as string };
}

export async function startSetup(browser: Browser, caseId: string) {
  const response = await browser.post(`/api/cases/${caseId}/setup-subscription`);
  expect(response.status).toBe(200);
  return response.body as { operationId: string; subscriptionId: string; approvalUrl: string };
}

export interface ApiResponse {
  status: number;
  body: any;
  headers: Headers;
}

/** A minimal cookie-keeping HTTP client that behaves like one browser profile. */
export class Browser {
  csrf = "";
  private readonly cookies = new Map<string, string>();

  constructor(
    private readonly origin: string,
    private readonly requestOrigin = origin,
  ) {}

  async request(
    method: string,
    path: string,
    body?: object,
    options: {
      csrf?: string | null;
      origin?: string;
      adviceFormat?: string | null;
      forwardedFor?: string;
    } = {},
  ): Promise<ApiResponse> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Cookie: [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; "),
    };
    if (options.adviceFormat !== null)
      headers["X-Val-Advice-Format"] = options.adviceFormat ?? subscriptionAdviceFormat;
    if (options.forwardedFor) headers["X-Forwarded-For"] = options.forwardedFor;
    if (method !== "GET") headers.Origin = options.origin ?? this.requestOrigin;
    const csrf = options.csrf === undefined ? this.csrf : options.csrf;
    if (csrf) headers["X-CSRF-Token"] = csrf;

    const response = await fetch(this.origin + path, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(";");
      const separator = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, separator), pair!.slice(separator + 1));
    }
    const text = await response.text();
    const parsed = text && response.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text;
    this.csrf = parsed?.session?.csrfToken ?? parsed?.csrfToken ?? this.csrf;
    return { status: response.status, body: parsed, headers: response.headers };
  }

  get = (path: string) => this.request("GET", path);
  post = (
    path: string,
    body: object = {},
    options?: { csrf?: string | null; origin?: string; adviceFormat?: string | null; forwardedFor?: string },
  ) => this.request("POST", path, body, options);

  /** Fetches the anonymous bootstrap session and its CSRF token. */
  async open() {
    return this.get("/api/session");
  }

  async login(credentials = reviewerLogin): Promise<ApiResponse> {
    await this.open();
    return this.post("/api/session", credentials);
  }

  cookie(name: string) {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string | undefined) {
    if (value === undefined) this.cookies.delete(name);
    else this.cookies.set(name, value);
  }
}
