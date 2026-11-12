import type {
  SavedSubscriptionReview,
  SubscriptionAdvice,
  SubscriptionEntry,
  SubscriptionPortfolio,
} from "../shared/subscriptions";
import { subscriptionReadiness } from "../shared/subscription-workflow";
import { comparisonOutcome } from "../shared/subscription-insights";

/** Completed checks remain useful even when no suitable replacement was established. */
export function restoreReviewFindings(
  portfolio: SubscriptionPortfolio,
  reviews: ReadonlyMap<string, SavedSubscriptionReview>,
) {
  return portfolio.subscriptions.flatMap((row) => {
    const result = reviews.get(row.serviceId);
    return result
      ? [
          {
            row,
            advice: result.advice,
            historicalCheckedAt: result.historical ? result.checkedAt : undefined,
          },
        ]
      : [];
  });
}

export function setupComplete(portfolio: SubscriptionPortfolio, revisitServiceIds: readonly string[] = []) {
  return subscriptionReadiness(portfolio, revisitServiceIds).phase === "ready";
}

export function hasSavings(advice: SubscriptionAdvice) {
  return advice.options.some((option) =>
    advice.comparisons?.some(
      (value) => value.serviceId === option.serviceId && (value.savingAnnualMinor ?? 0) > 0,
    ),
  );
}

/** Native-currency options can be useful even while their GBP saving is unknown. */
export function hasAlternatives(advice: SubscriptionAdvice) {
  return advice.options.some((option) =>
    advice.comparisons?.some((comparison) => comparison.serviceId === option.serviceId),
  );
}

/** Process completion does not mean that the checked provider evidence was complete. */
export function reviewCompletionMessage(
  results: readonly SubscriptionAdvice[],
  historical = false,
  retry = false,
) {
  const alternatives = results.some(hasAlternatives);
  const incomplete = results.some(
    (advice) => comparisonOutcome(advice) === "incomplete" || !!advice.discovery?.coverage?.incomplete.length,
  );
  if (incomplete)
    return historical
      ? "Some previous checks were incomplete. I haven’t run a new search; you can ask me to check again."
      : alternatives
        ? "Some provider checks are incomplete. These options come from the checks that finished."
        : "Some checks are incomplete. I haven’t established whether there’s a suitable cheaper match yet.";
  if (!alternatives)
    return historical
      ? "Your previous checks didn’t establish a saving. I haven’t run a new search; you can ask me to check again."
      : "I’ve checked these offers and haven’t established a suitable cheaper match.";
  return retry ? "Those checks are complete." : null;
}

type ConversationTurn = {
  from: "you" | "val";
  text: string;
  context?: "confirmation";
};

/** Keep customer answers with their question context; UI acknowledgements are already in saved memory. */
export function conversationHistory(history: ConversationTurn[], limit = 10) {
  const turns = history.filter((turn) => turn.context !== "confirmation");
  const selected = new Set<number>();
  for (let index = Math.max(0, turns.length - Math.min(4, limit)); index < turns.length; index++)
    selected.add(index);
  for (let index = turns.length - 1; index >= 0; index--) {
    if (turns[index]!.from !== "you") continue;
    const pair = [index];
    if (index > 0 && turns[index - 1]!.from === "val") pair.unshift(index - 1);
    const missing = pair.filter((item) => !selected.has(item));
    if (selected.size + missing.length <= limit) missing.forEach((item) => selected.add(item));
  }
  for (let index = turns.length - 1; index >= 0 && selected.size < limit; index--) selected.add(index);
  return [...selected]
    .sort((a, b) => a - b)
    .map((index) => ({ from: turns[index]!.from, text: turns[index]!.text }));
}

/** A reply can answer a question on a comparison card, not just the last blue chat bubble. */
export function historyWithReviewQuestions(
  history: ConversationTurn[],
  findings: { row: Pick<SubscriptionEntry, "name">; advice: SubscriptionAdvice }[],
) {
  const lines = findings.flatMap(({ row, advice }) =>
    advice.uncertainties.map((question) => `For ${row.name}: ${question}`),
  );
  const shown: string[] = [];
  for (const line of lines.reverse()) {
    if ([line, ...shown].join("\n").length > 1000) break;
    shown.unshift(line);
  }
  return shown.length
    ? [...conversationHistory(history, 9), { from: "val" as const, text: shown.join("\n") }]
    : conversationHistory(history);
}
