# Security

Report vulnerabilities privately to the maintainers. Include a synthetic reproduction and the affected version. Never post keys, session links or customer records in an issue.

## What stays on the server

Provider keys, database credentials, session secrets and KERNEL capabilities. Sessions use hashed tokens, owner binding, expiry and secure cookies on HTTPS. Writes require CSRF and origin checks. Model output cannot grant approval or change spending limits.

Public installations use their own credentials and a finite shared AI allowance. Wallet imports and switching are opt-in. Browser automation has broader account access than a reporting API; restrict its KERNEL project and keep viewer links private.

Switching requires approval of exact terms. The replacement must be verified active before cancellation. Unknown outcomes stay unresolved and block duplicate financial actions.

## Run it safely

Use HTTPS, a private database and a dedicated model identity. Set proxy trust only for verified ingress networks. Keep application spending controls and provider billing controls enabled. Application estimates are not a billing guarantee.

Keep secrets in ignored environment files or a secret manager. Never prefix a secret with `VITE_`. The client build rejects sensitive browser configuration. Static routes block private files and raw source.

Logging out ends the Val session. Disconnecting PayPal removes the retained remote browser profile; these are different actions.

## Rotate keys carefully

For existing installations, pin `DATA_SECRET` to the original `SESSION_SECRET` before changing the session secret. New installations should generate separate values. Rotating `SESSION_SECRET` expires sessions; changing `DATA_SECRET` can break durable account lookup.

Keep old `WALLET_ENCRYPTION_KEYS` until all wallet and switching envelopes have been rewritten or disconnected. `WALLET_ENCRYPTION_KEY_ID` selects the key for new writes. Losing a key can prevent both access and remote cleanup. An unresolved payment must remain unresolved after rotation.

## Release checks

Run the source, build and history scans. Exclude environment files, databases, raw conversations, logs, private reports and session URLs. This release starts from a clean export rather than the development Git history.

The scanner checks known local secret values and selected token patterns. Tests cover security boundaries with synthetic data. Neither proves complete security; review deployment configuration and dependencies too.
