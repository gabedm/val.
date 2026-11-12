import { createHash, createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFileSync, mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import type { CatalogueResponse } from "../src/shared/contracts.types";
import type { SubscriptionEntry } from "../src/shared/subscriptions";
import {
  judgeDemoCounters,
  ownerSubscriptions,
  paypalWalletConnections,
  paypalWalletReviews,
  owners,
} from "../src/server/db/schema";
import { connect, migrateDatabase } from "../src/server/db";
import {
  mergeWalletResult,
  openWalletState,
  runWalletJobs,
  runWalletOwner,
  sealWalletState,
  startWalletConnection,
  walletStatus,
} from "../src/server/paypal-wallet";
import { WalletRuntimeError, type WalletRead, type WalletRuntime } from "../src/server/paypal-wallet-runtime";
import { rememberRecognizedService, customerProduct } from "../src/server/subscription-recognition";
import { bindBuildProfile } from "../src/server/build-profile";
import { startTestApp, type TestApp } from "./helpers";

const services = (
  JSON.parse(
    readFileSync(new URL("../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
  ) as CatalogueResponse["catalogue"]
).services;
const key = (text: string) => createHash("sha256").update(text).digest("hex");
const bill = (merchant = "Spotify AB", id = merchant): WalletRead["bills"][number] => ({
  key: key(id),
  merchant,
  amountMinor: 1299,
  currency: "GBP",
  cycle: "month",
  paymentCount: 3,
  lastPaidOn: "2026-10-21",
  agreementRef: "I-ABCDEFGHIJKL",
  agreementStatus: "inferred",
});
const candidate = (merchant = "Readwise", id = merchant): NonNullable<WalletRead["candidates"]>[number] => ({
  ...bill(merchant, id),
  cycle: null,
  paymentCount: 1,
  agreementRef: "I-ABCDEFGHIJKL",
});
class Source implements WalletRuntime {
  signedIn = false;
  ready = false;
  submissions = 0;
  profileCalls: string[] = [];
  browserCalls: string[] = [];
  deletedBrowsers: string[] = [];
  deletedProfiles: string[] = [];
  agreements: string[] = [];
  rows: WalletRead = { bills: [bill()], ledgerRecords: 8, unresolvedPayments: 1 };
  readFailure: WalletRuntimeError | null = null;
  active = true;
  reportsExist = false;
  profile = async (name: string) => {
    this.profileCalls.push(name);
    return "profile-" + name;
  };
  browser = async (name: string, _profile: string) => {
    this.browserCalls.push(name);
    return {
      id: "browser-" + name,
      url: "https://prod-iad-test.kernel.sh:8443/browser/live/SecretSlug12?readOnly=false",
    };
  };
  authenticated = async (_id: string) => this.signedIn;
  reports = async (_id: string, _scope: unknown) =>
    this.reportsExist ? [{ marker: "report " + this.submissions, ready: this.ready }] : [];
  prepareReport = async (_id: string, _scope: unknown) => {};
  submitReport = async (_id: string, _scope: unknown) => {
    this.submissions++;
    this.reportsExist = true;
  };
  readReport = async (_id: string, _scope: unknown, _marker: string, _salt: string) => {
    if (this.readFailure) throw this.readFailure;
    return structuredClone(this.rows);
  };
  agreement = async (_id: string, reference: string) => {
    this.agreements.push(reference);
    return this.active ? ("active" as const) : ("inactive" as const);
  };
  deleteBrowser = async (id: string) => {
    this.deletedBrowsers.push(id);
  };
  deleteProfile = async (id: string) => {
    this.deletedProfiles.push(id);
  };
}
let app: TestApp, source: Source;
async function disposableWalletDatabase() {
  const base = new URL(process.env.TEST_DATABASE_URL!);
  const name = "val_wallet_" + randomUUID().replace(/-/g, "");
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  return new URL("/" + name, base).href;
}
beforeAll(async () => {
  source = new Source();
  app = await startTestApp({ databaseUrl: await disposableWalletDatabase(), walletRuntime: source });
});
afterAll(async () => {
  if (app) await app.close();
});
beforeEach(async () => {
  await app.ctx.db.delete(paypalWalletConnections);
  await app.ctx.db.delete(judgeDemoCounters).where(sql`${judgeDemoCounters.key} like 'wallet:%'`);
  source = new Source();
  app.ctx.walletRuntime = source;
  app.ctx.config.paypalWallet!.dailyImports = 10;
  app.ctx.config.paypalWallet!.maxConcurrent = 2;
});
async function owner() {
  const browser = app.browser();
  await browser.login();
  return { browser, id: String((await browser.open()).body.ownerId) };
}
async function tick(id: string) {
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(paypalWalletConnections.ownerId, id));
  await runWalletOwner(app.ctx, id, services);
  return walletStatus(app.ctx, id);
}
async function connected(id: string) {
  await startWalletConnection(app.ctx, id);
  await tick(id);
  source.signedIn = true;
  source.ready = true;
  for (let i = 0; i < 12; i++) {
    const result = await tick(id);
    if (result.phase === "complete") return result;
  }
  throw new Error("Synthetic wallet did not complete");
}
const commandRows = (rows: SubscriptionEntry[]) =>
  rows.map(({ serviceId, amountMinor, cycle, purpose }) => ({ serviceId, amountMinor, cycle, purpose }));

it("disables legacy financial actions for a live wallet even when local identity uses Sandbox", async () => {
  const live = await startTestApp({
    databaseUrl: await disposableWalletDatabase(),
    walletRuntime: new Source(),
    paypalWalletEnvironment: "live",
  });
  try {
    const browser = live.browser();
    await browser.login();
    expect((await browser.get("/api/deployment")).body).toEqual({
      passwordAccess: true,
      financialTools: false,
      paypalIdentityEnvironment: "sandbox",
      paypalWallet: true,
    });
    expect((await browser.post("/api/cases", { scenario: "feature_removed" })).status).toBe(404);
    expect(live.paypal.calls).toHaveLength(0);
  } finally {
    await live.close();
  }
});

it("requires owner authentication, exact consent and CSRF; capabilities and imports remain owner-bound", async () => {
  expect((await app.browser().get("/api/paypal/wallet")).status).toBe(401);
  const a = await owner(),
    b = await owner();
  expect(
    (await a.browser.post("/api/paypal/wallet/connect", { consent: "paypal-wallet.1" }, { csrf: null }))
      .status,
  ).toBe(403);
  for (const body of [
    {},
    { consent: "old" },
    { consent: "paypal-wallet.1", ownerId: b.id },
    { consent: "paypal-wallet.1", url: "https://example.test" },
  ])
    expect((await a.browser.post("/api/paypal/wallet/connect", body)).status).toBe(400);
  const start = await a.browser.post("/api/paypal/wallet/connect", { consent: "paypal-wallet.1" });
  expect(start.status).toBe(200);
  expect(start.body.phase).toBe("sign_in");
  expect(start.body.signInUrl).toContain("SecretSlug12");
  const other = await b.browser.get("/api/paypal/wallet");
  expect(other.body).toMatchObject({
    phase: "disconnected",
    signInUrl: null,
    portfolio: { subscriptions: [] },
  });
  expect(JSON.stringify((await app.ctx.db.select().from(paypalWalletConnections))[0])).not.toContain(
    "SecretSlug12",
  );
  expect((await a.browser.post("/api/paypal/wallet/check", { code: "arbitrary code" })).status).toBe(400);
  expect(
    (await a.browser.post("/api/subscriptions/chat", { message: null, expectedRevision: 0, history: [] }))
      .status,
  ).toBe(409);
  expect(app.model.requests).toHaveLength(0);
});

it("starts a fresh connection immediately even when the database default deadline is ahead of the worker clock", async () => {
  const { browser } = await owner();
  await app.ctx.db.execute(
    sql`alter table paypal_wallet_connections alter column next_attempt_at set default (now() + interval '5 seconds')`,
  );
  try {
    const start = await browser.post("/api/paypal/wallet/connect", { consent: "paypal-wallet.1" });
    expect(start.status).toBe(200);
    expect(start.body.phase).toBe("sign_in");
    expect(start.body.signInUrl).toContain("SecretSlug12");
  } finally {
    await app.ctx.db.execute(
      sql`alter table paypal_wallet_connections alter column next_attempt_at set default now()`,
    );
  }
});

it("imports only after the complete report and agreement check, without filling purpose or exposing provider references", async () => {
  const { browser, id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  source.signedIn = true;
  await tick(id);
  await tick(id);
  expect(source.submissions).toBe(1);
  await tick(id);
  await tick(id);
  expect((await browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
  source.ready = true;
  await tick(id);
  await tick(id);
  expect((await browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
  const result = await tick(id);
  expect(result.phase).toBe("complete");
  expect(result.signInUrl).toBeNull();
  expect(result.portfolio.subscriptions).toMatchObject([
    {
      serviceId: "pp_" + key("Spotify AB").slice(0, 40),
      productServiceId: "spotify",
      name: "Spotify",
      purpose: "",
      amountMinor: 1299,
      paypalEvidence: { agreementStatus: "active", paymentCount: 3 },
    },
  ]);
  expect(JSON.stringify(result)).not.toMatch(/I-ABCDEFGHIJKL|SecretSlug|profile-val/);
  expect(source.deletedBrowsers).toHaveLength(1);
  expect(source.deletedProfiles).toHaveLength(0);
  await browser.post("/api/paypal/wallet/connect", { consent: "paypal-wallet.1" });
  expect(source.submissions).toBe(1);
  await expect(
    bindBuildProfile({ ...app.ctx, config: { ...app.ctx.config, paypalWallet: null } }),
  ).rejects.toMatchObject({ code: "paypal_wallet_environment_mismatch" });
});

it("resumes after ambiguous report submission and session expiration without requesting a duplicate statement", async () => {
  const { id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  source.signedIn = true;
  await tick(id);
  const submit = source.submitReport;
  source.submitReport = async (...args) => {
    await submit(...args);
    throw new WalletRuntimeError("unavailable");
  };
  await tick(id);
  expect(source.submissions).toBe(1);
  source.ready = true;
  await tick(id);
  source.readFailure = new WalletRuntimeError("auth_required");
  expect((await tick(id)).phase).toBe("reconnect");
  const originalProfile = source.profileCalls[0];
  await startWalletConnection(app.ctx, id);
  source.readFailure = null;
  for (let i = 0; i < 8; i++) if ((await tick(id)).phase === "complete") break;
  expect((await walletStatus(app.ctx, id)).phase).toBe("complete");
  expect(source.submissions).toBe(1);
  expect(source.profileCalls).toEqual([originalProfile]);
});

it("gives a late sign-in its own bounded import window", async () => {
  const { id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  const state = openWalletState(app.ctx, id, "sandbox", connection!.secrets!);
  state.beganAt = new Date(Date.now() - 59 * 60_000).toISOString();
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ secrets: sealWalletState(app.ctx, id, "sandbox", state) })
    .where(eq(paypalWalletConnections.ownerId, id));
  source.signedIn = true;
  expect((await tick(id)).phase).toBe("preparing");
  const [signedIn] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  const importing = openWalletState(app.ctx, id, "sandbox", signedIn!.secrets!);
  importing.beganAt = new Date(Date.now() - 61 * 60_000).toISOString();
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ secrets: sealWalletState(app.ctx, id, "sandbox", importing) })
    .where(eq(paypalWalletConnections.ownerId, id));
  expect((await tick(id)).phase).toBe("preparing");
  expect(source.submissions).toBe(1);
  source.ready = true;
  for (let i = 0; i < 8; i++) if ((await tick(id)).phase === "complete") break;
  expect((await walletStatus(app.ctx, id)).phase).toBe("complete");
  expect(source.submissions).toBe(1);
});

it("expires an import after its authenticated work window", async () => {
  const { id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  const state = {
    ...openWalletState(app.ctx, id, "sandbox", connection!.secrets!),
    beganAt: new Date(Date.now() - 119 * 60_000).toISOString(),
    authenticatedAt: new Date(Date.now() - 61 * 60_000).toISOString(),
  };
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ phase: "preparing", secrets: sealWalletState(app.ctx, id, "sandbox", state) })
    .where(eq(paypalWalletConnections.ownerId, id));
  expect((await tick(id)).phase).toBe("failed");
  expect(source.submissions).toBe(0);
  expect(source.deletedBrowsers).not.toHaveLength(0);
});

it("keeps an absolute connection limit when PayPal repeatedly requires sign-in", async () => {
  const { id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  const state = {
    ...openWalletState(app.ctx, id, "sandbox", connection!.secrets!),
    beganAt: new Date(Date.now() - 121 * 60_000).toISOString(),
    authenticatedAt: new Date().toISOString(),
  };
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ phase: "reconnect", secrets: sealWalletState(app.ctx, id, "sandbox", state) })
    .where(eq(paypalWalletConnections.ownerId, id));
  source.signedIn = true;
  expect((await tick(id)).phase).toBe("failed");
  expect(source.submissions).toBe(0);
});

it("counts consecutive provider failures rather than failures separated by successful work", async () => {
  const { id } = await owner();
  await startWalletConnection(app.ctx, id);
  await tick(id);
  const authenticated = source.authenticated;
  source.authenticated = async () => {
    throw new WalletRuntimeError("unavailable");
  };
  for (let i = 0; i < 4; i++) expect((await tick(id)).phase).toBe("sign_in");
  source.authenticated = authenticated;
  expect((await tick(id)).phase).toBe("sign_in");
  const [recovered] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  expect(recovered!.failureCode).toBeNull();
  source.authenticated = async () => {
    throw new WalletRuntimeError("unavailable");
  };
  expect((await tick(id)).phase).toBe("sign_in");
  expect(source.deletedBrowsers).toHaveLength(0);
});

it("imports verified thirty-day history with its actual charge, without inventing usage or changing it to monthly", async () => {
  source.rows = {
    bills: [{ ...bill(), cycle: "30_days", paymentCount: 4, amountMinor: 1000 }],
    ledgerRecords: 4,
    unresolvedPayments: 0,
  };
  const { id } = await owner();
  const result = await connected(id);
  expect(result.phase).toBe("complete");
  expect(result.portfolio.subscriptions).toMatchObject([
    {
      amountMinor: 1000,
      cycle: "30_days",
      purpose: "",
      paypalBilling: { amountMinor: 1000, cycle: "30_days" },
      paypalEvidence: { paymentCount: 4, agreementStatus: "active" },
    },
  ]);
  expect(source.agreements).toHaveLength(1);
});

it("keeps sparse active mandates out of the portfolio until the owner confirms the last charge and period", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const { browser, id } = await owner();
  const imported = await connected(id);
  expect(imported.portfolio).toEqual({ revision: 0, subscriptions: [] });
  expect(imported.candidates).toMatchObject([
    { merchant: "Readwise", lastPaymentMinor: 1299, paymentCount: 1 },
  ]);
  expect(imported.candidates![0]!.choice).toBeUndefined();
  expect(source.agreements).toHaveLength(1);
  expect(JSON.stringify(imported)).not.toContain("I-ABCDEFGHIJKL");
  const command = {
    key: candidate().key,
    checkedAt: imported.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
    choice: "30_days",
  };
  const confirmed = await browser.post("/api/paypal/wallet/review", command);
  expect(confirmed.status).toBe(200);
  const row = confirmed.body.portfolio.subscriptions[0];
  expect(row).toMatchObject({
    name: "Readwise",
    amountMinor: 1299,
    cycle: "30_days",
    purpose: "",
    paypalEvidence: { paymentCount: 1, agreementStatus: "active", cycleBasis: "owner_confirmation" },
  });
  expect(row.paypalBilling).toBeUndefined();
  expect(confirmed.body.portfolio.revision).toBe(1);
  expect((await browser.post("/api/paypal/wallet/review", command)).body.portfolio).toEqual(
    confirmed.body.portfolio,
  );
  expect((await browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe("");
  await rememberRecognizedService(
    app.ctx,
    id,
    row.serviceId,
    row.name,
    customerProduct("Readwise", "reading", "Save, review and export reading highlights."),
  );
  app.model.script = (request, index) => {
    if (index === 0) return { call: "read_subscriptions" };
    if (index === 1) return { call: "check_paypal" };
    const outputs = (request.input as any[])
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output));
    expect(outputs.at(-1).subscriptions[0]).toMatchObject({
      amountMinor: 1299,
      cycle: "30_days",
      purpose: "",
      paymentEvidence: { cycleBasis: "owner_confirmation", observedPayments: 1 },
    });
    return {
      answer: {
        message: "What do you want to do with your reading highlights?",
        discussingRef: "saved:0",
        draft: null,
        compareRef: null,
      },
    };
  };
  const intro = await browser.post("/api/subscriptions/chat", {
    message: null,
    expectedRevision: 1,
    history: [],
  });
  expect(intro.status).toBe(200);
  expect(intro.body.draft).toBeNull();
  expect((await browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe("");
});

it("keeps candidate decisions owner-bound, CSRF-protected, exact-source and revision-checked", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const a = await owner(),
    b = await owner();
  const status = await connected(a.id);
  const command = {
    key: candidate().key,
    checkedAt: status.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
    choice: "month",
  };
  const guest = app.browser();
  await guest.open();
  expect((await guest.post("/api/paypal/wallet/review", command)).status).toBe(401);
  expect((await a.browser.post("/api/paypal/wallet/review", command, { csrf: null })).status).toBe(403);
  expect((await b.browser.post("/api/paypal/wallet/review", command)).status).toBe(409);
  for (const extra of [
    { amountMinor: 1 },
    { merchant: "Different merchant" },
    { ownerId: b.id },
    { agreementRef: "I-ABCDEFGHIJKL" },
  ])
    expect((await a.browser.post("/api/paypal/wallet/review", { ...command, ...extra })).status).toBe(400);
  for (const choice of ["week", "month; pay", null, {}])
    expect((await a.browser.post("/api/paypal/wallet/review", { ...command, choice })).status).toBe(400);
  expect(
    (await a.browser.post("/api/paypal/wallet/review", { ...command, checkedAt: "older report" })).status,
  ).toBe(409);
  expect(
    (await a.browser.post("/api/paypal/wallet/review", { ...command, expectedRevision: 8 })).status,
  ).toBe(409);
  expect(
    (await a.browser.post("/api/paypal/wallet/review", { ...command, key: key("not this payment") })).status,
  ).toBe(404);
  expect((await a.browser.get("/api/subscriptions")).body).toEqual({ revision: 0, subscriptions: [] });
  const raced = await Promise.all([
    a.browser.post("/api/paypal/wallet/review", command),
    a.browser.post("/api/paypal/wallet/review", { ...command, choice: "year" }),
  ]);
  expect(raced.map((result) => result.status).sort()).toEqual([200, 409]);
  const saved = (await a.browser.get("/api/subscriptions")).body;
  expect(saved.subscriptions).toHaveLength(1);
  expect(saved.revision).toBe(1);
});

it.each([false, true])(
  "keeps opening bill claims behind bounded correction rather than rewriting the model (persistent error: %s)",
  async (persistent) => {
    source.rows = {
      bills: [],
      candidates: [candidate("Spotify AB")],
      ledgerRecords: 1,
      unresolvedPayments: 1,
    };
    const { browser, id } = await owner();
    const status = await connected(id);
    expect(
      (
        await browser.post("/api/paypal/wallet/review", {
          key: candidate("Spotify AB").key,
          checkedAt: status.checkedAt,
          expectedRevision: 0,
          expectedReviewRevision: 0,
          choice: "30_days",
        })
      ).status,
    ).toBe(200);
    let answers = 0;
    const question = "Do you mainly use Spotify for music, podcasts or audiobooks?";
    app.model.script = (_request, index) => {
      if (index === 0) return { call: "read_subscriptions" };
      if (index === 1) return { call: "check_paypal" };
      return {
        answer: {
          message:
            answers++ === 0 || persistent
              ? "I found your £12.99 every 30 days in your PayPal wallet. What do you use Spotify for?"
              : question,
          discussingRef: "saved:0",
          draft: null,
          compareRef: null,
        },
      };
    };
    const result = await browser.post("/api/subscriptions/chat", {
      message: null,
      expectedRevision: 1,
      history: [],
    });
    expect(answers).toBe(2);
    expect(result.status).toBe(persistent ? 503 : 200);
    if (!persistent) expect(result.body.message).toBe(question);
    const row = (await browser.get("/api/subscriptions")).body.subscriptions[0];
    expect(row).toMatchObject({ amountMinor: 1299, cycle: "30_days", purpose: "" });
  },
);

it("versions two non-subscription choices independently of the unchanged portfolio and rejects stale ABA replays", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const a = await owner();
  let status = await connected(a.id);
  const command = {
    key: candidate().key,
    checkedAt: status.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
  };
  const raced = await Promise.all([
    a.browser.post("/api/paypal/wallet/review", { ...command, choice: "not_recurring" }),
    a.browser.post("/api/paypal/wallet/review", { ...command, choice: "later" }),
  ]);
  expect(raced.map((item) => item.status).sort()).toEqual([200, 409]);
  status = (await a.browser.get("/api/paypal/wallet")).body;
  const winner = status.candidates![0]!.choice!;
  expect(status.portfolio).toEqual({ revision: 0, subscriptions: [] });
  expect(status.candidates![0]!.reviewRevision).toBe(1);
  expect((await a.browser.post("/api/paypal/wallet/review", { ...command, choice: winner })).status).toBe(
    200,
  );
  const other = winner === "later" ? "not_recurring" : "later";
  expect(
    (
      await a.browser.post("/api/paypal/wallet/review", {
        ...command,
        expectedReviewRevision: 1,
        choice: other,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await a.browser.post("/api/paypal/wallet/review", {
        ...command,
        expectedReviewRevision: 2,
        choice: winner,
      })
    ).status,
  ).toBe(200);
  expect((await a.browser.post("/api/paypal/wallet/review", { ...command, choice: winner })).status).toBe(
    409,
  );
  expect(
    (
      await a.browser.post("/api/paypal/wallet/review", {
        ...command,
        expectedReviewRevision: undefined,
        choice: winner,
      })
    ).status,
  ).toBe(400);
  const b = await owner();
  const separate = await connected(b.id);
  expect(separate.candidates![0]!.choice).toBeUndefined();
  expect(separate.candidates![0]!.reviewRevision).toBe(0);
  expect(separate.portfolio.subscriptions).toEqual([]);
});

it.each(["not_recurring", "later", "month", "year", "30_days"] as const)(
  "preserves %s across full provider disconnection and re-exposes current evidence after reconnect",
  async (choice) => {
    source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
    const { browser, id } = await owner();
    const first = await connected(id);
    const command = {
      key: candidate().key,
      checkedAt: first.checkedAt,
      expectedRevision: 0,
      expectedReviewRevision: 0,
      choice,
    };
    const chosen = await browser.post("/api/paypal/wallet/review", command);
    expect(chosen.status).toBe(200);
    expect(chosen.body.candidates[0]).toMatchObject({ choice, reviewRevision: 1 });
    if (choice === "not_recurring" || choice === "later")
      expect(chosen.body.portfolio.subscriptions).toEqual([]);
    else {
      const row = chosen.body.portfolio.subscriptions[0];
      const memory = await browser.request("PUT", "/api/subscriptions", {
        expectedRevision: 1,
        subscriptions: commandRows([{ ...row, purpose: "Export French book-club highlights to Obsidian." }]),
      });
      expect(memory.status).toBe(200);
    }
    const removed = await browser.request("DELETE", "/api/paypal/wallet", {});
    expect(removed.status).toBe(200);
    expect(removed.body.phase).toBe("disconnected");
    expect(source.deletedProfiles).toHaveLength(1);
    expect(
      await app.ctx.db.select().from(paypalWalletConnections).where(eq(paypalWalletConnections.ownerId, id)),
    ).toHaveLength(0);
    const saved = await app.ctx.db
      .select()
      .from(paypalWalletReviews)
      .where(eq(paypalWalletReviews.ownerId, id));
    expect(saved).toMatchObject([{ choice, revision: 1, environment: "sandbox" }]);
    expect(Object.keys(saved[0]!).sort()).toEqual(
      ["ownerId", "environment", "paymentKey", "choice", "revision", "updatedAt"].sort(),
    );
    expect(JSON.stringify(saved)).not.toMatch(/SecretSlug|I-ABCDEFGHIJKL|Readwise/);
    source.rows = {
      bills: [{ ...bill("Readwise"), amountMinor: 1499, paymentCount: 4 }],
      ledgerRecords: 4,
      unresolvedPayments: 0,
    };
    const restored = await connected(id);
    expect(restored.candidates![0]).toMatchObject({
      choice,
      reviewRevision: 1,
      lastPaymentMinor: 1499,
      paymentCount: 4,
      historyCycle: "month",
    });
    if (choice === "not_recurring" || choice === "later")
      expect(restored.portfolio.subscriptions).toEqual([]);
    else
      expect(restored.portfolio.subscriptions[0]).toMatchObject({
        amountMinor: 1299,
        cycle: choice,
        purpose: "Export French book-club highlights to Obsidian.",
      });
    expect((await browser.post("/api/paypal/wallet/review", command)).status).toBe(409);
    const reviewAgain = await browser.post("/api/paypal/wallet/review", {
      ...command,
      checkedAt: restored.checkedAt,
      expectedRevision: restored.portfolio.revision,
      expectedReviewRevision: 1,
      choice: "30_days",
    });
    expect(reviewAgain.status).toBe(200);
    expect(reviewAgain.body.portfolio.subscriptions[0]).toMatchObject({
      amountMinor: 1499,
      cycle: "30_days",
      purpose:
        choice === "not_recurring" || choice === "later"
          ? ""
          : "Export French book-club highlights to Obsidian.",
    });
    expect(reviewAgain.body.candidates[0]).toMatchObject({ choice: "30_days", reviewRevision: 2 });
  },
);

it("keeps the same owner's decisions separated by PayPal environment", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const { browser, id } = await owner();
  await app.ctx.db.insert(paypalWalletReviews).values({
    ownerId: id,
    environment: "live",
    paymentKey: candidate().key,
    choice: "not_recurring",
    revision: 1,
  });
  const status = await connected(id);
  expect(status.candidates![0]!.choice).toBeUndefined();
  expect(status.candidates![0]!.reviewRevision).toBe(0);
  const confirmed = await browser.post("/api/paypal/wallet/review", {
    key: candidate().key,
    checkedAt: status.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
    choice: "month",
  });
  expect(confirmed.status).toBe(200);
  const saved = await app.ctx.db
    .select()
    .from(paypalWalletReviews)
    .where(eq(paypalWalletReviews.ownerId, id));
  expect(saved).toHaveLength(2);
  expect(saved.find((item) => item.environment === "live")!.choice).toBe("not_recurring");
  expect(saved.find((item) => item.environment === "sandbox")!.choice).toBe("month");
});

it("loads classifications from the database in a fresh application instance rather than a browser or server cache", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const { browser, id } = await owner();
  const status = await connected(id);
  const command = {
    key: candidate().key,
    checkedAt: status.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
    choice: "later",
  };
  expect((await browser.post("/api/paypal/wallet/review", command)).status).toBe(200);
  const restarted = await startTestApp({
    databaseUrl: app.ctx.config.databaseUrl,
    walletRuntime: new Source(),
  });
  try {
    const next = restarted.browser();
    const prefix = app.ctx.config.cookieNamespace ?? "val";
    for (const suffix of ["session", "owner"])
      next.setCookie(prefix + "_" + suffix, browser.cookie(prefix + "_" + suffix));
    expect((await next.open()).body.ownerId).toBe(id);
    const restored = await next.get("/api/paypal/wallet");
    expect(restored.body.candidates).toMatchObject([{ choice: "later", reviewRevision: 1 }]);
    expect(restored.body.portfolio).toEqual({ revision: 0, subscriptions: [] });
    expect(
      (
        await next.post("/api/paypal/wallet/review", {
          ...command,
          expectedReviewRevision: 1,
          choice: "not_recurring",
        })
      ).status,
    ).toBe(200);
    expect((await browser.get("/api/paypal/wallet")).body.candidates).toMatchObject([
      { choice: "not_recurring", reviewRevision: 2 },
    ]);
    expect((await browser.post("/api/paypal/wallet/review", command)).status).toBe(409);
  } finally {
    await restarted.close();
  }
});

it("migrates existing classifications and memory without moving credentials into the durable decision table", async () => {
  const url = await disposableWalletDatabase();
  expect(new URL(url).pathname).toMatch(/^\/val_wallet_[a-f0-9]+$/);
  const { db, pool } = connect(url);
  const priorMigrations = mkdtempSync(join(tmpdir(), "val-wallet-migrations-"));
  try {
    // Build the actual preceding schema, even after later migrations have been added.
    const journal = JSON.parse(
      readFileSync(new URL("../migrations/meta/_journal.json", import.meta.url), "utf8"),
    );
    journal.entries = journal.entries.filter((entry: { when: number }) => entry.when < 1793489000000);
    mkdirSync(join(priorMigrations, "meta"));
    writeFileSync(join(priorMigrations, "meta", "_journal.json"), JSON.stringify(journal));
    for (const entry of journal.entries)
      copyFileSync(
        new URL(`../migrations/${entry.tag}.sql`, import.meta.url),
        join(priorMigrations, `${entry.tag}.sql`),
      );
    await migrate(db, { migrationsFolder: priorMigrations });
    const ownerId = randomUUID(),
      remembered = key("remembered"),
      excluded = key("excluded"),
      legacy = key("legacy-choice"),
      fallback = key("fallback");
    await db.insert(owners).values({ id: ownerId });
    await pool.query(
      "INSERT INTO application_deployment (id,profile,paypal_identity_environment,paypal_wallet_environment) VALUES ('primary','owner','sandbox','sandbox')",
    );
    const portfolio = [
      {
        serviceId: "pp_" + remembered.slice(0, 40),
        name: "Synthetic reading tool",
        source: "paypal",
        amountMinor: 1299,
        cycle: "30_days",
        purpose: "Keep private reading notes.",
        paypalEvidence: { key: remembered, cycleBasis: "owner_confirmation", paymentCount: 1 },
      },
      {
        serviceId: "pp_" + excluded.slice(0, 40),
        name: "Excluded synthetic payment",
        source: "paypal",
        amountMinor: null,
        cycle: "month",
        purpose: "",
        paypalEvidence: { key: excluded, excludedByOwner: true },
      },
      {
        serviceId: "pp_" + fallback.slice(0, 40),
        name: "Earlier exclusion without its reason",
        source: "paypal",
        amountMinor: null,
        cycle: "month",
        purpose: "",
        paypalEvidence: { key: fallback, excludedByOwner: true },
      },
    ];
    await pool.query(
      "INSERT INTO owner_subscriptions (owner_id, revision, subscriptions) VALUES ($1, 7, $2)",
      [ownerId, JSON.stringify(portfolio)],
    );
    const result = {
      bills: [],
      checkedAt: "2026-10-31T00:00:00Z",
      ledgerRecords: 3,
      unresolvedPayments: 3,
      candidates: [
        { key: legacy, choice: "not_recurring" },
        { key: excluded, choice: "not_recurring" },
        { key: "raw-provider-reference", choice: "month" },
        { key: key("invalid"), choice: "execute" },
      ],
    };
    await pool.query(
      "INSERT INTO paypal_wallet_connections (owner_id,environment,phase,secrets,result) VALUES ($1,'sandbox','complete','synthetic-encrypted-capability',$2)",
      [ownerId, JSON.stringify(result)],
    );
    await migrateDatabase(db);
    await migrateDatabase(db);
    const saved = await db.select().from(paypalWalletReviews).where(eq(paypalWalletReviews.ownerId, ownerId));
    expect(saved).toHaveLength(4);
    expect(saved.find((item) => item.paymentKey === remembered)).toMatchObject({
      choice: "30_days",
      revision: 1,
    });
    expect(saved.find((item) => item.paymentKey === excluded)).toMatchObject({
      choice: "not_recurring",
      revision: 1,
    });
    expect(saved.find((item) => item.paymentKey === legacy)).toMatchObject({
      choice: "not_recurring",
      revision: 1,
    });
    expect(saved.find((item) => item.paymentKey === fallback)).toMatchObject({
      choice: "later",
      revision: 1,
    });
    expect(JSON.stringify(saved)).not.toMatch(
      /encrypted-capability|reading notes|reading tool|raw-provider-reference/,
    );
    const [original] = await db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, ownerId));
    expect(original!.subscriptions).toEqual(portfolio);
    expect(original!.revision).toBe(7);
  } finally {
    await pool.end();
    rmSync(priorMigrations, { recursive: true, force: true });
  }
});

