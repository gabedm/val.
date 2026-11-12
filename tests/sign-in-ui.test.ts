import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { SignIn } from "../src/client/SessionPanel";
import { DeploymentContext } from "../src/client/deployment";

afterEach(() => vi.unstubAllGlobals());
function welcome(url: string, enabled = true) {
  vi.stubGlobal("location", new URL(url));
  return renderToStaticMarkup(
    createElement(
      DeploymentContext,
      {
        value: {
          passwordAccess: true,
          financialTools: false,
          paypalIdentityEnvironment: "sandbox",
          paypalSandboxDemo: true,
          paypalSandboxDemoEntry: enabled,
        },
      },
      createElement(SignIn, { onSession: () => undefined }),
    ),
  );
}
it("keeps one PayPal button without technical environment copy", () => {
  const html = welcome("https://val.example/");
  expect(html).toContain("Continue with PayPal");
  expect(html).not.toMatch(/Sandbox|demo|test account|sandbox-notice/i);
  expect(html).not.toMatch(/type="password"|Sign in with Google|Sign in with Apple/);
});
it("retains a genuine PayPal login entry without presenting it as preconnected", () => {
  expect(welcome("https://val.example/?paypal=login")).not.toContain("Preconnected");
  expect(welcome("https://val.example/", false)).not.toContain("Preconnected");
});
