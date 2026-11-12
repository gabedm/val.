import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

const validEnvironment = {
  VAL_BUILD_PROFILE: "owner",
  DATABASE_URL: "postgres://localhost/val",
  APP_ORIGIN: "http://127.0.0.1:3000",
  SESSION_SECRET: "a-secret-that-is-at-least-thirty-two-characters",
  JUDGE_USERNAME: "judge",
  JUDGE_PASSWORD_HASH: "scrypt$salt$hash",
  ADMIN_USERNAME: "admin",
  ADMIN_PASSWORD_HASH: "scrypt$salt$hash",
};

describe("configuration", () => {
  it("enables hosted switching examples only in an explicit Sandbox judge installation", () => {
    const enabled = {
      ...validEnvironment,
      VAL_BUILD_PROFILE: "judge",
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$salt$hash",
      VAL_KERNEL_SWITCHING: "true",
      KERNEL_SWITCH_API_KEY: "synthetic-switch-key",
      VAL_SWITCH_ENVIRONMENT: "live",
      VAL_SWITCH_PREPARATION_ONLY: "true",
      PAYPAL_A_CLIENT_ID: "sandbox-client",
      PAYPAL_A_CLIENT_SECRET: "sandbox-secret",
      VAL_SWITCH_EXAMPLE: "true",
      SWITCH_EXAMPLE_ORIGIN: "https://isolated.provider.example.com",
      SWITCH_EXAMPLE_OPERATOR_KEY: "a".repeat(43),
      SWITCH_EXAMPLE_COMPANY: "Example Works",
      SWITCH_EXAMPLE_PURPOSE: "Offline notes for one person",
    };
    expect(loadConfig(enabled).switchExample?.company).toBe("Example Works");
    expect(loadConfig(validEnvironment).switchExample).toBeNull();
    for (const override of [
      { VAL_BUILD_PROFILE: "public" },
      { VAL_JUDGE_DEMO: "false" },
      { PAYPAL_IDENTITY_ENVIRONMENT: "live" },
      { VAL_KERNEL_SWITCHING: "false" },
      { PAYPAL_A_CLIENT_SECRET: "" },
      { SWITCH_EXAMPLE_ORIGIN: "http://127.0.0.1" },
      { SWITCH_EXAMPLE_ORIGIN: "https://user:password@provider.example.com" },
      { SWITCH_EXAMPLE_OPERATOR_KEY: "" },
      { SWITCH_EXAMPLE_COMPANY: "<script>" },
      { SWITCH_EXAMPLE_PURPOSE: "" },
    ])
      expect(() => loadConfig({ ...enabled, ...override })).toThrow(/Hosted switching examples/);
  });
  it("allows live-page preparation with a separate key while retaining the live financial gate", () => {
    const env = {
      ...validEnvironment,
      VAL_KERNEL_SWITCHING: "true",
      KERNEL_SWITCH_API_KEY: "synthetic-preparation-key",
      VAL_SWITCH_ENVIRONMENT: "live",
      VAL_SWITCH_PREPARATION_ONLY: "true",
    };
    const config = loadConfig(env);
    expect(config.switching).toMatchObject({
      apiKey: "synthetic-preparation-key",
      environment: "live",
      preparationOnly: true,
    });
    expect(config.paypalWallet).toBeNull();
    expect(config.paypalIdentityEnvironment).toBe("sandbox");
    expect(() => loadConfig({ ...env, VAL_SWITCH_PREPARATION_ONLY: "false" })).toThrow(
      /Live switching requires/,
    );
  });
  it("keeps connected switching off by default and restricts Sandbox execution to explicit isolated origins", () => {
    expect(loadConfig(validEnvironment).switching).toBeNull();
    const switching = {
      ...validEnvironment,
      VAL_KERNEL_SWITCHING: "true",
      KERNEL_API_KEY: "synthetic-switching-key",
      VAL_SWITCH_TEST_ORIGINS: "https://isolated.provider.example.com",
    };
    expect(loadConfig(switching).switching?.environment).toBe("sandbox");
    expect(() => loadConfig({ ...switching, KERNEL_API_KEY: "" })).toThrow(/KERNEL switching/);
    expect(() => loadConfig({ ...switching, VAL_SWITCH_TEST_ORIGINS: "" })).toThrow(/isolated test-provider/);
    expect(() => loadConfig({ ...switching, VAL_SWITCH_TEST_ORIGINS: "http://127.0.0.1:1234" })).toThrow(
      /public HTTPS origins/,
    );
    expect(() => loadConfig({ ...switching, VAL_SWITCH_ENVIRONMENT: "live" })).toThrow(
      /Live switching requires/,
    );
  });
  it("accepts private share links only with a finite digest/expiry and the shared budget gate", () => {
    const env = {
      ...validEnvironment,
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_USERNAME: "invite",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$salt$hash",
      JUDGE_DEMO_BUDGET_USD: "5",
      VAL_PRIVATE_LINK_SHA256: "a".repeat(64),
      VAL_PRIVATE_LINK_EXPIRES_AT: "2026-12-22T00:00:00Z",
    };
    expect(loadConfig(env).privateShareLink).toEqual({
      sha256: "a".repeat(64),
      expiresAt: new Date("2026-12-22T00:00:00Z"),
    });
    for (const change of [
      { VAL_JUDGE_DEMO: "false" },
      { VAL_PRIVATE_LINK_SHA256: "raw-secret" },
      { VAL_PRIVATE_LINK_EXPIRES_AT: "" },
      { VAL_PRIVATE_LINK_EXPIRES_AT: "not-a-date" },
    ])
      expect(() => loadConfig({ ...env, ...change })).toThrow(/Private links/);
  });
  it("selects project-billed Gemini with ADC and leaves other providers' keys unused", () => {
    const google = {
      ...validEnvironment,
      VAL_MODEL_PROVIDER: "google",
      GOOGLE_CLOUD_PROJECT: "example-val-project",
    };
    expect(loadConfig(google)).toMatchObject({
      modelProvider: "google",
      liveDiscovery: true,
      googleModel: { project: "example-val-project", location: "global" },
    });
    expect(loadConfig({ ...google, VAL_LIVE_DISCOVERY: "false" }).liveDiscovery).toBe(false);
    for (const change of [
      { GOOGLE_CLOUD_PROJECT: "" },
      { GOOGLE_CLOUD_PROJECT: "https://other.example" },
      { GOOGLE_CLOUD_LOCATION: "other.example" },
      { GEMINI_MODEL: "unpriced-model" },
      { GOOGLE_IMPERSONATE_SERVICE_ACCOUNT: "secret-bad-value" },
    ]) {
      expect(() => loadConfig({ ...google, ...change })).toThrow(/Google|GEMINI_MODEL/);
      try {
        loadConfig({ ...google, ...change });
      } catch (error) {
        expect(String(error)).not.toContain("secret-bad-value");
      }
    }
  });
  it("requires explicit bounded proxy networks and leaves direct requests untrusted by default", () => {
    expect(loadConfig(validEnvironment).trustedProxyCidrs).toEqual([]);
    expect(
      loadConfig({ ...validEnvironment, TRUSTED_PROXY_CIDRS: "127.0.0.1/32, ::1/128" }).trustedProxyCidrs,
    ).toEqual(["127.0.0.1/32", "::1/128"]);
    for (const value of [
      "true",
      "1",
      "0.0.0.0/0",
      "::/0",
      "127.0.0.1",
      "127.0.0.1/33",
      "::1/129",
      "localhost/32",
      "1.2.3.4/8/9",
    ])
      expect(() => loadConfig({ ...validEnvironment, TRUSTED_PROXY_CIDRS: value })).toThrow(
        /TRUSTED_PROXY_CIDRS/,
      );
  });
  it("separates stable data keys and validates wallet rotation keys without echoing secrets", () => {
    const legacy = loadConfig(validEnvironment);
    expect(legacy.dataSecret).toBe(validEnvironment.SESSION_SECRET);
    const secret = "synthetic-wallet-key-that-is-long-enough";
    const configured = {
      ...validEnvironment,
      DATA_SECRET: "stable-data-key-that-is-long-enough",
      WALLET_ENCRYPTION_KEYS: JSON.stringify({ current: secret }),
      WALLET_ENCRYPTION_KEY_ID: "current",
    };
    expect(loadConfig(configured)).toMatchObject({
      dataSecret: configured.DATA_SECRET,
      walletEncryption: { activeId: "current", keys: { current: secret } },
    });
    for (const change of [
      { DATA_SECRET: "short" },
      { WALLET_ENCRYPTION_KEY_ID: "missing" },
      { WALLET_ENCRYPTION_KEYS: JSON.stringify({ current: "short" }) },
      { WALLET_ENCRYPTION_KEYS: JSON.stringify({ legacy: secret }), WALLET_ENCRYPTION_KEY_ID: "legacy" },
      { WALLET_ENCRYPTION_KEYS: "malformed-secret-value" },
    ]) {
      expect(() => loadConfig({ ...configured, ...change })).toThrow(/Invalid configuration/);
      try {
        loadConfig({ ...configured, ...change });
      } catch (error) {
        expect(String(error)).not.toContain(secret);
        expect(String(error)).not.toContain("malformed-secret-value");
      }
    }
  });
  it("selects Claude explicitly, requires its own key and enables native research", () => {
    const claude = {
      ...validEnvironment,
      VAL_MODEL_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "synthetic-claude-key",
    };
    expect(loadConfig(claude)).toMatchObject({ modelProvider: "anthropic", liveDiscovery: true });
    expect(loadConfig({ ...claude, VAL_LIVE_DISCOVERY: "false" }).liveDiscovery).toBe(false);
    expect(() =>
      loadConfig({ ...claude, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "synthetic-openai-key" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => loadConfig({ ...claude, ANTHROPIC_MODEL: "another-model" })).toThrow(/ANTHROPIC_MODEL/);
    expect(() => loadConfig({ ...claude, VAL_MODEL_PROVIDER: "unknown" })).toThrow(/VAL_MODEL_PROVIDER/);
  });
  it("keeps wallet credentials server-side, bounds browser use and separates hosted source environments", () => {
    const wallet = {
      ...validEnvironment,
      VAL_PAYPAL_WALLET: "true",
      KERNEL_API_KEY: "synthetic-wallet-key",
      PAYPAL_WALLET_ENVIRONMENT: "live",
    };
    expect(loadConfig(wallet).paypalWallet).toMatchObject({
      environment: "live",
      maxConcurrent: 2,
      dailyImports: 10,
    });
    for (const override of [
      { KERNEL_API_KEY: "" },
      { PAYPAL_WALLET_ENVIRONMENT: "other" },
      { KERNEL_MAX_CONCURRENT_BROWSERS: "0" },
      { KERNEL_MAX_CONCURRENT_BROWSERS: "6" },
      { KERNEL_DAILY_IMPORT_LIMIT: "NaN" },
      { KERNEL_DAILY_IMPORT_LIMIT: "101" },
      { APP_ORIGIN: "https://val.example" },
    ])
      expect(() => loadConfig({ ...wallet, ...override })).toThrow();
    expect(
      loadConfig({ ...wallet, APP_ORIGIN: "https://val.example", PAYPAL_WALLET_ENVIRONMENT: "sandbox" })
        .paypalWallet?.environment,
    ).toBe("sandbox");
  });
  it("allows a reversible invitation pause only in a loopback owner build with its shared budget retained", () => {
    const enabled = {
      ...validEnvironment,
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$judge$hash",
      JUDGE_DEMO_BUDGET_USD: "10",
    };
    expect(loadConfig(enabled).judgeAccessPaused).toBe(false);
    expect(loadConfig({ ...enabled, VAL_JUDGE_ACCESS_PAUSED: "true" })).toMatchObject({
      judgeAccessPaused: true,
      host: "127.0.0.1",
      judgeDemo: { budgetMicros: 10_000_000 },
    });
    for (const override of [
      { APP_ORIGIN: "https://val.example" },
      { VAL_BUILD_PROFILE: "judge" },
      { VAL_BUILD_PROFILE: "public" },
      { VAL_JUDGE_DEMO: "false" },
    ])
      expect(() => loadConfig({ ...enabled, ...override, VAL_JUDGE_ACCESS_PAUSED: "true" })).toThrow(
        /VAL_JUDGE_ACCESS_PAUSED/,
      );
  });
  it("requires a protected judge profile and keeps owner credentials out of both distributable profiles", () => {
    expect(() => loadConfig({ ...validEnvironment, VAL_BUILD_PROFILE: "judge" })).toThrow(
      /judge profile requires/,
    );
    const config = loadConfig({
      ...validEnvironment,
      VAL_BUILD_PROFILE: "judge",
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$judge$hash",
    });
    expect(config).toMatchObject({ buildProfile: "judge", cookieNamespace: "val_judge", ownerAccess: null });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VAL_BUILD_PROFILE: "public",
        VAL_JUDGE_DEMO: "true",
        JUDGE_DEMO_PASSWORD_HASH: "scrypt$judge$hash",
      }),
    ).toThrow(/public profile/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        VAL_BUILD_PROFILE: "judge",
        VAL_JUDGE_DEMO: "true",
        JUDGE_DEMO_PASSWORD_HASH: "scrypt$judge$hash",
        OWNER_ACCESS_USERNAME: "owner",
        OWNER_ACCESS_PASSWORD_HASH: "scrypt$owner$hash",
      }),
    ).toThrow(/only in the owner/);
  });
  it("keeps private owner access optional and requires separate valid credentials under the existing guard", () => {
    const enabled = {
      ...validEnvironment,
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$judge$hash",
    };
    expect(loadConfig(enabled).ownerAccess).toBeNull();
    const owner = { OWNER_ACCESS_USERNAME: "owner", OWNER_ACCESS_PASSWORD_HASH: "scrypt$owner$hash" };
    expect(loadConfig({ ...enabled, ...owner }).ownerAccess).toEqual({
      username: "owner",
      passwordHash: owner.OWNER_ACCESS_PASSWORD_HASH,
    });
    for (const settings of [
      { ...enabled, OWNER_ACCESS_USERNAME: "owner" },
      { ...enabled, ...owner, OWNER_ACCESS_PASSWORD_HASH: "plaintext" },
      { ...enabled, ...owner, OWNER_ACCESS_USERNAME: "judge" },
      { ...enabled, ...owner, OWNER_ACCESS_PASSWORD_HASH: enabled.JUDGE_DEMO_PASSWORD_HASH },
      { ...validEnvironment, ...owner },
    ])
      expect(() => loadConfig(settings)).toThrow(/Owner access|OWNER_ACCESS/);
  });
  it("requires a separate valid password hash before enabling judge mode", () => {
    expect(loadConfig(validEnvironment).judgeDemo).toBeNull();
    expect(() => loadConfig({ ...validEnvironment, VAL_JUDGE_DEMO: "true" })).toThrow(
      /JUDGE_DEMO_PASSWORD_HASH/,
    );
    expect(() =>
      loadConfig({ ...validEnvironment, VAL_JUDGE_DEMO: "true", JUDGE_DEMO_PASSWORD_HASH: "plaintext" }),
    ).toThrow(/scrypt/);
    expect(
      loadConfig({
        ...validEnvironment,
        VAL_JUDGE_DEMO: "true",
        JUDGE_DEMO_PASSWORD_HASH: "scrypt$salt$hash",
      }).judgeDemo?.username,
    ).toBe("judge");
  });
  it("loads a local setup, treating missing PayPal credentials as unavailable merchants", () => {
    const config = loadConfig(validEnvironment);
    expect(config).toMatchObject({
      appOrigin: "http://127.0.0.1:3000",
      host: "127.0.0.1",
      secureCookies: false,
      merchants: { A: null, B: null },
    });
  });
  it("defaults to a five-dollar shared budget and validates an explicit operator cap", () => {
    const enabled = {
      ...validEnvironment,
      VAL_JUDGE_DEMO: "true",
      JUDGE_DEMO_PASSWORD_HASH: "scrypt$salt$hash",
    };
    expect(loadConfig(enabled).judgeDemo?.budgetMicros).toBe(5_000_000);
    expect(loadConfig({ ...enabled, JUDGE_DEMO_BUDGET_USD: "8" }).judgeDemo?.budgetMicros).toBe(8_000_000);
    for (const value of ["NaN", "Infinity", "0", "-1", "1.123", "1001", "8junk"])
      expect(() => loadConfig({ ...enabled, JUDGE_DEMO_BUDGET_USD: value })).toThrow(/JUDGE_DEMO_BUDGET_USD/);
  });

  it("reads each merchant's own credentials and optional webhook ID", () => {
    const config = loadConfig({
      ...validEnvironment,
      PAYPAL_A_CLIENT_ID: "a-id",
      PAYPAL_A_CLIENT_SECRET: "a-secret",
      PAYPAL_A_WEBHOOK_ID: "WH-A",
      PAYPAL_B_CLIENT_ID: "b-id",
      PAYPAL_B_CLIENT_SECRET: "b-secret",
    });
    expect(config.merchants.A).toEqual({ clientId: "a-id", clientSecret: "a-secret", webhookId: "WH-A" });
    expect(config.merchants.B).toEqual({ clientId: "b-id", clientSecret: "b-secret", webhookId: null });
  });

  it("uses secure cookies and all interfaces for a deployed https origin", () => {
    expect(loadConfig({ ...validEnvironment, APP_ORIGIN: "https://val.example" })).toMatchObject({
      secureCookies: true,
      host: "0.0.0.0",
    });
  });

  it("reports every missing required setting at once", () => {
    expect(() => loadConfig({ VAL_BUILD_PROFILE: "owner" })).toThrow(
      /DATABASE_URL is required.*SESSION_SECRET is required.*APP_ORIGIN must be a valid origin.*JUDGE_USERNAME is required/,
    );
  });

  it.each([
    ["a short session secret", { SESSION_SECRET: "short" }, /SESSION_SECRET must be at least 32/],
    [
      "a plain-http public origin",
      { APP_ORIGIN: "http://val.example" },
      /must be https unless it is localhost/,
    ],
    ["the same username for judge and admin", { ADMIN_USERNAME: "judge" }, /must differ/],
  ])("rejects %s", (_label, override, message) => {
    expect(() => loadConfig({ ...validEnvironment, ...override })).toThrow(message);
  });
});