it("allows a fresh explicit confirmation to replace a later cost correction without treating an old retry as authority", async () => {
  source.rows = {
    bills: [],
    candidates: [{ ...candidate(), currency: "EUR", amountMinor: 1500 }],
    ledgerRecords: 1,
    unresolvedPayments: 1,
  };
  const { browser, id } = await owner();
  const status = await connected(id);
  const command = {
    key: candidate().key,
    checkedAt: status.checkedAt,
    expectedRevision: 0,
    expectedReviewRevision: 0,
    choice: "month",
  };
  const first = await browser.post("/api/paypal/wallet/review", command);
  expect(first.status).toBe(200);
  const row = first.body.portfolio.subscriptions[0];
  expect(row).toMatchObject({ amountMinor: 1500, cycle: "month", currency: "EUR", purpose: "" });
  const correction = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    subscriptions: commandRows([
      { ...row, amountMinor: 2000, cycle: "year", purpose: "Keep and export annotations." },
    ]),
  });
  expect(correction.status).toBe(200);
  expect((await browser.post("/api/paypal/wallet/review", command)).status).toBe(409);
  const reconfirmed = await browser.post("/api/paypal/wallet/review", {
    ...command,
    expectedRevision: 2,
    expectedReviewRevision: 1,
  });
  expect(reconfirmed.status).toBe(200);
  expect(reconfirmed.body.portfolio.subscriptions[0]).toMatchObject({
    amountMinor: 1500,
    cycle: "month",
    currency: "EUR",
    purpose: "Keep and export annotations.",
    paypalEvidence: { cycleBasis: "owner_confirmation" },
  });
});

