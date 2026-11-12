import { randomUUID } from "node:crypto";
import pg from "pg";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startTestApp, reviewerLogin, type TestApp } from "./helpers";
import { bindBuildProfile } from "../src/server/build-profile";
import { keyedHash } from "../src/server/auth";
import {
  applicationDeployment,
  loginIdentities,
  ownerSubscriptions,
  owners,
  paypalSubscriptionLinks,
} from "../src/server/db/schema";
import { paypalLoginCallback } from "../src/server/paypal-login";

let app: TestApp;
let subject = "unfamiliar-live-customer";
let failing = false;
const calls: { url: string; init?: RequestInit }[] = [];
beforeAll(async () => {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const database = `val_live_identity_${randomUUID().replace(/-/g, "")}`;
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  app = await startTestApp({
    databaseUrl: new URL(`/${database}`, base).href,
    paypalIdentityEnvironment: "live",
    identityFetch: async (input, init) => {
      calls.push({ url: String(input), init });
      if (failing) return Response.json({ error: "private provider body" }, { status: 401 });
      return String(input).endsWith("/token")
        ? Response.json({ access_token: "synthetic-live-token", token_type: "Bearer" })
        : Response.json({ user_id: subject });
    },
  });
});
afterAll(() => app.close());
beforeEach(() => {
  calls.splice(0);
  failing = false;
  subject = "unfamiliar-live-customer";
});

async function login() {
  const browser = app.browser();
  await browser.open();
  const start = await browser.post("/api/auth/paypal");
  expect(start.status).toBe(200);
  const url = new URL(start.body.approvalUrl);
  expect(start.body.environment).toBe("live");
  expect(url.origin).toBe("https://www.paypal.com");
  expect(url.searchParams.get("scope")).toBe("openid");
  expect(url.searchParams.get("redirect_uri")).toBe(app.ctx.config.appOrigin + paypalLoginCallback);
  const callback = `${paypalLoginCallback}?state=${url.searchParams.get("state")}&code=synthetic-live-code`;
  return { browser, callback };
}

it("uses only the official live identity API, rotates secure cookies and keeps accounts separate", async () => {
  const { browser, callback } = await login();
  const response = await browser.get(callback);
  expect(response.headers.get("location")).toBe("/");
  expect(response.headers.get("set-cookie")).toMatch(/val_owner_live_session=.*Secure/);
  const first = (await browser.open()).body;
  expect(first.authenticated).toBe(true);
  expect(calls.map((call) => call.url)).toEqual([
    "https://api-m.paypal.com/v1/oauth2/token",
    "https://api-m.paypal.com/v1/identity/oauth2/userinfo?schema=openid",
  ]);
  expect(calls.every((call) => call.init?.redirect === "error")).toBe(true);
  const [identity] = await app.ctx.db
    .select()
    .from(loginIdentities)
    .where(eq(loginIdentities.ownerId, first.ownerId));
  expect(identity!.subjectHash).toBe(keyedHash(app.ctx.config, `paypal-live:live-test-client:${subject}`));
  expect(identity!.subjectHash).not.toBe(
    keyedHash(app.ctx.config, `paypal-sandbox:live-test-client:${subject}`),
  );
  expect(JSON.stringify(identity)).not.toMatch(/unfamiliar|synthetic|token/);
  const second = await login();
  await second.browser.get(second.callback);
  expect((await second.browser.open()).body.ownerId).toBe(first.ownerId);
  subject = "other-live-customer";
  const third = await login();
  await third.browser.get(third.callback);
  expect((await third.browser.open()).body.ownerId).not.toBe(first.ownerId);
  const before = calls.length;
  expect((await browser.get(callback)).headers.get("location")).toBe("/?login=expired");
  expect(calls).toHaveLength(before);
});

