import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { Response, ResponseCreateParamsNonStreaming } from "openai/resources/responses/responses";
import type { AppContext } from "./context";
import { judgeDemoCounters, judgeDemoOwners, judgeDemoRequests, ownerPriceChecks } from "./db/schema";
import { HttpError } from "./http";
import type { ModelClient } from "./responses-loop";
import { modelAvailabilityError } from "./model-availability";
import { modelName } from "./model-settings";
import { currentWorker } from "./worker-deployment";
import { geminiConversationModel } from "./gemini-model";

// USD microdollars. Reservations assume uncached input. Google settlement uses
// dated published rates and validated usage; its 25% margin applies only to reserves.
// Shared free quotas, credits and discounts are not assumed. This is not an invoice.
export const judgeLimits = {
  budgetMicros: 5_000_000,
  ownerCalls: 200,
  globalCalls: 1000,
  callsPerMinute: 20,
  outputTokens: 5000,
  webCalls: 5,
} as const;
const budgetKey = "judge-demo-budget-v1";
/** Internal worker capability, never accepted from an HTTP request or model output. */
export interface ScheduledCheckClaim {
  serviceId: string;
  revision: number;
  leaseToken: string;
}
export type BudgetContext = Pick<AppContext, "db" | "model"> & {
  worker?: AppContext["worker"];
  config: Pick<AppContext["config"], "judgeDemo" | "aiBudgetMicros" | "judgeAccessPaused">;
};
const budgetLimit = (ctx: BudgetContext) =>
  ctx.config.aiBudgetMicros ?? ctx.config.judgeDemo?.budgetMicros ?? judgeLimits.budgetMicros;
type Request = ResponseCreateParamsNonStreaming & { max_tool_calls?: number };
const modelContextTokens = 1_050_000;
type FundingState = {
  ownerId: string;
  pool: BudgetContext["db"]["$client"];
  ids: Set<string>;
  turn: Promise<void>;
  settlements: Set<() => void>;
};
const fundingGroups = new WeakMap<object, FundingState>();
/** Server-created capability for one owner's read-only task, never a request parameter. */
export function createModelFundingGroup(ctx: Pick<BudgetContext, "db">, ownerId: string) {
  const capability = Object.freeze({});
  fundingGroups.set(capability, {
    ownerId,
    pool: ctx.db.$client,
    ids: new Set(),
    turn: Promise.resolve(),
    settlements: new Set(),
  });
  return capability;
}
export function modelCostMicros(
  input: number,
  output: number,
  searches: number,
  provider: "openai" | "anthropic" | "google" = "openai",
  cachedInput = 0,
  at = new Date(),
  model?: string,
) {
  if (provider === "google") {
    // Gemini 3.8 Flash global: the published introductory token rates end in 2026.
    // Paid grounding is $14/1000 queries; the project's shared free quota is unknown.
    const introductory = at.getTime() < Date.UTC(2027, 0, 1);
    const inputRate = model === geminiConversationModel ? 0.25 : introductory ? 0.75 : 1.5;
    const outputRate = model === geminiConversationModel ? 1.5 : introductory ? 3.75 : 7.5;
    const cached =
      Number.isSafeInteger(cachedInput) && cachedInput >= 0 && cachedInput <= input ? cachedInput : 0;
    return Math.ceil(
      (input - cached) * inputRate + (cached * inputRate) / 10 + output * outputRate + searches * 14_000,
    );
  }
  // Sonnet 5.5 Standard: $2/$10 per million input/output tokens, plus
  // $0.10 per million cache hits and $10/1000 searches, checked 7 Nov 2026.
  // The margin covers five-minute writes. Invalid cache counts earn no discount.
  if (provider === "anthropic") {
    const cached =
      Number.isSafeInteger(cachedInput) && cachedInput >= 0 && cachedInput <= input ? cachedInput : 0;
    return Math.ceil(((input - cached) * 2 + cached * 0.1 + output * 10 + searches * 10_000) * 1.25);
  }
  // Above 272k input tokens, long-context rates apply to the entire request.
  // Aggregated internal search steps may overestimate that tier; never undercharge it.
  const longContext = input > 272_000;
  return Math.ceil(
    (input * (longContext ? 0.25 : 0.125) + output * (longContext ? 0.75 : 0.5) + searches * 10_000) * 1.25,
  );
}
const exhausted = () =>
  new HttpError(
    429,
    "judge_budget_exhausted",
    "This demo has reached its AI limit. Your saved subscriptions are still here.",
  );

