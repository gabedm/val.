/** Identity endpoints only. Merchant payment clients remain Sandbox-only. */
export type PayPalIdentityEnvironment = "sandbox" | "live";

export const paypalIdentityEndpoints = {
  sandbox: { connect: "https://www.sandbox.paypal.com/connect", api: "https://api-m.sandbox.paypal.com" },
  live: { connect: "https://www.paypal.com/connect", api: "https://api-m.paypal.com" },
} as const;

export interface PayPalSignIn {
  approvalUrl: string;
  environment: PayPalIdentityEnvironment;
}

/** Never follow an arbitrary URL, even if a sign-in response is malformed. */
export function paypalSignInDestination(result: PayPalSignIn): URL {
  if (result.environment !== "sandbox" && result.environment !== "live")
    throw new Error("Unknown PayPal sign-in environment.");
  const url = new URL(result.approvalUrl);
  const expected = new URL(paypalIdentityEndpoints[result.environment].connect);
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error("PayPal returned an unexpected sign-in link. Please try again.");
  return url;
}
