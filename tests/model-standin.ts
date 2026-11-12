import OpenAI from "openai";
import type {
  Response,
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses";
import type { PolicyDraft } from "../src/shared/contracts";
import type { ModelClient } from "../src/server/responses-loop";
import { agentModel } from "../src/server/agent-contract";
import { adviceConsistencyKinds, type AdviceConsistency } from "../src/server/advice-consistency";

export function consistencyCheckOutput(
  issues: AdviceConsistency["issues"] = [],
  options?: { serviceId: string }[],
) {
  return {
    ...(options
      ? {
          optionChecks: options.map((option) => ({
            serviceId: option.serviceId,
            status: "supported",
            explanation: null,
          })),
        }
      : {}),
    checks: Object.fromEntries(
      adviceConsistencyKinds.map((kind) => {
        const issue = issues.find((issue) => issue.kind === kind);
        return [kind, { conflict: !!issue, explanation: issue?.explanation ?? null }];
      }),
    ),
  };
}

/** What one stand-in turn returns: function calls, a final JSON answer, a refusal, or an unfinished response. */
export type Turn =
  | { call: string; arguments?: object; callId?: string }
  | { answer: unknown }
  | { text: string }
  | { refusal: string }
  | { incomplete: string }
  | { calls: { call: string; arguments?: object }[] };

type Script = (
  request: ResponseCreateParamsNonStreaming,
  index: number,
  signal?: AbortSignal,
) => Turn | undefined | Promise<Turn | undefined>;

type Item = Record<string, unknown>;
const inputItems = (request: ResponseCreateParamsNonStreaming) => request.input as unknown as Item[];

/**
 * Test-only stand-in for the OpenAI Responses API. Its default behaviour is a competent investigator that works only
 * from the tool results it is sent, so application flows can run without the real model. Tests set `script` to make it
 * misbehave. Like the real API it rejects a continuation whose function calls and outputs do not pair by call_id.
 */
export class ModelStandIn implements ModelClient {
  readonly requests: ResponseCreateParamsNonStreaming[] = [];
  script: Script | null = null;
  consistencyScript: Script | null = null;
  draft: (purpose: string) => PolicyDraft = draftFromKeywords;
  private nextId = 1;

  responses = {
    create: (body: ResponseCreateParamsNonStreaming, options?: { signal?: AbortSignal }) =>
      this.respond(body, options?.signal),
  };

  private async respond(body: ResponseCreateParamsNonStreaming, signal?: AbortSignal): Promise<Response> {
    const request = structuredClone(body);
    this.requests.push(request);
    rejectUnpairedCalls(inputItems(request));
    // A script sees how many tool results this conversation already holds: 0 on the task's first request.
    const toolResultsSoFar = inputItems(request).filter(
      (item) => item.type === "function_call_output",
    ).length;
    const consistency =
      request.text?.format?.type === "json_schema" && request.text.format.name === "AdviceConsistency";
    const script = consistency ? this.consistencyScript : this.script;
    const turn: Turn =
      (await script?.(request, toolResultsSoFar, signal)) ??
      (consistency ? { answer: consistencyCheckOutput() } : this.competentTurn(request));
    if (consistency && "answer" in turn && turn.answer && typeof turn.answer === "object") {
      const answer = turn.answer as Record<string, unknown>;
      // Existing fixture checks default to supported options; individual tests
      // supply explicit audits to exercise rejected references and missing proof.
      if (answer.checks && !Object.hasOwn(answer, "optionChecks")) {
        const input = JSON.parse((request.input as { content: string }[])[0]!.content);
        return this.responseFor({
          answer: {
            ...answer,
            optionChecks: (input.proposal?.options ?? []).map((option: { serviceId: string }) => ({
              serviceId: option.serviceId,
              status: "supported",
              explanation: null,
            })),
          },
        });
      }
    }
    return this.responseFor(turn);
  }

  private competentTurn(request: ResponseCreateParamsNonStreaming): Turn {
    const format = request.text?.format as { name: string } | undefined;
    const userInput = JSON.parse(
      (request.input as { role?: string; content: string }[]).findLast((item) => item.role === "user")!
        .content,
    );
    if (format?.name === "PolicyDraft") return { answer: this.draft(userInput.purpose) };
    return investigate(userInput, toolResults(inputItems(request)));
  }

  private responseFor(turn: Turn): Response {
    const id = () => `stand-in-${this.nextId++}`;
    const usage = {
      input_tokens: 100,
      output_tokens: 20,
      total_tokens: 120,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 },
    };
    const message = (content: object) => ({
      id: id(),
      type: "message",
      role: "assistant",
      status: "completed",
      content: [content],
    });
    const functionCall = (call: string, args: object = {}, callId = id()) => ({
      id: id(),
      type: "function_call",
      call_id: callId,
      name: call,
      arguments: JSON.stringify(args),
      status: "completed",
    });
    const reasoning = { id: id(), type: "reasoning", summary: [], encrypted_content: "opaque" };

    let output: object[];
    if ("incomplete" in turn)
      return {
        id: id(),
        model: agentModel,
        status: "incomplete",
        incomplete_details: { reason: turn.incomplete },
        output: [],
        usage,
      } as unknown as Response;
    if ("calls" in turn)
      output = [reasoning, ...turn.calls.map((call) => functionCall(call.call, call.arguments))];
    else if ("call" in turn) output = [reasoning, functionCall(turn.call, turn.arguments, turn.callId)];
    else if ("refusal" in turn) output = [message({ type: "refusal", refusal: turn.refusal })];
    else if ("text" in turn) output = [message({ type: "output_text", text: turn.text, annotations: [] })];
    else
      output = [
        reasoning,
        message({ type: "output_text", text: JSON.stringify(turn.answer), annotations: [] }),
      ];
    return {
      id: id(),
      model: agentModel,
      status: "completed",
      incomplete_details: null,
      output,
      usage,
    } as unknown as Response;
  }
}

