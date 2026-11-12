import OpenAI from "openai";
import type { Config } from "./config";
import { ClaudeModelClient } from "./anthropic-model";
import { GeminiModelClient } from "./gemini-model";
import type { ModelClient } from "./responses-loop";

/** Provider choice is server configuration. No automatic cross-provider fallback. */
export function createModelClient(
  config: Pick<Config, "modelProvider" | "anthropicApiKey" | "openaiApiKey" | "googleModel">,
): ModelClient | null {
  if (config.modelProvider === "google")
    return config.googleModel ? new GeminiModelClient(config.googleModel) : null;
  if (config.modelProvider === "anthropic")
    return config.anthropicApiKey ? new ClaudeModelClient(config.anthropicApiKey) : null;
  return config.openaiApiKey ? new OpenAI({ apiKey: config.openaiApiKey, maxRetries: 0 }) : null;
}

/** Operator checks use the same explicit provider choice as the application. */
export function modelFromEnvironment(): ModelClient | null {
  const provider = process.env.VAL_MODEL_PROVIDER ?? "openai";
  if (!["anthropic", "openai", "google"].includes(provider)) throw new Error("Invalid model provider.");
  return createModelClient({
    modelProvider: provider as "anthropic" | "openai" | "google",
    googleModel:
      provider === "google"
        ? {
            project: process.env.GOOGLE_CLOUD_PROJECT ?? "",
            location: process.env.GOOGLE_CLOUD_LOCATION || "global",
            impersonateServiceAccount: process.env.GOOGLE_IMPERSONATE_SERVICE_ACCOUNT || null,
          }
        : null,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
  });
}
