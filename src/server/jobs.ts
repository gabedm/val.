import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNull, lt, notInArray, or } from "drizzle-orm";
import type { AppContext } from "./context";
import type { Executor, Transaction } from "./db";
import { jobs, operations, transitions } from "./db/schema";
import { reportFailure } from "./logging";
import { currentWorker } from "./worker-deployment";

const leaseMs = 120_000;
const heartbeatMs = 30_000;
/** Job policyRevision 0 is reserved for setup and read-only reconciliation, which need no confirmed policy. */
const reconciliationRevision = 0;

export type JobRow = typeof jobs.$inferSelect;

/** Runs a database write only while the job's claim is still current. */
export type Commit = <T>(write: (tx: Transaction) => Promise<T>) => Promise<T>;

export class StaleClaimError extends Error {}

/** One job per (case, event, policy revision); queueing the same event again returns the existing job. */
export async function queueJob(
  db: Executor,
  caseId: string,
  eventId: string,
  policyRevision = reconciliationRevision,
): Promise<JobRow> {
  const [created] = await db
    .insert(jobs)
    .values({ id: randomUUID(), caseId, eventId, policyRevision, status: "QUEUED" })
    .onConflictDoNothing()
    .returning();
  if (created) return created;
  const [existing] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.caseId, caseId), eq(jobs.eventId, eventId), eq(jobs.policyRevision, policyRevision)));
  return existing!;
}

/**
 * Claims the oldest queued job, or a running one whose lease has lapsed, bumping its generation
 * so the previous worker can no longer commit. SKIP LOCKED lets concurrent workers pick different jobs.
 */
export async function claimJob(ctx: AppContext, workerId: string): Promise<JobRow | null> {
  return ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return null;
    const now = new Date();
    const [candidate] = await tx
      .select()
      .from(jobs)
      .where(or(eq(jobs.status, "QUEUED"), and(eq(jobs.status, "RUNNING"), lt(jobs.leaseExpiresAt, now))))
      .orderBy(jobs.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!candidate) return null;
    const [claimed] = await tx
      .update(jobs)
      .set({
        status: "RUNNING",
        claimOwner: workerId,
        claimGeneration: candidate.claimGeneration + 1,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(eq(jobs.id, candidate.id))
      .returning();
    return claimed!;
  });
}

/** Locks the job row and writes only if this worker's claim generation is current and unexpired. */
function commitUnderClaim(ctx: AppContext, job: JobRow): Commit {
  return (write) =>
    ctx.db.transaction(async (tx) => {
      const [live] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.id, job.id),
            eq(jobs.claimOwner, job.claimOwner!),
            eq(jobs.claimGeneration, job.claimGeneration),
            gt(jobs.leaseExpiresAt, new Date()),
          ),
        )
        .for("update");
      if (!live) throw new StaleClaimError(`Job ${job.id} is no longer claimed by this worker.`);
      return write(tx);
    });
}

async function finishJob(ctx: AppContext, job: JobRow, status: "COMPLETED" | "FAILED") {
  await commitUnderClaim(
    ctx,
    job,
  )((tx) =>
    tx.update(jobs).set({ status, leaseExpiresAt: null, updatedAt: new Date() }).where(eq(jobs.id, job.id)),
  );
}

export function renewJobLease(ctx: AppContext, job: JobRow) {
  const now = new Date();
  return ctx.db
    .update(jobs)
    .set({ leaseExpiresAt: new Date(now.getTime() + leaseMs), heartbeatAt: now })
    .where(
      and(
        eq(jobs.id, job.id),
        eq(jobs.status, "RUNNING"),
        eq(jobs.claimOwner, job.claimOwner!),
        eq(jobs.claimGeneration, job.claimGeneration),
        gt(jobs.leaseExpiresAt, now),
      ),
    );
}

/** Runs one claimed job, extending its lease while the work runs. A stale worker's writes are refused. */
export async function runJob(
  ctx: AppContext,
  job: JobRow,
  work: (job: JobRow, commit: Commit) => Promise<void>,
) {
  const heartbeat = setInterval(() => {
    void renewJobLease(ctx, job).catch((error) => reportFailure("job_heartbeat_failed", error));
  }, heartbeatMs);
  try {
    await work(job, commitUnderClaim(ctx, job));
    await finishJob(ctx, job, "COMPLETED");
  } catch (error) {
    if (error instanceof StaleClaimError) return;
    reportFailure("job_failed", error);
    await finishJob(ctx, job, "FAILED").catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
  }
}

/** Drains the queue; returns how many jobs this worker ran. */
export async function runQueuedJobs(
  ctx: AppContext,
  work: Parameters<typeof runJob>[2],
  workerId = randomUUID(),
): Promise<number> {
  let ran = 0;
  for (let job = await claimJob(ctx, workerId); job; job = await claimJob(ctx, workerId)) {
    await runJob(ctx, job, work);
    ran++;
  }
  return ran;
}

/**
 * Queues a read-only reconciliation for each case that still has an unfinished creation, an unverified
 * initial payment or an open transition (archived cases included). Run on the 30-second cadence.
 */
export async function queuePendingReconciliations(ctx: AppContext, now = new Date()): Promise<number> {
  const withUnresolvedOperations = await ctx.db
    .selectDistinct({ caseId: operations.caseId })
    .from(operations)
    .where(
      and(
        inArray(operations.kind, ["setup_create", "replacement_create"]),
        isNull(operations.retiredAt),
        or(
          inArray(operations.status, ["PLANNED", "IN_FLIGHT", "UNKNOWN"]),
          and(
            inArray(operations.paymentStatus, ["NOT_STARTED", "PENDING"]),
            notInArray(operations.billingStatus, ["CANCELLED", "EXPIRED"]),
          ),
        ),
      ),
    );
  const withOpenTransition = await ctx.db
    .select({ caseId: transitions.caseId })
    .from(transitions)
    .where(isNull(transitions.closedAt));
  const caseIds = new Set([...withUnresolvedOperations, ...withOpenTransition].map((row) => row.caseId));
  for (const caseId of caseIds) await queueJob(ctx.db, caseId, `pending:${now.getTime()}`);
  return caseIds.size;
}
