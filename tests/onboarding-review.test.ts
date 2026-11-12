import { expect, it } from "vitest";
import {
  hasSavings,
  hasAlternatives,
  conversationHistory,
  historyWithReviewQuestions,
  restoreReviewFindings,
  setupComplete,
  reviewCompletionMessage,
} from "../src/client/onboarding-review";
import type {
  SubscriptionAdvice,
  SubscriptionEntry,
  SubscriptionPortfolio,
} from "../src/shared/subscriptions";

it("does not describe incomplete provider research as an established absence of savings", () => {
  const incomplete = { summary: "Unfinished", options: [], uncertainties: [] } as SubscriptionAdvice;
  const message = reviewCompletionMessage([incomplete]);
  expect(message).toContain("checks are incomplete");
  expect(message).not.toContain("finished checking");
  expect(message).not.toContain("isn’t a saving");
  expect(reviewCompletionMessage([incomplete], true)).toContain("haven’t run a new search");
});

it("distinguishes a completed no-match check from incomplete coverage", () => {
  const complete = {
    summary: "No suitable offer established",
    options: [],
    uncertainties: [],
    discovery: { status: "live", providerOnly: true, coverage: { incomplete: [] } },
  } as unknown as SubscriptionAdvice;
  expect(reviewCompletionMessage([complete])).toContain("checked these offers");
  expect(reviewCompletionMessage([complete])).not.toContain("incomplete");
  const partial = {
    ...complete,
    discovery: {
      ...complete.discovery!,
      coverage: { checked: [], discovered: [], incomplete: ["provider.test"] },
    },
  };
  expect(reviewCompletionMessage([complete, partial])).toContain("checks are incomplete");
});

it("keeps an admitted alternative while acknowledging incomplete sibling provider checks", () => {
  const advice = {
    summary: "A supported offer",
    options: [{ serviceId: "provider:external", reason: "Fits the confirmed needs" }],
    comparisons: [{ serviceId: "provider:external", savingAnnualMinor: 1200 }],
    uncertainties: [],
    discovery: { status: "live", providerOnly: true, coverage: { incomplete: ["unread-provider.test"] } },
  } as unknown as SubscriptionAdvice;
  expect(reviewCompletionMessage([advice])).toContain("These options come from the checks that finished");
  const complete = {
    ...advice,
    discovery: { ...advice.discovery!, coverage: { checked: [], discovered: [], incomplete: [] } },
  };
  expect(reviewCompletionMessage([complete])).toBeNull();
  expect(reviewCompletionMessage([complete], false, true)).toBe("Those checks are complete.");
});

it("retains a combined customer answer while later confirmation controls accumulate", () => {
  const history: Parameters<typeof conversationHistory>[0] = [
    { from: "val", text: "What matters to you about these subscriptions?" },
    { from: "you", text: "A different use for each of my twelve subscriptions, all described here." },
  ];
  for (let index = 0; index < 11; index++) {
    history.push(
      { from: "val", text: `Does this capture subscription ${index}?` },
      { from: "you", text: `Remember this for ${index}.`, context: "confirmation" },
      { from: "val", text: `I’ll remember that for ${index}.`, context: "confirmation" },
    );
  }
  const context = conversationHistory(history);
  expect(context).toHaveLength(10);
  expect(context.slice(0, 2)).toEqual(history.slice(0, 2));
  expect(context.at(-1)?.text).toBe("Does this capture subscription 10?");
  expect(context.some((turn) => turn.text.startsWith("Remember this"))).toBe(false);
  expect(context.every((turn) => Object.keys(turn).sort().join() === "from,text")).toBe(true);
});

it("preserves actual typed confirmation words and recent corrections in their original order", () => {
  const history: Parameters<typeof conversationHistory>[0] = [
    { from: "val", text: "How do you use it?" },
    { from: "you", text: "Remember this: offline is essential." },
    ...Array.from({ length: 12 }, (_, index) => ({ from: "val" as const, text: `Follow-up ${index}` })),
    { from: "you", text: "Actually I never use it offline now. The rest still matters." },
  ];
  const context = conversationHistory(history);
  expect(context).toHaveLength(10);
  expect(context.slice(0, 2)).toEqual(history.slice(0, 2));
  expect(context.at(-1)).toEqual(history.at(-1));
  expect(conversationHistory(history, 9)).toHaveLength(9);
});