it("preserves an excluded payment and its confirmed needs through memory saves, reimports and reversal", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  const { browser, id } = await owner();
  let status = await connected(id);
  const choose = async (choice: string) => {
    const result = await browser.post("/api/paypal/wallet/review", {
      key: candidate().key,
      checkedAt: status.checkedAt,
      expectedRevision: status.portfolio.revision,
      expectedReviewRevision: status.candidates!.find((item) => item.key === candidate().key)!.reviewRevision,
      choice,
    });
    expect(result.status).toBe(200);
    status = result.body;
  };
  await choose("month");
  const first = status.portfolio.subscriptions[0]!;
  const memory = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: status.portfolio.revision,
    subscriptions: commandRows([{ ...first, purpose: "Export French book-club highlights to Obsidian." }]),
  });
  expect(memory.status).toBe(200);
  status.portfolio = memory.body;
  await choose("not_recurring");
  expect(status.portfolio.subscriptions).toEqual([]);
  const staleSave = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: status.portfolio.revision,
    subscriptions: commandRows([first]),
  });
  expect(staleSave.status).toBe(409);
  expect(
    (
      await browser.post("/api/subscriptions/review", {
        serviceId: first.serviceId,
        expectedRevision: status.portfolio.revision,
      })
    ).status,
  ).toBe(404);
  const otherBill = bill("Spotify AB");
  await mergeWalletResult(
    app.ctx,
    id,
    { bills: [otherBill], checkedAt: new Date().toISOString(), ledgerRecords: 3, unresolvedPayments: 0 },
    services,
  );
  const current = (await browser.get("/api/subscriptions")).body;
  const saved = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: current.revision,
    subscriptions: commandRows(current.subscriptions),
  });
  expect(saved.status).toBe(200);
  const [retained] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, id));
  expect(retained!.subscriptions.find((item) => item.serviceId === first.serviceId)?.purpose).toContain(
    "French",
  );
  // More observations must not silently reverse the person's classification.
  source.rows = {
    bills: [{ ...bill("Readwise"), paymentCount: 4, amountMinor: 1499 }],
    ledgerRecords: 4,
    unresolvedPayments: 0,
  };
  // Reuse the completed connection after its refresh interval, without clearing its decisions.
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({
      result: { ...connection!.result!, checkedAt: new Date(0).toISOString() },
    })
    .where(eq(paypalWalletConnections.ownerId, id));
  await startWalletConnection(app.ctx, id);
  for (let i = 0; i < 12; i++) {
    status = await tick(id);
    if (status.phase === "complete") break;
  }
  expect(status.portfolio.subscriptions.some((item) => item.serviceId === first.serviceId)).toBe(false);
  expect(status.candidates?.find((item) => item.key === candidate().key)?.choice).toBe("not_recurring");
  expect(status.candidates?.find((item) => item.key === candidate().key)).toMatchObject({
    lastPaymentMinor: 1499,
    paymentCount: 4,
    historyCycle: "month",
  });
  await choose("year");
  expect(status.portfolio.subscriptions.find((item) => item.serviceId === first.serviceId)).toMatchObject({
    amountMinor: 1499,
    cycle: "year",
    purpose: "Export French book-club highlights to Obsidian.",
  });
});