export function boundedJudgeRequest(request: Request, model?: ModelClient | null) {
  if (
    request.model !== modelName(model) ||
    request.tools?.some((tool) => !["function", "web_search"].includes(tool.type))
  )
    throw new HttpError(
      503,
      "judge_model_not_allowed",
      "This AI request is not available in the judge demo.",
    );
  const web = request.tools?.some((tool) => tool.type === "web_search") ?? false;
  const webCalls = web ? Math.min(request.max_tool_calls ?? judgeLimits.webCalls, judgeLimits.webCalls) : 0;
  if (!Number.isSafeInteger(webCalls) || webCalls < (web ? 1 : 0))
    throw new HttpError(400, "invalid_tool_limit", "Invalid research request.");
  const output = Math.min(request.max_output_tokens ?? judgeLimits.outputTokens, judgeLimits.outputTokens);
  if (
    !Number.isSafeInteger(output) ||
    output < 1 ||
    Buffer.byteLength(JSON.stringify(request), "utf8") > 200_000
  )
    throw new HttpError(
      400,
      "judge_request_too_large",
      "This request is too large for the demo. Try a shorter conversation.",
    );
  const body: Request = {
    ...request,
    service_tier: "default",
    max_output_tokens: output,
    ...(web ? { max_tool_calls: webCalls } : {}),
  };
  // Reserve a full model context at long-context rates per possible internal search step. Search content and
  // hidden output/reasoning cannot turn an apparently small prompt into unreserved work.
  // Claude's adapter includes native continuation blocks in its byte bound.
  // Each internal search may consume a full 1M context in addition to that input.
  const input =
    model?.provider === "google"
      ? (model.inputTokenBound?.(body) ?? modelContextTokens * 2) + 1_048_576 * webCalls
      : model?.provider === "anthropic"
        ? (model.inputTokenBound?.(body) ?? 1_000_000) + 1_000_000 * webCalls
        : modelContextTokens * (webCalls + 1);
  if (!Number.isSafeInteger(input) || input < 0) throw new Error("Invalid model token bound.");
  const generated = model?.outputTokenBound?.(body) ?? output;
  if (!Number.isSafeInteger(generated) || generated < output || generated > output * 2)
    throw new Error("Invalid model output bound.");
  const queries = web ? (model?.searchQueryBound ?? webCalls) : 0;
  if (!Number.isSafeInteger(queries) || queries < webCalls || queries > 100)
    throw new Error("Invalid model search bound.");
  const cost = modelCostMicros(input, generated, queries, model?.provider, 0, new Date(), modelName(model));
  return { body, reserveMicros: model?.provider === "google" ? Math.ceil(cost * 1.25) : cost };
}

