import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { startTestApp, type TestApp, reviewerLogin } from "./helpers";
import {
  ownerSwitchExamples,
  ownerSubscriptions,
  ownerSubscriptionSwitches,
  judgeDemoRequests,
} from "../src/server/db/schema";
import { runSwitchJobs } from "../src/server/subscription-switch";
import { switchDigest } from "../src/server/switch-security";
import type { SwitchRuntime, SwitchBrowser, SwitchAction, SwitchPage } from "../src/server/switch-runtime";
import type { SwitchDecision } from "../src/server/switch-agent";
import { switchConsentVersion } from "../src/shared/subscription-switch";
import { switchExampleConsent } from "../src/shared/switch-example";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import pg from "pg";
import { DeploymentContext } from "../src/client/deployment";
import { SwitchExampleEntry } from "../src/client/SwitchExample";

const apps: TestApp[] = [];
async function isolated() {
  const base = process.env.TEST_DATABASE_URL!,
    name = "val_test_example_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${name}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  return startTestApp({ buildProfile: "judge", databaseUrl: new URL("/" + name, base).href });
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const app of apps.splice(0)) await app.close();
});
const origin = "https://isolated.provider.example.com",
  company = "Example Works";
const terms = {
  name: company,
  plan: "Lite",
  currency: "GBP" as const,
  chargeMinor: 50,
  renewalMinor: 50,
  cycle: "month" as const,
  upfrontMinor: 0,
  minimumTermMonths: 0,
  quote: "Lite: £0.50 due now, renews monthly at £0.50. No setup fee. No minimum term.",
};
const cancellation = {
  currency: "GBP" as const,
  reference: "ref_0123456789abcdef",
  feeMinor: 0,
  effectiveOn: "2026-12-12",
  quote: "Subscription ref_0123456789abcdef: cancellation effective 2026-12-12. No cancellation fee.",
};
const activeQuote = "Example Works Lite subscription ref_abcdef0123456789 is active. Renews at £0.50/month.";
const cancelledQuote = "Subscription ref_0123456789abcdef is cancelled. Auto-renewal is off.";
class Runtime implements SwitchRuntime {
  active = false;
  cancelled = false;
  commits: string[] = [];
  async create(name: string) {
    return {
      id: name,
      profile: name,
      url: "https://prod-iad-hypeman-1.kernel.sh:8443/browser/live/test?readOnly=false",
    };
  }
  async observe(browser: SwitchBrowser): Promise<SwitchPage> {
    const old = browser.id.endsWith("-old"),
      text = old
        ? company + " Standard " + (this.cancelled ? cancelledQuote : cancellation.quote)
        : terms.quote + (this.active ? " " + activeQuote : "");
    return {
      nonce: randomUUID(),
      digest: switchDigest(text),
      origin,
      text,
      needsUser: false,
      controls: [
        {
          ref: "7",
          role: "button",
          label: old ? "End renewal" : "Start subscription",
          type: "submit",
          options: [],
        },
      ],
    };
  }
  async act(browser: SwitchBrowser, _page: SwitchPage, _action: SwitchAction, commit: boolean) {
    if (!commit) return;
    if (browser.id.endsWith("-old")) {
      if (!this.active) throw Error("Cancellation before activation");
      this.cancelled = true;
      this.commits.push("cancel");
    } else {
      this.active = true;
      this.commits.push("purchase");
    }
  }
  async handoff() {}
  async cleanup() {}
}
async function fixture() {
  const app = await isolated();
  apps.push(app);
  app.ctx.config.switching = {
    apiKey: "synthetic-switch-key",
    environment: "live",
    preparationOnly: true,
    testOrigins: [],
    maxConcurrent: 2,
    dailyAttempts: 100,
  };
  app.ctx.config.switchExample = {
    providerOrigin: origin,
    operatorKey: "a".repeat(43),
    company,
    purpose: "Offline personal notes on one device",
  };
  const browser = app.browser();
  await browser.login();
  expect((await browser.post("/api/judge/access", reviewerLogin)).status).toBe(200);
  const parent = (await browser.get("/api/session")).body.ownerId as string;
  let oldStatus = "APPROVAL_PENDING",
    unsafe = false;
  const provisions: string[] = [];
  const native = globalThis.fetch;
  vi.stubGlobal("fetch", async (url: any, init?: RequestInit) => {
    if (!String(url).startsWith(origin)) return native(url, init);
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer " + "a".repeat(43));
    const path = new URL(url).pathname;
    if (init?.method === "POST") provisions.push(JSON.parse(String(init.body)).id);
    const old = {
      name: company,
      plan: "Standard",
      amountMinor: 100,
      currency: "GBP",
      status: path === "/operator/catalogue" ? "NOT_CREATED" : oldStatus,
      subscriptionId: path === "/operator/catalogue" ? null : "I-EXAMPLE1234567",
    };
    return Response.json({
      company,
      old,
      replacement: { name: company, plan: "Lite", amountMinor: 50, currency: "GBP" },
      setupUrl:
        old.status === "APPROVAL_PENDING" ? "https://www.sandbox.paypal.com/approval?token=test" : null,
      oldEntry: (unsafe ? "https://untrusted.example.com" : origin) + "/connect#private-old",
      newEntry: origin + "/connect#private-new",
    });
  });
  return {
    app,
    browser,
    parent,
    provisions,
    setActive: () => {
      oldStatus = "ACTIVE";
    },
    unsafe: () => {
      unsafe = true;
    },
  };
}
it("is absent from public/default installations and renders only when explicitly configured", async () => {
  const app = await isolated();
  apps.push(app);
  const b = app.browser();
  await b.login();
  await b.post("/api/judge/access", reviewerLogin);
  expect((await b.get("/api/deployment")).body.switchExample).toBeUndefined();
  expect((await b.get("/api/switch-example")).status).toBe(404);
  expect(renderToStaticMarkup(createElement(SwitchExampleEntry))).toBe("");
  const markup = renderToStaticMarkup(
    createElement(
      DeploymentContext.Provider,
      {
        value: {
          passwordAccess: false,
          financialTools: false,
          paypalIdentityEnvironment: "sandbox",
          switchExample: { company },
        },
      },
      createElement(SwitchExampleEntry),
    ),
  );
  expect(markup).toContain(company);
  expect(markup).toContain("Sandbox switching example");
  expect(markup).toContain("Try switch");
});
it("allocates one private example per owner without adding bills or prefilled needs to their portfolio", async () => {
  const f = await fixture();
  const before = (await f.browser.get("/api/subscriptions")).body;
  const command = { consent: switchExampleConsent };
  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.browser.post("/api/switch-example", command)),
  );
  expect(results.every((row) => row.status === 200 && row.body.phase === "setup")).toBe(true);
  expect(new Set(f.provisions).size).toBe(1);
  const rows = await f.app.ctx.db
    .select()
    .from(ownerSwitchExamples)
    .where(eq(ownerSwitchExamples.ownerId, f.parent));
  expect(rows).toHaveLength(1);
  expect(rows[0]!.exampleOwnerId).not.toBe(f.parent);
  expect((await f.browser.get("/api/subscriptions")).body).toEqual(before);
  expect(
    await f.app.ctx.db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, rows[0]!.exampleOwnerId)),
  ).toHaveLength(0);
  expect((await f.browser.post("/api/switch-example/start", { consent: switchConsentVersion })).status).toBe(
    409,
  );
});
it("keeps consent, CSRF and the configured provider boundary enforced", async () => {
  const f = await fixture();
  expect((await f.browser.post("/api/switch-example", { consent: "wrong" })).status).toBe(400);
  expect(
    (await f.browser.post("/api/switch-example", { consent: switchExampleConsent }, { csrf: null })).status,
  ).toBe(403);
  await f.browser.post("/api/switch-example", { consent: switchExampleConsent });
  f.unsafe();
  expect((await f.browser.get("/api/switch-example")).status).toBe(503);
});
it("uses the unchanged agent and approval sequence while funding only the parent and keeping commercial writes disabled", async () => {
  const f = await fixture();
  await f.browser.post("/api/switch-example", { consent: switchExampleConsent });
  f.setActive();
  const runtime = new Runtime();
  f.app.ctx.switchRuntime = runtime;
  f.app.model.script = (request) => {
    const input = JSON.parse((request.input as any[]).findLast((item) => item.role === "user").content);
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
    if (input.task === "prepare_new") Object.assign(decision, { kind: "ready_purchase", terms });
    if (input.task === "verify_new" && runtime.active)
      Object.assign(decision, {
        kind: "active",
        evidence: { reference: "ref_abcdef0123456789", quote: activeQuote },
      });
    if (input.task === "verify_old" && runtime.cancelled)
      Object.assign(decision, {
        kind: "cancelled",
        evidence: { reference: cancellation.reference, quote: cancelledQuote },
      });
    return { answer: decision };
  };
  const before = (await f.browser.get("/api/subscriptions")).body;
  const started = await f.browser.post("/api/switch-example/start", { consent: switchConsentVersion });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const id = started.body.switchId;
  const step = async () => {
    await f.app.ctx.db
      .update(ownerSubscriptionSwitches)
      .set({ nextAttemptAt: new Date(0) })
      .where(eq(ownerSubscriptionSwitches.id, id));
    await runSwitchJobs(f.app.ctx, id);
    return (await f.browser.get(`/api/switch-example/subscriptions/switches/${id}`)).body;
  };
  await step();
  const ready = await step();
  expect(ready.phase, JSON.stringify(ready)).toBe("awaiting_approval");
  expect(ready.preparationOnly).toBe(false);
  expect(runtime.commits).toEqual([]);
  expect(f.app.ctx.config.switching!.preparationOnly).toBe(true);
  expect((await f.browser.get(`/api/subscriptions/switches/${id}`)).status).toBe(404);
  const other = f.app.browser();
  await other.login();
  await other.post("/api/judge/access", reviewerLogin);
  expect((await other.get(`/api/switch-example/subscriptions/switches/${id}`)).status).toBe(404);
  const approved = await f.browser.post(`/api/switch-example/subscriptions/switches/${id}/approve`, {
    revision: ready.revision,
    digest: ready.approvalDigest,
    consent: switchConsentVersion,
    confirmed: true,
  });
  expect(approved.status, JSON.stringify(approved.body)).toBe(200);
  let value;
  for (let i = 0; i < 5; i++) {
    value = await step();
    if (value.phase === "completed") break;
  }
  expect(value).toMatchObject({ phase: "completed", newActive: true, oldCancelled: true });
  expect(runtime.commits).toEqual(["purchase", "cancel"]);
  const requests = await f.app.ctx.db
    .select()
    .from(judgeDemoRequests)
    .where(eq(judgeDemoRequests.ownerId, f.parent));
  expect(requests.length).toBeGreaterThan(0);
  const [example] = await f.app.ctx.db
    .select()
    .from(ownerSwitchExamples)
    .where(eq(ownerSwitchExamples.ownerId, f.parent));
  expect(
    await f.app.ctx.db
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.ownerId, example!.exampleOwnerId)),
  ).toHaveLength(0);
  expect((await f.browser.get("/api/subscriptions")).body).toEqual(before);
  expect((await f.browser.get("/api/deployment")).body.kernelSwitching.preparationOnly).toBe(true);
});
it("does not bypass the shared model allowance through an isolated example owner", async () => {
  const f = await fixture();
  await f.browser.post("/api/switch-example", { consent: switchExampleConsent });
  f.setActive();
  f.app.ctx.switchRuntime = new Runtime();
  f.app.ctx.config.aiBudgetMicros = 1;
  const started = await f.browser.post("/api/switch-example/start", { consent: switchConsentVersion });
  expect(started.status).toBe(200);
  await runSwitchJobs(f.app.ctx, started.body.switchId);
  expect(f.app.model.requests).toHaveLength(0);
});
it("binds an unlisted selection to its saved needs without rewriting the real portfolio", async () => {
  const f = await fixture(),
    serviceId = "unlisted_" + randomUUID(),
    name = "Offbeat Audio",
    purpose = "Offline niche radio programmes for my commute; no adverts or family plan.";
  const source = {
    serviceId,
    name,
    purpose,
    amountMinor: 799,
    currency: "GBP",
    cycle: "month" as const,
    source: "manual" as const,
  };
  await f.app.ctx.db
    .insert(ownerSubscriptions)
    .values({ ownerId: f.parent, revision: 1, subscriptions: [source] })
    .onConflictDoUpdate({
      target: ownerSubscriptions.ownerId,
      set: { revision: 1, subscriptions: [source] },
    });
  const before = (await f.browser.get("/api/subscriptions")).body;
  expect(
    (
      await f.browser.post("/api/switch-example", {
        consent: switchExampleConsent,
        serviceId: "another-user-service",
        expectedRevision: 1,
      })
    ).status,
  ).toBe(409);
  expect(
    (
      await f.browser.post("/api/switch-example", {
        consent: switchExampleConsent,
        serviceId,
        expectedRevision: 0,
      })
    ).status,
  ).toBe(409);
  const started = await f.browser.post("/api/switch-example", {
    consent: switchExampleConsent,
    serviceId,
    expectedRevision: 1,
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  expect(started.body).toMatchObject({ sourceName: name, purpose });
  const [row] = await f.app.ctx.db
    .select()
    .from(ownerSwitchExamples)
    .where(eq(ownerSwitchExamples.ownerId, f.parent));
  expect(row).toMatchObject({ sourceServiceId: serviceId, sourceName: name, purpose });
  f.setActive();
  await f.app.ctx.db
    .update(ownerSubscriptions)
    .set({ revision: 2, subscriptions: [{ ...source, purpose: "A different priority" }] })
    .where(eq(ownerSubscriptions.ownerId, f.parent));
  expect((await f.browser.post("/api/switch-example/start", { consent: switchConsentVersion })).status).toBe(
    409,
  );
  const changed = (await f.browser.get("/api/subscriptions")).body;
  expect(changed.subscriptions[0].name).toBe(before.subscriptions[0].name);
  expect(changed.subscriptions[0].purpose).toBe("A different priority");
});
