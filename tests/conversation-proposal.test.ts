import { expect, it } from "vitest";
import { conversationProposal, proposalMatchesPortfolio } from "../src/client/conversation-proposal";
import type { ValChatDraft } from "../src/shared/subscriptions";

const portfolio = { revision: 23, subscriptions: [] };
const draft: ValChatDraft = {
  serviceId: "outside-list",
  name: "An unfamiliar product",
  amountMinor: null,
  cycle: "month",
  purpose: "what I actually use it for",
  source: "manual",
};

it("binds memory confirmation to the original revision without filling an unknown cost", () => {
  const proposed = conversationProposal({ portfolio, draft });
  expect(proposed).toEqual({ kind: "memory", revision: 23, draft });
  expect(proposalMatchesPortfolio(proposed!, 23)).toBe(true);
  expect(proposalMatchesPortfolio(proposed!, 24)).toBe(false);
  expect(proposalMatchesPortfolio(proposed!, 22)).toBe(false);
  portfolio.revision = 24;
  expect(proposed!.revision).toBe(23);
  portfolio.revision = 23;
});

it("requires the same portfolio revision when confirming or pausing granular schedules", () => {
  const scheduleDraft = {
    serviceIds: ["outside-list"],
    cadence: null,
    expectedRevisions: { "outside-list": 0 },
  };
  expect(conversationProposal({ portfolio, draft: null, scheduleDraft })).toEqual({
    kind: "schedule",
    revision: 23,
    draft: scheduleDraft,
  });
});

it("represents no confirmation as null and rejects incompatible simultaneous confirmations", () => {
  expect(conversationProposal({ portfolio, draft: null })).toBeNull();
  expect(() =>
    conversationProposal({
      portfolio,
      draft,
      scheduleDraft: { serviceIds: ["outside-list"], cadence: null, expectedRevisions: {} },
    }),
  ).toThrow("two confirmations");
});
