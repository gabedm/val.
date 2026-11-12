# PayPal login

Login provides identity, not wallet history or purchase authority. Imports and payment approvals are separate. Credentials stay on PayPal; Val keeps a keyed identity reference and its own server session. Login state is browser-bound, single-use and time-limited.

## Live accounts

Use a fresh database, an HTTPS `APP_ORIGIN` and your own approved PayPal login app.

1. Set `PAYPAL_IDENTITY_ENVIRONMENT=live`.
2. Set `PAYPAL_LIVE_LOGIN_CLIENT_ID` and `PAYPAL_LIVE_LOGIN_CLIENT_SECRET` in private server configuration.
3. Register `<APP_ORIGIN>/api/auth/paypal/callback` as the app's return URL.
4. Leave Sandbox identity and merchant credentials unset. Do not share a database between environments.

To import real payment history, configure the separate [KERNEL wallet connection](PAYPAL_WALLET.md). Signing in alone does not grant that access.

## Sandbox testing

Use `PAYPAL_IDENTITY_ENVIRONMENT=sandbox`, `PAYPAL_LOGIN_CLIENT_ID` and `PAYPAL_LOGIN_CLIENT_SECRET` from your own Sandbox app. Register the same callback path. Loopback HTTP is allowed for local testing.

Sandbox uses test accounts and funds. Its success does not establish commercial-provider support or production permission.
