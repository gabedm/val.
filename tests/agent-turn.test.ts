import { expect, it } from "vitest";
import { agentTurnState } from "../src/server/agent-turn";

const base = {
  read: true,
  opening: false,
  connectionChecked: false,
  unresolvedProducts: false,
  lookupReturned: false,
};

it("progresses from a portfolio read through connection checking into an opening reply", () => {
  expect(agentTurnState({ ...base, read: false, opening: true }).phase).toBe("read_portfolio");
  expect(agentTurnState({ ...base, opening: true })).toEqual({
    phase: "check_connection",
    toolChoice: "required",
    tools: ["check_paypal"],
  });
  expect(agentTurnState({ ...base, opening: true, connectionChecked: true })).toEqual({
    phase: "reply",
    toolChoice: "none",
    tools: [],
  });
});

it("offers product context tools without forcing the model to discuss an unfamiliar payment", () => {
  const state = agentTurnState({ ...base, unresolvedProducts: true });
  expect(state.phase).toBe("conversation");
  expect(state.toolChoice).toBe("auto");
  expect(state.tools).toContain("identify_subscription");
  expect(state.tools).toContain("describe_subscription");
});

it("allows a customer-description repair after an unresolved lookup and a format correction", () => {
  const unresolved = agentTurnState({ ...base, lookupReturned: true, unresolvedProducts: true });
  expect(unresolved.phase).toBe("conversation");
  expect(unresolved.tools).toContain("describe_subscription");
  expect(agentTurnState({ ...base, lookupReturned: true, unresolvedProducts: false })).toEqual({
    phase: "reply",
    toolChoice: "none",
    tools: [],
  });
});

it("enforces protocol invariants across all combinations without granting action authority", () => {
  for (let bits = 0; bits < 32; bits++) {
    const input = {
      read: !!(bits & 1),
      opening: !!(bits & 2),
      connectionChecked: !!(bits & 4),
      unresolvedProducts: !!(bits & 8),
      lookupReturned: !!(bits & 16),
    };
    const state = agentTurnState(input);
    expect(
      state.tools.every((name) =>
        [
          "read_subscriptions",
          "check_paypal",
          "search_subscriptions",
          "identify_subscription",
          "describe_subscription",
        ].includes(name),
      ),
    ).toBe(true);
    if (!input.read) expect(state.phase).toBe("read_portfolio");
    else if (input.opening && !input.connectionChecked) expect(state.phase).toBe("check_connection");
    else if (input.opening || (input.lookupReturned && !input.unresolvedProducts))
      expect(state.phase).toBe("reply");
    else expect(state.phase).toBe("conversation");
    expect(state.toolChoice === "none").toBe(state.tools.length === 0);
    if (state.phase === "conversation" && input.connectionChecked)
      expect(state.tools).not.toContain("check_paypal");
  }
});
