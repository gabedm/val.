import { randomUUID, createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import * as modelWork from "../src/server/model-work";
import { eq } from "drizzle-orm";
import { startTestApp, adminLogin, type TestApp } from "./helpers";
import {
  ownerSubscriptionSwitches as switches,
  ownerSubscriptions,
  ownerPriceChecks,
  ownerRecognizedServices,
  ownerSubscriptionReviews,
} from "../src/server/db/schema";
import { runSwitchJobs, type SwitchState } from "../src/server/subscription-switch";
import {
  sealSwitch,
  openSwitch,
  switchDigest,
  validSwitchTerms,
  validSwitchCancellation,
} from "../src/server/switch-security";
import { validSwitchEvidence, validSwitchActivation, type SwitchDecision } from "../src/server/switch-agent";
import {
  KernelSwitchRuntime,
  SwitchRuntimeError,
  switchRedactionScript,
  type SwitchRuntime,
  type SwitchPage,
  type SwitchBrowser,
  type SwitchAction,
} from "../src/server/switch-runtime";
import { subscriptionAdviceVersion } from "../src/server/subscription-advice";
import { modelVersion } from "../src/server/model-settings";
import { adviceContext } from "../src/server/advice-context";
import {
  switchConsentVersion,
  type SwitchTerms,
  type SwitchCancellation,
} from "../src/shared/subscription-switch";
import { isCurrentSubscription, type SubscriptionEntry } from "../src/shared/subscriptions";

const apps: TestApp[] = [];
const fixtureOwners = new Set<string>();
afterEach(async () => {
  for (const app of apps.splice(0)) {
    for (const ownerId of fixtureOwners)
      await app.ctx.db.delete(switches).where(eq(switches.ownerId, ownerId));
    await app.close();
  }
  fixtureOwners.clear();
});
const terms: SwitchTerms = {
  name: "",
  plan: "Solo",
  currency: "GBP",
  chargeMinor: 300,
  renewalMinor: 300,
  cycle: "month",
  upfrontMinor: 0,
  minimumTermMonths: 0,
  quote: "Solo: £3.00 due now, renews monthly at £3.00. No setup fee. No minimum term.",
};
const cancellation: SwitchCancellation = {
  currency: "GBP",
  reference: "ref_0123456789abcdef",
  feeMinor: 0,
  effectiveOn: "2026-12-11",
  quote: "Subscription ref_0123456789abcdef: cancellation effective 2026-12-11. No cancellation fee.",
};
const activeQuote = "Solo Offline subscription ref_abcdef0123456789 is active. Renews at £3.00/month.";
const cancelledQuote = "Subscription ref_0123456789abcdef is cancelled. Auto-renewal is off.";

it.each([
  "Subscription ref_abcdef0123456789 is not yet active.",
  "Subscription ref_abcdef0123456789 will become active after payment.",
  "Subscription ref_abcdef0123456789 becomes active once approval finishes.",
  "Subscription ref_abcdef0123456789 is no longer active.",
  "Subscription ref_abcdef0123456789 was active last month.",
])("does not verify an inactive or future replacement from an affirmative keyword: %s", (quote) => {
  expect(validSwitchEvidence({ reference: "ref_abcdef0123456789", quote }, quote, "active")).toBe(false);
});

it.each([
  "Subscription ref_0123456789abcdef is not cancelled.",
  "Subscription ref_0123456789abcdef has not been canceled. Auto-renewal is on.",
  "Subscription ref_0123456789abcdef cancellation pending; it will not renew once confirmed.",
  "Subscription ref_0123456789abcdef was cancelled, then reactivated. Auto-renewal is on.",
])("does not verify a denied or pending cancellation: %s", (quote) => {
  expect(validSwitchEvidence({ reference: "ref_0123456789abcdef", quote }, quote, "cancelled")).toBe(false);
});

class BrowserStandIn implements SwitchRuntime {
  active = false;
  cancelled = false;
  changed = false;
  timeoutPurchase = false;
  timeoutCancel = false;
  cleanupFailure = false;
  staleReceipt = false;
  commits: string[] = [];
  oldName = "";
  newName = "";
  async create(name: string) {
    return {
      id: name,
      profile: name,
      url: "https://prod-iad-hypeman-1.kernel.sh:8443/browser/live/test?readOnly=false",
    };
  }
  async observe(browser: SwitchBrowser): Promise<SwitchPage> {
    const old = browser.id.endsWith("-old");
    const text = old
      ? `${this.oldName} ${this.cancelled ? cancelledQuote : cancellation.quote}`
      : `${this.newName} ${terms.quote} ${this.active && !this.staleReceipt ? activeQuote : ""}`;
    return {
      nonce: randomUUID(),
      digest: switchDigest({ text, changed: this.changed }),
      origin: "https://provider.example.com",
      text,
      controls: [
        {
          ref: "7",
          role: "button",
          label: old ? "End renewal" : "Start subscription",
          type: "submit",
          options: [],
        },
      ],
      needsUser: false,
    };
  }
  async act(browser: SwitchBrowser, _page: SwitchPage, _action: SwitchAction, commit: boolean) {
    if (_action.kind === "refresh") {
      this.staleReceipt = false;
      return;
    }
    if (!commit) return;
    const old = browser.id.endsWith("-old");
    if (old) {
      if (!this.active) throw Error("Cancellation before activation");
      this.cancelled = true;
      this.commits.push("cancel");
      if (this.timeoutCancel) throw new SwitchRuntimeError("unavailable");
    } else {
      this.active = true;
      this.commits.push("purchase");
      if (this.timeoutPurchase) throw new SwitchRuntimeError("unavailable");
    }
  }
  async handoff() {}
  async cleanup() {
    if (this.cleanupFailure) throw Error("Cleanup unavailable");
  }
}

async function fixture() {
  const app = await startTestApp();
  apps.push(app);
  app.ctx.config.switching = {
    apiKey: "synthetic-test-key",
    environment: "sandbox",
    testOrigins: ["https://provider.example.com"],
    maxConcurrent: 2,
    dailyAttempts: 10,
  };
  const runtime = new BrowserStandIn();
  app.ctx.switchRuntime = runtime;
  const browser = app.browser();
  await browser.login();
  const ownerId = (await browser.get("/api/session")).body.ownerId as string;
  fixtureOwners.add(ownerId);
  const id = randomUUID(),
    name = `Unlisted ${randomUUID().slice(0, 8)}`,
    next = `Different ${randomUUID().slice(0, 8)}`;
  runtime.oldName = name;
  runtime.newName = next;
  const old: SubscriptionEntry = {
    serviceId: `unlisted_${id}`,
    name,
    amountMinor: 1000,
    currency: "GBP",
    cycle: "month",
    purpose: "only the features I actually use, offline on a train",
    source: "manual",
  };
  await app.ctx.db
    .insert(ownerSubscriptions)
    .values({ ownerId, revision: 1, subscriptions: [old] })
    .onConflictDoUpdate({ target: ownerSubscriptions.ownerId, set: { revision: 1, subscriptions: [old] } });
  const state: SwitchState = {
    old,
    oldBasis: switchDigest({
      id: old.serviceId,
      name: old.name,
      amount: old.amountMinor,
      cycle: old.cycle,
      currency: old.currency,
      purpose: old.purpose,
      current: true,
    }),
    candidate: { id: "unknown-new", name: next, plan: "Solo" },
    steps: 0,
    message: "Preparing",
    terms: null,
    cancellation: null,
    approval: null,
    purchaseDispatchedAt: null,
    cancelDispatchedAt: null,
    newProof: null,
    oldProof: null,
    resume: null,
    handoffSide: null,
    stopped: false,
  };
  await app.ctx.db.insert(switches).values({
    id,
    ownerId,
    phase: "preparing_old",
    state,
    browserSlots: 2,
    secrets: sealSwitch(app.ctx.config, ownerId, id, {
      salt: "synthetic-salt",
      oldUrl: "https://provider.example.com/old",
      newUrl: "https://provider.example.com/new",
      browsers: {},
      prepared: {},
    }),
  });
  app.model.script = (request) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    const decision: SwitchDecision = {
      kind: "handoff",
      ref: "7",
      text: "",
      reason: "",
      terms: null,
      cancellation: null,
      evidence: null,
    };
    if (input.task === "prepare_old") Object.assign(decision, { kind: "ready_cancel", cancellation });
    if (input.task === "prepare_new")
      Object.assign(decision, { kind: "ready_purchase", terms: { ...terms, name: next } });
    if (input.task === "verify_new" && runtime.active && runtime.staleReceipt)
      Object.assign(decision, { kind: "refresh", ref: "" });
    else if (input.task === "verify_new" && runtime.active)
      Object.assign(decision, {
        kind: "active",
        terms: null,
        evidence: { reference: "ref_abcdef0123456789", quote: activeQuote },
      });
    if (input.task === "verify_old" && runtime.cancelled)
      Object.assign(decision, {
        kind: "cancelled",
        evidence: { reference: cancellation.reference, quote: cancelledQuote },
      });
    return { answer: decision };
  };
  const path = `/api/subscriptions/switches/${id}`;
  const step = async () => {
    await app.ctx.db
      .update(switches)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(switches.id, id));
    await runSwitchJobs(app.ctx, id);
    return (await browser.get(path)).body;
  };
  const review = async () => {
    await step();
    return step();
  };
  const approve = async () => {
    const current = (await browser.get(path)).body;
    return browser.post(path + "/approve", {
      revision: current.revision,
      digest: current.approvalDigest,
      confirmed: true,
      consent: switchConsentVersion,
    });
  };
  return { app, browser, ownerId, id, old, runtime, path, step, review, approve };
}

