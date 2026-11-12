import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { keyedHash } from "../src/server/auth";
import { loginAttempts, loginIdentities, owners } from "../src/server/db/schema";
import { paypalLoginCallback, paypalLoginStateHash } from "../src/server/paypal-login";
import { reviewerLogin, startTestApp, type Browser, type TestApp } from "./helpers";

let app: TestApp;
let subject = "test-buyer-one";
let upstreamFailure = false;
let calls: { url: string; init?: RequestInit }[] = [];
const identityFetch: typeof fetch = async (input, init) => {
  const url = String(input);
  calls.push({ url, init });
  if (upstreamFailure)
    return new Response(JSON.stringify({ error: "private provider data" }), { status: 500 });
  if (url.endsWith("/v1/oauth2/token"))
    return Response.json({
      access_token: "private-access-token",
      refresh_token: "private-refresh-token",
      token_type: "Bearer",
    });
  return Response.json({ user_id: subject, email: "ignored@example.test" });
};

beforeAll(async () => {
  app = await startTestApp({ identityFetch });
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  calls = [];
  upstreamFailure = false;
  subject = "test-buyer-one";
  app.ctx.config.paypalIdentityEnvironment = "sandbox";
  app.ctx.config.paypalLogin = { clientId: "login-client", clientSecret: "private-login-secret" };
});

async function begin(browser: Browser) {
  await browser.open();
  const response = await browser.post("/api/auth/paypal");
  expect(response.status).toBe(200);
  const url = new URL(response.body.approvalUrl);
  return {
    url,
    callback: `${paypalLoginCallback}?state=${url.searchParams.get("state")}&code=private-auth-code`,
  };
}

