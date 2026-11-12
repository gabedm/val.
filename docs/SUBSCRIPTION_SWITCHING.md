# Switching

Switching uses the shared KERNEL browser agent, not provider-specific success scripts. It is disabled by default.

1. Read the new checkout and old cancellation terms.
2. Show the exact charge, renewal, fees and effective dates for approval.
3. Submit the approved purchase once.
4. Verify the replacement is active and matches the approved terms.
5. Cancel the old renewal, then verify cancellation.

Approval is bound to the offer, saved needs and observed provider pages. Changed or expired terms require new approval. A stopped or timed-out action remains unresolved until checked; it never grants permission to submit again.

## Configuration

Set `VAL_KERNEL_SWITCHING=true` and a server-only `KERNEL_SWITCH_API_KEY`. Sandbox execution needs `VAL_SWITCH_ENVIRONMENT=sandbox` and explicit `VAL_SWITCH_TEST_ORIGINS` for isolated providers you control.

`VAL_SWITCH_PREPARATION_ONLY=true` permits terms inspection and a provider handoff while blocking purchases and cancellations. Live execution also needs `VAL_SWITCH_LIVE=true` and live identity. These are enablement gates, not proof of provider support or permission.

## Boundaries

The model receives redacted page text and opaque control references. It cannot choose scripts, credentials or browser IDs. Users handle provider login and any required payment verification.

The supported contract covers explicit steady monthly, yearly and 30-day charges in GBP, USD and EUR. Unclear fees, trials, changing prices and unknown activation require review. Website or authentication changes may require a handoff.

State and browser capabilities are encrypted. The replacement keeps confirmed needs and monitoring cadence. Both bills remain visible until cancellation is verified. Keep old encryption keys and unresolved financial records through rotation.

The engine lives in `src/server/subscription-switch.ts`, browser controls in `switch-runtime.ts` and model decisions in `switch-agent.ts`. The controlled provider in `tests/fixtures/switch-provider.mjs` is a test fixture, not a commercial integration.
