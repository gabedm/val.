import type { AppContext } from "./context";
import { investigateCase } from "./investigation";
import type { Commit, JobRow } from "./jobs";
import { reconcileCase } from "./operations";
import { advanceTransition } from "./transition";

/**
 * The work behind a queued job. Jobs with a policy revision are investigations; revision 0 jobs read PayPal's current
 * state first and then advance the case's open transition, which never needs a model or a new consent.
 */
export async function runCaseJob(ctx: AppContext, job: JobRow, commit: Commit) {
  if (job.policyRevision > 0) return investigateCase(ctx, job, commit);
  await reconcileCase(ctx, job.caseId, commit);
  await advanceTransition(ctx, job.caseId, commit, { retry: job.eventId.startsWith("retry:") });
}