async function reserve(
  ctx: BudgetContext,
  ownerId: string,
  amount: number,
  concurrentIds?: ReadonlySet<string>,
  backgroundCheck?: ScheduledCheckClaim,
) {
  return ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx)))
      throw new HttpError(
        409,
        "worker_superseded",
        "Val has been updated. Refresh this page to continue. Your saved needs are safe.",
      );
    await tx.insert(judgeDemoCounters).values({ key: budgetKey }).onConflictDoNothing();
    const [budget] = await tx
      .select()
      .from(judgeDemoCounters)
      .where(eq(judgeDemoCounters.key, budgetKey))
      .for("update");
    const [grant] = await tx.select().from(judgeDemoOwners).where(eq(judgeDemoOwners.ownerId, ownerId));
    let scheduled = false;
    if (backgroundCheck) {
      const [check] = await tx
        .select()
        .from(ownerPriceChecks)
        .where(
          sql`
        ${ownerPriceChecks.ownerId} = ${ownerId}
        and ${ownerPriceChecks.serviceId} = ${backgroundCheck.serviceId}
      `,
        )
        .for("update");
      scheduled =
        !!check &&
        !!check.cadence &&
        check.status === "checking" &&
        check.revision === backgroundCheck.revision &&
        check.leaseToken === backgroundCheck.leaseToken &&
        !!check.leaseUntil &&
        check.leaseUntil.getTime() > Date.now();
      if (!scheduled)
        throw new HttpError(409, "scheduled_check_changed", "This price check was paused or changed.");
    }
    // Confirmed schedules authorize only their claimed background work. Browser access
    // still expires normally; all funding, owner, frequency and concurrency limits apply.
    if (ctx.config.judgeDemo && (!grant || (grant.expiresAt.getTime() <= Date.now() && !scheduled)))
      throw new HttpError(403, "judge_access_required", "Log in with your access details to continue.");
    if (budget!.usedMicros + amount > budgetLimit(ctx) || budget!.calls >= judgeLimits.globalCalls)
      throw exhausted();
    const rows = await tx
      .select({
        id: judgeDemoRequests.id,
        state: judgeDemoRequests.state,
        createdAt: judgeDemoRequests.createdAt,
      })
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.ownerId, ownerId));
    if (!ctx.config.judgeAccessPaused && rows.length >= judgeLimits.ownerCalls)
      throw new HttpError(
        429,
        "judge_owner_limit",
        "You’ve reached this demo’s AI allowance. Your saved subscriptions are still here.",
      );
    const recent = rows.filter((row) => row.createdAt.getTime() > Date.now() - 60_000);
    if (recent.length >= judgeLimits.callsPerMinute) {
      // A reply needs multiple model calls. Waiting for one free slot would
      // spend it on the required read and immediately reject the continuation.
      const times = recent.map((row) => row.createdAt.getTime()).sort((a, b) => a - b);
      const resumeAt = times[Math.ceil(judgeLimits.callsPerMinute / 2) - 1]! + 60_000;
      throw new HttpError(
        429,
        "judge_rate_limited",
        "Val needs a short pause. Please try again in a minute.",
        Math.max(1, Math.ceil((resumeAt - Date.now()) / 1000)),
      );
    }
    const pending = rows.filter(
      (row) => row.state === "pending" && row.createdAt.getTime() > Date.now() - 120_000,
    );
    // Only the same server-created comparison may share two pending calls.
    // Other operations and reconstructed wrappers retain the overlap guard.
    if (pending.some((row) => !concurrentIds?.has(row.id)) || pending.length >= (concurrentIds ? 2 : 1))
      throw new HttpError(429, "judge_request_running", "Val is still working on your last request.");
    const id = randomUUID();
    await tx
      .insert(judgeDemoRequests)
      .values({ id, ownerId, reservedMicros: amount, chargedMicros: amount, state: "pending" });
    await tx
      .update(judgeDemoCounters)
      .set({ usedMicros: budget!.usedMicros + amount, calls: budget!.calls + 1 })
      .where(eq(judgeDemoCounters.key, budgetKey));
    return id;
  });
}

function usageCost(ctx: BudgetContext, response: Response, at: Date) {
  const usage = response.usage;
  const input = usage?.input_tokens;
  const output = usage?.output_tokens;
  const searches = ctx.model?.searchQueryCount
    ? ctx.model.searchQueryCount(response)
    : response.output.filter((item) => item.type === "web_search_call").length;
  const valid =
    response.model === modelName(ctx.model) &&
    Number.isSafeInteger(searches) &&
    searches >= 0 &&
    searches <= (ctx.model?.searchQueryBound ?? judgeLimits.webCalls) &&
    Number.isSafeInteger(input) &&
    input! >= 0 &&
    Number.isSafeInteger(output) &&
    output! >= 0;
  return valid
    ? modelCostMicros(
        input!,
        output!,
        searches,
        ctx.model?.provider,
        usage?.input_tokens_details?.cached_tokens,
        at,
        modelName(ctx.model),
      )
    : null;
}

async function checkpoint(ctx: BudgetContext, id: string, completed: Response, remaining: Request) {
  if (ctx.model?.provider !== "google" || remaining.model !== modelName(ctx.model) || remaining.tools?.length)
    return;
  const input = ctx.model.inputTokenBound?.(remaining);
  const output = ctx.model.outputTokenBound?.(remaining);
  if (
    !Number.isSafeInteger(input) ||
    input! < 0 ||
    !Number.isSafeInteger(output) ||
    output! < 1 ||
    output! > judgeLimits.outputTokens
  )
    return;
  await ctx.db.transaction(async (tx) => {
    const [budget] = await tx
      .select()
      .from(judgeDemoCounters)
      .where(eq(judgeDemoCounters.key, budgetKey))
      .for("update");
    const [request] = await tx
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.id, id))
      .for("update");
    if (!budget || !request || request.state !== "pending") return;
    const known = usageCost(ctx, completed, request.createdAt);
    if (known === null) return;
    const held =
      known +
      Math.ceil(
        modelCostMicros(input!, output!, 0, "google", 0, request.createdAt, modelName(ctx.model)) * 1.25,
      );
    if (held >= request.chargedMicros) return;
    // The search's usage is known. Only the tool-free extraction can still incur
    // an unknown charge; keep its full bound and retain the original reserve for audit.
    await tx
      .update(judgeDemoCounters)
      .set({ usedMicros: budget.usedMicros - request.chargedMicros + held })
      .where(eq(judgeDemoCounters.key, budgetKey));
    await tx.update(judgeDemoRequests).set({ chargedMicros: held }).where(eq(judgeDemoRequests.id, id));
  });
}

