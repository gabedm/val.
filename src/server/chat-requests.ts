import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import type {
  SubscriptionIngestionProgress,
  ValChatCommand,
  ValChatReply,
  ValChatRequest,
} from "../shared/subscriptions";
import { requireLogin } from "./auth";
import type { AppContext } from "./context";
import { ownerChatRequests, ownerSubscriptionReviews, owners } from "./db/schema";
import { HttpError } from "./http";
import { reportFailure } from "./logging";
import { readSubscriptionPortfolio } from "./subscriptions";
import { ChatAttemptError, ChatExecutionError, createValChatService, parseValChatCommand } from "./val-chat";
import { currentWorker } from "./worker-deployment";

type Row = typeof ownerChatRequests.$inferSelect;
const requestId = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const leaseMs = 45_000;
const services = new WeakMap<AppContext, ReturnType<typeof createValChatService>>();
const workers = new WeakMap<
  AppContext,
  {
    stopped: boolean;
    controllers: Set<AbortController>;
    tasks: Set<Promise<void>>;
    claims: Set<Promise<Row | null>>;
  }
>();
function state(ctx: AppContext) {
  let value = workers.get(ctx);
  if (!value) {
    value = { stopped: false, controllers: new Set(), tasks: new Set(), claims: new Set() };
    workers.set(ctx, value);
  }
  return value;
}
function canonical(command: ValChatCommand): ValChatCommand {
  return {
    message: command.message,
    history: command.history.map(({ from, text }) => ({ from, text })),
    expectedRevision: command.expectedRevision,
    activeServiceId: command.activeServiceId ?? null,
    revisitServiceIds: [...(command.revisitServiceIds ?? [])].sort(),
  };
}
const matches = (row: Row) =>
  and(
    eq(ownerChatRequests.ownerId, row.ownerId),
    eq(ownerChatRequests.id, row.id),
    eq(ownerChatRequests.leaseToken, row.leaseToken!),
  );
const safeFailure = (error: unknown): NonNullable<ValChatRequest["error"]> =>
  error instanceof HttpError
    ? {
        status: error.status,
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      }
    : {
        status: 503,
        code: "chat_interrupted",
        message: "I couldn’t finish that reply. Your answer is safe; please try again.",
      };

async function view(ctx: AppContext, row: Row): Promise<ValChatRequest> {
  const changed =
    row.reply &&
    (await readSubscriptionPortfolio(ctx, row.ownerId)).revision !== row.reply.portfolio.revision;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    status: changed ? "superseded" : row.status,
    command: row.command,
    progress: row.progress,
    reply: changed ? null : row.reply,
    error: changed
      ? {
          status: 409,
          code: "subscriptions_changed",
          message: "Your subscriptions changed. Please review them before continuing.",
        }
      : row.error,
  };
}