it("releases the switch lock even when releasing model work fails", async () => {
  const f = await fixture();
  const acquire = modelWork.acquireModelWork;
  const spy = vi.spyOn(modelWork, "acquireModelWork").mockImplementation(async (...args) => {
    const release = await acquire(...args);
    return async () => {
      await release();
      throw new Error("Model lock release failed");
    };
  });
  try {
    await expect(f.step()).rejects.toThrow("Model lock release failed");
  } finally {
    spy.mockRestore();
  }
  const connection = await f.app.ctx.db.$client.connect();
  try {
    const result = await connection.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [
      `val-switch:${f.id}`,
    ]);
    expect(result.rows[0]?.locked).toBe(true);
  } finally {
    await connection.query("select pg_advisory_unlock(hashtextextended($1,0))", [`val-switch:${f.id}`]);
    connection.release();
  }
});

it("requires exact approval, verifies replacement before cancelling, preserves needs and moves monitoring", async () => {
  const f = await fixture();
  await f.app.ctx.db.insert(ownerPriceChecks).values({
    ownerId: f.ownerId,
    serviceId: f.old.serviceId,
    revision: 1,
    cadence: { every: 1, unit: "week" },
    anchorAt: new Date(),
    nextCheckAt: new Date(Date.now() + 604800000),
    status: "scheduled",
  });
  expect((await f.review()).phase).toBe("awaiting_approval");
  expect(f.runtime.commits).toEqual([]);
  await f.step();
  expect(f.runtime.commits).toEqual([]);
  const stale = await f.browser.post(f.path + "/approve", {
    revision: 1,
    digest: "forged",
    confirmed: true,
    consent: switchConsentVersion,
  });
  expect(stale.status).toBe(409);
  expect((await f.approve()).status).toBe(200);
  expect((await f.step()).phase).toBe("verifying_new");
  expect(f.runtime.commits).toEqual(["purchase"]);
  expect((await f.step()).newActive).toBe(true);
  expect((await f.browser.get("/api/subscriptions")).body.subscriptions).toHaveLength(2);
  await f.step();
  expect(f.runtime.commits).toEqual(["purchase", "cancel"]);
  const done = await f.step();
  expect(done.phase).toBe("completed");
  const portfolio = (await f.browser.get("/api/subscriptions")).body;
  expect(portfolio.subscriptions).toHaveLength(1);
  expect(portfolio.subscriptions[0].purpose).toBe(f.old.purpose);
  const [record] = await f.app.ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, f.ownerId));
  expect(record!.subscriptions).toHaveLength(2);
  expect(isCurrentSubscription(record!.subscriptions[0]!)).toBe(false);
  const schedules = await f.app.ctx.db
    .select()
    .from(ownerPriceChecks)
    .where(eq(ownerPriceChecks.ownerId, f.ownerId));
  expect(schedules.find((s) => s.serviceId === f.old.serviceId)?.status).toBe("paused");
  expect(schedules.find((s) => s.serviceId === portfolio.subscriptions[0].serviceId)?.cadence).toEqual({
    every: 1,
    unit: "week",
  });
  await f.step();
  const [saved] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  expect(saved!.secrets).toBeNull();
  expect(saved!.browserSlots).toBe(0);
});

