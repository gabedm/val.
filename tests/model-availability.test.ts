import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import { expect, it } from "vitest";
import { modelAvailabilityError, unavailableSearchDomains } from "../src/server/model-availability";

it("distinguishes credit, temporary rate and access errors without returning provider diagnostics", () => {
  for (const [status, code, type, expected] of [
    [429, "credit_balance_exhausted", "insufficient_quota", "model_credit_exhausted"],
    [429, "organization_usage_limit_exceeded", null, "model_credit_exhausted"],
    [429, "spend_limit_exceeded", null, "model_credit_exhausted"],
    [429, "rate_limit_exceeded", null, "model_rate_limited"],
    [401, "invalid_api_key", null, "model_access_unavailable"],
    [403, null, null, "model_access_unavailable"],
  ] as const) {
    const error = OpenAI.APIError.generate(
      status,
      { error: { code, type, message: "secret provider diagnostic" } },
      "secret provider diagnostic",
      new Headers(),
    );
    expect(modelAvailabilityError(error)).toMatchObject({ code: expected });
    expect(modelAvailabilityError(error)?.message).not.toContain("secret");
  }
  expect(modelAvailabilityError(new Error("network interrupted"))).toBeNull();
  expect(
    modelAvailabilityError(
      OpenAI.APIError.generate(500, { message: "server error" }, "server error", new Headers()),
    ),
  ).toBeNull();
});

it("distinguishes an excluded search source from an invalid model request without exposing diagnostics", () => {
  for (const [message, code] of [
    [
      "The following domains are not accessible to our user agent: ['example.org']. Read more: private diagnostic",
      "model_source_unavailable",
    ],
    ["Invalid model tool schema: private diagnostic", "model_request_rejected"],
  ]) {
    const error = Anthropic.APIError.generate(
      400,
      { type: "error", error: { type: "invalid_request_error", message } },
      message,
      new Headers(),
    );
    expect(modelAvailabilityError(error)?.code).toBe(code);
    expect(unavailableSearchDomains(error)).toEqual(
      code === "model_source_unavailable" ? ["example.org"] : [],
    );
    expect(modelAvailabilityError(error)?.message).not.toMatch(/example\.org|private diagnostic/);
  }
});
