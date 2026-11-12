import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { BrandScene } from "../src/client/SubscriptionScene";
import { Preferences } from "../src/client/Preferences";
import { needsOnboarding } from "../src/client/startup";
import type { PortfolioData } from "../src/client/Subscriptions";
import { SubscriptionChat } from "../src/client/ValConversation";
import type { CaseSnapshot } from "../src/shared/contracts.types";

const paid = {
  case: { id: "paid-case", state: "SETUP", archivedAt: null },
  policy: null,
  receipt: {
    oldSubscriptionId: "verified-sub",
    oldBilling: "ACTIVE",
    oldService: "ACTIVE",
    oldAccessEndsAt: new Date(Date.now() + 86400000).toISOString(),
  },
} as CaseSnapshot;

it("opens first-time needs only after a verified current paid period, never a pending or failed checkout", () => {
  expect(needsOnboarding(paid)).toBe(true);
  for (const changes of [
    { oldBilling: "UNKNOWN" },
    { oldBilling: "CANCELLED" },
    { oldService: "ENDED" },
    { oldSubscriptionId: null },
    { oldAccessEndsAt: null },
    { oldAccessEndsAt: "invalid" },
    { oldAccessEndsAt: "2000-01-01T00:00:00Z" },
  ]) {
    expect(needsOnboarding({ ...paid, receipt: { ...paid.receipt, ...changes } } as CaseSnapshot)).toBe(
      false,
    );
  }
  expect(needsOnboarding({ ...paid, policy: {} } as CaseSnapshot)).toBe(false);
  expect(needsOnboarding({ ...paid, case: { ...paid.case, archivedAt: new Date().toISOString() } })).toBe(
    false,
  );
});

it("uses plain black boot bubbles while retaining the Val wordmark", () => {
  const html = renderToStaticMarkup(createElement(BrandScene));
  expect(html).toContain('aria-hidden="true"');
  expect(html).not.toContain("<img");
  expect(html.match(/brand-orb-face brand-orb-neutral/g)).toHaveLength(8);
  expect(html).toContain('class="scene-val"');
  const welcome = renderToStaticMarkup(createElement(BrandScene, { variant: "welcome" }));
  expect(welcome).toContain("Apple TV+");
  expect(welcome).not.toContain("<img");
  expect(html).not.toMatch(/brand-spark|✦/);
  expect(html).not.toMatch(/Original service|Margin|connected|active|subscription-orb/);
});

it("keeps the chat's startup cluster empty until ingestion supplies the owner's records", () => {
  const data = {
    portfolio: {
      revision: 1,
      subscriptions: [
        {
          serviceId: "spotify",
          name: "Spotify",
          purpose: "Offline music",
          amountMinor: 1199,
          cycle: "month",
          source: "manual",
        },
      ],
    },
    catalogue: { catalogue: { services: [] }, logos: { spotify: "spotify.svg", netflix: "netflix.svg" } },
  } as unknown as PortfolioData;
  const render = () => renderToStaticMarkup(createElement(SubscriptionChat, { data, onUpdate: () => {} }));
  expect(render()).not.toContain('class="portfolio-orbit"');
  expect(render()).not.toContain("/logos/netflix.svg");
  data.portfolio.subscriptions = [];
  expect(render()).not.toContain('class="portfolio-orbit"');
});

it("can reopen the first needs question without changing an existing saved policy", () => {
  const snapshot = {
    ...paid,
    policy: {
      caseId: paid.case.id,
      revision: 4,
      purpose: "Editable meeting notes",
      requiredCapabilities: ["editable_text"],
      recurringCeiling: { currency: "GBP", amountMinor: 1500 },
      preserveHistory: false,
      allowInvestigation: true,
    },
  } as CaseSnapshot;
  const before = JSON.stringify(snapshot);
  const render = (fresh: boolean) =>
    renderToStaticMarkup(
      createElement(Preferences, {
        snapshot,
        proposal: null,
        fresh,
        refresh: async () => {},
        onDone: () => {},
      }),
    );
  expect(render(false)).toContain("What would you like to change?");
  expect(render(false)).toContain("Your saved preferences");
  expect(render(true)).toContain("What do you need your plan for?");
  expect(render(true)).not.toContain("Your saved preferences");
  expect(render(true)).not.toContain("Confirm and save preferences");
  expect(JSON.stringify(snapshot)).toBe(before);
});