it("does not promote inactive sparse agreements or accept malformed candidate evidence", async () => {
  source.rows = { bills: [], candidates: [candidate()], ledgerRecords: 1, unresolvedPayments: 1 };
  source.active = false;
  const inactive = await owner();
  const status = await connected(inactive.id);
  expect(status.candidates).toEqual([]);
  expect(status.portfolio.subscriptions).toEqual([]);
  source.active = true;
  const invalid = await owner();
  source.rows.candidates![0]!.paymentCount = 0;
  await startWalletConnection(app.ctx, invalid.id);
  source.signedIn = true;
  for (let i = 0; i < 14; i++) await tick(invalid.id);
  expect((await walletStatus(app.ctx, invalid.id)).phase).toBe("failed");
  expect((await invalid.browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
});

it("retries form preparation and definitive pre-click failures without recording a report that was never submitted", async () => {
  const { id } = await owner();
  let preparations = 0,
    submissions = 0;
  source.prepareReport = async () => {
    if (preparations++ === 0) throw new WalletRuntimeError("layout_changed");
  };
  const submit = source.submitReport;
  source.submitReport = async (...args) => {
    if (submissions++ === 0) throw new WalletRuntimeError("not_submitted");
    await submit(...args);
  };
  await startWalletConnection(app.ctx, id);
  await tick(id);
  source.signedIn = true;
  source.ready = true;
  await tick(id);
  await tick(id);
  const [before] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  expect(openWalletState(app.ctx, id, "sandbox", before!.secrets!).submitted).toBeUndefined();
  await tick(id);
  const [refused] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  expect(openWalletState(app.ctx, id, "sandbox", refused!.secrets!).submitted).toBe(false);
  for (let i = 0; i < 8; i++) if ((await tick(id)).phase === "complete") break;
  expect((await walletStatus(app.ctx, id)).phase).toBe("complete");
  expect(source.submissions).toBe(1);
});

it("retains a browser slot after uncertain creation until deletion is confirmed", async () => {
  const a = await owner(),
    b = await owner(),
    c = await owner();
  const browser = source.browser,
    remove = source.deleteBrowser;
  source.browser = async () => {
    throw new WalletRuntimeError("unavailable");
  };
  source.deleteBrowser = async () => {
    throw new WalletRuntimeError("unavailable");
  };
  await startWalletConnection(app.ctx, a.id);
  for (let i = 0; i < 5; i++) await tick(a.id);
  const [failed] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, a.id));
  expect(failed).toMatchObject({ phase: "failed", browserReserved: true });
  source.browser = browser;
  await startWalletConnection(app.ctx, b.id);
  await tick(b.id);
  await startWalletConnection(app.ctx, c.id);
  await tick(c.id);
  expect((await walletStatus(app.ctx, c.id)).phase).toBe("queued");
  source.deleteBrowser = remove;
  await tick(a.id);
  await tick(c.id);
  expect((await walletStatus(app.ctx, c.id)).phase).toBe("sign_in");
});

