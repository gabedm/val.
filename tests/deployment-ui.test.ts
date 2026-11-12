import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { DeploymentContext } from "../src/client/deployment";
import { SignIn } from "../src/client/SessionPanel";
import { Account } from "../src/client/Activity";
import type { DeploymentCapabilities } from "../src/shared/deployment";

const render = (value: DeploymentCapabilities) =>
  renderToStaticMarkup(
    createElement(DeploymentContext, { value }, [
      createElement(SignIn, { key: "login", onSession: () => {} }),
      createElement(Account, {
        key: "account",
        session: { authenticated: true, role: "admin", ownerId: "test-owner", csrfToken: "test-csrf" },
        onSession: () => {},
      }),
    ]),
  );

it("uses the same UI components for live and safe Sandbox configurations without operator entry points", () => {
  for (const paypalIdentityEnvironment of ["sandbox", "live"] as const) {
    const html = render({ passwordAccess: false, financialTools: false, paypalIdentityEnvironment });
    expect(html).toContain("Continue with PayPal");
    expect(html).not.toMatch(
      /Demo access|Review tools|Restore on this browser|Create an account|Connect a bank/,
    );
  }
});

it("retains the private Sandbox controls when explicitly enabled by the server", () => {
  const html = render({ passwordAccess: true, financialTools: true, paypalIdentityEnvironment: "sandbox" });
  expect(html).toContain("Sign in");
  expect(html).toContain("Review tools");
  expect(html).toContain("Restore on this browser");
});

it("keeps product testing PayPal-only even when private operator password routes remain available", () => {
  for (const feature of [{ paypalSandboxDemo: true }, { paypalWallet: true }]) {
    const html = render({
      passwordAccess: true,
      financialTools: false,
      paypalIdentityEnvironment: "sandbox",
      ...feature,
    });
    expect(html).toContain("Continue with PayPal");
    expect(html).not.toMatch(/Demo access|Restore on this browser|Use your demo login details/);
  }
});
