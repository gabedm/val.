import type { PayPalIdentityEnvironment } from "../shared/paypal-identity";
import { isIP } from "node:net";
import { readSandboxSubscriptions, type SandboxSubscriptionBinding } from "./sandbox-demo";
import { geminiModel, validGoogleModelConfig, type GoogleModelConfig } from "./gemini-model";

export type Merchant = "A" | "B";

/** Optional ignored file holding only OPENAI_API_KEY, for local runs of the app and the evaluator. */
export const openaiEnvFile = "private/openai.env";
export const anthropicEnvFile = "private/anthropic.env";
export const googleEnvFile = "private/google.env";

export interface MerchantConfig {
  clientId: string;
  clientSecret: string;
  webhookId: string | null;
}

export interface LoginAccount {
  username: string;
  passwordHash: string;
}

export interface Config {
  buildProfile?: "public" | "judge" | "owner";
  /** Public installations retain a server-enforced total AI budget without a judge invitation. */
  aiBudgetMicros?: number | null;
  httpRequestLimits?: boolean;
  /** Explicit ingress peer networks only; never a hop count or blanket trust. */
  trustedProxyCidrs?: string[];
  databaseUrl: string;
  appOrigin: string;
  /** Local origins listen on loopback only; deployed origins listen on all interfaces. */
  host: string;
  port: number;
  sessionSecret: string;
  /** Stable lookup key. Existing installations pin their original SESSION_SECRET here before rotation. */
  dataSecret?: string;
  walletEncryption?: { activeId: string; keys: Record<string, string> };
  secureCookies: boolean;
  /** Optional namespace for an isolated local instance sharing the same loopback hostname. */
  cookieNamespace?: string;
  judge: LoginAccount;
  admin: LoginAccount;
  /** Defaults to Sandbox for existing installations. Live identity has no merchant payment authority. */
  paypalIdentityEnvironment?: PayPalIdentityEnvironment;
  /** Separate opt-in for identity. Merchant checkout credentials never enable login implicitly. */
  paypalLogin?: { clientId: string; clientSecret: string } | null;
  /** Shared test billing evidence only; customer memories remain private to each visitor. */
  paypalSandboxSubscriptions?: SandboxSubscriptionBinding[] | null;
  /** Opt-in entry to a private visitor session using shared Sandbox agreements, never live identity. */
  paypalSandboxDemoEntry?: boolean;
  paypalWallet?: {
    apiKey: string;
    environment: PayPalIdentityEnvironment;
    maxConcurrent: number;
    dailyImports: number;
  } | null;
  switching?: {
    apiKey: string;
    preparationOnly?: boolean;
    environment: PayPalIdentityEnvironment;
    testOrigins: string[];
    maxConcurrent: number;
    dailyAttempts: number;
  } | null;
  /** Optional hosted Sandbox example; its accounts never become customer accounts. */
  switchExample?: { providerOrigin: string; operatorKey: string; company: string; purpose: string } | null;
  /** Null when a merchant's sandbox credentials are absent; PayPal features then report unavailable. */
  merchants: Record<Merchant, MerchantConfig | null>;
  /** Null when absent; the agent then reports that no investigation ran. */
  openaiApiKey: string | null;
  modelProvider?: "openai" | "anthropic" | "google";
  anthropicApiKey?: string | null;
  googleModel?: GoogleModelConfig | null;
  /** Live provider research uses the existing model connection; explicitly disable for offline runs. */
  liveDiscovery: boolean;
  /** Separate invitation gate and durable application budget for the judged demo. */
  judgeDemo: (LoginAccount & { budgetMicros?: number }) | null;
  /** Optional revocable private link; only its digest is kept in server configuration. */
  privateShareLink?: { sha256: string; expiresAt: Date } | null;
  /** Temporary loopback-owner testing only; leaves the judge budget and identity controls enabled. */
  judgeAccessPaused?: boolean;
  /** Optional private testing invitation; does not grant an administrator role or raise the shared budget. */
  ownerAccess?: LoginAccount | null;
}

function merchantConfig(env: NodeJS.ProcessEnv, merchant: Merchant): MerchantConfig | null {
  const clientId = env[`PAYPAL_${merchant}_CLIENT_ID`]?.trim();
  const clientSecret = env[`PAYPAL_${merchant}_CLIENT_SECRET`]?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, webhookId: env[`PAYPAL_${merchant}_WEBHOOK_ID`]?.trim() || null };
}

