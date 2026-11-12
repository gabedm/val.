import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "./http";
import { ModelServiceError } from "./model-service-error";

/** Only read-only callers may opt into one separately funded retry. */
export function transientModelRetryDelay(error: unknown): number | null {
  if (error instanceof ModelServiceError && error.possiblyBilled) return null;
  if (
    error instanceof Anthropic.APIUserAbortError ||
    error instanceof OpenAI.APIUserAbortError ||
    error instanceof Anthropic.APIConnectionTimeoutError ||
    error instanceof OpenAI.APIConnectionTimeoutError
  )
    return null;
  const api =
    error instanceof Anthropic.APIError ||
    error instanceof OpenAI.APIError ||
    error instanceof ModelServiceError;
  if (!api) return null;
  const retryable =
    error instanceof Anthropic.APIConnectionError ||
    error instanceof OpenAI.APIConnectionError ||
    [500, 502, 503, 504, 529].includes(error.status ?? 0) ||
    (error instanceof Anthropic.APIError &&
      error.status === undefined &&
      ["overloaded_error", "api_error"].includes(error.type ?? ""));
  if (!retryable) return null;
  const header = error.headers?.get("retry-after");
  if (!header) return 1000;
  const delay = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
  return Number.isFinite(delay) && delay >= 0 && delay <= 10_000 ? Math.max(1000, Math.ceil(delay)) : null;
}

function retryAfter(error: { headers?: Headers }) {
  const value = error.headers?.get("retry-after");
  const seconds =
    value && /^\d+(?:\.\d+)?$/.test(value)
      ? Number(value)
      : value
        ? (Date.parse(value) - Date.now()) / 1000
        : NaN;
  return Number.isFinite(seconds) && seconds > 0 && seconds <= 3600 ? Math.ceil(seconds) : 60;
}

/** An account failure cannot be repaired by searching another provider. Never expose SDK error text. */
export function modelAvailabilityError(error: unknown): HttpError | null {
  if (error instanceof ModelServiceError && error.possiblyBilled) return null;
  if (
    !(error instanceof OpenAI.APIError) &&
    !(error instanceof Anthropic.APIError) &&
    !(error instanceof ModelServiceError)
  )
    return null;
  if (
    [
      "credit_balance_exhausted",
      "insufficient_quota",
      "organization_usage_limit_exceeded",
      "billing_hard_limit_reached",
      "spend_limit_exceeded",
    ].includes(error instanceof OpenAI.APIError ? (error.code ?? "") : "") ||
    (error instanceof OpenAI.APIError && error.type === "insufficient_quota") ||
    (error instanceof Anthropic.APIError &&
      error.status === 400 &&
      /credit balance|usage limit/i.test(error.message))
  ) {
    return new HttpError(
      503,
      "model_credit_exhausted",
      "Val’s AI service has reached its usage limit. Your saved answers and completed comparisons are safe. New checks can resume once access is restored.",
    );
  }
  if (error.status === 429)
    return new HttpError(
      429,
      "model_rate_limited",
      "Val needs a short pause before checking more offers. Your saved answers and completed comparisons are safe; try again in a minute.",
      retryAfter(error),
    );
  if (error.status === 401 || error.status === 403)
    return new HttpError(
      503,
      "model_access_unavailable",
      "Val couldn’t connect to its AI service. Your saved answers and completed comparisons are safe. New checks can resume once access is restored.",
    );
  if (
    error instanceof Anthropic.BadRequestError &&
    /The following domains are not accessible to our user agent:/i.test(error.message)
  )
    return new HttpError(
      503,
      "model_source_unavailable",
      "Val couldn’t read this provider’s website. Other provider checks can continue.",
    );
  if (
    error instanceof Anthropic.BadRequestError ||
    (error instanceof ModelServiceError && [400, 404].includes(error.status))
  )
    return new HttpError(
      503,
      "model_request_rejected",
      "Val couldn’t prepare that reply. Your saved answers are safe. Please try again once the service configuration is corrected.",
    );
  return null;
}

/** Remove only explicitly refused domains from an already bounded verification list. */
export function unavailableSearchDomains(error: unknown): string[] {
  if (modelAvailabilityError(error)?.code !== "model_source_unavailable") return [];
  const detail = (error as { error?: { error?: { message?: unknown }; message?: unknown } }).error;
  const message =
    typeof detail?.error?.message === "string"
      ? detail.error.message
      : typeof detail?.message === "string"
        ? detail.message
        : (error as Error).message;
  const listed = message.match(
    /The following domains are not accessible to our user agent:\s*\[([^\]\r\n]{1,2000})\]/i,
  )?.[1];
  return [
    ...new Set(
      (listed?.split(",") ?? [])
        .map((value) =>
          value
            .trim()
            .replace(/^['"]|['"]$/g, "")
            .toLowerCase()
            .replace(/^www\./, ""),
        )
        .filter(
          (value) =>
            value.length <= 253 &&
            /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value),
        ),
    ),
  ];
}
