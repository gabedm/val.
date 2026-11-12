export const agentTurnVersion = "agent-turn.3";
type LookupTool = "identify_subscription" | "describe_subscription";
type TurnTool = "read_subscriptions" | "check_paypal" | "search_subscriptions" | LookupTool;
export type AgentTurnState =
  | { phase: "read_portfolio"; toolChoice: "required"; tools: TurnTool[] }
  | { phase: "check_connection"; toolChoice: "required"; tools: TurnTool[] }
  | { phase: "reply"; toolChoice: "none"; tools: TurnTool[] }
  | { phase: "conversation"; toolChoice: "auto"; tools: TurnTool[] };

/** A read-only turn protocol. It grants no ownership, saving, scheduling or payment authority. */
export function agentTurnState(input: {
  read: boolean;
  opening: boolean;
  connectionChecked: boolean;
  unresolvedProducts: boolean;
  lookupReturned: boolean;
}): AgentTurnState {
  if (!input.read) return { phase: "read_portfolio", toolChoice: "required", tools: ["read_subscriptions"] };
  if (input.opening && !input.connectionChecked)
    return { phase: "check_connection", toolChoice: "required", tools: ["check_paypal"] };
  if (input.opening || (input.lookupReturned && !input.unresolvedProducts))
    return { phase: "reply", toolChoice: "none", tools: [] };
  return {
    phase: "conversation",
    toolChoice: "auto",
    tools: [
      ...(!input.connectionChecked ? (["check_paypal"] as const) : []),
      "search_subscriptions",
      "identify_subscription",
      ...(input.unresolvedProducts ? (["describe_subscription"] as const) : []),
    ],
  };
}