it("refuses to switch environments on the same database or adopt an unbound populated database", async () => {
  const [bound] = await app.ctx.db.select().from(applicationDeployment);
  expect(bound!.paypalIdentityEnvironment).toBe("live");
  await expect(
    bindBuildProfile({ ...app.ctx, config: { ...app.ctx.config, paypalIdentityEnvironment: "sandbox" } }),
  ).rejects.toMatchObject({ code: "paypal_environment_mismatch" });
  // Roll back the entire simulated legacy database state after checking the guard.
  const rollback = new Error("test rollback");
  await expect(
    app.ctx.db.transaction(async (tx) => {
      await tx.delete(applicationDeployment);
      await tx.insert(owners).values({ id: randomUUID() });
      await expect(
        bindBuildProfile({ ...app.ctx, db: tx as unknown as TestApp["ctx"]["db"] }),
      ).rejects.toMatchObject({ code: "build_profile_unbound" });
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  expect(await app.ctx.db.select().from(applicationDeployment)).toHaveLength(1);
});

it("does not use injected Sandbox links, invent costs, or expose legacy payment and recovery routes", async () => {
  const capabilities = await app.browser().get("/api/deployment");
  expect(capabilities.body).toEqual({
    passwordAccess: false,
    financialTools: false,
    paypalIdentityEnvironment: "live",
  });
  expect(capabilities.headers.get("Cache-Control")).toBe("no-store");
  const { browser, callback } = await login();
  await browser.get(callback);
  const ownerId = (await browser.open()).body.ownerId;
  await app.ctx.db.insert(paypalSubscriptionLinks).values({
    id: randomUUID(),
    ownerId,
    merchant: "A",
    subscriptionId: "I-SANDBOX-ONLY",
    planId: "P-TEST",
    customId: "synthetic-test-link",
    serviceId: "netflix",
    name: "Netflix",
  });
  const imported = await browser.post("/api/subscriptions/import");
  expect(imported.body).toMatchObject({
    status: "identity_only",
    portfolio: { revision: 0, subscriptions: [] },
    verifiedServiceIds: [],
  });
  expect(app.paypal.calls).toHaveLength(0);
  expect((await browser.post("/api/cases", { scenario: "feature_removed" })).status).toBe(404);
  expect((await browser.get("/api/cases")).body).toEqual([]);
  expect((await browser.post("/api/owner/recover", { recoveryCode: "old-code" })).status).toBe(404);
  const anonymous = app.browser();
  await anonymous.open();
  expect((await anonymous.login(reviewerLogin)).status).toBe(404);
  expect((await browser.get("/api/session")).headers.get("Content-Security-Policy")).toContain(
    "form-action 'self' https://www.paypal.com",
  );
});

it("starts unfamiliar customers empty and retains only their own explicitly saved needs", async () => {
  subject = "different-subscription-set";
  const { browser, callback } = await login();
  await browser.get(callback);
  await browser.open();
  const before = await browser.get("/api/subscriptions");
  expect(before.body).toEqual({ revision: 0, subscriptions: [] });
  const saved = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      {
        serviceId: "spotify",
        amountMinor: null,
        cycle: "month",
        purpose: "Offline jazz playlists during a train commute; Android phone.",
      },
    ],
  });
  expect(saved.status).toBe(200);
  expect(saved.body.subscriptions[0]).toMatchObject({ source: "manual", amountMinor: null });
  const ownerId = (await browser.open()).body.ownerId;
  const [record] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  expect(record!.subscriptions[0]!.purpose).toContain("Offline jazz");
  subject = "yet-another-customer";
  const other = await login();
  await other.browser.get(other.callback);
  expect((await other.browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
  expect(
    (await browser.post("/api/subscriptions/import")).body.portfolio.subscriptions[0].amountMinor,
  ).toBeNull();
});

it("consumes failed and cancelled live attempts without leaking provider data or logging in", async () => {
  const cancelled = await login();
  expect(
    (await cancelled.browser.get(cancelled.callback + "&error=access_denied")).headers.get("location"),
  ).toBe("/?login=cancelled");
  expect(calls).toHaveLength(0);
  const failed = await login();
  failing = true;
  const response = await failed.browser.get(failed.callback);
  expect(response.headers.get("location")).toBe("/?login=failed");
  expect((await failed.browser.open()).body.authenticated).toBe(false);
  expect(JSON.stringify(response.body)).not.toContain("private provider body");
  expect((await failed.browser.get(failed.callback)).headers.get("location")).toBe("/?login=expired");
});
