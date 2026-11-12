# Models and spending

Gemini is the default. Set `VAL_MODEL_PROVIDER=google`, `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION=global`. Authenticate with Google Application Default Credentials. Cloud Run can use its assigned service identity. Local development can use `gcloud auth application-default login`; grant only the project/model permissions needed.

No Google API key is required. Keep any local credential file outside source control. `GOOGLE_APPLICATION_CREDENTIALS` and optional service-account impersonation are server settings.

Anthropic and OpenAI are explicit alternatives, using your own server-side keys. Selecting Google never falls back to another provider's key. Model names and cost assumptions are pinned in the adapters; changing a model requires reviewing those assumptions.

## Allowance

`AI_BUDGET_USD` is a shared application allowance, default USD5. Judge deployments also set a finite `JUDGE_DEMO_BUDGET_USD`. These are conservative estimates, not provider billing cutoffs. Set provider billing controls separately.

Each funded request reserves a bounded cost. Valid returned usage settles it; unknown outcomes keep their hold. Restarts, model changes and browser requests cannot reset the ledger. Search, URL context and backup requests can add cost.

Provider research keeps source receipts and validates extracted terms. Model extraction is not independent price verification. A missing fact stays unknown.

Google Search Suggestions display follows the selected service's terms and pricing conditions. The adapter has an omission mode for eligible configurations; review those conditions before changing the model or deployment scale.

Tests simulate services and do not spend API credit. Evaluations and real provider checks can spend credit; run them intentionally.