it("starts an old saved offer directly and checks current provider terms without a chat detour or financial writes", async () => {
  const f = await fixture();
  await f.app.ctx.db.delete(switches).where(eq(switches.id, f.id));
  f.app.ctx.config.switching!.preparationOnly = true;
  const [profile] = await f.app.ctx.db
    .insert(ownerRecognizedServices)
    .values({
      ownerId: f.ownerId,
      serviceId: f.old.serviceId,
      name: f.old.name,
      profile: {
        identification: "matched",
        displayName: f.old.name,
        category: "productivity",
        servicePurpose: "Notes and offline reference",
        capabilities: [],
        constraints: [],
        possibleProducts: [],
        origin: "customer",
        sources: [{ url: "https://provider.example.com/old", quote: "Provider account" }],
        checkedAt: new Date().toISOString(),
      },
    })
    .returning();
  const catalogue = (await f.browser.get("/api/catalogue")).body.catalogue;
  const optionId = "saved-alternative";
  await f.app.ctx.db.insert(ownerSubscriptionReviews).values({
    id: randomUUID(),
    ownerId: f.ownerId,
    serviceId: f.old.serviceId,
    portfolioRevision: 1,
    version: modelVersion(subscriptionAdviceVersion, f.app.ctx.model),
    createdAt: new Date(Date.now() - 3600_000),
    input: {},
    result: {
      recognitionUpdatedAt: profile!.updatedAt.toISOString(),
      dependencyKey: adviceContext([f.old], f.old.serviceId, catalogue.services)!.dependencyKey,
      advice: {
        summary: "A previously researched alternative.",
        options: [{ serviceId: optionId, reason: "Offline use" }],
        uncertainties: [],
        comparisons: [
          {
            serviceId: optionId,
            name: f.runtime.newName,
            plan: "Solo",
            owned: false,
            priceMinor: 999,
            priceUnit: "month",
            monthlyMinor: 999,
            annualMinor: 11988,
            savingAnnualMinor: 12,
            savingMonthlyMinor: 1,
            checkedOn: "2026-11-01",
            sources: ["https://provider.example.com/new"],
          },
        ],
      },
    },
  });
  const command = {
    serviceId: f.old.serviceId,
    optionId,
    expectedRevision: 1,
    consent: switchConsentVersion,
  };
  const started = await f.browser.post("/api/subscriptions/switches", command);
  expect(started.status).toBe(200);
  expect(started.body).toMatchObject({ phase: "preparing_old", preparationOnly: true });
  const id = started.body.id;
  for (let i = 0; i < 2; i++) {
    await f.app.ctx.db
      .update(switches)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(switches.id, id));
    await runSwitchJobs(f.app.ctx, id);
  }
  const review = (await f.browser.get(`/api/subscriptions/switches/${id}`)).body;
  expect(review.phase).toBe("awaiting_approval");
  expect(review.terms.chargeMinor).toBe(300);
  expect(f.runtime.commits).toEqual([]);
  expect(review.handoff.url).toContain("kernel.sh");
  f.app.ctx.config.switching!.preparationOnly = false;
  const attempted = await f.browser.post(`/api/subscriptions/switches/${id}/approve`, {
    revision: review.revision,
    confirmed: true,
    digest: review.approvalDigest,
    consent: switchConsentVersion,
  });
  expect(attempted.status).toBe(409);
  expect(attempted.body.error).toBe("switch_preparation_only");
  expect(f.runtime.commits).toEqual([]);
});

