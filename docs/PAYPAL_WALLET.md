# PayPal wallet import

This optional connector uses KERNEL to read PayPal statements and automatic-payment details. No email access or manual merchant naming is required. Login alone does not provide this access.

## Setup

Set `VAL_PAYPAL_WALLET=true`, `KERNEL_API_KEY` and `PAYPAL_WALLET_ENVIRONMENT`. Restrict the KERNEL key to the required project, browsers and profiles. Use separate Sandbox and live configurations.

The owner connects explicitly and signs in on PayPal in the remote browser. The fixed server workflow reads payment records, removes temporary reports and stores billing evidence. Recurrence is inferred where the available records support it; uncertain frequency needs confirmation.

## Data and limits

Browser capabilities and partial job state are encrypted with owner/environment binding. Raw statements stay out of model research. Merchant names, costs, frequency and confirmed usage can go to the selected model.

Defaults cap concurrent browsers at two and daily imports at ten. Failed cleanup keeps its slot until reconciled. Disconnect removes the retained profile and prevents a running import from publishing afterwards. Logout only ends the Val session.

## Deployment

The authenticated browser has broader account access than a read-only API. Protect its viewer link and key. Production automation needs separate permission and review under the provider's terms; the code and a successful Sandbox run do not establish that permission.