export function readMerchants(env: NodeJS.ProcessEnv = process.env): Config["merchants"] {
  return { A: merchantConfig(env, "A"), B: merchantConfig(env, "B") };
}

/** Reads and validates the process environment; every problem is reported at once. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const required = (name: string) => {
    const value = env[name]?.trim();
    if (!value) problems.push(`${name} is required`);
    return value ?? "";
  };

  const databaseUrl = required("DATABASE_URL");
  const trustedProxyCidrs = (env.TRUSTED_PROXY_CIDRS?.trim() ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    trustedProxyCidrs.length > 8 ||
    trustedProxyCidrs.some((value) => {
      const parts = value.split("/");
      const family = isIP(parts[0]!);
      const prefix = Number(parts[1]);
      return (
        parts.length !== 2 ||
        !/^\d+$/.test(parts[1]!) ||
        !family ||
        prefix < (family === 4 ? 8 : 16) ||
        prefix > (family === 4 ? 32 : 128)
      );
    })
  )
    problems.push(
      "TRUSTED_PROXY_CIDRS must contain at most eight explicit IPv4 /8-/32 or IPv6 /16-/128 ingress networks",
    );
  const sessionSecret = required("SESSION_SECRET");
  if (sessionSecret && sessionSecret.length < 32)
    problems.push("SESSION_SECRET must be at least 32 characters");
  const dataSecret = env.DATA_SECRET?.trim() || sessionSecret;
  if (dataSecret.length < 32) problems.push("DATA_SECRET must be at least 32 characters");
  let walletEncryption: Config["walletEncryption"];
  if (env.WALLET_ENCRYPTION_KEYS?.trim() || env.WALLET_ENCRYPTION_KEY_ID?.trim()) {
    try {
      const keys = JSON.parse(env.WALLET_ENCRYPTION_KEYS ?? "");
      const activeId = env.WALLET_ENCRYPTION_KEY_ID?.trim() ?? "";
      if (
        !keys ||
        typeof keys !== "object" ||
        Array.isArray(keys) ||
        Object.keys(keys).length > 8 ||
        !Object.hasOwn(keys, activeId) ||
        Object.entries(keys).some(
          ([id, value]) =>
            !/^[a-zA-Z0-9_-]{1,40}$/.test(id) ||
            id === "legacy" ||
            typeof value !== "string" ||
            value.trim().length < 32,
        )
      )
        throw new Error();
      walletEncryption = { activeId, keys };
    } catch {
      problems.push(
        "WALLET_ENCRYPTION_KEYS must contain at most eight named secrets of at least 32 characters, with WALLET_ENCRYPTION_KEY_ID selecting one; legacy is reserved",
      );
    }
  }

  const appUrl = URL.parse(env.APP_ORIGIN?.trim() ?? "");
  if (!appUrl) problems.push("APP_ORIGIN must be a valid origin");
  else if (appUrl.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(appUrl.hostname)) {
    problems.push("APP_ORIGIN must be https unless it is localhost");
  }
  const appOrigin = appUrl?.origin ?? "";
  if (
    appUrl &&
    (!["http:", "https:"].includes(appUrl.protocol) ||
      appUrl.username ||
      appUrl.password ||
      appUrl.pathname !== "/" ||
      appUrl.search ||
      appUrl.hash)
  )
    problems.push(
      "APP_ORIGIN must contain only an http(s) origin, without credentials, a path, query or fragment",
    );

  const paypalIdentityEnvironment = env.PAYPAL_IDENTITY_ENVIRONMENT?.trim() || "sandbox";
  if (!["sandbox", "live"].includes(paypalIdentityEnvironment))
    problems.push("PAYPAL_IDENTITY_ENVIRONMENT must be sandbox or live");
  const liveIdentity = paypalIdentityEnvironment === "live";
  const loginPrefix = liveIdentity ? "PAYPAL_LIVE_LOGIN" : "PAYPAL_LOGIN";
  const loginClientId = env[`${loginPrefix}_CLIENT_ID`]?.trim();
  const loginClientSecret = env[`${loginPrefix}_CLIENT_SECRET`]?.trim();
  if (!!loginClientId !== !!loginClientSecret)
    problems.push(`${loginPrefix}_CLIENT_ID and ${loginPrefix}_CLIENT_SECRET must be supplied together`);
  if (liveIdentity) {
    if (!loginClientId || !loginClientSecret)
      problems.push(
        "Live PayPal identity requires separate PAYPAL_LIVE_LOGIN_CLIENT_ID and PAYPAL_LIVE_LOGIN_CLIENT_SECRET",
      );
    if (appUrl?.protocol !== "https:") problems.push("Live PayPal identity requires an HTTPS APP_ORIGIN");
    if (
      [
        "PAYPAL_LOGIN_CLIENT_ID",
        "PAYPAL_LOGIN_CLIENT_SECRET",
        "PAYPAL_A_CLIENT_ID",
        "PAYPAL_A_CLIENT_SECRET",
        "PAYPAL_A_WEBHOOK_ID",
        "PAYPAL_B_CLIENT_ID",
        "PAYPAL_B_CLIENT_SECRET",
        "PAYPAL_B_WEBHOOK_ID",
      ].some((key) => env[key]?.trim())
    )
      problems.push(
        "Live PayPal identity cannot load Sandbox login or merchant credentials; use a separate environment and database",
      );
    if (env.VAL_JUDGE_DEMO === "true")
      problems.push("Live PayPal identity cannot use the Sandbox judge demo");
  }

  const buildProfile = env.VAL_BUILD_PROFILE?.trim() || "public";
  if (!["public", "judge", "owner"].includes(buildProfile))
    problems.push("VAL_BUILD_PROFILE must be public, judge or owner");
  const localAccounts = buildProfile !== "public";
  const walletEnabled = env.VAL_PAYPAL_WALLET === "true";
  const switchEnabled = env.VAL_KERNEL_SWITCHING === "true";
  const switchPreparationOnly = env.VAL_SWITCH_PREPARATION_ONLY === "true";
  const switchApiKey = env.KERNEL_SWITCH_API_KEY?.trim() || env.KERNEL_API_KEY?.trim();
  const switchEnvironment = env.VAL_SWITCH_ENVIRONMENT?.trim() || "sandbox";
  const switchOrigins = (env.VAL_SWITCH_TEST_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (switchEnabled && (!switchApiKey || !["sandbox", "live"].includes(switchEnvironment)))
    problems.push("KERNEL switching requires its key and a valid environment");
  if (
    switchEnabled &&
    switchEnvironment === "live" &&
    !switchPreparationOnly &&
    (env.VAL_SWITCH_LIVE !== "true" || paypalIdentityEnvironment !== "live")
  )
    problems.push("Live switching requires explicit VAL_SWITCH_LIVE and live PayPal identity");
  if (
    switchEnabled &&
    (switchOrigins.length > 8 ||
      switchOrigins.some((value) => {
        const url = URL.parse(value);
        return (
          !url ||
          url.protocol !== "https:" ||
          url.origin !== value ||
          !url.hostname.includes(".") ||
          !!isIP(url.hostname) ||
          !!url.port ||
          !!url.username ||
          !!url.password
        );
      }))
  )
    problems.push("Switch test origins must be explicit public HTTPS origins");
  if (switchEnabled && switchEnvironment === "sandbox" && !switchOrigins.length)
    problems.push(
      "Sandbox switching requires isolated test-provider origins; it cannot purchase from live commercial providers",
    );
  const exampleEnabled = env.VAL_SWITCH_EXAMPLE === "true";
  const exampleOrigin = URL.parse(env.SWITCH_EXAMPLE_ORIGIN?.trim() ?? "");
  const exampleKey = env.SWITCH_EXAMPLE_OPERATOR_KEY?.trim() ?? "";
  const exampleCompany = env.SWITCH_EXAMPLE_COMPANY?.trim() ?? "";
  const examplePurpose = env.SWITCH_EXAMPLE_PURPOSE?.trim() ?? "";
  if (
    exampleEnabled &&
    (buildProfile !== "judge" ||
      env.VAL_JUDGE_DEMO !== "true" ||
      liveIdentity ||
      !switchEnabled ||
      !env.PAYPAL_A_CLIENT_ID?.trim() ||
      !env.PAYPAL_A_CLIENT_SECRET?.trim() ||
      !exampleOrigin ||
      exampleOrigin.protocol !== "https:" ||
      exampleOrigin.origin !== env.SWITCH_EXAMPLE_ORIGIN?.trim() ||
      isIP(exampleOrigin.hostname) ||
      !exampleOrigin.hostname.includes(".") ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(exampleKey) ||
      !exampleCompany ||
      exampleCompany.length > 80 ||
      /[\r\n@<>]/.test(exampleCompany) ||
      !examplePurpose ||
      examplePurpose.length > 500)
  )
    problems.push(
      "Hosted switching examples require an isolated Sandbox judge build, operator credentials and explicit example data",
    );
  const walletEnvironment = env.PAYPAL_WALLET_ENVIRONMENT?.trim() || paypalIdentityEnvironment;
  if (walletEnabled && !env.KERNEL_API_KEY?.trim())
    problems.push("KERNEL_API_KEY is required for PayPal wallet ingestion");
  if (walletEnabled && !["sandbox", "live"].includes(walletEnvironment))
    problems.push("PAYPAL_WALLET_ENVIRONMENT must be sandbox or live");
  if (
    walletEnabled &&
    walletEnvironment !== paypalIdentityEnvironment &&
    !(buildProfile === "owner" && appUrl && ["localhost", "127.0.0.1"].includes(appUrl.hostname))
  )
    problems.push("Hosted wallet ingestion must use the same environment as PayPal identity");
  const walletConcurrent = Number(env.KERNEL_MAX_CONCURRENT_BROWSERS ?? "2");
  const walletDaily = Number(env.KERNEL_DAILY_IMPORT_LIMIT ?? "10");
  if (
    walletEnabled &&
    (!Number.isInteger(walletConcurrent) ||
      walletConcurrent < 1 ||
      walletConcurrent > 5 ||
      !Number.isInteger(walletDaily) ||
      walletDaily < 1 ||
      walletDaily > 100)
  )
    problems.push("Invalid KERNEL browser or daily import limit");
  const judge = {
    username: localAccounts ? required("JUDGE_USERNAME") : "",
    passwordHash: localAccounts ? required("JUDGE_PASSWORD_HASH") : "",
  };
  const admin = {
    username: localAccounts ? required("ADMIN_USERNAME") : "",
    passwordHash: localAccounts ? required("ADMIN_PASSWORD_HASH") : "",
  };
  if (judge.username && judge.username === admin.username)
    problems.push("JUDGE_USERNAME and ADMIN_USERNAME must differ");
  const budgetUsd = env.JUDGE_DEMO_BUDGET_USD?.trim() || "5";
  const budgetMicros = Math.round(Number(budgetUsd) * 1_000_000);
  const judgeDemo =
    env.VAL_JUDGE_DEMO === "true"
      ? {
          username: env.JUDGE_DEMO_USERNAME?.trim() || "judge",
          passwordHash: required("JUDGE_DEMO_PASSWORD_HASH"),
          budgetMicros,
        }
      : null;
  if (buildProfile === "judge" && !judgeDemo)
    problems.push("The judge profile requires VAL_JUDGE_DEMO and its budget guard");
  if (buildProfile === "public" && judgeDemo)
    problems.push("The public profile does not accept judge demo configuration");
  if (judgeDemo && !/^scrypt\$[^$]+\$[^$]+$/.test(judgeDemo.passwordHash))
    problems.push("JUDGE_DEMO_PASSWORD_HASH must be a scrypt password hash");
  if (
    judgeDemo &&
    (!/^\d+(?:\.\d{1,2})?$/.test(budgetUsd) ||
      !Number.isSafeInteger(budgetMicros) ||
      budgetMicros < 10_000 ||
      budgetMicros > 1_000_000_000)
  )
    problems.push("JUDGE_DEMO_BUDGET_USD must be between 0.01 and 1000 with at most two decimals");
  const ownerAccess =
    env.OWNER_ACCESS_USERNAME?.trim() || env.OWNER_ACCESS_PASSWORD_HASH?.trim()
      ? { username: required("OWNER_ACCESS_USERNAME"), passwordHash: required("OWNER_ACCESS_PASSWORD_HASH") }
      : null;
  const shareHash = env.VAL_PRIVATE_LINK_SHA256?.trim();
  const shareExpiry = env.VAL_PRIVATE_LINK_EXPIRES_AT?.trim();
  const privateShareLink =
    shareHash || shareExpiry ? { sha256: shareHash ?? "", expiresAt: new Date(shareExpiry ?? "") } : null;
  if (
    privateShareLink &&
    (!judgeDemo ||
      !/^[a-f0-9]{64}$/.test(privateShareLink.sha256) ||
      !shareExpiry ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(shareExpiry) ||
      !Number.isFinite(privateShareLink.expiresAt.getTime()))
  )
    problems.push("Private links require the judge budget, a SHA-256 digest and a UTC expiry");
  if (ownerAccess && !judgeDemo)
    problems.push(
      "Owner access requires VAL_JUDGE_DEMO so the shared invitation and budget controls remain enabled",
    );
  if (ownerAccess && buildProfile !== "owner")
    problems.push("Owner access is available only in the owner build profile");
  if (ownerAccess && !/^scrypt\$[^$]+\$[^$]+$/.test(ownerAccess.passwordHash))
    problems.push("OWNER_ACCESS_PASSWORD_HASH must be a scrypt password hash");
  if (
    ownerAccess &&
    (ownerAccess.username.length > 100 ||
      ownerAccess.username === judgeDemo?.username ||
      ownerAccess.passwordHash === judgeDemo?.passwordHash)
  )
    problems.push("Owner access must use separate credentials from judge access");
  const judgeAccessPaused = env.VAL_JUDGE_ACCESS_PAUSED === "true";
  let paypalSandboxSubscriptions: SandboxSubscriptionBinding[] | null = null;
  try {
    paypalSandboxSubscriptions = readSandboxSubscriptions(env.PAYPAL_SANDBOX_SUBSCRIPTIONS_JSON);
  } catch {
    problems.push("PAYPAL_SANDBOX_SUBSCRIPTIONS_JSON must contain valid, unique test-agreement bindings");
  }
  const localOwnerTesting =
    buildProfile === "owner" &&
    appUrl?.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(appUrl.hostname);
  const merchants = readMerchants(env);
  const paypalSandboxDemoEntry = env.VAL_PAYPAL_SANDBOX_DEMO_ENTRY === "true";
  if (env.VAL_PAYPAL_SANDBOX_DEMO_ENTRY && !["true", "false"].includes(env.VAL_PAYPAL_SANDBOX_DEMO_ENTRY))
    problems.push("VAL_PAYPAL_SANDBOX_DEMO_ENTRY must be true or false");
  if (
    paypalSandboxDemoEntry &&
    (!paypalSandboxSubscriptions ||
      !judgeDemo ||
      liveIdentity ||
      walletEnabled ||
      (buildProfile !== "judge" && !localOwnerTesting) ||
      paypalSandboxSubscriptions.some((binding) => !merchants[binding.merchant]))
  )
    problems.push(
      "VAL_PAYPAL_SANDBOX_DEMO_ENTRY requires isolated Sandbox test agreements, their merchant credentials and the shared budget",
    );
  if (
    paypalSandboxSubscriptions &&
    ((buildProfile !== "judge" && !localOwnerTesting) || liveIdentity || walletEnabled || !judgeDemo)
  )
    problems.push(
      "Shared Sandbox subscriptions require isolated judge or loopback owner testing, Sandbox identity, budget controls and no wallet connection",
    );
  if (
    judgeAccessPaused &&
    (!judgeDemo ||
      buildProfile !== "owner" ||
      !appUrl ||
      !["localhost", "127.0.0.1"].includes(appUrl.hostname))
  )
    problems.push("VAL_JUDGE_ACCESS_PAUSED requires a loopback owner build with the judge budget enabled");

  const publicBudget = env.AI_BUDGET_USD?.trim() || "5";
  const publicBudgetMicros = Math.round(Number(publicBudget) * 1_000_000);
  if (
    (buildProfile === "public" || liveIdentity) &&
    (!/^\d+(?:\.\d{1,2})?$/.test(publicBudget) ||
      !Number.isSafeInteger(publicBudgetMicros) ||
      publicBudgetMicros < 10_000 ||
      publicBudgetMicros > 1_000_000_000)
  )
    problems.push("AI_BUDGET_USD must be between 0.01 and 1000 with at most two decimals");
  const modelProvider = env.VAL_MODEL_PROVIDER?.trim() || "openai";
  if (!["openai", "anthropic", "google"].includes(modelProvider))
    problems.push("VAL_MODEL_PROVIDER must be openai, anthropic or google");
  const googleModel =
    modelProvider === "google"
      ? {
          project: env.GOOGLE_CLOUD_PROJECT?.trim() ?? "",
          location: env.GOOGLE_CLOUD_LOCATION?.trim() || "global",
          impersonateServiceAccount: env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT?.trim() || null,
        }
      : null;
  if (googleModel && !validGoogleModelConfig(googleModel))
    problems.push(
      "Google models require GOOGLE_CLOUD_PROJECT, the global location and a valid optional service account",
    );
  if (modelProvider === "google" && env.GEMINI_MODEL?.trim() && env.GEMINI_MODEL.trim() !== geminiModel)
    problems.push(`GEMINI_MODEL must be ${geminiModel}; other models need reviewed pricing and limits`);
  if (modelProvider === "anthropic" && !env.ANTHROPIC_API_KEY?.trim())
    problems.push("ANTHROPIC_API_KEY is required when VAL_MODEL_PROVIDER is anthropic");
  if (env.ANTHROPIC_MODEL?.trim() && env.ANTHROPIC_MODEL.trim() !== "claude-sonnet-5-5")
    problems.push("ANTHROPIC_MODEL must be claude-sonnet-5-5; other models need reviewed pricing and limits");
  if (problems.length > 0) throw new Error(`Invalid configuration: ${problems.join("; ")}`);

  return {
    databaseUrl,
    buildProfile: buildProfile as "public" | "judge" | "owner",
    aiBudgetMicros: buildProfile === "public" || liveIdentity ? publicBudgetMicros : null,
    httpRequestLimits: true,
    trustedProxyCidrs,
    ...(liveIdentity
      ? { cookieNamespace: `val_${buildProfile}_live` }
      : buildProfile !== "owner"
        ? { cookieNamespace: `val_${buildProfile}` }
        : {}),
    appOrigin,
    host: appUrl && ["localhost", "127.0.0.1"].includes(appUrl.hostname) ? "127.0.0.1" : "0.0.0.0",
    port: Number(env.PORT) || 3000,
    sessionSecret,
    dataSecret,
    walletEncryption,
    secureCookies: appOrigin.startsWith("https://"),
    judge,
    admin,
    paypalIdentityEnvironment: paypalIdentityEnvironment as PayPalIdentityEnvironment,
    paypalSandboxSubscriptions,
    paypalSandboxDemoEntry,
    paypalLogin:
      loginClientId && loginClientSecret
        ? { clientId: loginClientId, clientSecret: loginClientSecret }
        : null,
    paypalWallet: walletEnabled
      ? {
          apiKey: env.KERNEL_API_KEY!.trim(),
          environment: walletEnvironment as PayPalIdentityEnvironment,
          maxConcurrent: walletConcurrent,
          dailyImports: walletDaily,
        }
      : null,
    switching: switchEnabled
      ? {
          apiKey: switchApiKey!,
          preparationOnly: switchPreparationOnly,
          environment: switchEnvironment as PayPalIdentityEnvironment,
          testOrigins: switchOrigins,
          maxConcurrent: 2,
          dailyAttempts: 10,
        }
      : null,
    switchExample: exampleEnabled
      ? {
          providerOrigin: exampleOrigin!.origin,
          operatorKey: exampleKey,
          company: exampleCompany,
          purpose: examplePurpose,
        }
      : null,
    merchants,
    openaiApiKey: env.OPENAI_API_KEY?.trim() || null,
    modelProvider: modelProvider as "openai" | "anthropic" | "google",
    googleModel,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    liveDiscovery:
      !!(modelProvider === "google"
        ? googleModel
        : modelProvider === "anthropic"
          ? env.ANTHROPIC_API_KEY?.trim()
          : env.OPENAI_API_KEY?.trim()) && env.VAL_LIVE_DISCOVERY !== "false",
    judgeDemo,
    privateShareLink,
    judgeAccessPaused,
    ownerAccess,
  };
}
