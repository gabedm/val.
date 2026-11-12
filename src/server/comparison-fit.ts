import type { SubscriptionAdvice } from "../shared/subscriptions";

/** Preserve the accepted decision in new and cached responses; never infer fit from prose or price. */
export function withComparisonFit(advice: SubscriptionAdvice, output: unknown): SubscriptionAdvice {
  const options =
    output && typeof output === "object" && !Array.isArray(output)
      ? (output as { options?: unknown }).options
      : undefined;
  const choices = Array.isArray(options) && options.length <= 3 ? options : [];
  const duplicates = new Set(
    choices
      .filter((row, index) => choices.findIndex((other) => other?.serviceId === row?.serviceId) !== index)
      .map((row) => row?.serviceId),
  );
  return {
    ...advice,
    comparisons: advice.comparisons?.map((row) => {
      const comparison = { ...row };
      delete comparison.fit;
      delete comparison.fitCondition;
      if (duplicates.has(row.serviceId)) return comparison;
      const choice = choices.find((choice) => choice && choice.serviceId === row.serviceId);
      if (choice?.replacement === "supported" && choice.condition === null) comparison.fit = "supported";
      else if (
        choice?.replacement === "conditional" &&
        typeof choice.condition === "string" &&
        choice.condition.trim() &&
        choice.condition.length <= 250
      ) {
        comparison.fit = "conditional";
        comparison.fitCondition = choice.condition;
      }
      return comparison;
    }),
  };
}