it("blocks financial execution in both the worker and the KERNEL runtime during preparation", async () => {
  const f = await fixture();
  await f.review();
  await f.approve();
  f.app.ctx.config.switching!.preparationOnly = true;
  expect((await f.step()).phase).toBe("stopped");
  expect(f.runtime.commits).toEqual([]);
  let requests = 0;
  const runtime = new KernelSwitchRuntime({ apiKey: "synthetic", preparationOnly: true }, async () => {
    requests++;
    throw Error("Unexpected network write");
  });
  await expect(
    runtime.act(
      await f.runtime.create("new"),
      await f.runtime.observe(await f.runtime.create("new")),
      { kind: "click", ref: "7", text: "" },
      true,
    ),
  ).rejects.toMatchObject({ code: "blocked_action" });
  expect(requests).toBe(0);
});

it("releases abandoned preparation browsers without changing subscriptions or saved needs", async () => {
  const f = await fixture();
  await f.review();
  await f.app.ctx.db
    .update(switches)
    .set({ updatedAt: new Date(Date.now() - 1200_000) })
    .where(eq(switches.id, f.id));
  expect((await f.step()).phase).toBe("stopped");
  await f.step();
  const [record] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  expect(record!.browserSlots).toBe(0);
  expect(record!.secrets).toBeNull();
  expect(f.runtime.commits).toEqual([]);
  const portfolio = (await f.browser.get("/api/subscriptions")).body;
  expect(portfolio.subscriptions[0].purpose).toBe(f.old.purpose);
  expect(portfolio.subscriptions).toHaveLength(1);
});