async function settle(ctx: BudgetContext, id: string, response: Response) {
  await ctx.db.transaction(async (tx) => {
    const [budget] = await tx
      .select()
      .from(judgeDemoCounters)
      .where(eq(judgeDemoCounters.key, budgetKey))
      .for("update");
    const [request] = await tx
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.id, id))
      .for("update");
    if (!request || request.state !== "pending") return;
    const cost = usageCost(ctx, response, request.createdAt);
    const charged = cost ?? request.chargedMicros;
    if (charged > request.chargedMicros) {
      // Unexpected provider accounting/pricing behavior: freeze further demo work.
      await tx
        .update(judgeDemoCounters)
        .set({ usedMicros: Math.max(budget!.usedMicros, budgetLimit(ctx)), calls: judgeLimits.globalCalls })
        .where(eq(judgeDemoCounters.key, budgetKey));
      await tx.update(judgeDemoRequests).set({ state: "uncertain" }).where(eq(judgeDemoRequests.id, id));
      return;
    }
    await tx
      .update(judgeDemoCounters)
      .set({ usedMicros: budget!.usedMicros - request.chargedMicros + charged })
      .where(eq(judgeDemoCounters.key, budgetKey));
    await tx
      .update(judgeDemoRequests)
      .set({ chargedMicros: charged, state: cost !== null ? "settled" : "uncertain" })
      .where(eq(judgeDemoRequests.id, id));
  });
}

/** A definitive pre-generation account/rate rejection has no generated usage. Unknown outcomes keep their hold. */
async function rejectRequest(ctx: BudgetContext, id: string) {
  await ctx.db.transaction(async (tx) => {
    const [budget] = await tx
      .select()
      .from(judgeDemoCounters)
      .where(eq(judgeDemoCounters.key, budgetKey))
      .for("update");
    const [request] = await tx
      .select()
      .from(judgeDemoRequests)
      .where(eq(judgeDemoRequests.id, id))
      .for("update");
    if (!budget || !request || request.state !== "pending") return;
    await tx
      .update(judgeDemoCounters)
      .set({ usedMicros: budget.usedMicros - request.chargedMicros })
      .where(eq(judgeDemoCounters.key, budgetKey));
    await tx
      .update(judgeDemoRequests)
      .set({ state: "rejected", chargedMicros: 0 })
      .where(eq(judgeDemoRequests.id, id));
  });
}

