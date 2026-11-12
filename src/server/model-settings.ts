import { createHash } from "node:crypto";
import type { ModelClient } from "./responses-loop";
import { geminiAdapterVersion, geminiConversationModel } from "./gemini-model";

export const claudeModel = "claude-sonnet-5-5";
export const claudeAdapterVersion = "val-claude.6";

export function modelName(client: ModelClient | null | undefined) {
  return client?.model ?? "gpt-6-luna";
}

/** Recorded versions and caches must identify the model that actually did the work. */
export function modelVersion<T extends { model: string; fingerprint: string }>(
  version: T,
  client: ModelClient | null | undefined,
): T {
  if (client?.provider !== "anthropic" && client?.provider !== "google") return version;
  const adapter = client.provider === "google" ? geminiAdapterVersion : claudeAdapterVersion;
  const reasoning =
    client.provider === "google"
      ? modelName(client) === geminiConversationModel
        ? "thinking.minimal"
        : "thinking.low"
      : "between_tools.low";
  return {
    ...version,
    model: modelName(client),
    reasoning,
    reasoningEffort: reasoning,
    fingerprint: createHash("sha256")
      .update(`${version.fingerprint}:${adapter}:${modelName(client)}`)
      .digest("hex"),
  };
}