export function chatRequestRoutes(ctx: AppContext, catalogue: CatalogueResponse["catalogue"]) {
  const router = Router();
  const kick = () => {
    void runChatRequest(ctx, catalogue).catch((error) => reportFailure("background_task_failed", error));
  };
  router.post("/subscriptions/chat/requests", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (
      !req.body ||
      Object.keys(req.body).some((key) => !["id", "command"].includes(key)) ||
      typeof req.body.id !== "string" ||
      !requestId.test(req.body.id)
    )
      throw new HttpError(400, "invalid_chat_request", "Send a valid chat request.");
    const id = req.body.id.toLowerCase();
    const command = canonical(parseValChatCommand(req.body.command));
    const hash = createHash("sha256").update(JSON.stringify(command)).digest("hex");
    const now = new Date();
    const row = await ctx.db.transaction(async (tx) => {
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for("update");
      const [existing] = await tx
        .select()
        .from(ownerChatRequests)
        .where(and(eq(ownerChatRequests.ownerId, ownerId), eq(ownerChatRequests.id, id)));
      if (existing) {
        if (existing.commandHash !== hash)
          throw new HttpError(
            409,
            "chat_request_conflict",
            "This request ID belongs to a different message.",
          );
        return existing;
      }
      // A lost create response or a refresh may mint another UUID for the same
      // turn. Reattach recent successful/active work; explicit failed retries stay possible.
      const [duplicate] = await tx
        .select()
        .from(ownerChatRequests)
        .where(
          sql`${ownerChatRequests.ownerId} = ${ownerId} and ${ownerChatRequests.commandHash} = ${hash} and ${ownerChatRequests.status} in ('queued','running','complete') and ${ownerChatRequests.createdAt} > ${new Date(now.getTime() - 60_000)}`,
        )
        .orderBy(desc(ownerChatRequests.createdAt))
        .limit(1);
      if (duplicate) return duplicate;
      await tx
        .update(ownerChatRequests)
        .set({
          status: "failed",
          leaseToken: null,
          leaseUntil: null,
          error: {
            status: 503,
            code: "chat_expired",
            message: "This reply expired. Your saved needs are safe; please try again.",
          },
          updatedAt: now,
        })
        .where(
          sql`${ownerChatRequests.ownerId} = ${ownerId} and ${ownerChatRequests.status} in ('queued','running') and ${ownerChatRequests.deadlineAt} <= ${now}`,
        );
      const [pending] = await tx
        .select({ id: ownerChatRequests.id })
        .from(ownerChatRequests)
        .where(
          sql`${ownerChatRequests.ownerId} = ${ownerId} and ${ownerChatRequests.status} in ('queued','running')`,
        );
      if (pending) throw new HttpError(429, "chat_running", "Val is still replying to your last message.", 2);
      const [created] = await tx
        .insert(ownerChatRequests)
        .values({
          ownerId,
          id,
          commandHash: hash,
          command,
          status: "queued",
          deadlineAt: new Date(now.getTime() + 600_000),
          expiresAt: new Date(now.getTime() + 86_400_000),
        })
        .returning();
      return created!;
    });
    res.json(await view(ctx, row));
    kick();
  });
  router.get("/subscriptions/chat/latest", async (_req, res) => {
    const { ownerId } = requireLogin(res);
    const [row] = await ctx.db
      .select()
      .from(ownerChatRequests)
      .where(and(eq(ownerChatRequests.ownerId, ownerId), gt(ownerChatRequests.expiresAt, new Date())))
      .orderBy(desc(ownerChatRequests.createdAt))
      .limit(1);
    res.json(row ? await view(ctx, row) : null);
    if (row && ["queued", "running"].includes(row.status)) kick();
  });
  router.get("/subscriptions/chat/requests/:id", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (!requestId.test(req.params.id!))
      throw new HttpError(404, "chat_request_missing", "This reply is unavailable.");
    const [row] = await ctx.db
      .select()
      .from(ownerChatRequests)
      .where(
        and(
          eq(ownerChatRequests.ownerId, ownerId),
          eq(ownerChatRequests.id, req.params.id!.toLowerCase()),
          gt(ownerChatRequests.expiresAt, new Date()),
        ),
      );
    if (!row) throw new HttpError(404, "chat_request_missing", "This reply is unavailable.");
    res.json(await view(ctx, row));
    if (["queued", "running"].includes(row.status)) kick();
  });
  return router;
}

