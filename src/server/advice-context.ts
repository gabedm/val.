import { createHash } from "node:crypto";
import {
  isCurrentSubscription,
  subscriptionCatalogueId,
  subscriptionPaymentEvidence,
  type SubscriptionEntry,
} from "../shared/subscriptions";

type Service = { id: string; service: string; category?: string };

/** New records bind exact product context; older records remain usable only before a later correction. */
export function recognitionBasisMatches(
  result: { recognitionUpdatedAt?: unknown },
  updatedAt: Date | undefined,
  legacyDate: Date | null,
) {
  if (Object.hasOwn(result, "recognitionUpdatedAt"))
    return result.recognitionUpdatedAt === (updatedAt?.toISOString() ?? null);
  return !updatedAt || (!!legacyDate && updatedAt.getTime() <= legacyDate.getTime());
}
const key = (text: string) =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
// Bundle and prerequisite notes can link categories without naming the other product.
const crossProductNeed = (text: string) =>
  /\b(bundle[ds]?|includes?|included|comes? with|perks?|benefits?|requires?|depends? on|subscription|membership|account)\b/i.test(
    text,
  );

/** Keep ownership visible; unrelated personal notes are not evidence about the selected product. */
export function adviceContext(rows: SubscriptionEntry[], serviceId: string, services: Service[]) {
  const current = rows.filter(isCurrentSubscription);
  const selected = current.find((row) => row.serviceId === serviceId);
  if (!selected) return null;
  const category = (row: SubscriptionEntry) =>
    services.find((service) => service.id === subscriptionCatalogueId(row, services))?.category;
  const related = (row: SubscriptionEntry) =>
    !category(selected) ||
    !category(row) ||
    category(row) === category(selected) ||
    crossProductNeed(selected.purpose) ||
    crossProductNeed(row.purpose) ||
    (key(row.name).length >= 3 && key(selected.purpose).includes(key(row.name))) ||
    (key(selected.name).length >= 3 && key(row.purpose).includes(key(selected.name)));
  const others = current
    .filter((row) => row.serviceId !== serviceId)
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId));
  const existingSubscriptions = others.map((row) => ({
    name: row.name,
    ...(related(row) ? { purpose: row.purpose } : {}),
    paymentEvidence: subscriptionPaymentEvidence(row),
  }));
  const evidence = (row: SubscriptionEntry) =>
    row.paypalEvidence
      ? {
          key: row.paypalEvidence.key,
          merchant: row.paypalEvidence.merchant,
          paymentCount: row.paypalEvidence.paymentCount,
          lastPaidOn: row.paypalEvidence.lastPaidOn,
          agreementStatus: row.paypalEvidence.agreementStatus,
          cycleBasis: row.paypalEvidence.cycleBasis ?? "payment_history",
          excludedByOwner: !!row.paypalEvidence.excludedByOwner,
          recurrenceStale: !!row.paypalEvidence.recurrenceStale,
        }
      : null;
  const product = (row: SubscriptionEntry) =>
    row.paypalProduct ? { name: row.paypalProduct.name, planName: row.paypalProduct.planName } : null;
  const dependencyKey = createHash("sha256")
    .update(
      JSON.stringify({
        selected: {
          serviceId: selected.serviceId,
          name: selected.name,
          amountMinor: selected.amountMinor,
          cycle: selected.cycle,
          purpose: selected.purpose,
          source: selected.source,
          currency: selected.currency,
          productServiceId: selected.productServiceId,
          paypalProduct: product(selected),
          paypalEvidence: evidence(selected),
          paypalBilling: selected.paypalBilling
            ? { amountMinor: selected.paypalBilling.amountMinor, cycle: selected.paypalBilling.cycle }
            : undefined,
        },
        others: others.map((row) => ({
          serviceId: row.serviceId,
          name: row.name,
          productServiceId: row.productServiceId,
          paypalProduct: product(row),
          amountMinor: row.amountMinor,
          cycle: row.cycle,
          currency: row.currency,
          purpose: related(row) ? row.purpose : undefined,
          evidence: evidence(row),
        })),
      }),
    )
    .digest("hex");
  return { dependencyKey, existingSubscriptions };
}