it("preserves needs and explicit cost corrections across refreshes, deactivates exact contracts and keeps matching merchant agreements distinct", async () => {
  const { browser, id } = await owner();
  source.rows.bills = [bill(), bill("Spotify AB", "second contract")];
  source.rows.bills[1]!.agreementRef = null;
  const result = await connected(id);
  const entries = result.portfolio.subscriptions.map((row, index) => ({
    ...row,
    amountMinor: index === 0 ? 999 : row.amountMinor,
    purpose: index === 0 ? "Offline jazz on train journeys." : "Music at the office.",
  }));
  const saved = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: result.portfolio.revision,
    subscriptions: commandRows(entries),
  });
  expect(saved.status).toBe(200);
  const { agreementRef: _ref, ...updated } = bill();
  await mergeWalletResult(
    app.ctx,
    id,
    {
      bills: [{ ...updated, amountMinor: 1499, agreementStatus: "active" }],
      ledgerRecords: 9,
      unresolvedPayments: 1,
      checkedAt: new Date().toISOString(),
      inactiveKeys: [key("second contract")],
    },
    services,
  );
  const after = (await browser.get("/api/subscriptions")).body;
  expect(after.subscriptions).toMatchObject([
    { amountMinor: 999, purpose: "Offline jazz on train journeys.", paypalBilling: { amountMinor: 1499 } },
  ]);
  const [raw] = await app.ctx.db.select().from(ownerSubscriptions).where(eq(ownerSubscriptions.ownerId, id));
  expect(raw!.subscriptions).toHaveLength(2);
  expect(raw!.subscriptions[1]!.purpose).toBe("Music at the office.");
  expect(
    (
      await browser.request("PUT", "/api/subscriptions", {
        expectedRevision: after.revision,
        subscriptions: commandRows(after.subscriptions),
      })
    ).status,
  ).toBe(200);
  const [retained] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, id));
  expect(retained!.subscriptions).toHaveLength(2);
});