/** The real API refuses a function call without its output, or an output for no call. */
function rejectUnpairedCalls(input: Item[]) {
  const calls = input.filter((item) => item.type === "function_call").map((item) => item.call_id);
  const outputs = input.filter((item) => item.type === "function_call_output").map((item) => item.call_id);
  const unpaired =
    calls.some((callId) => !outputs.includes(callId)) || outputs.some((callId) => !calls.includes(callId));
  if (unpaired)
    throw new OpenAI.BadRequestError(
      400,
      { message: "No tool output found for function call." },
      "No tool output found for function call.",
      new Headers(),
    );
}

/** Tool results so far, keyed by tool name and, for candidate tools, by candidate. */
function toolResults(input: Item[]) {
  const results = new Map<string, any>();
  for (const call of input.filter(
    (item): item is Item & ResponseFunctionToolCall => item.type === "function_call",
  )) {
    const output = input.find(
      (item) => item.type === "function_call_output" && item.call_id === call.call_id,
    ) as { output: string } | undefined;
    const candidate = (JSON.parse(call.arguments) as { candidateId?: string }).candidateId;
    if (output) results.set(candidate ? `${call.name}:${candidate}` : call.name, JSON.parse(output.output));
  }
  return results;
}

/** A careful investigator written independently of Val's own rules: read, compare every option, pick from results. */
function investigate(userInput: any, results: Map<string, any>): Turn {
  const policy = userInput.confirmedPolicy;
  const answer = (
    action: string,
    candidateId: string | null,
    evidenceIds: string[],
    explanation: string,
  ) => ({
    answer: {
      action,
      candidateId,
      policyRevision: policy.revision,
      evidenceIds,
      explanation,
      uncertainties: [],
    },
  });
  const account = results.get("read_account");
  if (!account) return { call: "read_account" };
  const passes = (capabilityResults: { passes: boolean }[]) =>
    capabilityResults.every((result) => result.passes);
  const valueNotice =
    typeof userInput.providerNotice?.text === "string" &&
    userInput.providerNotice.text.includes("authored plan notice announces GBP");
  if (passes(account.capabilityResults) && !valueNotice)
    return answer(
      "stay",
      null,
      account.evidenceIds,
      "The current plan's actual output still meets every requirement.",
    );

  const listed = results.get("list_plans");
  if (!listed) return { call: "list_plans" };
  const others = listed.plans.filter((plan: any) => plan.planId !== account.account.planId);
  if (valueNotice && !results.has(`get_quote:${account.account.planId}`))
    return { call: "get_quote", arguments: { candidateId: account.account.planId } };
  for (const plan of others)
    if (!results.has(`get_quote:${plan.candidateId}`))
      return { call: "get_quote", arguments: { candidateId: plan.candidateId } };
  const ceiling = policy.replacementCeiling.amountMinor;
  const affordable = others.filter((plan: any) => {
    const quote = results.get(`get_quote:${plan.candidateId}`).quote;
    return quote.recurringTotal.amountMinor <= ceiling && quote.offer?.eligibility !== "INELIGIBLE";
  });
  for (const plan of affordable)
    if (!results.has(`test_candidate:${plan.candidateId}`))
      return { call: "test_candidate", arguments: { candidateId: plan.candidateId } };

  const eligible = affordable.filter((plan: any) =>
    passes(results.get(`test_candidate:${plan.candidateId}`).capabilityResults),
  );
  const evidenceFor = (plan: any) => [
    ...account.evidenceIds,
    results.get(`get_quote:${plan.candidateId}`).quote.evidenceId,
    ...results.get(`test_candidate:${plan.candidateId}`).evidenceIds,
  ];
  if (valueNotice) {
    const current = results.get(`get_quote:${account.account.planId}`).quote;
    const baseline = current.comparison;
    if (
      !baseline ||
      baseline.oldNextBillingAt !== account.account.paidThrough ||
      eligible.some((plan: any) => !results.get(`get_quote:${plan.candidateId}`).quote.comparison)
    )
      return answer("investigate", null, account.evidenceIds, "The dated billing comparison is incomplete.");
    const annual = (plan: any) =>
      results.get(`get_quote:${plan.candidateId}`).quote.comparison.candidateTotal.amountMinor;
    const due = (plan: any) => results.get(`get_quote:${plan.candidateId}`).quote.dueNowTotal.amountMinor;
    const [best] = eligible.sort(
      (first: any, second: any) => annual(first) - annual(second) || due(first) - due(second),
    );
    if (!best || (passes(account.capabilityResults) && annual(best) >= baseline.currentTotal.amountMinor))
      return answer(
        "stay",
        null,
        [...account.evidenceIds, current.evidenceId],
        "Keeping Original service costs no more over the same twelve months than the suitable paid alternatives.",
      );
    const quote = results.get(`get_quote:${best.candidateId}`).quote;
    const cost = (minor: number) => `£${(minor / 100).toFixed(2)}`;
    const explanation = `Original service still meets the required output, but its authored notice projects ${cost(baseline.announcedRenewal.amountMinor)} from ${baseline.renewalEffectiveAt}; that is not a PayPal charge. Keeping it is projected at ${cost(baseline.currentTotal.amountMinor)} over twelve months. ${best.candidateId} passes its own checks, costs ${cost(due(best))} now${quote.offer ? ` for ${quote.offer.introductoryCycles} paid cycles` : ""}, then ${cost(quote.recurringTotal.amountMinor)} monthly, and totals ${cost(annual(best))}. Other suitable quotes were compared over the same horizon.`;
    return answer(
      best.providerId === account.account.providerId ? "change_plan" : "switch",
      best.candidateId,
      [
        ...account.evidenceIds,
        current.evidenceId,
        quote.evidenceId,
        ...results.get(`test_candidate:${best.candidateId}`).evidenceIds,
      ],
      explanation,
    );
  }
  const upgrade = eligible.find((plan: any) => plan.providerId === account.account.providerId);
  if (upgrade)
    return answer(
      "change_plan",
      upgrade.candidateId,
      evidenceFor(upgrade),
      "A plan from the current provider passes within the ceiling.",
    );
  const price = (plan: any) => results.get(`get_quote:${plan.candidateId}`).quote.recurringTotal.amountMinor;
  const [replacement] = eligible.sort((first: any, second: any) => price(first) - price(second));
  if (replacement)
    return answer(
      "switch",
      replacement.candidateId,
      evidenceFor(replacement),
      "The cheapest replacement whose actual output passes.",
    );
  return answer(
    "investigate",
    null,
    account.evidenceIds,
    "No plan within the ceiling passes the requirements.",
  );
}

/** A predictable stand-in for drafting: capabilities and the ceiling from plain keywords in the purpose. */
function draftFromKeywords(purpose: string): PolicyDraft {
  const lower = purpose.toLowerCase();
  const requiredCapabilities: ("editable_text" | "speaker_labels")[] = [];
  if (lower.includes("edit")) requiredCapabilities.push("editable_text");
  if (lower.includes("speaker") || lower.includes("who said")) requiredCapabilities.push("speaker_labels");
  const pounds = /£(\d+)/.exec(purpose);
  return {
    purpose,
    requiredCapabilities: requiredCapabilities as PolicyDraft["requiredCapabilities"],
    recurringCeiling: pounds ? { currency: "GBP", amountMinor: Number(pounds[1]) * 100 } : null,
    preserveHistory: lower.includes("keep") ? true : null,
    allowInvestigation: null,
    interpretationNotes: [],
    unsupportedRequirements: lower.includes("translat") ? ["Translation of each call"] : [],
  };
}
