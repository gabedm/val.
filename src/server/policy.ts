import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { Policy, PolicyCommand } from "../shared/contracts";
import { latestPolicy, lockCaseAndTransition, setCaseState, toPolicy } from "./cases";
import type { AppContext } from "./context";
import type { Executor } from "./db";
import {
  consents,
  exitAuthorizations,
  operations,
  policies,
  providerAccounts,
  transitions,
} from "./db/schema";
import { HttpError } from "./http";
import type { CaseRow, OperationRow } from "./operations";
import { unsupportedRequirementsFor } from "./policy-draft";

/**
 * Provider A's initial subscription once PayPal has confirmed its payment and paid-through boundary. Payment is a
 * historical fact; whether A's billing is still active is read separately, from PayPal, wherever it matters.
 */
export async function verifiedSetup(
  db: Executor,
  caseRow: CaseRow,
): Promise<{ operation: OperationRow; paidThrough: Date } | null> {
  const [operation] = await db
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.caseId, caseRow.id),
        eq(operations.kind, "setup_create"),
        eq(operations.probe, false),
      ),
    );
  const [account] = await db
    .select()
    .from(providerAccounts)
    .where(eq(providerAccounts.id, caseRow.initialAccountId));
  return operation?.paymentStatus === "VERIFIED" && account?.paidThrough
    ? { operation, paidThrough: account.paidThrough }
    : null;
}

/**
 * Records the user's confirmed policy as the next revision. Confirming grants no purchase or exit authority, and it
 * withdraws what the old revision had granted: unconsumed purchase consent and not-yet-used exit authorization.
 * An open transition past purchase pauses, because its exits were authorized under the old terms.
 */
export async function confirmPolicy(
  ctx: AppContext,
  caseRow: CaseRow,
  command: PolicyCommand,
): Promise<Policy> {
  const { policy, expectedRevision } = command;
  if (new Set(policy.requiredCapabilities).size !== policy.requiredCapabilities.length)
    throw new HttpError(400, "invalid_policy", "Required capabilities must be distinct.");
  if (policy.purpose.trim() === "")
    throw new HttpError(400, "invalid_policy", "The purpose cannot be blank.");
  if (!(await verifiedSetup(ctx.db, caseRow)))
    throw new HttpError(
      409,
      "setup_incomplete",
      "Provider A's paid period must be verified before a policy can be confirmed.",
    );
  return ctx.db.transaction(async (tx) => {
    const { state, transition } = await lockCaseAndTransition(tx, caseRow.id);
    const latest = await latestPolicy(tx, caseRow.id);
    if ((latest?.revision ?? 0) !== expectedRevision)
      throw new HttpError(409, "stale_policy", "The policy changed since it was loaded.");
    const unsupported = await unsupportedRequirementsFor(tx, caseRow.id, policy.purpose, latest?.purpose);
    if (unsupported.length > 0)
      throw new HttpError(
        409,
        "unsupported_requirements",
        `Val cannot test: ${unsupported.join("; ")}. Edit the purpose and draft it again before confirming.`,
      );

    const [created] = await tx
      .insert(policies)
      .values({
        id: randomUUID(),
        caseId: caseRow.id,
        revision: expectedRevision + 1,
        purpose: policy.purpose,
        requiredCapabilities: policy.requiredCapabilities,
        recurringCeilingMinor: policy.recurringCeiling.amountMinor,
        preserveHistory: policy.preserveHistory,
        allowInvestigation: policy.allowInvestigation,
      })
      .returning();

    const now = new Date();
    await tx
      .update(consents)
      .set({ revokedAt: now })
      .where(
        and(
          eq(consents.caseId, caseRow.id),
          isNull(consents.consumedByOperationId),
          isNull(consents.revokedAt),
        ),
      );
    if (!transition) {
      // A completed switch stays complete; every other case resumes monitoring under the new revision.
      if (state !== "COMPLETE") await setCaseState(tx, caseRow.id, "MONITORING");
    } else {
      await tx
        .update(exitAuthorizations)
        .set({ revokedAt: now })
        .where(
          and(
            eq(exitAuthorizations.transitionId, transition.id),
            isNull(exitAuthorizations.consumedAt),
            isNull(exitAuthorizations.revokedAt),
          ),
        );
      if (transition.state === "VERIFYING_NEW" || transition.state === "EXITING_OLD") {
        await tx
          .update(transitions)
          .set({
            state: "ATTENTION_REQUIRED",
            lastError: "The policy changed after purchase; review the remaining exits before they continue.",
            updatedAt: now,
          })
          .where(eq(transitions.id, transition.id));
        await setCaseState(tx, caseRow.id, "ATTENTION_REQUIRED", "authority_changed");
      }
    }
    return toPolicy(created!);
  });
}
