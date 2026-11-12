import { eq, sql } from "drizzle-orm";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { AppContext } from "./context";
import { chatModelHealth } from "./db/schema";
import { createModelFundingGroup, modelForOwner } from "./judge-budget";
import { modelName } from "./model-settings";
import { ModelServiceError } from "./model-service-error";
import type { ModelClient } from "./responses-loop";
import { HttpError } from "./http";
import { reportFailure } from "./logging";

const softDeadlineMs = 8_000;
const cooldownMs = 30_000;
export const chatRecoveryVersion = "google-chat-failover.1";

/** Budget/access/validation failures never authorize another provider request. */
export function recoverableChatModelError(error: unknown) {
  return error instanceof ModelServiceError && [429, 500, 502, 503, 504, 529].includes(error.status);
}

/** One task may use one separately funded backup. No tools execute inside this race. */
export function chatModelForOwner(ctx: AppContext, ownerId: string, primary: ModelClient) {
  const candidate = primary === ctx.conversationModel ? ctx.model : ctx.conversationModel;
  const alternate =
    primary.provider === "google" &&
    candidate?.provider === "google" &&
    modelName(primary) !== modelName(candidate)
      ? candidate
      : null;
  const group = createModelFundingGroup(ctx, ownerId);
  const funded = (model: ModelClient) =>
    modelForOwner({ ...ctx, model }, ownerId, { concurrentRequests: 2, fundingGroup: group });
  const primaryClient = funded(primary),
    backup = alternate ? funded(alternate) : null;
  let preferred = primary;
  let recoveryUsed = false;
  let actual = primary;
  const usedModels = new Set<string>();

  async function health(model: ModelClient) {
    const [row] = await ctx.db
      .select()
      .from(chatModelHealth)
      .where(eq(chatModelHealth.model, modelName(model)));
    return row?.openUntil && row.openUntil.getTime() > Date.now();
  }
  async function record(model: ModelClient, failed: boolean) {
    const now = new Date();
    await ctx.db
      .insert(chatModelHealth)
      .values({ model: modelName(model), failures: failed ? 1 : 0, openUntil: null, updatedAt: now })
      .onConflictDoUpdate({
        target: chatModelHealth.model,
        set: failed
          ? {
              failures: sql`case when ${chatModelHealth.updatedAt} < ${new Date(now.getTime() - 120_000)} then 1 else least(${chatModelHealth.failures} + 1, 100) end`,
              openUntil: sql`case when ${chatModelHealth.updatedAt} >= ${new Date(now.getTime() - 120_000)} and ${chatModelHealth.failures} >= 1 then ${new Date(now.getTime() + cooldownMs).toISOString()}::timestamptz else null end`,
              updatedAt: now,
            }
          : { failures: 0, openUntil: null, updatedAt: now },
      });
  }
  async function send(
    model: ModelClient,
    client: ModelClient,
    request: ResponseCreateParamsNonStreaming,
    options: Parameters<ModelClient["responses"]["create"]>[1],
  ) {
    const started = Date.now();
    usedModels.add(modelName(model));
    try {
      if (!client.managesDispatch) options?.onDispatch?.();
      const response = await client.responses.create({ ...request, model: modelName(model) }, options);
      if (Date.now() - started < softDeadlineMs)
        await record(model, false).catch((error) => reportFailure("background_task_failed", error));
      console.info(
        JSON.stringify({
          event: "chat_model_request",
          model: modelName(model),
          outcome: "response",
          elapsedMs: Date.now() - started,
        }),
      );
      return { response, model };
    } catch (error) {
      if (recoverableChatModelError(error))
        await record(model, true).catch((issue) => reportFailure("background_task_failed", issue));
      console.info(
        JSON.stringify({
          event: "chat_model_request",
          model: modelName(model),
          outcome: options?.signal?.aborted
            ? "cancelled"
            : recoverableChatModelError(error)
              ? "transient_failure"
              : "blocked",
          elapsedMs: Date.now() - started,
        }),
      );
      throw error;
    }
  }
  const client: ModelClient = {
    provider: primary.provider,
    model: primary.model,
    managesRecovery: !!backup,
    responses: {
      create: async (request, options) => {
        if (request.tools?.some((tool) => tool.type !== "function"))
          throw new Error("Chat failover accepts read-only application tools only.");
        options?.signal?.throwIfAborted();
        if (!backup || !alternate) return (await send(primary, primaryClient, request, options)).response;
        const [primaryOpen, backupOpen] = await Promise.all([health(primary), health(alternate)]);
        if (primaryOpen && backupOpen)
          throw new HttpError(
            503,
            "chat_model_cooling",
            "I’m waiting for the AI service to recover. Your answer is safe.",
            30,
          );
        if ((preferred !== primary || primaryOpen) && !backupOpen) {
          preferred = alternate;
          recoveryUsed = true;
          const result = await send(alternate, backup, request, options);
          actual = result.model;
          return result.response;
        }
        if (recoveryUsed || backupOpen) {
          const result = await send(primary, primaryClient, request, options);
          actual = result.model;
          return result.response;
        }
        const first = new AbortController(),
          second = new AbortController();
        const signal = (controller: AbortController) =>
          options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let transient = false;
        const original = send(primary, primaryClient, request, { ...options, signal: signal(first) });
        const attempts: Promise<unknown>[] = [original];
        try {
          const early = await Promise.race([
            original.catch((error) => {
              if (!recoverableChatModelError(error)) throw error;
              transient = true;
              return null;
            }),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), softDeadlineMs);
            }),
          ]);
          clearTimeout(timer);
          if (early) {
            actual = early.model;
            return early.response;
          }
          options?.signal?.throwIfAborted();
          recoveryUsed = true;
          if (!transient)
            await record(primary, true).catch((error) => reportFailure("background_task_failed", error));
          // Stagger overload recovery. A slow inference may continue racing its
          // backup; each has its own reservation and uncertain outcomes keep holds.
          if (transient)
            await new Promise<void>((resolve, reject) => {
              const delay = setTimeout(done, 1000 + Math.floor(Math.random() * 500));
              function done() {
                options?.signal?.removeEventListener("abort", abort);
                resolve();
              }
              function abort() {
                clearTimeout(delay);
                reject(options?.signal?.reason);
              }
              options?.signal?.addEventListener("abort", abort, { once: true });
              if (options?.signal?.aborted) abort();
            });
          const recovery = send(alternate, backup, request, { ...options, signal: signal(second) });
          attempts.push(recovery);
          let result: { response: Response; model: ModelClient };
          try {
            result = await Promise.any([original, recovery]);
          } catch (error) {
            if (error instanceof AggregateError && error.errors.length) throw error.errors[0];
            throw error;
          }
          preferred = result.model;
          actual = result.model;
          return result.response;
        } finally {
          clearTimeout(timer);
          first.abort();
          second.abort();
          let settled: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              Promise.allSettled(attempts),
              new Promise<void>((resolve) => {
                settled = setTimeout(resolve, 1000);
              }),
            ]);
          } finally {
            clearTimeout(settled);
          }
        }
      },
    },
  };
  return { client, hasFallback: !!backup, actualModel: () => actual, usedModels: () => [...usedModels] };
}