it.each(["inferred", "active"] as const)(
  "withdraws stale charge evidence without cancelling an %s agreement or forgetting needs",
  async (agreementStatus) => {
    const { browser, id } = await owner();
    const old = { ...bill(), agreementStatus, lastPaidOn: "2026-07-05" };
    await mergeWalletResult(
      app.ctx,
      id,
      { bills: [old], ledgerRecords: 3, unresolvedPayments: 0, checkedAt: "2026-07-06T00:00:00Z" },
      services,
    );
    const initial = (await browser.get("/api/subscriptions")).body;
    const saved = await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: initial.revision,
      subscriptions: commandRows(
        initial.subscriptions.map((row: SubscriptionEntry) => ({
          ...row,
          purpose: "Offline jazz while travelling.",
        })),
      ),
    });
    expect(saved.status).toBe(200);
    const refresh = { bills: [], ledgerRecords: 0, unresolvedPayments: 0, checkedAt: "2026-11-06T00:00:00Z" };
    await mergeWalletResult(app.ctx, id, refresh, services);
    const empty = (await browser.get("/api/subscriptions")).body;
    expect(empty.subscriptions).toEqual([]);
    const [stored] = await app.ctx.db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, id));
    expect(stored!.subscriptions[0]).toMatchObject({
      amountMinor: 1299,
      purpose: "Offline jazz while travelling.",
      paypalEvidence: { agreementStatus, recurrenceStale: true },
    });
    const calls = app.model.requests.length;
    expect(
      (
        await browser.post("/api/subscriptions/review", {
          serviceId: initial.subscriptions[0].serviceId,
          expectedRevision: empty.revision,
        })
      ).status,
    ).toBe(404);
    expect(app.model.requests).toHaveLength(calls);
    expect(
      (
        await browser.request("PUT", "/api/subscriptions", {
          expectedRevision: empty.revision,
          subscriptions: commandRows(saved.body.subscriptions),
        })
      ).body.error,
    ).toBe("subscription_unconfirmed");
    const emptySave = await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: empty.revision,
      subscriptions: [{ serviceId: "netflix", amountMinor: 1299, cycle: "month", purpose: "Films at home" }],
    });
    expect(emptySave.status).toBe(200);
    await mergeWalletResult(
      app.ctx,
      id,
      {
        ...refresh,
        bills: [{ ...old, lastPaidOn: "2026-11-07", paymentCount: 4 }],
        checkedAt: "2026-11-08T00:00:00Z",
      },
      services,
    );
    const restored = (await browser.get("/api/subscriptions")).body;
    expect(restored.subscriptions).toHaveLength(2);
    const returned = restored.subscriptions.find(
      (row: SubscriptionEntry) => row.serviceId === initial.subscriptions[0].serviceId,
    );
    expect(returned).toMatchObject({
      amountMinor: 1299,
      purpose: "Offline jazz while travelling.",
    });
    expect(returned.paypalEvidence.recurrenceStale).toBeUndefined();
  },
);

it("does not expire recent monthly charges, annual charges within their period, or evidence from an older refresh", async () => {
  const { browser, id } = await owner();
  const monthly = { ...bill(), lastPaidOn: "2026-10-20" };
  const annual = { ...bill("Annual service"), cycle: "year" as const, lastPaidOn: "2026-01-01" };
  const old = { ...bill("Older service"), lastPaidOn: "2026-07-01" };
  await mergeWalletResult(
    app.ctx,
    id,
    {
      bills: [monthly, annual, old],
      ledgerRecords: 4,
      unresolvedPayments: 0,
      checkedAt: "2026-11-01T00:00:00Z",
    },
    services,
  );
  for (const checkedAt of ["2026-10-30T00:00:00Z", "2026-11-06T00:00:00Z"]) {
    await mergeWalletResult(
      app.ctx,
      id,
      { bills: [], ledgerRecords: 0, unresolvedPayments: 0, checkedAt },
      services,
    );
    expect((await browser.get("/api/subscriptions")).body.subscriptions).toHaveLength(
      checkedAt === "2026-10-30T00:00:00Z" ? 3 : 2,
    );
  }
});

