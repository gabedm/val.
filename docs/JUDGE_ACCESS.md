# Sandbox test setup

The public release does not include a hosted invitation, buyer password, merchant credentials or test agreement IDs.

For a separate judge installation, use `VAL_BUILD_PROFILE=judge`, a fresh database and your own `.env.judge.local`. Set distinct reviewer, administrator and invitation credentials. Generate hashes with `npm run hash-password`; keep inputs and hashes private.

To share your own merchant-owned Sandbox agreements, set `PAYPAL_SANDBOX_SUBSCRIPTIONS_JSON` privately. Bind each record to the intended merchant, agreement, plan, custom ID, service ID and name. PayPal supplies the actual active status and bill. Do not put prices or needs in that configuration.

`VAL_PAYPAL_SANDBOX_DEMO_ENTRY=true` gives each visitor a separate Val session using those shared test agreements. It does not log into a real buyer's wallet.

Keep a finite shared `JUDGE_DEMO_BUDGET_USD`. A private URL is a bearer capability, not a substitute for server ownership and spending checks. Never commit the link or its token.

See [profiles](BUILD_PROFILES.md), [wallet import](PAYPAL_WALLET.md) and [switch example](SWITCHING_EXAMPLE.md).
