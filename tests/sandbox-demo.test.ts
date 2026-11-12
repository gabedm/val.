import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { judgeDemoCounters, judgeDemoRequests, loginIdentities, owners } from "../src/server/db/schema";
import { readSandboxSubscriptions, sandboxSubscriptions } from "../src/server/sandbox-demo";
import { loadConfig } from "../src/server/config";
import { startTestApp, reviewerLogin, type TestApp } from "./helpers";
import { paypalLoginCallback } from "../src/server/paypal-login";

const binding = {
  merchant: "A" as const,
  id: "I-SAMPLE12345678",
  planId: "P-SAMPLE1234567890",
  customId: "synthetic-binding",
  serviceId: "netflix",
  name: "Netflix",
};
const environment = {
  VAL_BUILD_PROFILE: "judge",
  DATABASE_URL: "postgres://localhost/val",
  APP_ORIGIN: "https://val.example",
  SESSION_SECRET: "synthetic-session-secret-at-least-thirty-two-characters",
  JUDGE_USERNAME: "reviewer",
  JUDGE_PASSWORD_HASH: "scrypt$salt$hash",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD_HASH: "scrypt$salt$hash",
  VAL_JUDGE_DEMO: "true",
  JUDGE_DEMO_PASSWORD_HASH: "scrypt$salt$hash",
  PAYPAL_SANDBOX_SUBSCRIPTIONS_JSON: JSON.stringify([binding]),
};

it("requires explicit isolated Sandbox configuration and merchant credentials for one-click entry", () => {
  expect(loadConfig(environment).paypalSandboxDemoEntry).toBe(false);
  const enabled = {
    ...environment,
    VAL_PAYPAL_SANDBOX_DEMO_ENTRY: "true",
    PAYPAL_A_CLIENT_ID: "synthetic-merchant",
    PAYPAL_A_CLIENT_SECRET: "synthetic-merchant-secret",
  };
  expect(loadConfig(enabled).paypalSandboxDemoEntry).toBe(true);
  expect(
    loadConfig({ ...enabled, VAL_BUILD_PROFILE: "owner", APP_ORIGIN: "http://127.0.0.1:3000" })
      .paypalSandboxDemoEntry,
  ).toBe(true);
  for (const override of [
    { VAL_BUILD_PROFILE: "public" },
    { PAYPAL_SANDBOX_SUBSCRIPTIONS_JSON: "" },
    { PAYPAL_A_CLIENT_SECRET: "" },
    { VAL_JUDGE_DEMO: "false" },
    { VAL_PAYPAL_SANDBOX_DEMO_ENTRY: "yes" },
    { VAL_PAYPAL_WALLET: "true", KERNEL_API_KEY: "synthetic-key" },
  ])
    expect(() => loadConfig({ ...enabled, ...override })).toThrow(/VAL_PAYPAL_SANDBOX_DEMO_ENTRY/);
});

it("accepts only server-owned unique Sandbox bindings, never prefilled prices or usage", () => {
  expect(readSandboxSubscriptions(undefined)).toBeNull();
  expect(readSandboxSubscriptions(JSON.stringify([binding]))).toEqual([binding]);
  for (const records of [
    [],
    [binding, binding],
    [{ ...binding, amountMinor: 1200 }],
    [{ ...binding, purpose: "Prefilled usage" }],
    [{ ...binding, id: "https://untrusted.example" }],
    [{ ...binding, merchant: "live" }],
  ])
    expect(() => readSandboxSubscriptions(JSON.stringify(records))).toThrow();
  const config = loadConfig(environment);
  expect(sandboxSubscriptions(config)).toEqual([binding]);
  for (const changed of [
    { ...environment, VAL_BUILD_PROFILE: "public" },
    { ...environment, VAL_BUILD_PROFILE: "owner" },
    { ...environment, VAL_PAYPAL_WALLET: "true", KERNEL_API_KEY: "synthetic-key" },
  ])
    expect(() => loadConfig(changed)).toThrow(/Sandbox/);
  expect(() => sandboxSubscriptions({ ...config, paypalIdentityEnvironment: "live" })).toThrow();
});

