import type { PolicyDraft, PolicyFields } from "../shared/contracts.types";

export interface PreferenceTurn {
  question: string;
  answer: string;
}
export const openingQuestion = "What do you need your plan for?";
export const conversationLimit = 2000;

/** The existing drafting API receives every answer with its question. Never silently trim earlier needs or consent. */
export function preferencePurpose(
  turns: readonly PreferenceTurn[],
  baseline: PolicyFields | null = null,
): string {
  const context = baseline ? `Preferences to revise: ${JSON.stringify(baseline)}\n\n` : "";
  return context + turns.map((turn) => `Val asked: ${turn.question}\nMy answer: ${turn.answer}`).join("\n\n");
}

/** A model draft is a proposal, never authority. Unknown fields stay unknown until another answer. */
export function confirmedFields(draft: PolicyDraft | null, legacyPreservation = false): PolicyFields | null {
  if (
    !draft ||
    draft.unsupportedRequirements.length ||
    draft.requiredCapabilities.length !== 1 ||
    draft.requiredCapabilities[0] !== "editable_text" ||
    !draft.purpose.trim() ||
    draft.purpose.length > conversationLimit ||
    !draft.recurringCeiling ||
    draft.recurringCeiling.currency !== "GBP" ||
    !Number.isSafeInteger(draft.recurringCeiling.amountMinor) ||
    draft.recurringCeiling.amountMinor < 0 ||
    (draft.preserveHistory === true && !legacyPreservation) ||
    draft.allowInvestigation === null
  )
    return null;
  return {
    purpose: draft.purpose,
    requiredCapabilities: ["editable_text"],
    recurringCeiling: draft.recurringCeiling,
    // Compatibility with stored policies only; content transfer is not a current product preference.
    preserveHistory: legacyPreservation,
    allowInvestigation: draft.allowInvestigation,
  };
}

/** Bounded follow-ups around the live model's structured interpretation; no guessed budget or permission. */
export function preferenceQuestion(draft: PolicyDraft | null, legacyPreservation = false): string {
  if (!draft) return openingQuestion;
  if (draft.preserveHistory === true && !legacyPreservation)
    return "Val compares plans and handles approved billing changes. It can’t move or copy content between services.";
  if (
    draft.unsupportedRequirements.length ||
    draft.requiredCapabilities.some((capability) => capability === "speaker_labels")
  ) {
    return "Val can’t verify that requirement on its connected plans. You can clarify what you need; I won’t assume it’s met.";
  }
  if (!draft.requiredCapabilities.some((capability) => capability === "editable_text"))
    return "Which features matter most to you? Val needs to verify that an alternative meets your needs before recommending a change.";
  if (
    !draft.recurringCeiling ||
    draft.recurringCeiling.currency !== "GBP" ||
    !Number.isSafeInteger(draft.recurringCeiling.amountMinor) ||
    draft.recurringCeiling.amountMinor < 0
  ) {
    return "What’s your monthly budget in pounds, including the full renewal price after any offer?";
  }
  if (draft.allowInvestigation === null)
    return "May Val compare connected plans for your needs and value for money? You’ll review the costs and approve any new subscription in PayPal.";
  return "Here’s what I understood. You can save these preferences or tell me what to change.";
}