/** Every funded request, including tool continuations and correction attempts, passes here. */
export function modelForOwner(
  ctx: BudgetContext,
  ownerId: string,
  execution: {
    concurrentRequests?: 1 | 2;
    backgroundCheck?: ScheduledCheckClaim;
    fundingGroup?: object;
  } = {},
): ModelClient {
  const model = ctx.model;
  if (!model)
    throw new HttpError(503, "model_unavailable", "Val couldn’t connect just now. Please try again.");
  if (!ctx.config.judgeDemo && ctx.config.aiBudgetMicros == null) return model;
  const suppliedGroup = execution.fundingGroup ? fundingGroups.get(execution.fundingGroup) : undefined;
  if (
    execution.fundingGroup &&
    (!suppliedGroup ||
      suppliedGroup.ownerId !== ownerId ||
      suppliedGroup.pool !== ctx.db.$client ||
      execution.concurrentRequests !== 2)
  )
    throw new Error("Invalid model funding group.");
  const group = suppliedGroup ?? {
    ids: new Set<string>(),
    turn: Promise.resolve(),
    settlements: new Set<() => void>(),
  };
  const concurrentIds = execution.concurrentRequests === 2 ? group.ids : undefined;
  const settlements = group.settlements;
  async function reserveRequest(amount: number, signal: AbortSignal) {
    if (!concurrentIds) return reserve(ctx, ownerId, amount, undefined, execution.backgroundCheck);
    // Register ownership before the next funding transaction inspects pending calls.
    const previous = group.turn;
    let release!: () => void;
    group.turn = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      signal.throwIfAborted();
      const id = await reserve(ctx, ownerId, amount, concurrentIds, execution.backgroundCheck);
      concurrentIds.add(id);
      return id;
    } finally {
      release();
    }
  }
  function waitForSettlement(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!concurrentIds?.size) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const clear = () => {
        settlements.delete(finished);
        signal.removeEventListener("abort", aborted);
      };
      const finished = () => {
        clear();
        resolve();
      };
      const aborted = () => {
        clear();
        reject(signal.reason);
      };
      settlements.add(finished);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  return {
    provider: model.provider,
    model: model.model,
    inputTokenBound: model.inputTokenBound,
    outputTokenBound: model.outputTokenBound,
    searchQueryBound: model.searchQueryBound,
    searchQueryCount: model.searchQueryCount,
    hasSearchContext: model.hasSearchContext,
    managesDispatch: true,
    responses: {
      create: async (request, options) => {
        let signal = options?.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)])
          : AbortSignal.timeout(90_000);
        signal.throwIfAborted();
        let bounded = boundedJudgeRequest(request, model);
        let id: string;
        for (;;) {
          signal.throwIfAborted();
          try {
            id = await reserveRequest(bounded.reserveMicros, signal);
            break;
          } catch (error) {
            // Reduce search depth before dispatch when its worst-case reservation no
            // longer fits. The shared dollar limit and per-call safeguards stay intact.
            if (!(error instanceof HttpError) || error.code !== "judge_budget_exhausted") throw error;
            if (!bounded.body.max_tool_calls || bounded.body.max_tool_calls <= 1) {
              // A sibling search may temporarily hold the remaining allowance. Wait
              // for its known outcome rather than failing the whole comparison.
              if (!concurrentIds?.size) throw error;
              await waitForSettlement(signal);
              continue;
            }
            bounded = boundedJudgeRequest(
              {
                ...bounded.body,
                max_tool_calls: bounded.body.max_tool_calls - 1,
              },
              model,
            );
          }
        }
        let dispatched = false;
        try {
          signal.throwIfAborted();
          // Funding wait has its own deadline. A queued sibling must still get
          // the complete execution window once its reservation becomes available.
          signal = options?.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(90_000)])
            : AbortSignal.timeout(90_000);
          options?.onDispatch?.();
          signal.throwIfAborted();
          dispatched = true;
          const response = await new Promise<Response>((resolve, reject) => {
            const abandon = () => reject(signal.reason ?? new Error("Model request cancelled."));
            signal.addEventListener("abort", abandon, { once: true });
            Promise.resolve()
              .then(() => {
                signal.throwIfAborted();
                return model.responses.create(bounded.body, {
                  signal,
                  maxRetries: 0,
                  onUsageCheckpoint: async (completed, remaining) => {
                    await checkpoint(ctx, id, completed, remaining);
                    for (const finished of [...settlements]) finished();
                  },
                });
              })
              .then(resolve, reject)
              .finally(() => signal.removeEventListener("abort", abandon));
            if (signal.aborted) abandon();
          });
          await settle(ctx, id, response);
          return response;
        } catch (error) {
          if (!dispatched || modelAvailabilityError(error)) {
            await rejectRequest(ctx, id);
            throw error;
          }
          // A network/timeout error is not proof of no charge. Keep the full reservation.
          await ctx.db
            .update(judgeDemoRequests)
            .set({ state: "uncertain" })
            .where(eq(judgeDemoRequests.id, id));
          throw error;
        } finally {
          if (concurrentIds?.delete(id)) for (const finished of [...settlements]) finished();
        }
      },
    },
  };
}

export async function judgeBudgetStatus(ctx: BudgetContext) {
  const [budget] = await ctx.db.select().from(judgeDemoCounters).where(eq(judgeDemoCounters.key, budgetKey));
  const [held] = await ctx.db
    .select({ count: sql<number>`count(*)::int` })
    .from(judgeDemoRequests)
    .where(sql`${judgeDemoRequests.state} in ('pending', 'uncertain')`);
  return {
    budgetUsd: budgetLimit(ctx) / 1_000_000,
    usedUsd: (budget?.usedMicros ?? 0) / 1_000_000,
    requests: budget?.calls ?? 0,
    unresolvedRequests: held!.count,
  };
}
