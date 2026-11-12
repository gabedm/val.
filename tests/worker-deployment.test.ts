import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { startTestApp, type TestApp } from "./helpers";
import { activateWorker, currentWorker } from "../src/server/worker-deployment";
import { applicationDeployment, judgeDemoRequests, ownerReviewBatches } from "../src/server/db/schema";
import { runReviewBatch } from "../src/server/review-batches";
import { modelForOwner, judgeBudgetStatus } from "../src/server/judge-budget";
import { agentModel } from "../src/server/agent-contract";
import type { CatalogueResponse } from "../src/shared/contracts.types";

let app: TestApp;
beforeAll(async () => {
  const base = process.env.TEST_DATABASE_URL!;
  const database = "val_test_worker_deploy_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Client({ connectionString: new URL("/postgres", base).href });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}" WITH ENCODING 'UTF8' TEMPLATE template0`);
  } finally {
    await admin.end();
  }
  app = await startTestApp({ databaseUrl: new URL("/" + database, base).href });
  await app.browser().open();
});
afterAll(() => app.close());
beforeEach(async () => {
  app.ctx.worker = undefined;
  await app.ctx.db.delete(ownerReviewBatches);
  await app.ctx.db.update(applicationDeployment).set({ workerGeneration: null, workerRevision: null });
  app.model.script = () => ({
    answer: { summary: "No suitable lower-cost match was established.", options: [], uncertainties: [] },
  });
});
async function setup() {
  const browser = app.browser();
  await browser.login();
  const ownerId = (await browser.get("/api/session")).body.ownerId;
  const response = await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      {
        serviceId: "spotify",
        amountMinor: 1299,
        cycle: "month",
        purpose: "Only background music while working",
      },
    ],
  });
  expect(response.status).toBe(200);
  const catalogue = (await browser.get("/api/catalogue")).body.catalogue as CatalogueResponse["catalogue"];
  await browser.post("/api/subscriptions/review-batch", { expectedRevision: 1 });
  return { browser, ownerId, catalogue };
}
it("keeps newer deployment ownership across old cold starts and permits current replicas", async () => {
  const first = await activateWorker(app.ctx.db, "val-test", "val-test-00001-aaa");
  expect(await currentWorker({ ...app.ctx, worker: first })).toBe(true);
  const second = await activateWorker(app.ctx.db, "val-test", "val-test-00002-bbb");
  expect(await currentWorker({ ...app.ctx, worker: first })).toBe(false);
  expect(await currentWorker({ ...app.ctx, worker: second })).toBe(true);
  await activateWorker(app.ctx.db, "val-test", "val-test-00001-aaa");
  expect(await currentWorker({ ...app.ctx, worker: first })).toBe(false);
  const replica = await activateWorker(app.ctx.db, "val-test", "val-test-00002-bbb");
  expect(await currentWorker({ ...app.ctx, worker: replica })).toBe(true);
  expect(await currentWorker({ ...app.ctx, worker: undefined })).toBe(false);
  expect(await activateWorker(app.ctx.db)).toBeUndefined();
  await expect(activateWorker(app.ctx.db, "other-service", "val-test-00003-ccc")).rejects.toThrow(
    "Invalid hosted worker identity",
  );
  await expect(activateWorker(app.ctx.db, "other-service", "other-service-00099-ccc")).rejects.toThrow(
    "another hosted worker service",
  );
  await expect(activateWorker(app.ctx.db, "val", "val-00099-ddd")).rejects.toThrow(
    "another hosted worker service",
  );
});
it("does not let a retired worker claim or fail a newly queued comparison", async () => {
  const { browser, ownerId, catalogue } = await setup();
  const old = await activateWorker(app.ctx.db, "val-test", "val-test-00001-aaa");
  const current = await activateWorker(app.ctx.db, "val-test", "val-test-00002-bbb");
  const count = app.model.requests.length;
  expect(await runReviewBatch({ ...app.ctx, worker: old }, catalogue)).toBe(false);
  expect(app.model.requests).toHaveLength(count);
  const [batch] = await app.ctx.db
    .select()
    .from(ownerReviewBatches)
    .where(eq(ownerReviewBatches.ownerId, ownerId));
  expect(batch).toMatchObject({ status: "queued", completed: [], failed: [] });
  expect(await runReviewBatch({ ...app.ctx, worker: current }, catalogue)).toBe(true);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "complete",
    failed: [],
  });
});
it("blocks obsolete funding before it creates a reservation or calls the model", async () => {
  const { ownerId } = await setup();
  const old = await activateWorker(app.ctx.db, "val-test", "val-test-00001-aaa");
  await activateWorker(app.ctx.db, "val-test", "val-test-00002-bbb");
  const ctx = { ...app.ctx, worker: old, config: { ...app.ctx.config, aiBudgetMicros: 100_000_000 } };
  const before = await judgeBudgetStatus(ctx),
    calls = app.model.requests.length;
  await expect(
    modelForOwner(ctx, ownerId).responses.create({ model: agentModel, input: "Authored test" }),
  ).rejects.toMatchObject({ code: "worker_superseded" });
  expect(await judgeBudgetStatus(ctx)).toEqual(before);
  expect(app.model.requests).toHaveLength(calls);
  expect(
    await app.ctx.db.select().from(judgeDemoRequests).where(eq(judgeDemoRequests.ownerId, ownerId)),
  ).toHaveLength(0);
});
it("hands a comparison to the current deployment when ownership changes between model stages", async () => {
  const { browser, catalogue } = await setup();
  const old = await activateWorker(app.ctx.db, "val-test", "val-test-00001-aaa");
  let current = old,
    changed = false;
  app.model.script = async () => {
    if (!changed) {
      changed = true;
      current = await activateWorker(app.ctx.db, "val-test", "val-test-00002-bbb");
    }
    return {
      answer: { summary: "No suitable lower-cost match was established.", options: [], uncertainties: [] },
    };
  };
  const ctx = { ...app.ctx, worker: old, config: { ...app.ctx.config, aiBudgetMicros: 100_000_000 } };
  await runReviewBatch(ctx, catalogue);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "queued",
    completed: [],
    failed: [],
  });
  await runReviewBatch({ ...ctx, worker: current }, catalogue);
  expect((await browser.get("/api/subscriptions/review-batch?revision=1")).body).toMatchObject({
    status: "complete",
    failed: [],
  });
});
