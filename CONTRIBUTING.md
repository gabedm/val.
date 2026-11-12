# Contributing

Keep changes focused. Preserve saved needs, ownership checks, approvals and uncertain payment outcomes.

## Before a pull request

`npm ci`

`npm run typecheck`

`npm test`

`npm run build`

`npm run format:check`

`npm run security:scan`

`git diff --check`

Run `npm audit` after dependency changes. Keep credentials and generated reports out of Git.

Tests create a temporary PostgreSQL cluster and simulate external services. If you supply `TEST_DATABASE_URL`, use a separate disposable cluster named `val_test` or `val_test_<suffix>` and set `VAL_TEST_DATABASE_DISPOSABLE=true`. Never use an application database.

Shared schemas live in `src/shared`; `npm run contracts` regenerates the types. Keep migrations additive.

Use synthetic accounts and conversations in tests. Leave real credentials, customer data and session links out. Keep comments short and explain the reason for a decision.

Paid evaluations use a separate `val_evals` database. Run them, resource setup and deployment only when intended.
