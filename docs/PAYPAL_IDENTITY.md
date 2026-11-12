# PayPal login

Configure a PayPal Sandbox login app with `PAYPAL_LOGIN_CLIENT_ID` and `PAYPAL_LOGIN_CLIENT_SECRET`. Register `<APP_ORIGIN>/api/auth/paypal/callback` as the return URL.

Login state is browser-bound, single-use and time-limited. Credentials stay on PayPal. Val keeps a keyed identity reference and its own server session.

Login provides identity, not wallet history or purchase authority. Imports and payment approvals are separate.

Live identity needs `PAYPAL_IDENTITY_ENVIRONMENT=live`, separate `PAYPAL_LIVE_LOGIN_*` credentials, HTTPS, an approved app and a fresh database. Do not mix live identity with Sandbox credentials.
