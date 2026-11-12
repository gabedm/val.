export const researchLimits = {
  overallMs: 120_000,
  googleOverallMs: 180_000,
  providerMs: 45_000,
  googleProviderMs: 80_000,
  adviceMs: 120_000,
} as const;

// A claim must outlive research, advice and their database commits.
export const comparisonLeaseMs =
  Math.max(researchLimits.overallMs, researchLimits.googleOverallMs) + researchLimits.adviceMs + 120_000;