it("never discards an uncertain financial outcome as an abandoned preparation", async () => {
  const f = await fixture();
  const [record] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  await f.app.ctx.db
    .update(switches)
    .set({
      phase: "needs_user",
      state: { ...record!.state, purchaseDispatchedAt: new Date().toISOString() },
      updatedAt: new Date(Date.now() - 1200_000),
    })
    .where(eq(switches.id, f.id));
  expect(await runSwitchJobs(f.app.ctx, f.id)).toBe(0);
  const result = (await f.browser.get(f.path)).body;
  expect(result.phase).toBe("needs_user");
  expect(result.unresolved).toBe(true);
  expect(f.runtime.commits).toEqual([]);
});

it("reconciles uncertain purchase and cancellation without duplicate clicks after a worker resumes", async () => {
  const f = await fixture();
  f.runtime.timeoutPurchase = true;
  f.runtime.timeoutCancel = true;
  await f.review();
  await f.approve();
  await f.step();
  const resumed = await startTestApp({ databaseUrl: f.app.ctx.config.databaseUrl });
  apps.push(resumed);
  resumed.ctx.config.switching = f.app.ctx.config.switching;
  resumed.ctx.switchRuntime = f.runtime;
  resumed.model.script = f.app.model.script;
  await f.app.ctx.db
    .update(switches)
    .set({ nextAttemptAt: new Date(0) })
    .where(eq(switches.id, f.id));
  await runSwitchJobs(resumed.ctx, f.id);
  // Re-entering the exported worker has no process-local switch state.
  expect((await f.step()).newActive).toBe(true);
  await f.step();
  await f.step();
  await f.step();
  expect(f.runtime.commits).toEqual(["purchase", "cancel"]);
  expect((await f.browser.get(f.path)).body.phase).toBe("completed");
});

it("stops an uncertain action, removes its browser sessions and later verifies without repeating it", async () => {
  const f = await fixture();
  f.runtime.timeoutPurchase = true;
  await f.review();
  await f.approve();
  await f.step();
  let status = (await f.browser.get(f.path)).body;
  expect((await f.browser.post(f.path + "/stop", { revision: status.revision })).body.unresolved).toBe(true);
  await f.step();
  const [stored] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  expect(stored!.browserSlots).toBe(0);
  expect(stored!.state.stopped).toBe(true);
  status = (await f.browser.get(f.path)).body;
  expect((await f.browser.post(f.path + "/resume", { revision: status.revision })).body.phase).toBe(
    "verifying_new",
  );
  await f.step();
  await f.step();
  await f.step();
  expect(f.runtime.commits).toEqual(["purchase"]);
  expect((await f.browser.get(f.path)).body.phase).toBe("awaiting_approval");
});

