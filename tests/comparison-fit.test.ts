import { expect, it } from "vitest";
import { withComparisonFit } from "../src/server/comparison-fit";
import type { SubscriptionAdvice } from "../src/shared/subscriptions";
const advice: SubscriptionAdvice = {
  summary: "Two possible options.",
  options: [
    { serviceId: "supported", reason: "Meets the supplied need." },
    { serviceId: "conditional", reason: "Potential match." },
  ],
  uncertainties: [],
  comparisons: ["supported", "conditional"].map((serviceId) => ({
    serviceId,
    name: serviceId,
    plan: "Basic",
    owned: false,
    monthlyMinor: 500,
    savingMonthlyMinor: 200,
    priceMinor: 500,
    priceUnit: "month",
    savingAnnualMinor: 2400,
    annualMinor: 6000,
    checkedOn: "2026-11-01",
    sources: ["https://provider.example.com/pricing"],
  })),
};
it("carries the accepted fit and exact material condition without changing prices or original advice", () => {
  const result = withComparisonFit(advice, {
    options: [
      { serviceId: "supported", replacement: "supported", condition: null },
      {
        serviceId: "conditional",
        replacement: "conditional",
        condition: "A customer-owned prerequisite is not confirmed.",
      },
    ],
  });
  expect(result.comparisons?.[0]).toEqual({ ...advice.comparisons![0], fit: "supported" });
  expect(result.comparisons?.[1]).toEqual({
    ...advice.comparisons![1],
    fit: "conditional",
    fitCondition: "A customer-owned prerequisite is not confirmed.",
  });
  expect(advice.comparisons?.some((row) => row.fit)).toBe(false);
});
it("does not infer a fit from zero cost or trust unsupported fit metadata in a cached body", () => {
  const cached = {
    ...advice,
    comparisons: [
      {
        ...advice.comparisons![0]!,
        priceMinor: 0,
        fit: "supported" as const,
        fitCondition: "Outdated qualification",
      },
    ],
  };
  const result = withComparisonFit(cached, {});
  expect(result.comparisons![0]!.priceMinor).toBe(0);
  expect(result.comparisons![0]!.fit).toBeUndefined();
  expect(result.comparisons![0]!.fitCondition).toBeUndefined();
});
it.each(["missing-condition", "complement", "duplicate"])(
  "does not expose a guessed fit for an unusable accepted-decision record (%s)",
  (failure) => {
    const option = {
      serviceId: "conditional",
      replacement: failure === "complement" ? "complement" : "conditional",
      condition: failure === "missing-condition" ? null : "An unresolved detail.",
    };
    const result = withComparisonFit(advice, {
      options:
        failure === "duplicate"
          ? [option, { ...option, replacement: "supported", condition: null }]
          : [option],
    });
    expect(result.comparisons!.find((row) => row.serviceId === "conditional")?.fit).toBeUndefined();
  },
);
