# Deployment profiles

All profiles use the same client and server.

| Profile | Access                         | Defaults                                                        |
| ------- | ------------------------------ | --------------------------------------------------------------- |
| public  | PayPal identity                | No local passwords; USD5 shared AI allowance; payment tools off |
| judge   | Invitation, then account login | Separate credentials and finite allowance; Sandbox tools only   |
| owner   | Local operator setup           | Private development configuration                               |

Use a fresh database, separate secrets and separate PayPal credentials per deployment. A populated database cannot silently change its profile or identity environment.

Copy the matching environment example to an ignored local file. Run `npm run start:public` or `npm run start:judge` after building and migrating with that same environment file.

Live identity requires HTTPS, an approved PayPal app and its separate credentials. It does not enable Sandbox payment tools.
