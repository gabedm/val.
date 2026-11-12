import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PolicyDraft } from "../src/shared/contracts.types";
import {
  confirmedFields,
  conversationLimit,
  openingQuestion,
  preferencePurpose,
  preferenceQuestion,
} from "../src/client/preferencesChat";
import { Preferences } from "../src/client/Preferences";
import { SignIn } from "../src/client/SessionPanel";
import type { CaseSnapshot } from "../src/shared/contracts.types";

const complete: PolicyDraft = {
  purpose: "Editable notes, £15 monthly including renewal; you may test plans.",
  requiredCapabilities: ["editable_text"],
  recurringCeiling: { currency: "GBP", amountMinor: 1500 },
  preserveHistory: null,
  allowInvestigation: true,
  unsupportedRequirements: [],
  interpretationNotes: [],
};

describe("conversational preference confirmation", () => {
  it("asks for missing budget and permission without asking about content transfers", () => {
    expect(preferenceQuestion(null)).toBe(openingQuestion);
    for (const field of ["recurringCeiling", "allowInvestigation"] as const) {
      const draft = { ...complete, [field]: null };
      expect(confirmedFields(draft)).toBeNull();
      expect(preferenceQuestion(draft)).toMatch(
        field === "recurringCeiling" ? /full renewal/ : /approve any new subscription in PayPal/,
      );
    }
    expect(confirmedFields(complete)?.preserveHistory).toBe(false);
    expect(preferenceQuestion(complete)).not.toMatch(/preserve|copies|saved work/);
  });
  it("declines new transfer requests without waiving previously recorded obligations", () => {
    const request = { ...complete, preserveHistory: true };
    expect(confirmedFields(request)).toBeNull();
    expect(preferenceQuestion(request)).toMatch(/can’t move or copy content/);
    expect(confirmedFields(complete, true)?.preserveHistory).toBe(true);
  });
  it("accepts an explicit refusal and zero budget without treating them as unanswered", () => {
    expect(
      confirmedFields({
        ...complete,
        recurringCeiling: { currency: "GBP", amountMinor: 0 },
        preserveHistory: false,
        allowInvestigation: false,
      }),
    ).toMatchObject({
      recurringCeiling: { amountMinor: 0 },
      preserveHistory: false,
      allowInvestigation: false,
    });
  });
  it("keeps unsupported or legacy needs out of the confirmation path", () => {
    expect(confirmedFields({ ...complete, unsupportedRequirements: ["Translation"] })).toBeNull();
    expect(
      confirmedFields({ ...complete, requiredCapabilities: ["editable_text", "speaker_labels"] }),
    ).toBeNull();
    expect(confirmedFields({ ...complete, requiredCapabilities: [] })).toBeNull();
    expect(preferenceQuestion({ ...complete, unsupportedRequirements: ["Translation"] })).toMatch(
      /won’t assume it’s met/,
    );
  });
  it("asks about genuine needs without steering an undecided person into a text-editing use case", () => {
    const draft: PolicyDraft = { ...complete, requiredCapabilities: [] };
    expect(preferenceQuestion(draft)).toMatch(/Which features matter most/);
    expect(preferenceQuestion(draft)).not.toMatch(/text|edit|record|transcript|saved work/);
    expect(confirmedFields(draft)).toBeNull();
  });
  it("distinguishes comparison permission from PayPal payment approval", () => {
    const question = preferenceQuestion({ ...complete, allowInvestigation: null });
    expect(question).toContain("value for money");
    expect(question).toContain("PayPal");
    expect(confirmedFields({ ...complete, allowInvestigation: null })).toBeNull();
    const html = renderToStaticMarkup(createElement(SignIn, { onSession: () => {} }));
    expect(html).toContain("Continue with PayPal");
    expect(html).not.toContain("You approve any new subscription in PayPal");
    expect(html).not.toMatch(/watches your subscriptions|preserv|walkthrough/i);
  });
  it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "refuses an invalid interpreted amount %s",
    (amountMinor) => {
      expect(confirmedFields({ ...complete, recurringCeiling: { currency: "GBP", amountMinor } })).toBeNull();
    },
  );
  it("preserves the exact conversation, context and short-answer question for the server guard", () => {
    const turns = [
      { question: openingQuestion, answer: "I need editable notes and translation." },
      { question: "Monthly limit?", answer: "£15" },
    ];
    const purpose = preferencePurpose(turns);
    expect(purpose).toContain("I need editable notes and translation.");
    expect(purpose).toContain("Monthly limit?\nMy answer: £15");
    expect(confirmedFields({ ...complete, purpose })?.purpose).toBe(purpose);
    expect(preferencePurpose(turns, confirmedFields(complete)!)).toContain('"allowInvestigation":true');
    expect(
      preferencePurpose([...turns, { question: "Anything else?", answer: "x".repeat(conversationLimit) }])
        .length,
    ).toBeGreaterThan(conversationLimit);
    expect(confirmedFields({ ...complete, purpose: "x".repeat(conversationLimit + 1) })).toBeNull();
  });
  it("starts with a conversation and no selectable or default financial authority", () => {
    const snapshot = {
      case: { id: "local-test", state: "MONITORING" },
      policy: null,
      receipt: { oldBilling: "ACTIVE" },
    } as CaseSnapshot;
    const html = renderToStaticMarkup(
      createElement(Preferences, { snapshot, proposal: null, refresh: async () => {}, onDone: () => {} }),
    );
    expect(html).toContain(openingQuestion);
    expect(html).toContain("Send reply");
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("Confirm and save preferences");
    expect(html).not.toMatch(/speaker|transcript|walkthrough|demo controls/i);
  });
});
