# Val

Val finds better-value subscriptions around what you actually use. Tell it what matters, compare the options and let it keep checking on your schedule.

Built with PayPal Sandbox, Gemini and KERNEL. One React client, one Node server and PostgreSQL. The repository includes the onboarding, research, monitoring and switching code. You bring your own accounts and credentials.

## Run it

You need Node.js 22+, npm and a fresh PostgreSQL database.

1. Run `npm ci`.
2. Copy `.env.example` to `.env`. Set `DATABASE_URL`, `APP_ORIGIN=http://127.0.0.1:3000`, `PORT=3000`, `SESSION_SECRET` and `DATA_SECRET`.
3. Generate each secret separately with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.
4. Configure your Google Cloud project and Application Default Credentials for Gemini. Set `VAL_MODEL_PROVIDER=google` and `GOOGLE_CLOUD_PROJECT`. See [model setup](docs/MODEL_COSTS.md).
5. Add your PayPal Sandbox login app's client ID and secret. Register `http://127.0.0.1:3000/api/auth/paypal/callback` as its return URL.
6. Run `npm run db:migrate`, `npm run build` and `npm start`. Open `http://127.0.0.1:3000`.

Need a local database? Run `npm run db:local` in another terminal and use the connection URL it prints. Keep it running. Windows may also need the [Microsoft Visual C++ runtime](https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist).

For development, run `npm run dev:server` and `npm run dev:client` in separate terminals. Set `APP_ORIGIN=http://127.0.0.1:5173`.

## Connect your data

PayPal login identifies your account. It does not grant access to your payment history.

- [Sandbox import](docs/JUDGE_ACCESS.md): configure your own merchant-owned test agreements. Each visitor gets separate answers and saved needs.
- [Wallet import](docs/PAYPAL_WALLET.md): optional KERNEL connection that reads PayPal statements and identifies recurring payments. No email access.
- [Switching](docs/SUBSCRIPTION_SWITCHING.md): approval, purchase, activation check, cancellation and confirmation. Disabled by default. Commercial-provider support needs separate testing and permission.

Nothing here connects to the hosted demo's database, keys or accounts. Usage answers start blank. Test data is synthetic. Provider names are plain text; third-party logo images are excluded.

## Check it

`npm run typecheck`, `npm test`, `npm run build`, `npm run format:check` and `npm run security:scan`.

Tests use disposable databases and simulated services. They do not make paid model calls or PayPal purchases. Live research may be incomplete; a cheaper option is not guaranteed.

[Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [Architecture](docs/STATE_MACHINES.md) · [Licences](docs/LICENSES.md)

Original code: [MIT](LICENSE).
