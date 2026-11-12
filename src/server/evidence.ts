import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Artifact, Evidence } from "../shared/contracts";
import type { Executor } from "./db";
import { artifacts, evidence } from "./db/schema";
import { maxArtifactBytes, sha256 } from "./validation";

export interface AdvisoryOption {
  advisory?: boolean;
}

/** Stores exact bytes and their raw SHA-256 (distinct from any canonical digest). Oversized content is refused, never truncated. */
export async function storeArtifact(
  tx: Executor,
  caseId: string,
  content: string,
  mimeType: Artifact["mimeType"] = "application/json",
  options: AdvisoryOption = {},
): Promise<Artifact> {
  if (Buffer.byteLength(content, "utf8") > maxArtifactBytes)
    throw new Error("Artifact exceeds the 16 KiB limit and is unavailable as evidence.");
  const [stored] = await tx
    .insert(artifacts)
    .values({
      id: randomUUID(),
      caseId,
      mimeType,
      content,
      sha256: sha256(content),
      advisory: options.advisory ?? false,
    })
    .returning();
  return {
    id: stored!.id,
    caseId: stored!.caseId,
    mimeType: stored!.mimeType,
    content: stored!.content,
    sha256: stored!.sha256,
    createdAt: stored!.createdAt.toISOString(),
  };
}

interface NewEvidence {
  caseId: string;
  kind: Evidence["kind"];
  summary: string;
  operationId?: string;
  providerId?: Evidence["providerId"];
  accountId?: string;
  planId?: string;
  entitlementRevision?: number;
  artifactId?: string;
  detail?: unknown;
}

export async function recordEvidence(
  tx: Executor,
  input: NewEvidence,
  options: AdvisoryOption = {},
): Promise<{ id: string; observedAt: Date }> {
  const id = randomUUID();
  const observedAt = new Date();
  await tx.insert(evidence).values({
    id,
    caseId: input.caseId,
    operationId: input.operationId,
    providerId: input.providerId,
    accountId: input.accountId,
    planId: input.planId,
    entitlementRevision: input.entitlementRevision,
    kind: input.kind,
    observedAt,
    artifactId: input.artifactId,
    advisory: options.advisory ?? false,
    summary: input.summary,
    detail: input.detail,
  });
  return { id, observedAt };
}

export async function loadEvidence(tx: Executor, evidenceId: string, options: AdvisoryOption = {}) {
  const [row] = await tx
    .select()
    .from(evidence)
    .where(and(eq(evidence.id, evidenceId), eq(evidence.advisory, options.advisory ?? false)));
  return row!;
}

export async function evidenceIdForArtifact(
  tx: Executor,
  artifactId: string,
  options: AdvisoryOption = {},
): Promise<string> {
  const [row] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.artifactId, artifactId), eq(evidence.advisory, options.advisory ?? false)));
  return row!.id;
}
