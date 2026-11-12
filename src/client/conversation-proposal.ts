import type { ValChatDraft, ValChatReply } from "../shared/subscriptions";
import type { PriceCheckDraft } from "../shared/price-checks";

export type ConversationProposal =
  | { kind: "memory"; revision: number; draft: ValChatDraft }
  | { kind: "schedule"; revision: number; draft: PriceCheckDraft };

/** Confirmation always refers to the portfolio from which the agent proposed it. */
export function conversationProposal(
  reply: Pick<ValChatReply, "draft" | "scheduleDraft" | "portfolio">,
): ConversationProposal | null {
  if (reply.draft && reply.scheduleDraft)
    throw new Error("Val returned two confirmations together. Please try that reply again.");
  if (reply.draft) return { kind: "memory", revision: reply.portfolio.revision, draft: reply.draft };
  if (reply.scheduleDraft)
    return { kind: "schedule", revision: reply.portfolio.revision, draft: reply.scheduleDraft };
  return null;
}

export function proposalMatchesPortfolio(proposal: ConversationProposal, revision: number) {
  return proposal.revision === revision;
}
