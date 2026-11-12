import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type {
  FunctionTool,
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from "openai/resources/responses/responses";
import { agentLimits, reasoningEffort } from "./agent-contract";
import { modelName } from "./model-settings";
import { transientModelRetryDelay } from "./model-availability";
import { ModelServiceError } from "./model-service-error";

/** The shared tool contract; a provider adapter translates it to its native API. */
export interface ModelClient {
  provider?: "openai" | "anthropic" | "google";
  model?: string;
  inputTokenBound?: (body: ResponseCreateParamsNonStreaming) => number;
  outputTokenBound?: (body: ResponseCreateParamsNonStreaming) => number;
  /** Some providers issue multiple billable queries inside one grounded operation. */
  searchQueryBound?: number;
  searchQueryCount?: (response: Response) => number;
  /** True only while the adapter still holds the response's actual provider search content. */
  hasSearchContext?: (response: Response) => boolean;
  /** The funding wrapper signals when a queued request actually starts. */
  managesDispatch?: boolean;
  /** Read-only routing owns its single bounded model recovery. */
  managesRecovery?: boolean;
  responses: {
    create(
      body: ResponseCreateParamsNonStreaming,
      options?: {
        signal?: AbortSignal;
        maxRetries?: number;
        onDispatch?: () => void;
        /** Adapter-owned completed usage and the remaining native request, never customer input. */
        onUsageCheckpoint?: (
          completed: Response,
          remaining: ResponseCreateParamsNonStreaming,
        ) => Promise<void>;
      },
    ): Promise<Response>;
  };
}

export type ReviewReason =
  | "model_unavailable"
  | "model_error"
  | "timeout"
  | "tool_budget"
  | "unknown_tool"
  | "invalid_call"
  | "invalid_arguments"
  | "tool_refused"
  | "refusal"
  | "incomplete"
  | "missing_output"
  | "invalid_output";

export interface TraceStep {
  origin?: "server";
  tool: string;
  callId: string;
  arguments: unknown;
  result: unknown;
  elapsedMs: number;
}

export interface ModelUsage {
  modelCalls: number;
  retryAttempts?: number;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

export type TaskOutcome<T> =
  { completed: true; output: T } | { completed: false; reason: ReviewReason; detail: string };
export type TaskResult<T> = TaskOutcome<T> & { trace: TraceStep[]; usage: ModelUsage; elapsedMs: number };

/** Thrown by a tool executor that will not act on a call (bad identifier, foreign artifact, provider refusal). */
export class ToolRefusal extends Error {}

export interface ModelTask<T> {
  instructions: string;
  signal?: AbortSignal;
  /** Prior conversational turns, before the current JSON user message. Never system or tool authority. */
  history?: { role: "user" | "assistant"; content: string }[];
  /** Strings are sent as the current user message; structured inputs are encoded as JSON. */
  input: unknown;
  tools: FunctionTool[];
  /** Mandatory application reads use the same executor, deadline and tool allowance. */
  initialReads?: { name: string; arguments: unknown }[];
  /** Supply application context before the current message, preserving its user authority. */
  inputAfterInitialReads?: boolean;
  /** Read-only chat only. The funded client reserves each attempt separately. */
  retryTransientErrors?: boolean;
  /** A stalled read-only chat may answer from supplied context without another tool-selection round. */
  contextOnlyRecovery?: boolean;
  /** Narrow read-only tools to the evidence/permission available at this step. */
  availableTools?: () => FunctionTool[];
  /** A step may require a read-only tool before the model is allowed to answer. */
  toolChoice?: () => "auto" | "required" | "none";
  output: {
    name: string;
    schema: Record<string, unknown>;
    accept: (value: unknown) => value is T;
    /** Server-authored format correction, attempted once within the original task deadline. */
    invalidFeedback?: string;
    feedback?: (value: T, signal: AbortSignal) => string | null | Promise<string | null>;
  };
  executeTool?: (name: string, args: unknown, signal: AbortSignal) => Promise<unknown>;
}

export interface ModelTaskLimits {
  maxToolCalls: number;
  timeoutMs: number;
  /** Task-specific ceiling, still bounded by the installation spending guard. */
  maxOutputTokens?: number;
  /** Read-only chat can abandon one stalled inference without repeating completed tools. */
  inferenceTimeoutMs?: number;
  /** Opt-in read-only inference may race one backup without discarding the original reply. */
  inferenceHedgeMs?: number;
  /** Read-only comparisons may opt into one additional checked revision. */
  maxCorrections?: 1 | 2;
}

/**
 * One bounded model task over the Responses API: strict tools, a strict final schema and an explicit loop. Every output
 * item, opaque reasoning included, is sent back in full and each function_call_output carries its call's call_id.
 * Anything unexpected ends the task in review rather than in a guessed answer; reasoning is never kept or logged.
 * The deadline covers model requests and tool work alike and ends the task on time even if a call never returns.
 */
export async function runModelTask<T>(
  client: ModelClient,
  task: ModelTask<T>,
  limits: ModelTaskLimits = agentLimits,
): Promise<TaskResult<T>> {
  const maxCorrections = limits.maxCorrections ?? 1;
  if (task.contextOnlyRecovery && !task.retryTransientErrors)
    throw new Error("Context recovery requires a read-only task.");
  if (maxCorrections !== 1 && maxCorrections !== 2) throw new Error("Invalid model correction limit.");
  if (
    limits.maxOutputTokens !== undefined &&
    (!Number.isSafeInteger(limits.maxOutputTokens) ||
      limits.maxOutputTokens < 1 ||
      limits.maxOutputTokens > 5000)
  )
    throw new Error("Invalid task output limit.");
  if (
    limits.inferenceTimeoutMs !== undefined &&
    (!Number.isSafeInteger(limits.inferenceTimeoutMs) ||
      limits.inferenceTimeoutMs <= 0 ||
      limits.inferenceTimeoutMs > limits.timeoutMs ||
      (!task.retryTransientErrors && !client.managesRecovery))
  )
    throw new Error("Invalid read-only inference deadline.");
  if (
    limits.inferenceHedgeMs !== undefined &&
    (!limits.inferenceTimeoutMs ||
      !Number.isSafeInteger(limits.inferenceHedgeMs) ||
      limits.inferenceHedgeMs <= 0 ||
      limits.inferenceHedgeMs >= limits.inferenceTimeoutMs)
  )
    throw new Error("Invalid read-only recovery deadline.");
  const started = Date.now();
  const trace: TraceStep[] = [];
  const usage: ModelUsage = { modelCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), limits.timeoutMs);
  const cancel = () => deadline.abort();
  if (task.signal?.aborted) cancel();
  else task.signal?.addEventListener("abort", cancel, { once: true });
  const finish = (outcome: TaskOutcome<T>): TaskResult<T> => ({
    ...outcome,
    trace,
    usage,
    elapsedMs: Date.now() - started,
  });
  const review = (reason: ReviewReason, detail: string) => finish({ completed: false, reason, detail });

  const currentInput: ResponseInputItem = {
    role: "user",
    content: typeof task.input === "string" ? task.input : JSON.stringify(task.input),
  };
  const conversation: ResponseInputItem[] = [
    ...(task.history ?? []),
    ...(!task.inputAfterInitialReads ? [currentInput] : []),
  ];
  const seenCallIds = new Set<string>();
  let corrections = 0;
  let correctedFormat = false;
  const correctedRequiredStages = new Set<number>();
  try {
    for (const read of task.initialReads ?? []) {
      if (trace.length >= limits.maxToolCalls)
        return review("tool_budget", "The required application reads exceed the tool limit.");
      const available = task.availableTools?.() ?? task.tools;
      if (!task.executeTool || !available.some((tool) => tool.name === read.name))
        return review("unknown_tool", "A required application read is not available at this step.");
      const serialized = JSON.stringify(read.arguments);
      const args = typeof serialized === "string" ? parseJson(serialized) : undefined;
      if (args === undefined) return review("invalid_arguments", "Invalid application read arguments.");
      const callId = `app_read_${randomUUID().replaceAll("-", "")}`;
      seenCallIds.add(callId);
      const toolStarted = Date.now();
      const execute = task.executeTool;
      const result = await beforeDeadline(deadline.signal, () => execute(read.name, args, deadline.signal));
      trace.push({
        origin: "server",
        tool: read.name,
        callId,
        arguments: args,
        result,
        elapsedMs: Date.now() - toolStarted,
      });
      conversation.push(
        { type: "function_call", name: read.name, call_id: callId, arguments: serialized! },
        { type: "function_call_output", call_id: callId, output: JSON.stringify(result) },
      );
    }
    if (task.inputAfterInitialReads) conversation.push(currentInput);
    for (;;) {
      if (task.inputAfterInitialReads) {
        // Tool output or validation feedback must not displace the customer's
        // latest answer. Move this exact data item; do not duplicate or rewrite it.
        const position = conversation.indexOf(currentInput);
        if (position >= 0) conversation.splice(position, 1);
        conversation.push(currentInput);
      }
      const offeredTools = task.availableTools?.() ?? task.tools;
      const requestedChoice = task.toolChoice?.();
      const exhausted = task.tools.length > 0 && trace.length >= limits.maxToolCalls;
      if (exhausted && requestedChoice === "required" && offeredTools.length)
        return review("tool_budget", "The remaining required evidence exceeds the tool limit.");
      // Once optional reads are spent, let the model answer from what it has.
      // Required evidence and the final validator still cannot be bypassed.
      const availableTools = exhausted ? [] : offeredTools;
      const toolChoice = exhausted ? "none" : requestedChoice;
      const request: ResponseCreateParamsNonStreaming = {
        model: modelName(client),
        ...(limits.maxOutputTokens ? { max_output_tokens: limits.maxOutputTokens } : {}),
        reasoning: { effort: reasoningEffort },
        instructions:
          task.instructions +
          (exhausted
            ? "\nNo further tools are available for this turn. Return the structured reply using only evidence already supplied. If a material fact is still missing, ask a concise clarification or report the uncertainty; never invent an answer or completed research."
            : ""),
        input: conversation,
        ...(availableTools.length > 0 && { tools: availableTools, parallel_tool_calls: false }),
        ...(toolChoice && { tool_choice: toolChoice }),
        text: {
          format: { type: "json_schema", name: task.output.name, schema: task.output.schema, strict: true },
        },
        store: false,
        include: ["reasoning.encrypted_content"],
      };
      let response: Response;
      for (;;) {
        const attempt = new AbortController();
        const inferenceTimeout = limits.inferenceTimeoutMs;
        const attemptTimer = inferenceTimeout
          ? setTimeout(() => attempt.abort(), inferenceTimeout)
          : undefined;
        const signal = AbortSignal.any([deadline.signal, attempt.signal]);
        try {
          response = await beforeDeadline(signal, () =>
            limits.inferenceHedgeMs &&
            !client.managesRecovery &&
            !usage.retryAttempts &&
            !request.tools?.some((tool) => tool.type === "web_search")
              ? readOnlyHedgedInference(
                  client,
                  request,
                  signal,
                  limits.inferenceHedgeMs,
                  () => {
                    usage.retryAttempts = 1;
                  },
                  task.contextOnlyRecovery && toolChoice !== "required"
                    ? {
                        ...request,
                        tools: [],
                        tool_choice: "none",
                        instructions:
                          request.instructions +
                          "\nFor this recovery attempt, use the conversation and application reads already supplied. No additional tools are available. Reply to the current message, proposing memory when enough is known or asking one brief clarification when the meaning or a required product fact is genuinely unclear. Do not invent facts, change known billing, claim an unperformed read, or bypass confirmation and ownership rules.",
                      }
                    : undefined,
                )
              : client.responses.create(request, { signal }),
          );
          break;
        } catch (error) {
          const stalled = attempt.signal.aborted && !deadline.signal.aborted;
          const delay =
            task.retryTransientErrors && !client.managesRecovery && !usage.retryAttempts
              ? stalled && !request.tools?.some((tool) => tool.type === "web_search")
                ? 1000
                : transientModelRetryDelay(error)
              : null;
          if (stalled && delay === null)
            return review("timeout", "The model reply exceeded its inference deadline.");
          if (delay === null || deadline.signal.aborted) throw error;
          // Retry only the failed inference. Earlier reads/tools and partial
          // output are never replayed. The funded client retains an unknown
          // charge and reserves this attempt separately; the task deadline still applies.
          await beforeDeadline(
            deadline.signal,
            () => new Promise<void>((resolve) => setTimeout(resolve, delay)),
          );
          usage.retryAttempts = 1;
        } finally {
          clearTimeout(attemptTimer);
        }
      }
      usage.modelCalls++;
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;
      usage.reasoningTokens += response.usage?.output_tokens_details?.reasoning_tokens ?? 0;
      if (response.status !== "completed")
        return review(
          "incomplete",
          `The response ended ${response.status}${response.incomplete_details?.reason ? ` (${response.incomplete_details.reason})` : ""}.`,
        );

      conversation.push(...(response.output as ResponseInputItem[]));
      const calls = response.output.filter(
        (item): item is ResponseFunctionToolCall => item.type === "function_call",
      );
      if (calls.length === 0) {
        // Some providers cannot force a tool call. The server still refuses
        // a skipped read. Each completed tool advances the stage; a second
        // miss at the same stage still stops within the original deadline.
        if (toolChoice === "required" && availableTools.length > 0) {
          if (correctedRequiredStages.has(trace.length))
            return review("invalid_output", "The model skipped a required tool.");
          correctedRequiredStages.add(trace.length);
          conversation.push({
            role: "developer",
            content: `Call one of the available tools before answering: ${availableTools.map((tool) => tool.name).join(", ")}. A final answer without that required read cannot be accepted.`,
          });
          continue;
        }
        const answer = finalAnswer(response, task.output);
        if (
          !answer.completed &&
          answer.reason === "invalid_output" &&
          task.output.invalidFeedback &&
          !correctedFormat
        ) {
          correctedFormat = true;
          conversation.push({ role: "developer", content: task.output.invalidFeedback });
          continue;
        }
        const feedback =
          answer.completed && task.output.feedback
            ? await beforeDeadline(deadline.signal, () =>
                Promise.resolve(task.output.feedback!(answer.output, deadline.signal)),
              )
            : null;
        if (!feedback) return finish(answer);
        if (corrections >= maxCorrections)
          return review(
            "invalid_output",
            maxCorrections === 1
              ? "The reply still failed its conversational check after one correction."
              : "The reply still failed its conversational check after two corrections.",
          );
        corrections++;
        conversation.push({ role: "developer", content: feedback });
        continue;
      }

      for (const call of calls) {
        if (trace.length >= limits.maxToolCalls)
          return review("tool_budget", `The model asked for more than ${limits.maxToolCalls} tool calls.`);
        if (!task.executeTool || !availableTools.some((tool) => tool.name === call.name))
          return review("unknown_tool", `The model called ${call.name}, which it was not given.`);
        if (!call.call_id || seenCallIds.has(call.call_id))
          return review("invalid_call", "A tool call had a missing or repeated call_id.");
        seenCallIds.add(call.call_id);
        const args = parseJson(call.arguments);
        if (args === undefined)
          return review("invalid_arguments", `The arguments for ${call.name} are not JSON.`);

        const toolStarted = Date.now();
        const executeTool = task.executeTool;
        const result = await beforeDeadline(deadline.signal, () =>
          executeTool(call.name, args, deadline.signal),
        );
        trace.push({
          tool: call.name,
          callId: call.call_id,
          arguments: args,
          result,
          elapsedMs: Date.now() - toolStarted,
        });
        conversation.push({
          type: "function_call_output",
          call_id: call.call_id,
          output: JSON.stringify(result),
        });
      }
    }
  } catch (error) {
    if (deadline.signal.aborted)
      return review("timeout", `The task exceeded ${limits.timeoutMs / 1000} seconds.`);
    if (error instanceof ToolRefusal) return review("tool_refused", error.message);
    if (
      error instanceof OpenAI.APIError ||
      error instanceof Anthropic.APIError ||
      error instanceof ModelServiceError
    )
      return review(
        "model_error",
        `The model request failed: ${error.status ?? "no status"} ${error.name}${error instanceof Anthropic.APIError && ["overloaded_error", "api_error", "rate_limit_error", "invalid_request_error", "authentication_error", "permission_error"].includes(error.type ?? "") ? ` (${error.type})` : ""}.`,
      );
    throw error;
  } finally {
    clearTimeout(timer);
    task.signal?.removeEventListener("abort", cancel);
  }
}

/**
 * Settles with the work, or rejects the moment the deadline passes, whether or not the work listens to the signal. Work
 * abandoned this way is not waited for; its late result or error is ignored.
 */
/** Only model inference is raced; tool execution and validated application writes stay sequential. */
async function readOnlyHedgedInference(
  client: ModelClient,
  request: ResponseCreateParamsNonStreaming,
  signal: AbortSignal,
  hedgeAfterMs: number,
  onHedge: () => void,
  recoveryRequest?: ResponseCreateParamsNonStreaming,
): Promise<Response> {
  const first = new AbortController(),
    second = new AbortController();
  const start = (controller: AbortController, body = request) =>
    client.responses.create(body, { signal: AbortSignal.any([signal, controller.signal]) });
  const original = start(first);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const early = await Promise.race([
      original.then((response) => ({ response })),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), hedgeAfterMs);
      }),
    ]);
    clearTimeout(timer);
    if (early) return early.response;
    signal.throwIfAborted();
    onHedge();
    // Each attempt is independently funded. A losing or disconnected request
    // retains its uncertain usage hold; no paid searches or tools are replayed.
    try {
      const recovery = start(second, recoveryRequest).then((response) => {
        if (recoveryRequest && response.output.some((item) => item.type === "function_call"))
          throw new ToolRefusal("The context-only recovery requested an unavailable tool.");
        return response;
      });
      return await Promise.any([original, recovery]);
    } catch (error) {
      // Preserve provider error handling after both funded attempts fail.
      if (error instanceof AggregateError && error.errors.length) throw error.errors[0];
      throw error;
    }
  } finally {
    clearTimeout(timer);
    first.abort();
    second.abort();
  }
}

function beforeDeadline<T>(deadline: AbortSignal, start: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abandon = () => reject(new Error("The deadline passed."));
    if (deadline.aborted) return abandon();
    deadline.addEventListener("abort", abandon, { once: true });
    start()
      .then(resolve, reject)
      .finally(() => deadline.removeEventListener("abort", abandon));
  });
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The final structured answer, accepted only if it is present, not a refusal, valid JSON and passes local validation. */
function finalAnswer<T>(response: Response, output: ModelTask<T>["output"]): TaskOutcome<T> {
  const parts = response.output.flatMap((item) => (item.type === "message" ? item.content : []));
  const refusal = parts.find((part) => part.type === "refusal");
  if (refusal) return { completed: false, reason: "refusal", detail: refusal.refusal };
  const text = parts.flatMap((part) => (part.type === "output_text" ? [part.text] : [])).join("");
  if (!text)
    return { completed: false, reason: "missing_output", detail: "The model returned no final answer." };
  const value = parseJson(text);
  if (!output.accept(value))
    return {
      completed: false,
      reason: "invalid_output",
      detail: "The final answer does not match the required schema.",
    };
  return { completed: true, output: value };
}
