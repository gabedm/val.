import { expect, it } from "vitest";
import { adviceContext, recognitionBasisMatches } from "../src/server/advice-context";
import type { SubscriptionEntry } from "../src/shared/subscriptions";
it("binds new results to exact recognition context and retires older results after a correction", () => {
  const old = new Date("2026-11-08T12:00:00Z"),
    current = new Date("2026-11-09T12:00:00Z");
  expect(recognitionBasisMatches({}, undefined, old)).toBe(true);
  expect(recognitionBasisMatches({}, current, old)).toBe(false);
  expect(recognitionBasisMatches({}, old, current)).toBe(true);
  expect(recognitionBasisMatches({ recognitionUpdatedAt: current.toISOString() }, current, null)).toBe(true);
  expect(recognitionBasisMatches({ recognitionUpdatedAt: old.toISOString() }, current, null)).toBe(false);
  expect(recognitionBasisMatches({ recognitionUpdatedAt: old.toISOString() }, undefined, null)).toBe(false);
  expect(recognitionBasisMatches({ recognitionUpdatedAt: null }, undefined, null)).toBe(true);
  expect(recognitionBasisMatches({ recognitionUpdatedAt: "invalid" }, current, null)).toBe(false);
});
const services = [
  { id: "music", service: "Harbour Music", category: "audio" },
  { id: "mobile", service: "Harbour Mobile", category: "mobile" },
  { id: "other-audio", service: "Other Audio", category: "audio" },
];
const rows: SubscriptionEntry[] = services.map((s) => ({
  serviceId: s.id,
  name: s.service,
  source: "manual",
  amountMinor: 1299,
  cycle: "month",
  purpose: "My confirmed personal use",
}));
it("preserves unrelated advice while retaining related, explicit and unknown dependencies", () => {
  const original = adviceContext(rows, "music", services)!;
  expect(original.existingSubscriptions.find((r) => r.name === "Harbour Mobile")).not.toHaveProperty(
    "purpose",
  );
  const change = (index: number, purpose: string) =>
    rows.map((row, i) => (i === index ? { ...row, purpose } : row));
  expect(adviceContext(change(1, "Maps and calls"), "music", services)!.dependencyKey).toBe(
    original.dependencyKey,
  );
  expect(adviceContext(change(0, "Offline jazz"), "music", services)!.dependencyKey).not.toBe(
    original.dependencyKey,
  );
  expect(adviceContext(change(2, "Shared family plan"), "music", services)!.dependencyKey).not.toBe(
    original.dependencyKey,
  );
  expect(adviceContext(change(1, "Includes Harbour Music"), "music", services)!.dependencyKey).not.toBe(
    original.dependencyKey,
  );
  const bundled = adviceContext(change(1, "Comes with free music streaming"), "music", services)!;
  expect(bundled.existingSubscriptions.find((row) => row.name === "Harbour Mobile")?.purpose).toBe(
    "Comes with free music streaming",
  );
  expect(bundled.dependencyKey).not.toBe(original.dependencyKey);
  expect(adviceContext(change(1, "Maps and calls"), "music", services.slice(0, 1))!.dependencyKey).not.toBe(
    adviceContext(rows, "music", services.slice(0, 1))!.dependencyKey,
  );
});
it("ignores object order but invalidates ownership and billing changes", () => {
  const original = adviceContext(rows, "music", services)!.dependencyKey;
  const reordered = rows
    .map((row) => Object.fromEntries(Object.entries(row).reverse()) as unknown as SubscriptionEntry)
    .reverse();
  expect(adviceContext(reordered, "music", services)!.dependencyKey).toBe(original);
  expect(adviceContext(rows.slice(0, 2), "music", services)!.dependencyKey).not.toBe(original);
  expect(
    adviceContext(
      rows.map((row) => ({ ...row, amountMinor: 1199 })),
      "music",
      services,
    )!.dependencyKey,
  ).not.toBe(original);
});
