import type { SubscriptionEntry, SubscriptionPortfolio } from "../shared/subscriptions";

export interface PortfolioIngestion {
  phase: "finding" | "ready" | "failed";
  subscriptions: SubscriptionEntry[];
}

/** Both summary pages follow the same received records and confirmed needs. Saved memory is never erased for a replay. */
export function portfolioSummary(
  saved: SubscriptionPortfolio,
  ingestion: PortfolioIngestion | null,
  fresh: boolean,
  confirmed: readonly string[],
) {
  const rows = ingestion && ingestion.phase !== "ready" ? ingestion.subscriptions : saved.subscriptions;
  return {
    ...saved,
    subscriptions: rows.map((row) => ({
      ...row,
      purpose: fresh && !confirmed.includes(row.serviceId) ? "" : row.purpose,
    })),
  };
}
