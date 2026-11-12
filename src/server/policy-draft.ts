import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { validate, type PolicyDraft } from "../shared/contracts";
import { agentVersion, draftingInstructions, strictSchemaFor } from "./agent-contract";
import type { AppContext } from "./context";
import type { Executor } from "./db";
import { agentRuns, cases, policyDrafts } from "./db/schema";
import { HttpError } from "./http";
import type { CaseRow } from "./operations";
import { runModelTask, type ModelClient, type TaskResult } from "./responses-loop";
import { modelForOwner } from "./judge-budget";

/** Local checks the schema cannot express: each capability once. */
function draftProblem(draft: PolicyDraft): string | null {
  if (new Set(draft.requiredCapabilities).size !== draft.requiredCapabilities.length)
    return "It lists a capability twice.";
  return null;
}

/** One drafting task: the checked draft, or the reason there is none. The purpose stays the person's own text. */
export async function runPolicyDraft(
  model: ModelClient,
  purpose: string,
): Promise<{ draft: PolicyDraft | null; problem: string | null; result: TaskResult<PolicyDraft> }> {
  const result = await runModelTask(model, {
    instructions: draftingInstructions,
    input: { purpose },
    tools: [],
    output: { name: "PolicyDraft", schema: strictSchemaFor("PolicyDraft"), accept: validate.policyDraft },
  });
  const problem = result.completed ? draftProblem(result.output) : result.detail;
  const draft = result.completed && !problem ? { ...result.output, purpose } : null;
  return { draft, problem, result };
}

/**
 * Proposes requirements from the person's own words. The draft grants nothing: the person confirms or edits it, and
 * requirements Val cannot test are kept visible. Every attempt is recorded, including ones that end in review.
 */
export async function draftPolicy(ctx: AppContext, caseRow: CaseRow, purpose: string): Promise<PolicyDraft> {
  if (!ctx.model)
    throw new HttpError(
      503,
      "model_unavailable",
      "Drafting needs the configured AI service. You can still write and confirm the requirements yourself.",
    );
  const { draft, problem, result } = await runPolicyDraft(modelForOwner(ctx, caseRow.ownerId), purpose);

  await ctx.db.transaction(async (tx) => {
    await tx.select({ id: cases.id }).from(cases).where(eq(cases.id, caseRow.id)).for("update");
    const agentRunId = randomUUID();
    await tx.insert(agentRuns).values({
      id: agentRunId,
      caseId: caseRow.id,
      task: "policy_draft",
      version: agentVersion(ctx.model),
      outcome: draft ? "accepted" : result.completed ? "rejected" : "review",
      detail: problem,
      trace: result.trace,
      output: result.completed ? result.output : null,
      usage: result.usage,
      elapsedMs: result.elapsedMs,
    });
    if (draft)
      await tx
        .insert(policyDrafts)
        .values({ id: randomUUID(), caseId: caseRow.id, purpose, draft, agentRunId });
  });

  if (!draft)
    throw new HttpError(
      409,
      "draft_review",
      `Val could not draft requirements from that text. ${problem} You can write them yourself or try other wording.`,
    );
  return draft;
}

const purposeKey = (purpose: string) =>
  purpose
    .normalize("NFC")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[.!?]+$/u, "")
    .trim();

/** Known unsupported requirements survive cosmetic edits; a changed purpose needs its own review before clearing them. */
export async function unsupportedRequirementsFor(
  db: Executor,
  caseId: string,
  purpose: string,
  confirmedPurpose?: string,
): Promise<string[]> {
  const drafts = await db
    .select({ purpose: policyDrafts.purpose, draft: policyDrafts.draft })
    .from(policyDrafts)
    .where(eq(policyDrafts.caseId, caseId));
  const key = purposeKey(purpose);
  const matching = drafts.filter((row) => purposeKey(row.purpose) === key);
  const unsupported = [...new Set(matching.flatMap((row) => row.draft.unsupportedRequirements))];
  if (unsupported.length > 0) return unsupported;
  if (matching.length > 0 || (confirmedPurpose !== undefined && purposeKey(confirmedPurpose) === key))
    return [];
  if (drafts.some((row) => row.draft.unsupportedRequirements.length > 0)) {
    throw new HttpError(
      409,
      "draft_required",
      "This case has a known unsupported requirement. Suggest choices from the revised purpose before confirming it.",
    );
  }
  return [];
}
