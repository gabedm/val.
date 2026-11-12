import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { productRoute } from "../src/client/navigation";
import { SavedSetupPayment } from "../src/client/SavedSetupPayment";
import { Home } from "../src/client/Home";
import type { CaseSnapshot } from "../src/shared/contracts.types";

it("sends obsolete and malformed bookmarks to the current product, never fixture setup", () => {
  for (const profile of [false, true]) {
    expect(productRoute("onboarding", "retired", false, profile)).toBe("home");
    expect(productRoute("preferences", null, false, profile)).toBe("home");
    for (const raw of ["login", "signup", "daybook", "val/%ZZ", "val/", "service/", "unknown"])
      expect(productRoute(raw, "retired", false, profile)).toBe("subscriptions");
    expect(productRoute("tools", "retired", false, profile)).toBe("account");
  }
});

it("retains explicit saved-payment routes but excludes them from the public build", () => {
  for (const route of ["case", "options", "preferences", "review", "recovery"]) {
    expect(productRoute(route, "paid-case", false, false)).toBe(route);
    expect(productRoute(route, "paid-case", false, true)).toBe(
      route === "preferences" ? "home" : "subscriptions",
    );
  }
  expect(productRoute("tools", null, true, false)).toBe("tools");
  expect(productRoute("tools", null, true, true)).toBe("account");
  for (const route of [
    "home",
    "subscriptions",
    "activity",
    "discover",
    "you",
    "val/spusu",
    "service/netflix",
  ])
    expect(productRoute(route, "retired", false, true)).toBe(
      route === "discover" ? "subscriptions" : route === "you" ? "account" : route,
    );
});

it("always starts a fresh onboarding in Val even with a stale subscriptions hash, without overriding an explicit payment return", () => {
  for (const publicBuild of [true, false]) {
    for (const route of ["", "home", "welcome", "subscriptions", "you", "val/second"])
      expect(productRoute(route, null, false, publicBuild, true)).toBe("home");
    expect(productRoute("", null, false, publicBuild)).toBe("home");
    expect(productRoute("home", null, false, publicBuild)).toBe("home");
    expect(productRoute("subscriptions", null, false, publicBuild)).toBe("subscriptions");
  }
  expect(productRoute("recovery", "saved-payment", false, false, true)).toBe("recovery");
});

it("shows retained setup billing and resumes only an existing approval, without a new purchase or old preferences", () => {
  const base = {
    case: { id: "saved", state: "SETUP" },
    receipt: { oldSubscriptionId: null, oldBilling: "UNKNOWN", oldAccessEndsAt: null },
    handover: null,
  } as unknown as CaseSnapshot;
  const render = (snapshot: CaseSnapshot) =>
    renderToStaticMarkup(createElement(SavedSetupPayment, { snapshot, refresh: async () => {} }));
  const empty = render(base);
  expect(empty).toContain("No payment recorded.");
  expect(empty).not.toMatch(/Check existing payment|Resume existing|£12|Set preferences|Start your/);
  const saved = render({
    ...base,
    receipt: {
      ...base.receipt,
      oldSubscriptionId: "retained-sub",
      oldBilling: "ACTIVE",
      oldAccessEndsAt: "2026-11-17T00:00:00Z",
    },
    handover: { approvalUrl: "https://www.sandbox.paypal.com/existing-approval" } as CaseSnapshot["handover"],
  });
  expect(saved).toContain("Verified active");
  expect(saved).toContain("Resume existing PayPal approval");
  expect(saved).toContain("Check existing payment");
  expect(saved).not.toMatch(/£12|Set preferences|Start your/);
  const home = renderToStaticMarkup(
    createElement(Home, { snapshot: null, loading: false, failure: "", refresh: async () => {} }),
  );
  expect(home).toContain("Talk to Val");
  expect(home).not.toContain("Start with Original service");
});