it("allows local product testing without the judge invitation while retaining identity, budget and Sandbox boundaries", () => {
  const values = {
    ...environment,
    VAL_BUILD_PROFILE: "owner",
    APP_ORIGIN: "http://127.0.0.1:13216",
    VAL_JUDGE_ACCESS_PAUSED: "true",
  };
  const config = loadConfig(values);
  expect(config.judgeAccessPaused).toBe(true);
  expect(config.judgeDemo?.budgetMicros).toBeGreaterThan(0);
  expect(sandboxSubscriptions(config)).toEqual([binding]);
  for (const appOrigin of [
    "https://val.example",
    "http://127.0.0.1.untrusted.example",
    "http://localhost.untrusted.example",
  ])
    expect(() => loadConfig({ ...values, APP_ORIGIN: appOrigin })).toThrow();
  expect(() => loadConfig({ ...values, VAL_JUDGE_DEMO: "false" })).toThrow();
  expect(() => sandboxSubscriptions({ ...config, appOrigin: "https://val.example" })).toThrow();
});

let app: TestApp;
beforeAll(async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const name = `val_test_sandbox_demo_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  app = await startTestApp({
    databaseUrl: new URL(`/${name}`, base).href,
    buildProfile: "judge",
    sandboxSubscriptions: [binding],
    identityFetch: async (input) =>
      String(input).endsWith("/token")
        ? Response.json({ access_token: "synthetic-token", token_type: "Bearer" })
        : Response.json({ user_id: "shared-sandbox-buyer" }),
  });
  app.ctx.config.paypalLogin = { clientId: "synthetic-login", clientSecret: "synthetic-secret" };
  app.paypal.planPriceMinor.set(binding.planId, 1299);
  app.paypal.subscriptions.set(binding.id, {
    id: binding.id,
    merchant: "A",
    planId: binding.planId,
    customId: binding.customId,
    status: "APPROVAL_PENDING",
    createdAt: new Date(),
    paidAt: null,
    paidMinor: 0,
    transactions: [],
  });
  app.paypal.approve(binding.id);
});
afterAll(async () => {
  if (app) await app.close();
});

async function signIn() {
  const browser = app.browser();
  await browser.open();
  expect((await browser.post("/api/judge/access", reviewerLogin)).status).toBe(200);
  const start = await browser.post("/api/auth/paypal");
  expect(start.status).toBe(200);
  const url = new URL(start.body.approvalUrl);
  expect(
    (
      await browser.get(`${paypalLoginCallback}?state=${url.searchParams.get("state")}&code=synthetic-code`)
    ).headers.get("location"),
  ).toBe("/");
  const session = (await browser.open()).body;
  expect(session.authenticated).toBe(true);
  return { browser, ownerId: session.ownerId };
}

it("isolates visitors sharing a Sandbox buyer, imports live API prices with blank memories and blocks payment routes", async () => {
  const first = await signIn();
  expect((await first.browser.get("/api/deployment")).body).toMatchObject({
    paypalSandboxDemo: true,
    financialTools: false,
  });
  const imported = await first.browser.post("/api/subscriptions/import");
  expect(imported.status).toBe(200);
  expect(imported.body).toMatchObject({
    source: "sandbox",
    portfolio: {
      revision: 1,
      subscriptions: [{ serviceId: "netflix", amountMinor: 1299, purpose: "", source: "paypal" }],
    },
  });
  expect(JSON.stringify(imported.body)).not.toContain(binding.id);
  const saved = await first.browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    subscriptions: [
      {
        serviceId: "netflix",
        amountMinor: 1299,
        cycle: "month",
        purpose: "First visitor's private viewing preferences",
      },
    ],
  });
  expect(saved.status).toBe(200);
  const second = await signIn();
  expect(second.ownerId).not.toBe(first.ownerId);
  expect((await second.browser.get("/api/subscriptions")).body).toEqual({ revision: 0, subscriptions: [] });
  const other = await second.browser.post("/api/subscriptions/import");
  expect(other.body.portfolio.subscriptions[0].purpose).toBe("");
  expect((await first.browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe(
    "First visitor's private viewing preferences",
  );
  expect((await second.browser.post("/api/cases", { scenario: "value_offer" })).status).toBe(404);
  expect(
    (await second.browser.post("/api/subscriptions/import", { subscriptionId: binding.id })).status,
  ).toBe(400);
  app.model.script = (_request, index) =>
    index === 0
      ? { call: "read_subscriptions" }
      : index === 1
        ? { call: "check_paypal" }
        : {
            answer: {
              message:
                "These are Sandbox test subscriptions. What do you watch on Netflix, and do you need downloads or ad-free viewing?",
              discussingRef: "saved:0",
              draft: null,
              compareRef: null,
            },
          };
  const opening = await second.browser.post("/api/subscriptions/chat", {
    message: null,
    history: [],
    expectedRevision: 1,
  });
  expect(opening.status).toBe(200);
  expect(opening.body.activeServiceId).toBe("netflix");
  expect(opening.body.draft).toBeNull();
  expect(opening.body.portfolio.subscriptions[0].purpose).toBe("");
  app.paypal.subscriptions.get(binding.id)!.status = "CANCELLED";
  const third = await signIn();
  expect((await third.browser.post("/api/subscriptions/import")).body.portfolio.subscriptions).toEqual([]);
});

describe("one-click Sandbox entry", () => {
  let previousConfig: typeof app.ctx.config;
  let previousStatus: string;
  beforeEach(() => {
    previousConfig = { ...app.ctx.config };
    previousStatus = app.paypal.subscriptions.get(binding.id)!.status;
    app.ctx.config.paypalSandboxDemoEntry = true;
    app.paypal.subscriptions.get(binding.id)!.status = "ACTIVE";
  });
  afterEach(() => {
    Object.assign(app.ctx.config, previousConfig);
    app.paypal.subscriptions.get(binding.id)!.status = previousStatus;
  });

  async function invitedBrowser() {
    const browser = app.browser();
    await browser.open();
    expect((await browser.post("/api/judge/access", reviewerLogin)).status).toBe(200);
    return browser;
  }

  it("starts a private empty session, keeps billing on the API path and never fabricates OAuth identity", async () => {
    const identities = await app.ctx.db.select().from(loginIdentities);
    const requests = await app.ctx.db.select().from(judgeDemoRequests);
    const budget = await app.ctx.db
      .select()
      .from(judgeDemoCounters)
      .where(eq(judgeDemoCounters.key, "judge-demo-budget-v1"));
    const browser = await invitedBrowser();
    const oldCookie = browser.cookie("val_judge_session");
    const beforeApiCalls = app.paypal.calls.length;
    expect((await browser.post("/api/auth/paypal/demo")).body).toEqual({
      demo: true,
      environment: "sandbox",
    });
    expect(browser.cookie("val_judge_session")).not.toBe(oldCookie);
    const session = (await browser.open()).body;
    expect(session).toMatchObject({ authenticated: true, role: "reviewer" });
    expect((await browser.get("/api/subscriptions")).body).toEqual({ revision: 0, subscriptions: [] });
    const imported = await browser.post("/api/subscriptions/import");
    expect(imported.status).toBe(200);
    expect(imported.body.portfolio.subscriptions[0]).toMatchObject({
      amountMinor: 1299,
      purpose: "",
      source: "paypal",
    });
    expect(app.paypal.calls.slice(beforeApiCalls)).toContainEqual({
      merchant: "A",
      method: "GET",
      path: `/v1/billing/subscriptions/${binding.id}`,
    });
    expect(await app.ctx.db.select().from(loginIdentities)).toEqual(identities);
    expect(await app.ctx.db.select().from(judgeDemoRequests)).toEqual(requests);
    expect(
      await app.ctx.db
        .select()
        .from(judgeDemoCounters)
        .where(eq(judgeDemoCounters.key, "judge-demo-budget-v1")),
    ).toEqual(budget);
    expect((await browser.post("/api/cases", { scenario: "value_offer" })).status).toBe(404);
    expect((await browser.get("/api/deployment")).body.paypalSandboxDemoEntry).toBe(true);
  });

  it("keeps each visitor's confirmed usage separate while reload retains their own session", async () => {
    const first = await invitedBrowser();
    await first.post("/api/auth/paypal/demo");
    const firstSession = (await first.open()).body;
    await first.post("/api/subscriptions/import");
    expect(
      (
        await first.request("PUT", "/api/subscriptions", {
          expectedRevision: 1,
          subscriptions: [
            {
              serviceId: "netflix",
              amountMinor: 1299,
              cycle: "month",
              purpose: "My private viewing preferences",
            },
          ],
        })
      ).status,
    ).toBe(200);
    const second = await invitedBrowser();
    await second.post("/api/auth/paypal/demo");
    expect((await second.open()).body.ownerId).not.toBe(firstSession.ownerId);
    expect((await second.get("/api/subscriptions")).body).toEqual({ revision: 0, subscriptions: [] });
    expect((await second.post("/api/subscriptions/import")).body.portfolio.subscriptions[0].purpose).toBe("");
    expect((await first.open()).body.ownerId).toBe(firstSession.ownerId);
    expect((await first.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe(
      "My private viewing preferences",
    );
  });

  it("rejects missing invitation, invalid CSRF, cross-origin entry and supplied portfolio data", async () => {
    const uninvited = app.browser();
    await uninvited.open();
    const before = await app.ctx.db.select().from(owners);
    expect((await uninvited.post("/api/auth/paypal/demo")).status).toBe(403);
    const browser = await invitedBrowser();
    expect((await browser.post("/api/auth/paypal/demo", {}, { csrf: "wrong" })).status).toBe(403);
    expect(
      (await browser.post("/api/auth/paypal/demo", {}, { origin: "https://elsewhere.test" })).status,
    ).toBe(403);
    expect(
      (
        await browser.post("/api/auth/paypal/demo", {
          purpose: "Injected usage",
          redirect: "https://elsewhere.test",
        })
      ).status,
    ).toBe(400);
    expect(await app.ctx.db.select().from(owners)).toEqual(before);
  });

  it("fails closed outside its configured Sandbox context and keeps genuine OAuth available", async () => {
    const browser = await invitedBrowser();
    app.ctx.config.paypalSandboxDemoEntry = false;
    expect((await browser.post("/api/auth/paypal/demo")).status).toBe(404);
    app.ctx.config.paypalSandboxDemoEntry = true;
    app.ctx.config.paypalIdentityEnvironment = "live";
    expect((await browser.post("/api/auth/paypal/demo")).status).toBe(404);
    app.ctx.config.paypalIdentityEnvironment = "sandbox";
    app.ctx.config.buildProfile = "public";
    expect((await browser.post("/api/auth/paypal/demo")).status).toBe(404);
    app.ctx.config.buildProfile = "judge";
    const start = await browser.post("/api/auth/paypal");
    expect(start.status).toBe(200);
    expect(new URL(start.body.approvalUrl).origin).toBe("https://www.sandbox.paypal.com");
    expect((await browser.open()).body.authenticated).toBe(false);
  });

  it("consumes a bootstrap once under concurrent clicks and cannot replace a signed-in owner's session", async () => {
    const browser = await invitedBrowser();
    const before = await app.ctx.db.select().from(owners);
    const results = await Promise.all([
      browser.post("/api/auth/paypal/demo"),
      browser.post("/api/auth/paypal/demo"),
    ]);
    expect(results.filter((result) => result.status === 200)).toHaveLength(1);
    expect([403, 409]).toContain(results.find((result) => result.status !== 200)!.status);
    expect(await app.ctx.db.select().from(owners)).toHaveLength(before.length + 1);
    const session = (await browser.open()).body;
    expect((await browser.post("/api/auth/paypal/demo")).status).toBe(409);
    expect((await browser.open()).body.ownerId).toBe(session.ownerId);
  });
});