it("rejects stale writes to archived bills without duplicating or overwriting their saved needs", async () => {
  const { browser, id } = await owner();
  source.rows.bills = [bill(), bill("Spotify AB", "archived contract")];
  const imported = await connected(id);
  const entries = imported.portfolio.subscriptions.map((row, index) => ({
    ...row,
    purpose: index === 0 ? "Offline music during travel." : "A separate family listening plan.",
  }));
  expect(
    (
      await browser.request("PUT", "/api/subscriptions", {
        expectedRevision: imported.portfolio.revision,
        subscriptions: commandRows(entries),
      })
    ).status,
  ).toBe(200);
  await mergeWalletResult(
    app.ctx,
    id,
    {
      bills: [],
      inactiveKeys: [key("archived contract")],
      ledgerRecords: 9,
      unresolvedPayments: 0,
      checkedAt: new Date().toISOString(),
    },
    services,
  );
  const [before] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, id));
  for (let attempt = 0; attempt < 2; attempt++) {
    const saved = await browser.request("PUT", "/api/subscriptions", {
      expectedRevision: before!.revision,
      subscriptions: commandRows(entries.map((row) => ({ ...row, purpose: "A stale browser edit." }))),
    });
    expect(saved.status).toBe(409);
    expect(saved.body.error).toBe("subscription_inactive");
  }
  const [after] = await app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, id));
  expect(after).toEqual(before);
});

it("binds encrypted session state to owner and environment and rejects malformed remote output before publishing", async () => {
  const a = await owner(),
    b = await owner();
  const state = {
    version: 1,
    name: "val-wallet-" + randomUUID(),
    consent: "paypal-wallet.1",
    scope: { start: "2024-10-21", end: "2026-10-21" },
    beganAt: new Date().toISOString(),
  };
  const sealed = sealWalletState(app.ctx, a.id, "sandbox", state);
  expect(openWalletState(app.ctx, a.id, "sandbox", sealed)).toEqual(state);
  expect(() => openWalletState(app.ctx, b.id, "sandbox", sealed)).toThrow();
  expect(() => openWalletState(app.ctx, a.id, "live", sealed)).toThrow();
  source.rows.bills[0]!.lastPaidOn = "2026-02-31";
  await startWalletConnection(app.ctx, a.id);
  await tick(a.id);
  source.signedIn = true;
  source.ready = true;
  for (let i = 0; i < 12; i++) await tick(a.id);
  expect((await walletStatus(app.ctx, a.id)).phase).toBe("failed");
  expect((await a.browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
  const response = await a.browser.request("DELETE", "/api/paypal/wallet", {});
  expect(response.body.phase).toBe("disconnected");
  expect(source.deletedProfiles).toHaveLength(1);
});

it("keeps legacy connections readable and disconnectable after session and wallet-key rotation", async () => {
  const { browser, id } = await owner();
  const imported = await connected(id);
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: imported.portfolio.revision,
    subscriptions: commandRows(
      imported.portfolio.subscriptions.map((row) => ({ ...row, purpose: "Offline music on trains" })),
    ),
  });
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, id));
  const state = openWalletState(app.ctx, id, "sandbox", connection!.secrets!);
  const previousConfig = app.ctx.config;
  // Recreate the old unversioned envelope, using its original key and AAD.
  const iv = randomBytes(12);
  const key = createHash("sha256")
    .update("val-wallet-encryption.1\0" + previousConfig.sessionSecret)
    .digest();
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(id + "\0sandbox"));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(state), "utf8"), cipher.final()]);
  const legacy = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ secrets: legacy })
    .where(eq(paypalWalletConnections.ownerId, id));
  try {
    const firstKey = "synthetic-first-wallet-key-0123456789abcdef";
    app.ctx.config = {
      ...previousConfig,
      dataSecret: previousConfig.sessionSecret,
      sessionSecret: "synthetic-rotated-session-key-0123456789",
      walletEncryption: { activeId: "first", keys: { first: firstKey } },
    };
    expect(openWalletState(app.ctx, id, "sandbox", legacy)).toEqual(state);
    const first = sealWalletState(app.ctx, id, "sandbox", state);
    expect(first).toMatch(/^v2\.first\./);
    app.ctx.config.walletEncryption = {
      activeId: "second",
      keys: {
        first: firstKey,
        second: "synthetic-second-wallet-key-0123456789abcdef",
      },
    };
    expect(openWalletState(app.ctx, id, "sandbox", first)).toEqual(state);
    const second = sealWalletState(app.ctx, id, "sandbox", state);
    expect(second).toMatch(/^v2\.second\./);
    expect(openWalletState(app.ctx, id, "sandbox", second)).toEqual(state);
    expect(() => openWalletState(app.ctx, id, "sandbox", second.replace(".second.", ".first."))).toThrow();
    delete app.ctx.config.walletEncryption.keys.first;
    expect(() => openWalletState(app.ctx, id, "sandbox", first)).toThrow();
    // Legacy data is still available for remote cleanup; rotation never silently drops the connection.
    await browser.login();
    expect((await browser.open()).body.ownerId).toBe(id);
    expect((await browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe(
      "Offline music on trains",
    );
    expect((await browser.request("DELETE", "/api/paypal/wallet", {})).body.phase).toBe("disconnected");
    expect(source.deletedProfiles).toHaveLength(1);
    expect(
      await app.ctx.db.select().from(paypalWalletConnections).where(eq(paypalWalletConnections.ownerId, id)),
    ).toHaveLength(0);
  } finally {
    app.ctx.config = previousConfig;
  }
});

it("bounds simultaneous browsers and daily admissions, and lets disconnect win over a running import", async () => {
  const a = await owner(),
    b = await owner(),
    c = await owner();
  for (const owner of [a, b, c]) {
    await startWalletConnection(app.ctx, owner.id);
    await tick(owner.id);
  }
  expect(source.browserCalls).toHaveLength(2);
  expect((await walletStatus(app.ctx, c.id)).phase).toBe("queued");
  await a.browser.request("DELETE", "/api/paypal/wallet", {});
  await tick(c.id);
  expect(source.browserCalls).toHaveLength(3);
  const next = await owner();
  app.ctx.config.paypalWallet!.dailyImports = 3;
  expect((await next.browser.post("/api/paypal/wallet/connect", { consent: "paypal-wallet.1" })).status).toBe(
    429,
  );
  // Disconnect races a source read: the stale worker must never commit the received rows.
  source.signedIn = true;
  source.ready = true;
  await tick(b.id);
  await tick(b.id);
  await tick(b.id);
  let release!: (value: WalletRead) => void;
  source.readReport = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const work = tick(b.id);
  while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
  expect((await b.browser.request("DELETE", "/api/paypal/wallet", {})).body.phase).toBe("disconnecting");
  release(structuredClone(source.rows));
  await work;
  await tick(b.id);
  expect((await walletStatus(app.ctx, b.id)).phase).toBe("disconnected");
  expect((await b.browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
});

async function queuedWalletOwners(count: number) {
  const ids = Array.from({ length: count }, () => randomUUID());
  await app.ctx.db.insert(owners).values(ids.map((id) => ({ id })));
  app.ctx.config.paypalWallet!.dailyImports = 100;
  for (const id of ids) await startWalletConnection(app.ctx, id);
  await app.ctx.db.update(paypalWalletConnections).set({ nextAttemptAt: new Date(0) });
  return ids;
}

it.each(["disconnecting", "failed"] as const)(
  "processes %s cleanup behind a full batch of blocked imports without duplicate work",
  async (phase) => {
    app.ctx.config.paypalWallet!.maxConcurrent = 1;
    const ids = await queuedWalletOwners(13);
    const cleanupId = ids.at(-1)!;
    await tick(cleanupId);
    const [connection] = await app.ctx.db
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, cleanupId));
    const state = openWalletState(app.ctx, cleanupId, "sandbox", connection!.secrets!);
    await app.ctx.db
      .update(paypalWalletConnections)
      .set({ phase, nextAttemptAt: new Date(0) })
      .where(eq(paypalWalletConnections.ownerId, cleanupId));

    await Promise.all([runWalletJobs(app.ctx, services), runWalletJobs(app.ctx, services)]);
    const [cleaned] = await app.ctx.db
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, cleanupId));
    if (phase === "disconnecting") expect(cleaned).toBeUndefined();
    else expect(cleaned).toMatchObject({ phase: "failed", browserReserved: false });
    expect(source.deletedBrowsers.filter((id) => id === state.browserId)).toHaveLength(1);
    if (phase === "disconnecting")
      expect(source.deletedProfiles.filter((id) => id === state.profileId)).toHaveLength(1);

    await runWalletJobs(app.ctx, services);
    const rows = await app.ctx.db.select().from(paypalWalletConnections);
    expect(rows.filter((row) => row.browserReserved)).toHaveLength(1);
    expect(rows.some((row) => row.ownerId !== cleanupId && row.phase === "sign_in")).toBe(true);
    expect(source.browserCalls).toHaveLength(2);
  },
);