describe("PayPal sandbox login", () => {
  it("advertises only the configured sandbox provider and fails safely without it", async () => {
    const browser = app.browser();
    await browser.open();
    app.ctx.config.paypalLogin = null;
    expect((await browser.get("/api/auth/providers")).body).toEqual({
      paypal: false,
      google: false,
      apple: false,
    });
    expect((await browser.post("/api/auth/paypal")).status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it("requires same-origin CSRF and requests identity only at the fixed sandbox host", async () => {
    const browser = app.browser();
    await browser.open();
    expect((await browser.post("/api/auth/paypal", {}, { csrf: "wrong" })).status).toBe(403);
    expect((await browser.post("/api/auth/paypal", {}, { origin: "https://elsewhere.test" })).status).toBe(
      403,
    );
    expect((await browser.post("/api/auth/paypal", { redirect: "https://elsewhere.test" })).status).toBe(400);
    const { url } = await begin(browser);
    expect(url.origin).toBe("https://www.sandbox.paypal.com");
    expect(url.searchParams.get("scope")).toBe("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(app.origin + paypalLoginCallback);
    expect(url.href).not.toContain("private-login-secret");
  });

  it("rejects cross-browser callbacks without consuming the initiating browser's attempt", async () => {
    const original = app.browser();
    const other = app.browser();
    await other.open();
    const { callback } = await begin(original);
    expect((await other.get(callback)).headers.get("location")).toBe("/?login=expired");
    expect(calls).toHaveLength(0);
    expect((await original.get(callback)).headers.get("location")).toBe("/");
    expect((await original.open()).body.authenticated).toBe(true);
    expect((await other.open()).body.authenticated).toBe(false);
  });

  it("rotates identity/session and preserves the old owner without linking or payment scopes", async () => {
    const browser = app.browser();
    const legacy = await browser.login(reviewerLogin);
    const oldOwner = legacy.body.session.ownerId;
    await browser.request("DELETE", "/api/session", {});
    const { callback } = await begin(browser);
    const bootstrap = browser.cookie("val_session");
    const response = await browser.get(callback);
    expect(response.status).toBe(303);
    const current = (await browser.open()).body;
    expect(current).toMatchObject({ authenticated: true, role: "reviewer" });
    expect(current.ownerId).not.toBe(oldOwner);
    expect(browser.cookie("val_session")).not.toBe(bootstrap);
    expect(await app.ctx.db.select().from(owners).where(eq(owners.id, oldOwner))).toHaveLength(1);
    expect((await browser.get("/api/cases")).body).toEqual([]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v1/identity/oauth2/userinfo?schema=openid",
    ]);
    expect(String(calls[0]!.init!.body)).toContain("grant_type=authorization_code");
    expect(calls[0]!.init!.redirect).toBe("error");
    expect(response.headers.get("location")).not.toMatch(/token|code|buyer/);
    const identity = await app.ctx.db
      .select()
      .from(loginIdentities)
      .where(eq(loginIdentities.ownerId, current.ownerId));
    expect(JSON.stringify(identity)).not.toMatch(/test-buyer|private-|@/);
    expect((await browser.get(callback)).headers.get("location")).toBe("/?login=expired");
    expect(calls).toHaveLength(2);
  });

  it("returns to the same owner across browsers; a different verified subject stays separate", async () => {
    const first = app.browser();
    await first.get((await begin(first)).callback);
    const owner = (await first.open()).body.ownerId;
    const second = app.browser();
    await second.get((await begin(second)).callback);
    expect((await second.open()).body.ownerId).toBe(owner);
    subject = "test-buyer-two";
    const third = app.browser();
    await third.get((await begin(third)).callback);
    expect((await third.open()).body.ownerId).not.toBe(owner);
  });

  it("expires sessions on rotation but keeps the verified PayPal account linked to its saved owner", async () => {
    const previous = app.ctx.config.sessionSecret;
    const first = app.browser();
    await first.get((await begin(first)).callback);
    const ownerId = (await first.open()).body.ownerId;
    const stableHash = keyedHash(app.ctx.config, "durable-provider-reference");
    try {
      app.ctx.config.sessionSecret = "rotated-session-secret-0123456789abcdef";
      expect((await first.open()).body.authenticated).toBe(false);
      expect(keyedHash(app.ctx.config, "durable-provider-reference")).toBe(stableHash);
      const next = app.browser();
      await next.get((await begin(next)).callback);
      expect((await next.open()).body).toMatchObject({ authenticated: true, ownerId });
    } finally {
      app.ctx.config.sessionSecret = previous;
    }
  });

  it("expires state, replaces older tabs, consumes cancellation without calling the provider", async () => {
    const browser = app.browser();
    const first = await begin(browser);
    const second = await begin(browser);
    expect((await browser.get(first.callback)).headers.get("location")).toBe("/?login=expired");
    const stateHash = paypalLoginStateHash(app.ctx.config, second.url.searchParams.get("state")!);
    await app.ctx.db
      .update(loginAttempts)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(loginAttempts.stateHash, stateHash));
    expect((await browser.get(second.callback)).headers.get("location")).toBe("/?login=expired");
    const third = await begin(browser);
    expect((await browser.get(third.callback + "&error=access_denied")).headers.get("location")).toBe(
      "/?login=cancelled",
    );
    expect((await browser.get(third.callback)).headers.get("location")).toBe("/?login=expired");
    expect(calls).toHaveLength(0);
  });

  it("does not leak upstream errors or retain state after provider failure", async () => {
    const browser = app.browser();
    const { callback, url } = await begin(browser);
    upstreamFailure = true;
    const response = await browser.get(callback);
    expect(response.headers.get("location")).toBe("/?login=failed");
    expect((await browser.open()).body.authenticated).toBe(false);
    expect(
      await app.ctx.db
        .select()
        .from(loginAttempts)
        .where(
          eq(loginAttempts.stateHash, paypalLoginStateHash(app.ctx.config, url.searchParams.get("state")!)),
        ),
    ).toHaveLength(0);
    expect(JSON.stringify(response.body)).not.toContain("private provider data");
  });

  it("keeps an isolated preview's cookies separate from the retained app", async () => {
    const isolated = await startTestApp({ identityFetch });
    try {
      isolated.ctx.config.cookieNamespace = "val_entry";
      isolated.ctx.config.paypalLogin = { clientId: "login-client", clientSecret: "private-login-secret" };
      const browser = isolated.browser();
      await browser.open();
      browser.setCookie("val_session", "retained-session-cookie");
      browser.setCookie("val_owner", "retained-owner-cookie");
      const url = new URL((await browser.post("/api/auth/paypal")).body.approvalUrl);
      await browser.get(
        `${paypalLoginCallback}?state=${url.searchParams.get("state")}&code=private-auth-code`,
      );
      expect((await browser.open()).body.authenticated).toBe(true);
      expect(browser.cookie("val_session")).toBe("retained-session-cookie");
      expect(browser.cookie("val_owner")).toBe("retained-owner-cookie");
      expect(browser.cookie("val_entry_session")).toBeTruthy();
      expect(browser.cookie("val_entry_owner")).toBeTruthy();
    } finally {
      await isolated.close();
    }
  });

  it("binds pending callbacks to the issuing app and environment", async () => {
    const browser = app.browser();
    const { callback } = await begin(browser);
    app.ctx.config.paypalIdentityEnvironment = "live";
    expect((await browser.get(callback)).headers.get("location")).toBe("/?login=expired");
    app.ctx.config.paypalIdentityEnvironment = "sandbox";
    app.ctx.config.paypalLogin!.clientId = "different-app";
    expect((await browser.get(callback)).headers.get("location")).toBe("/?login=expired");
    expect(calls).toHaveLength(0);
    app.ctx.config.paypalLogin!.clientId = "login-client";
    expect((await browser.get(callback)).headers.get("location")).toBe("/");
    expect((await browser.open()).body.authenticated).toBe(true);
  });

  it("preserves existing Sandbox identity hashes across the environment upgrade", async () => {
    const browser = app.browser();
    await browser.get((await begin(browser)).callback);
    const ownerId = (await browser.open()).body.ownerId;
    const [identity] = await app.ctx.db
      .select()
      .from(loginIdentities)
      .where(eq(loginIdentities.ownerId, ownerId));
    expect(identity!.subjectHash).toBe(keyedHash(app.ctx.config, `paypal-sandbox:login-client:${subject}`));
  });
});
