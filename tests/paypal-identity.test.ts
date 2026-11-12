import { describe, expect, it } from "vitest";
import { paypalSignInDestination } from "../src/shared/paypal-identity";
import { loadConfig } from "../src/server/config";
import { openingMessage } from "../src/server/val-chat";

const base = {
  DATABASE_URL: "postgres://localhost/val",
  APP_ORIGIN: "https://val.example",
  SESSION_SECRET: "a-secret-that-is-at-least-thirty-two-characters",
};
const live = {
  ...base,
  PAYPAL_IDENTITY_ENVIRONMENT: "live",
  PAYPAL_LIVE_LOGIN_CLIENT_ID: "live-app",
  PAYPAL_LIVE_LOGIN_CLIENT_SECRET: "private-live-secret",
};

describe("explicit PayPal identity environments", () => {
  it("keeps existing configurations on Sandbox without implicitly enabling identity", () => {
    expect(loadConfig(base)).toMatchObject({ paypalIdentityEnvironment: "sandbox", paypalLogin: null });
    expect(
      loadConfig({ ...base, PAYPAL_LOGIN_CLIENT_ID: "test", PAYPAL_LOGIN_CLIENT_SECRET: "secret" })
        .paypalLogin?.clientId,
    ).toBe("test");
    expect(() => loadConfig({ ...base, PAYPAL_LOGIN_CLIENT_ID: "test" })).toThrow(/supplied together/);
  });

  it("requires distinct live credentials, HTTPS and a bounded AI budget", () => {
    expect(loadConfig(live)).toMatchObject({
      paypalIdentityEnvironment: "live",
      paypalLogin: { clientId: "live-app", clientSecret: "private-live-secret" },
      secureCookies: true,
      cookieNamespace: "val_public_live",
      merchants: { A: null, B: null },
      aiBudgetMicros: 5_000_000,
    });
    for (const override of [
      { PAYPAL_IDENTITY_ENVIRONMENT: "production" },
      { PAYPAL_LIVE_LOGIN_CLIENT_SECRET: "" },
      { APP_ORIGIN: "http://127.0.0.1:3000" },
      { PAYPAL_A_CLIENT_ID: "sandbox" },
      { PAYPAL_LOGIN_CLIENT_SECRET: "sandbox" },
      { PAYPAL_B_WEBHOOK_ID: "WH-test" },
      { VAL_JUDGE_DEMO: "true" },
      { AI_BUDGET_USD: "Infinity" },
    ])
      expect(() => loadConfig({ ...live, ...override })).toThrow();
    const owner = {
      VAL_BUILD_PROFILE: "owner",
      JUDGE_USERNAME: "judge",
      JUDGE_PASSWORD_HASH: "scrypt$salt$hash",
      ADMIN_USERNAME: "admin",
      ADMIN_PASSWORD_HASH: "scrypt$other$hash",
    };
    expect(loadConfig({ ...live, ...owner, AI_BUDGET_USD: "3" })).toMatchObject({
      aiBudgetMicros: 3_000_000,
      cookieNamespace: "val_owner_live",
    });
    expect(() => loadConfig({ ...live, ...owner, AI_BUDGET_USD: "0" })).toThrow(/AI_BUDGET_USD/);
  });

  it("rejects origins with credentials, non-web schemes or callback paths", () => {
    for (const APP_ORIGIN of [
      "https://user:pass@val.example",
      "https://val.example/callback",
      "https://val.example/?secret=x",
      "https://val.example/#home",
      "ftp://localhost",
    ])
      expect(() => loadConfig({ ...base, APP_ORIGIN })).toThrow(/APP_ORIGIN/);
  });

  it("checks environment-specific browser destinations rather than permitting arbitrary PayPal-looking URLs", () => {
    expect(
      paypalSignInDestination({
        environment: "live",
        approvalUrl: "https://www.paypal.com/connect?state=123",
      }).hostname,
    ).toBe("www.paypal.com");
    expect(
      paypalSignInDestination({
        environment: "sandbox",
        approvalUrl: "https://www.sandbox.paypal.com/connect?state=123",
      }).hostname,
    ).toBe("www.sandbox.paypal.com");
    for (const approvalUrl of [
      "https://www.sandbox.paypal.com/connect",
      "http://www.paypal.com/connect",
      "https://www.paypal.com.evil.test/connect",
      "https://www.paypal.com@evil.test/connect",
      "https://user@www.paypal.com/connect",
      "https://www.paypal.com/connect/other",
      "https://www.paypal.com/connect#secret",
      "javascript:alert(1)",
    ])
      expect(() => paypalSignInDestination({ environment: "live", approvalUrl })).toThrow();
    expect(() =>
      paypalSignInDestination({
        environment: "evil" as "live",
        approvalUrl: "https://www.paypal.com/connect",
      }),
    ).toThrow();
  });

  it("explains identity-only access instead of claiming to have searched an inaccessible wallet", () => {
    const result = {
      status: "identity_only" as const,
      checkedAt: new Date().toISOString(),
      verifiedServiceIds: [],
      portfolio: { revision: 0, subscriptions: [] },
    };
    expect(openingMessage(result)).toMatch(/sign-in doesn’t share your subscription bills/);
    expect(openingMessage(result)).not.toMatch(/couldn’t find|via PayPal/);
  });
});