it.each(["environment", "lease"] as const)(
  "excludes %s-ineligible rows before limiting the wallet batch",
  async (blockedBy) => {
    const ids = await queuedWalletOwners(13);
    for (const id of ids.slice(0, -1))
      await app.ctx.db
        .update(paypalWalletConnections)
        .set({
          phase: "disconnecting",
          ...(blockedBy === "environment"
            ? { environment: "live" as const }
            : { leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 60_000) }),
        })
        .where(eq(paypalWalletConnections.ownerId, id));
    const cleanupId = ids.at(-1)!;
    await app.ctx.db
      .update(paypalWalletConnections)
      .set({ phase: "disconnecting" })
      .where(eq(paypalWalletConnections.ownerId, cleanupId));

    await runWalletJobs(app.ctx, services);
    const rows = await app.ctx.db.select().from(paypalWalletConnections);
    expect(rows.map((row) => row.ownerId).sort()).toEqual(ids.slice(0, -1).sort());
    expect(source.deletedProfiles).toHaveLength(1);
    expect(source.browserCalls).toHaveLength(0);
  },
);

it("cleans expired failed profiles without a browser reservation while new imports are blocked", async () => {
  app.ctx.config.paypalWallet!.maxConcurrent = 1;
  const ids = await queuedWalletOwners(13);
  const heldId = ids.at(-2)!,
    cleanupId = ids.at(-1)!;
  await tick(heldId);
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ nextAttemptAt: new Date(Date.now() + 60_000) })
    .where(eq(paypalWalletConnections.ownerId, heldId));
  const [connection] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, cleanupId));
  const state = openWalletState(app.ctx, cleanupId, "sandbox", connection!.secrets!);
  state.beganAt = new Date(Date.now() - 8 * 86400_000).toISOString();
  state.profileId = "profile-" + state.name;
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ phase: "failed", secrets: sealWalletState(app.ctx, cleanupId, "sandbox", state) })
    .where(eq(paypalWalletConnections.ownerId, cleanupId));

  await runWalletJobs(app.ctx, services);
  const rows = await app.ctx.db.select().from(paypalWalletConnections);
  expect(rows.find((row) => row.ownerId === cleanupId)).toMatchObject({
    secrets: null,
    browserReserved: false,
  });
  expect(source.deletedProfiles).toEqual([state.profileId]);
  expect(rows.filter((row) => row.browserReserved).map((row) => row.ownerId)).toEqual([heldId]);
  expect(source.browserCalls).toHaveLength(1);
});

it("retains an uncertain cleanup reservation under queue pressure until removal succeeds", async () => {
  app.ctx.config.paypalWallet!.maxConcurrent = 1;
  const ids = await queuedWalletOwners(13);
  const cleanupId = ids.at(-1)!;
  await tick(cleanupId);
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ phase: "disconnecting", nextAttemptAt: new Date(0) })
    .where(eq(paypalWalletConnections.ownerId, cleanupId));
  const remove = source.deleteBrowser;
  source.deleteBrowser = async () => {
    throw new WalletRuntimeError("unavailable");
  };
  await runWalletJobs(app.ctx, services);
  const [pending] = await app.ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, cleanupId));
  expect(pending).toMatchObject({ phase: "disconnecting", browserReserved: true, failureCode: "retrying" });
  expect(source.browserCalls).toHaveLength(1);
  expect(source.deletedProfiles).toHaveLength(0);

  source.deleteBrowser = remove;
  await app.ctx.db
    .update(paypalWalletConnections)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(paypalWalletConnections.ownerId, cleanupId));
  await runWalletJobs(app.ctx, services);
  await runWalletJobs(app.ctx, services);
  expect((await walletStatus(app.ctx, cleanupId)).phase).toBe("disconnected");
  expect(source.browserCalls).toHaveLength(2);
});

it("hands imported products to targeted chat, retains an unfamiliar usage answer only on confirmation and researches the saved need", async () => {
  const { browser, id } = await owner();
  source.rows.bills = [bill("Readwise", "reading")];
  const result = await connected(id),
    row = result.portfolio.subscriptions[0]!;
  await rememberRecognizedService(
    app.ctx,
    id,
    row.serviceId,
    row.name,
    customerProduct("Readwise", "reading", "Save, review and export reading highlights."),
  );
  app.model.script = (request, index) => {
    if (index === 0) return { call: "read_subscriptions" };
    if (index === 1) return { call: "check_paypal" };
    const outputs = (request.input as any[])
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output));
    expect(outputs.at(-1)).toMatchObject({
      source: "wallet",
      subscriptions: [{ name: "Readwise", amountMinor: 1299, purpose: "" }],
    });
    return {
      answer: {
        message: "I found your Readwise payments. What do you want to do with your saved highlights?",
        discussingRef: "saved:0",
        draft: null,
        compareRef: null,
      },
    };
  };
  const intro = await browser.post("/api/subscriptions/chat", {
    message: null,
    expectedRevision: 1,
    history: [],
  });
  expect(intro.status).toBe(200);
  expect(intro.body.draft).toBeNull();
  expect(intro.body.message).not.toMatch(/add.*manually/i);
  const answer =
    "mostly keep spanish excerpts for my bookclub then dump em into obsidian, dont need flashcards";
  app.model.script = (_request, index) =>
    index === 0
      ? { call: "read_subscriptions" }
      : {
          answer: {
            message: "Shall I remember this?",
            discussingRef: "saved:0",
            draft: {
              serviceRef: "saved:0",
              amountMinor: 1299,
              cycle: "month",
              purpose:
                "Save Spanish reading excerpts for a book club and export to Obsidian; flashcards are unnecessary.",
            },
            costStatement: null,
            compareRef: null,
          },
        };
  const proposal = await browser.post("/api/subscriptions/chat", {
    message: answer,
    history: [{ from: "val", text: intro.body.message }],
    expectedRevision: 1,
    activeServiceId: row.serviceId,
  });
  expect(proposal.status).toBe(200);
  expect(proposal.body.draft.purpose).toContain("Obsidian");
  expect((await browser.get("/api/subscriptions")).body.subscriptions[0].purpose).toBe("");
  const confirmed = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 1,
    subscriptions: commandRows([proposal.body.draft]),
  });
  expect(confirmed.status).toBe(200);
  expect(confirmed.body.subscriptions[0].purpose).toContain("Spanish");
  app.model.script = (request) => {
    const input = JSON.parse((request.input as any[])[0].content);
    expect(input.subscription.purpose).toContain("Obsidian");
    return {
      answer: {
        summary: "I need a sourced price and confirmed Obsidian export before recommending a replacement.",
        options: [],
        uncertainties: [],
      },
    };
  };
  expect(
    (await browser.post("/api/subscriptions/review", { serviceId: row.serviceId, expectedRevision: 2 }))
      .status,
  ).toBe(200);
  expect(source.submissions).toBe(1);
});