it("rejects stale deployment workers before a financial dispatch", async () => {
  const f = await fixture();
  await f.review();
  await f.approve();
  f.app.ctx.worker = { generation: 999, revision: "obsolete-00999-test" };
  expect(await runSwitchJobs(f.app.ctx, f.id)).toBe(0);
  expect(f.runtime.commits).toEqual([]);
});

it("refreshes a stale checkout before verification without submitting another purchase", async () => {
  const f = await fixture();
  f.runtime.staleReceipt = true;
  await f.review();
  await f.approve();
  await f.step();
  await f.step();
  expect(f.runtime.commits).toEqual(["purchase"]);
  expect((await f.step()).newActive).toBe(true);
  expect(f.runtime.commits).toEqual(["purchase"]);
});

it("corrects an unsupported checkout extraction from the observed page before requesting approval", async () => {
  const f = await fixture(),
    normal = f.app.model.script!;
  let corrected = false;
  f.app.model.script = async (request, index, signal) => {
    const input = JSON.parse((request.input as { content: string }[])[0]!.content);
    if (input.task === "prepare_new" && !corrected) {
      corrected = true;
      return {
        answer: {
          kind: "ready_purchase",
          ref: "7",
          text: "",
          reason: "",
          terms: { ...terms, name: f.runtime.newName, chargeMinor: 1 },
          cancellation: null,
          evidence: null,
        },
      };
    }
    return normal(request, index, signal);
  };
  const result = await f.review();
  expect(corrected).toBe(true);
  expect(result.phase).toBe("awaiting_approval");
  expect(result.terms.chargeMinor).toBe(300);
  expect(f.runtime.commits).toEqual([]);
});

it("invalidates a changed checkout and expired approval without a purchase", async () => {
  const f = await fixture();
  await f.review();
  await f.approve();
  f.runtime.changed = true;
  expect((await f.step()).phase).toBe("preparing_new");
  expect(f.runtime.commits).toEqual([]);
  await f.step();
  const [row] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  row!.state.approval!.expiresAt = new Date(0).toISOString();
  await f.app.ctx.db.update(switches).set({ state: row!.state }).where(eq(switches.id, f.id));
  expect((await f.approve()).status).toBe(409);
  const status = (await f.browser.get(f.path)).body;
  expect((await f.browser.post(f.path + "/resume", { revision: status.revision })).body.phase).toBe(
    "preparing_new",
  );
});

it("rejects forged activation, foreign owners and browser-capability replay", async () => {
  const f = await fixture();
  await f.review();
  await f.approve();
  await f.step();
  f.runtime.active = false;
  await f.step();
  expect(f.runtime.commits).toEqual(["purchase"]);
  const other = f.app.browser();
  await other.login(adminLogin);
  expect((await other.get(f.path)).status).toBe(404);
  expect(
    (
      await other.post(f.path + "/approve", {
        revision: 1,
        digest: "x",
        confirmed: true,
        consent: switchConsentVersion,
      })
    ).status,
  ).toBe(404);
  const envelope = sealSwitch(f.app.ctx.config, f.ownerId, f.id, { url: "secret" });
  expect(() => openSwitch(f.app.ctx.config, "foreign", f.id, envelope)).toThrow();
  expect(() => openSwitch(f.app.ctx.config, f.ownerId, randomUUID(), envelope)).toThrow();
});