const row = (
  serviceId: string,
  purpose = "My saved needs",
  amountMinor: number | null = 1800,
): SubscriptionEntry => ({
  serviceId,
  name: serviceId,
  purpose,
  amountMinor,
  cycle: "month",
  source: "manual",
});
const portfolio = (rows: SubscriptionEntry[]): SubscriptionPortfolio => ({
  revision: 7,
  subscriptions: rows,
});
const stay: SubscriptionAdvice = { summary: "Stay for now", options: [], uncertainties: [] };
it("restores a completed no-match explanation after reload without treating it as a saving", () => {
  const noMatch = {
    summary: "The checked plans did not support the offline workflow you need.",
    options: [],
    uncertainties: ["Provider prices were checked; no compatible replacement was established."],
  };
  const checkedAt = "2026-11-01T12:00:00.000Z";
  const results = restoreReviewFindings(
    portfolio([row("unfamiliar-software"), row("not-checked")]),
    new Map([
      [
        "unfamiliar-software",
        { serviceId: "unfamiliar-software", advice: noMatch, checkedAt, historical: true },
      ],
      ["removed-service", { serviceId: "removed-service", advice: stay, checkedAt, historical: false }],
    ]),
  );
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    row: { serviceId: "unfamiliar-software" },
    advice: noMatch,
    historicalCheckedAt: checkedAt,
  });
  expect(hasAlternatives(results[0]!.advice)).toBe(false);
  expect(hasSavings(results[0]!.advice)).toBe(false);
});

it("waits for fresh purpose confirmations even when every subscription has an older saved purpose", () => {
  const saved = portfolio([row("netflix", "An old viewing purpose"), row("three", "An old data purpose")]);
  expect(setupComplete(saved)).toBe(true);
  expect(setupComplete(saved, ["netflix", "three"])).toBe(false);
  expect(setupComplete(saved, ["three"])).toBe(false);
  expect(setupComplete(saved, [])).toBe(true);
  expect(saved.subscriptions.map((entry) => entry.purpose)).toEqual([
    "An old viewing purpose",
    "An old data purpose",
  ]);
});

it("sends displayed comparison questions as conversation context so a short answer has its subscription and scope", () => {
  const history = Array.from({ length: 12 }, (_, index) => ({
    from: "val" as const,
    text: `Earlier turn ${index}`,
  }));
  const question =
    "How much data does TikTok itself use? YouTube is included; your other usage is under 10GB.";
  const combined = historyWithReviewQuestions(history, [
    { row: { name: "Three" }, advice: { ...stay, uncertainties: [question] } },
  ]);
  expect(combined).toHaveLength(10);
  expect(combined.at(-1)).toEqual({ from: "val", text: `For Three: ${question}` });
  expect(historyWithReviewQuestions(history, [])).toEqual(history.slice(-10));
  const many = Array.from({ length: 50 }, (_, index) => ({
    row: { name: `Service ${index}` },
    advice: { ...stay, uncertainties: ["A useful personal question?".repeat(5)] },
  }));
  expect(historyWithReviewQuestions(history, many).at(-1)!.text.length).toBeLessThanOrEqual(1000);
  expect(historyWithReviewQuestions(history, many).at(-1)!.text).toContain("Service 49");
});

it("only claims savings from matching positive comparisons, without forcing either demo brand", () => {
  expect(hasSavings(stay)).toBe(false);
  const advice = { ...stay, options: [{ serviceId: "provider:unknown", reason: "Could fit" }] };
  expect(hasSavings(advice)).toBe(false);
  const value = { serviceId: "provider:unknown", savingAnnualMinor: 8600 } as NonNullable<
    SubscriptionAdvice["comparisons"]
  >[number];
  expect(hasSavings({ ...advice, comparisons: [value] })).toBe(true);
  expect(hasSavings({ ...advice, comparisons: [{ ...value, savingAnnualMinor: 0 }] })).toBe(false);
});
it("keeps researched native-currency alternatives visible without claiming a converted saving", () => {
  const advice = {
    ...stay,
    options: [
      {
        serviceId: "provider:outside-catalogue",
        reason: "Fits the saved workflow; conversion is unresolved.",
      },
    ],
    comparisons: [
      {
        serviceId: "provider:outside-catalogue",
        currency: "EUR",
        savingAnnualMinor: null,
        savingMonthlyMinor: null,
      },
    ] as SubscriptionAdvice["comparisons"],
  };
  expect(hasAlternatives(advice)).toBe(true);
  expect(hasSavings(advice)).toBe(false);
  expect(hasAlternatives({ ...advice, comparisons: [] })).toBe(false);
  expect(
    hasAlternatives({ ...advice, options: [{ serviceId: "unmatched", reason: "No priced comparison" }] }),
  ).toBe(false);
  expect(hasAlternatives(stay)).toBe(false);
});
