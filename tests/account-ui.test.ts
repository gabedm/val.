import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, expect, it } from "vitest";
import { DeploymentContext } from "../src/client/deployment";
import { Activity, Account } from "../src/client/Activity";
import type { CaseSnapshot, CaseSummary, SessionView } from "../src/shared/contracts.types";
import { startTestApp, type TestApp } from "./helpers";
import { approvePurchaseAndReturn, snapshotOf, startPurchase, valueAwaitingConsent } from "./scenarios";

let app: TestApp;
let snapshot: CaseSnapshot;
let session: SessionView;
const ownerMarkup = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(
      DeploymentContext,
      { value: { passwordAccess: true, financialTools: true, paypalIdentityEnvironment: "sandbox" } },
      element,
    ),
  );
beforeAll(async () => {
  app = await startTestApp();
  const flow = await valueAwaitingConsent(app);
  const purchase = await startPurchase(app, flow);
  await approvePurchaseAndReturn(app, flow, purchase.approval);
  snapshot = await snapshotOf(flow.browser, flow.caseId);
  session = (await flow.browser.get("/api/session")).body;
});
afterAll(() => app.close());

it("hides current and archived setup placeholders without hiding an actual payment handover", () => {
  const setup: CaseSummary = { ...snapshot.case, id: "retired-setup", state: "SETUP", archivedAt: null };
  const archived: CaseSummary = {
    ...setup,
    id: "retired-archived-setup",
    archivedAt: new Date().toISOString(),
  };
  const render = (cases: CaseSummary[]) =>
    renderToStaticMarkup(
      createElement(Activity, { cases, selected: snapshot.case.id, snapshot, onOpen: () => {} }),
    );
  const empty = render([setup, archived]);
  expect(empty).toContain("No activity yet.");
  expect(empty).not.toContain("Original service setup");
  expect(empty).not.toContain("Current reviews");
  expect(empty).not.toContain("Previous reviews");
  const mixed = render([setup, archived, snapshot.case]);
  expect(mixed).not.toContain("Original service setup");
  expect(mixed).toContain("£6 paid");
  expect(mixed).toContain("Current reviews");
});

it("does not offer the retired setup-creation control in the subscription-portfolio account", () => {
  const html = ownerMarkup(createElement(Account, { session, onSession: () => {} }));
  expect(html).not.toContain("Start a new review");
  expect(html).not.toContain("Archive and start fresh");
  expect(html).not.toContain("Comparisons and price checks");
  expect(html).toContain("Restore on this browser");
});

it("keeps archived reviews reachable without borrowing the selected review's verified payment", () => {
  const previous: CaseSummary = {
    ...snapshot.case,
    id: "previous-review",
    archivedAt: new Date().toISOString(),
  };
  const render = (value: CaseSnapshot) =>
    renderToStaticMarkup(
      createElement(Activity, {
        cases: [snapshot.case, previous],
        selected: snapshot.case.id,
        snapshot: value,
        onOpen: () => {},
      }),
    );
  const html = render(snapshot);
  expect(html).toContain("Current reviews");
  expect(html).toContain("Previous reviews");
  expect(html.match(/£6 paid/g)).toHaveLength(1);
  expect(html).toContain("Switch recorded");
  expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  const unverified = render({ ...snapshot, receipt: { ...snapshot.receipt, paymentEvidenceId: null } });
  expect(unverified).toContain("Switch needs review");
  expect(unverified).not.toContain("£6 paid");
  const mismatched = render({ ...snapshot, case: { ...snapshot.case, id: "another-review" } });
  expect(mismatched).not.toContain("£6 paid");
});

it("retains recovery and operator boundaries without subscription summaries in Account", () => {
  const render = (role: SessionView["role"]) =>
    ownerMarkup(createElement(Account, { session: { ...session, role }, onSession() {} }));
  const customer = render("reviewer");
  expect(customer).toContain("Your account");
  expect(customer).toContain("Restore on this browser");
  expect(customer).toContain("Privacy and data");
  expect(customer).toContain('href="/privacy.html"');
  expect(customer).not.toMatch(
    /Your preferences|Your needs|Monthly budget|Comparisons and price checks|Review tools|Archive and start fresh/,
  );
  expect(render("admin")).toContain("Review tools");
});

it("omits recovery-code and operator controls unless explicitly enabled", () => {
  const html = renderToStaticMarkup(
    createElement(Account, { session: { ...session, role: "admin" }, onSession() {} }),
  );
  expect(html).not.toMatch(/Restore on this browser|Recovery code|Review tools|Archive and start fresh/);
  expect(html).toContain("Log out");
  expect(html).toContain("Privacy and data");
  expect(html).not.toMatch(/Your preferences|Your needs|Comparisons and price checks/);
});
