import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { jobs, webhookEvents } from "../src/server/db/schema";
import { claimJob, queueJob, queuePendingReconciliations, renewJobLease, runJob } from "../src/server/jobs";
import { newCase, startSetup, startTestApp, type TestApp } from "./helpers";

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

const loadJob = async (jobId: string) => (await app.ctx.db.select().from(jobs).where(eq(jobs.id, jobId)))[0]!;
const writeMarker = (marker: string) => (tx: Parameters<Parameters<typeof app.ctx.db.transaction>[0]>[0]) =>
  tx
    .insert(webhookEvents)
    .values({ id: randomUUID(), merchant: "A", verified: false, rejectionReason: marker });
const markerRows = (marker: string) =>
  app.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.rejectionReason, marker));

describe("job queue and claims", () => {
  it("cannot revive an expired lease with a late heartbeat", async () => {
    await app.runJobs();
    const { caseId } = await newCase(app);
    await queueJob(app.ctx.db, caseId, "late-heartbeat");
    const claimed = (await claimJob(app.ctx, "paused-worker"))!;
    const expiredAt = new Date(Date.now() - 1000);
    await app.ctx.db.update(jobs).set({ leaseExpiresAt: expiredAt }).where(eq(jobs.id, claimed.id));
    await renewJobLease(app.ctx, claimed);
    expect((await loadJob(claimed.id)).leaseExpiresAt).toEqual(expiredAt);
    expect(await claimJob(app.ctx, "replacement-worker")).toMatchObject({
      id: claimed.id,
      claimGeneration: 2,
    });
  });

  it("returns the existing job when the same case event is queued twice", async () => {
    const { caseId } = await newCase(app);
    const first = await queueJob(app.ctx.db, caseId, "return:operation:approved");
    const second = await queueJob(app.ctx.db, caseId, "return:operation:approved");
    expect(second.id).toBe(first.id);
    expect(await app.ctx.db.select().from(jobs).where(eq(jobs.caseId, caseId))).toHaveLength(1);
  });

  it("lets exactly one of several racing workers claim a job", async () => {
    await app.runJobs();
    const { caseId } = await newCase(app);
    const queued = await queueJob(app.ctx.db, caseId, "race");

    const claims = await Promise.all(["w1", "w2", "w3", "w4"].map((worker) => claimJob(app.ctx, worker)));
    const winners = claims.filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ id: queued.id, status: "RUNNING", claimGeneration: 1 });
  });

  it("fences a stale worker: after its lease passes to another worker only the current claim can commit", async () => {
    await app.runJobs();
    const { caseId } = await newCase(app);
    await queueJob(app.ctx.db, caseId, "fencing");

    const staleClaim = (await claimJob(app.ctx, "worker-1"))!;
    await app.ctx.db
      .update(jobs)
      .set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(jobs.id, staleClaim.id));
    const currentClaim = (await claimJob(app.ctx, "worker-2"))!;
    expect(currentClaim).toMatchObject({ id: staleClaim.id, claimGeneration: 2, claimOwner: "worker-2" });

    await runJob(
      app.ctx,
      staleClaim,
      async (_job, commit) => void (await commit(writeMarker("stale-write"))),
    );
    expect(await markerRows("stale-write")).toHaveLength(0);
    expect(await loadJob(staleClaim.id)).toMatchObject({
      status: "RUNNING",
      claimOwner: "worker-2",
      claimGeneration: 2,
    });

    await runJob(
      app.ctx,
      currentClaim,
      async (_job, commit) => void (await commit(writeMarker("current-write"))),
    );
    expect(await markerRows("current-write")).toHaveLength(1);
    expect(await loadJob(staleClaim.id)).toMatchObject({ status: "COMPLETED" });
  });

  it("marks a job failed when its work throws, without stopping later jobs", async () => {
    await app.runJobs();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { caseId } = await newCase(app);
      await queueJob(app.ctx.db, caseId, "failing");
      const claimed = (await claimJob(app.ctx, "worker"))!;
      await runJob(app.ctx, claimed, async () => {
        throw new Error("PayPal read failed");
      });
      expect(await loadJob(claimed.id)).toMatchObject({ status: "FAILED" });
    } finally {
      quiet.mockRestore();
    }
  });
});

describe("pending reconciliation", () => {
  it("queues only cases with a creation or initial payment still unresolved", async () => {
    const unresolved = await newCase(app);
    await startSetup(unresolved.browser, unresolved.caseId);

    const verified = await newCase(app);
    const { subscriptionId } = await startSetup(verified.browser, verified.caseId);
    app.paypal.approve(subscriptionId);
    await verified.browser.post(`/api/cases/${verified.caseId}/reconcile`);
    await app.runJobs();

    const untouched = await newCase(app);
    await queuePendingReconciliations(app.ctx);

    const pendingJobs = async (caseId: string) =>
      (await app.ctx.db.select().from(jobs).where(eq(jobs.caseId, caseId))).filter((job) =>
        job.eventId.startsWith("pending:"),
      );
    expect(await pendingJobs(unresolved.caseId)).toHaveLength(1);
    expect(await pendingJobs(verified.caseId)).toHaveLength(0);
    expect(await pendingJobs(untouched.caseId)).toHaveLength(0);
  });
});