async function claim(ctx: AppContext, now: Date): Promise<Row | null> {
  return ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended('val-chat-admission',0))`);
    const revision = ctx.worker?.revision ?? null;
    const [active] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(ownerChatRequests)
      .where(
        sql`${ownerChatRequests.status} = 'running' and ${ownerChatRequests.leaseUntil} > ${now} and ${ownerChatRequests.workerRevision} is not distinct from ${revision}`,
      );
    if ((active?.count ?? 0) >= 2) return null;
    const [row] = await tx
      .select()
      .from(ownerChatRequests)
      .where(
        sql`${ownerChatRequests.nextAttemptAt} <= ${now} and (${ownerChatRequests.status} = 'queued' or (${ownerChatRequests.status} = 'running' and (${ownerChatRequests.leaseUntil} <= ${now} or ${ownerChatRequests.workerRevision} is distinct from ${revision})))`,
      )
      .orderBy(ownerChatRequests.createdAt)
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;
    if (row.deadlineAt <= now) {
      await tx
        .update(ownerChatRequests)
        .set({
          status: "failed",
          leaseToken: null,
          leaseUntil: null,
          error: {
            status: 503,
            code: "chat_expired",
            message: "This reply expired. Your answer is safe; please try again.",
          },
          updatedAt: now,
        })
        .where(and(eq(ownerChatRequests.ownerId, row.ownerId), eq(ownerChatRequests.id, row.id)));
      return null;
    }
    const [claimed] = await tx
      .update(ownerChatRequests)
      .set({
        status: "running",
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + leaseMs),
        workerRevision: revision,
        updatedAt: now,
      })
      .where(and(eq(ownerChatRequests.ownerId, row.ownerId), eq(ownerChatRequests.id, row.id)))
      .returning();
    return claimed!;
  });
}

async function commit(ctx: AppContext, row: Row, changes: Partial<typeof ownerChatRequests.$inferInsert>) {
  return ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return false;
    const result = await tx
      .update(ownerChatRequests)
      .set({ ...changes, updatedAt: new Date() })
      .where(
        and(
          matches(row),
          eq(ownerChatRequests.status, "running"),
          gt(ownerChatRequests.leaseUntil, new Date()),
        ),
      )
      .returning({ id: ownerChatRequests.id });
    return result.length > 0;
  });
}

/** One globally admitted job. A saved reply closes the result/commit crash gap. */
export async function runChatRequest(
  ctx: AppContext,
  catalogue: CatalogueResponse["catalogue"],
  now = new Date(),
) {
  const worker = state(ctx);
  if (worker.stopped || worker.tasks.size >= 2) return false;
  const pendingClaim = claim(ctx, now).then(async (row) => {
    if (row && worker.stopped) {
      await commit(ctx, row, { status: "queued", leaseToken: null, leaseUntil: null });
      return null;
    }
    return row;
  });
  worker.claims.add(pendingClaim);
  let row: Row | null;
  try {
    row = await pendingClaim;
  } finally {
    worker.claims.delete(pendingClaim);
  }
  if (!row) return false;
  if (worker.stopped) {
    await commit(ctx, row, { status: "queued", leaseToken: null, leaseUntil: null });
    return false;
  }
  const controller = new AbortController();
  worker.controllers.add(controller);
  const task = (async () => {
    let leaseBusy = false;
    const heartbeat = setInterval(async () => {
      if (leaseBusy) return;
      leaseBusy = true;
      try {
        if (!(await commit(ctx, row, { leaseUntil: new Date(Date.now() + leaseMs) }))) controller.abort();
      } catch (error) {
        controller.abort();
        reportFailure("job_heartbeat_failed", error);
      } finally {
        leaseBusy = false;
      }
    }, 10_000);
    let progress: SubscriptionIngestionProgress[] = [];
    let writes = Promise.resolve();
    let attemptStarted = false;
    const priorReviewId = row.reviewId;
    try {
      if (row.reviewId) {
        const [saved] = await ctx.db
          .select()
          .from(ownerSubscriptionReviews)
          .where(
            and(
              eq(ownerSubscriptionReviews.id, row.reviewId),
              eq(ownerSubscriptionReviews.ownerId, row.ownerId),
            ),
          );
        const result = saved?.result as
          { reply?: ValChatReply; completed?: boolean; reason?: string } | undefined;
        if (result?.reply) {
          await commit(ctx, row, {
            status: "complete",
            reply: result.reply,
            error: null,
            leaseToken: null,
            leaseUntil: null,
          });
          return;
        }
        if (saved && result?.reason !== "timeout" && result?.reason !== "model_error") {
          await commit(ctx, row, {
            status: "failed",
            error: safeFailure(new ChatAttemptError(false)),
            leaseToken: null,
            leaseUntil: null,
          });
          return;
        }
      }
      const reviewId = randomUUID();
      let service = services.get(ctx);
      if (!service) {
        service = createValChatService(ctx, catalogue);
        services.set(ctx, service);
      }
      const signal = AbortSignal.any([
        controller.signal,
        AbortSignal.timeout(Math.max(1, Math.min(185_000, row.deadlineAt.getTime() - Date.now()))),
      ]);
      const reply = await service(
        row.ownerId,
        parseValChatCommand(row.command),
        signal,
        (event) => {
          // Bound progress to ingestion events; no raw model tokens or private SDK details.
          progress = [...progress, event].slice(-64);
          const snapshot = progress;
          writes = writes
            .then(async () => {
              if (!(await commit(ctx, row, { progress: snapshot }))) controller.abort();
            })
            .catch((error) => {
              controller.abort();
              reportFailure("background_task_failed", error);
            });
        },
        reviewId,
        async () => {
          // Recheck only after owning the conversation lock. A departing worker
          // may have saved its reply while this worker was waiting to acquire it.
          if (priorReviewId) {
            const [saved] = await ctx.db
              .select()
              .from(ownerSubscriptionReviews)
              .where(
                and(
                  eq(ownerSubscriptionReviews.id, priorReviewId),
                  eq(ownerSubscriptionReviews.ownerId, row.ownerId),
                ),
              );
            const result = saved?.result as { reply?: ValChatReply } | undefined;
            if (result?.reply) return result.reply;
          }
          if (row.attempts >= 2) throw new ChatAttemptError(false);
          if (!(await commit(ctx, row, { attempts: row.attempts + 1, reviewId, progress: [] }))) {
            controller.abort();
            controller.signal.throwIfAborted();
          }
          row.reviewId = reviewId;
          row.attempts++;
          attemptStarted = true;
          return undefined;
        },
      );
      await writes;
      if (!controller.signal.aborted)
        await commit(ctx, row, {
          status: "complete",
          reply,
          error: null,
          progress,
          leaseToken: null,
          leaseUntil: null,
        });
    } catch (error) {
      await writes;
      if (controller.signal.aborted) return;
      const safe = safeFailure(error);
      const busy = error instanceof HttpError && ["review_running", "chat_running"].includes(error.code);
      const waiting =
        error instanceof HttpError &&
        ["judge_rate_limited", "model_rate_limited", "chat_model_cooling"].includes(error.code);
      const transient =
        (error instanceof ChatAttemptError || error instanceof ChatExecutionError) && error.retryable;
      const freeWait = busy || (waiting && error instanceof ChatExecutionError && !error.dispatched);
      const retry =
        (freeWait || ((waiting || transient) && row.attempts < 2)) && Date.now() < row.deadlineAt.getTime();
      const delay = waiting
        ? Math.min(60, Math.max(1, safe.retryAfterSeconds ?? 2)) * 1000
        : 1000 + Math.floor(Math.random() * 1000);
      await commit(
        ctx,
        row,
        retry
          ? {
              status: "queued",
              reviewId: attemptStarted ? null : priorReviewId,
              attempts: freeWait && attemptStarted ? Math.max(0, row.attempts - 1) : row.attempts,
              error: null,
              nextAttemptAt: new Date(Date.now() + delay),
              leaseToken: null,
              leaseUntil: null,
            }
          : { status: "failed", error: safe, leaseToken: null, leaseUntil: null },
      );
      if (!(error instanceof HttpError)) reportFailure("background_task_failed", error);
    } finally {
      clearInterval(heartbeat);
      worker.controllers.delete(controller);
      if (controller.signal.aborted)
        await commit(ctx, row, { leaseUntil: new Date() }).catch((error) =>
          reportFailure("background_task_failed", error),
        );
    }
  })();
  worker.tasks.add(task);
  try {
    await task;
  } finally {
    worker.tasks.delete(task);
  }
  return true;
}

export async function stopChatRequests(ctx: AppContext) {
  const worker = state(ctx);
  worker.stopped = true;
  for (const controller of worker.controllers) controller.abort();
  await Promise.allSettled([...worker.claims]);
  await Promise.allSettled([...worker.tasks]);
}
