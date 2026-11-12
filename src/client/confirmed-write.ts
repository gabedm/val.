import { ApiError } from "./api";
import type { ConversationProposal } from "./conversation-proposal";
import type { PriceCheckSchedule } from "../shared/price-checks";
import type { SubscriptionPortfolio } from "../shared/subscriptions";

/** A lost response is not permission to replay a confirmed write. Read back its intended effect. */
export async function recoverCommittedWrite<T>(
  write: () => Promise<T>,
  read: () => Promise<T>,
  matches: (value: T) => boolean,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 409)
      throw error;
    let current: T;
    try {
      current = await read();
    } catch {
      throw error;
    }
    if (!matches(current)) throw error;
    return current;
  }
}

export function memoryWriteMatches(
  proposal: Extract<ConversationProposal, { kind: "memory" }>,
  current: SubscriptionPortfolio,
) {
  return current.revision > proposal.revision && memoryAlreadySaved(proposal, current);
}

/** A restored proposal can be obsolete even when it was generated after the save. */
export function memoryAlreadySaved(
  proposal: Extract<ConversationProposal, { kind: "memory" }>,
  current: SubscriptionPortfolio,
) {
  const draft = proposal.draft;
  const saved = current.subscriptions.find((row) => row.serviceId === draft.serviceId);
  return (
    current.revision >= proposal.revision &&
    !!saved &&
    saved.amountMinor === draft.amountMinor &&
    saved.cycle === draft.cycle &&
    saved.purpose === draft.purpose.trim() &&
    (saved.currency ?? "GBP") === (draft.currency ?? "GBP")
  );
}

export function scheduleWriteMatches(
  proposal: Extract<ConversationProposal, { kind: "schedule" }>,
  schedules: PriceCheckSchedule[],
) {
  return proposal.draft.serviceIds.every((id) => {
    const saved = schedules.find((row) => row.serviceId === id);
    const cadence = proposal.draft.cadence;
    return (
      !!saved &&
      saved.revision > proposal.draft.expectedRevisions[id]! &&
      (cadence === null
        ? saved.cadence === null
        : saved.cadence?.every === cadence.every && saved.cadence.unit === cadence.unit)
    );
  });
}