it("retains browser reservations on uncertain cleanup and rejects injected start parameters", async () => {
  const f = await fixture();
  f.runtime.cleanupFailure = true;
  const state = (await f.browser.get(f.path)).body;
  expect((await f.browser.post(f.path + "/stop", { revision: state.revision })).status).toBe(200);
  await f.step();
  const [saved] = await f.app.ctx.db.select().from(switches).where(eq(switches.id, f.id));
  expect(saved!.browserSlots).toBe(2);
  expect(saved!.secrets).not.toBeNull();
  const response = await f.browser.post("/api/subscriptions/switches", {
    serviceId: f.old.serviceId,
    optionId: "invented",
    expectedRevision: 1,
    consent: switchConsentVersion,
    url: "https://evil.example.com",
    priceMinor: 1,
  });
  expect(response.status).toBe(400);
});

it("requires verbatim complete terms and account-specific evidence", () => {
  expect(switchDigest({ a: 1, b: { z: 2, c: 3 } })).toBe(switchDigest({ b: { c: 3, z: 2 }, a: 1 }));
  const t = { ...terms, name: "Unknown service" };
  expect(validSwitchTerms(t, t.quote, t.name)).toBe(true);
  expect(validSwitchTerms({ ...t, renewalMinor: 1 }, t.quote, t.name)).toBe(false);
  expect(validSwitchTerms({ ...t, minimumTermMonths: 12 }, t.quote, t.name)).toBe(false);
  expect(validSwitchTerms({ ...t, quote: t.quote + " Trial" }, t.quote + " Trial", t.name)).toBe(false);
  expect(validSwitchCancellation({ ...cancellation, effectiveOn: "2026-99-99" }, cancellation.quote)).toBe(
    false,
  );
  expect(
    validSwitchEvidence({ reference: "ref_abcdef0123456789", quote: activeQuote }, activeQuote, "active"),
  ).toBe(true);
  expect(
    validSwitchEvidence(
      { reference: "ref_abcdef0123456789", quote: "Your plan is active" },
      "Your plan is active",
      "active",
    ),
  ).toBe(false);
  expect(
    validSwitchEvidence(
      { reference: "ref_abcdef0123456789", quote: "ref_abcdef0123456789 subscription will be active" },
      "ref_abcdef0123456789 subscription will be active",
      "active",
    ),
  ).toBe(false);
});

it("preserves financial dates while masking numeric, all-letter and mixed account references", () => {
  const redact = new Function(
    "crypto",
    "state",
    "value",
    switchRedactionScript + "return redact(value);",
  ) as (crypto: unknown, state: unknown, value: string) => string;
  const text = redact(
    { createHmac },
    { salt: "test-salt" },
    "Subscription I-ABCDEFGHIJKL cancellation effective 2026-12-11. Account 123456789101. Person person@example.com. Card 1234 5678 9012 3456.",
  );
  expect(text).toContain("2026-12-11");
  expect(text).not.toContain("I-ABCDEFGHIJKL");
  expect(text).not.toContain("123456789101");
  expect(text).not.toContain("person@");
  expect(text).not.toContain("1234 5678");
  expect(text.match(/ref_[a-f0-9]{16}/g)).toHaveLength(2);
  const quote = cancellation.quote.replace("2026-12-11", "11 December 2026");
  expect(validSwitchCancellation({ ...cancellation, quote }, quote)).toBe(true);
  expect(validSwitchCancellation({ ...cancellation, effectiveOn: "2026-12-12", quote }, quote)).toBe(false);
});

it("verifies active account evidence without requiring the checkout form to be repeated", () => {
  const evidence = { reference: "ref_abcdef0123456789", quote: activeQuote };
  expect(validSwitchActivation(evidence, activeQuote, terms)).toBe(true);
  const wrongPrice = activeQuote.replace("£3.00", "£4.00");
  expect(validSwitchActivation({ ...evidence, quote: wrongPrice }, wrongPrice, terms)).toBe(false);
  const wrongPlan = activeQuote.replace("Solo Offline", "Different plan");
  expect(validSwitchActivation({ ...evidence, quote: wrongPlan }, wrongPlan, terms)).toBe(false);
  const statusOnly = "Subscription ref_abcdef0123456789 is active.";
  expect(validSwitchActivation({ ...evidence, quote: statusOnly }, statusOnly, terms)).toBe(false);
});
