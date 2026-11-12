import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CaseSnapshot } from "../src/shared/contracts.types";
import { activeSubscriptions, SubscriptionScene } from "../src/client/SubscriptionScene";

const now = Date.UTC(2026, 9, 15);
const snapshot = {
  case: { id: "owned-case" },
  currentAccount: null,
  transition: null,
  receipt: {
    oldSubscriptionId: "old-sub",
    oldBilling: "ACTIVE",
    oldService: "ACTIVE",
    oldAccessEndsAt: "2026-11-15T00:00:00Z",
    newSubscriptionId: null,
    newBillingStatus: "NONE",
    duePayment: "NOT_STARTED",
    paymentEvidenceId: null,
    capability: "NOT_STARTED",
    capabilityEvidenceId: null,
  },
} as CaseSnapshot;

describe("personalised subscription artwork", () => {
  it("uses a verified active paid period, not catalogue entries or pending approvals", () => {
    expect(activeSubscriptions(null, now)).toEqual([]);
    expect(activeSubscriptions(snapshot, now).map((service) => service.name)).toEqual(["Original service"]);
    for (const changes of [
      { oldBilling: "UNKNOWN" },
      { oldSubscriptionId: null },
      { oldAccessEndsAt: null },
      { oldService: "ENDED" },
    ]) {
      expect(
        activeSubscriptions(
          { ...snapshot, receipt: { ...snapshot.receipt, ...changes } } as CaseSnapshot,
          now,
        ),
      ).toEqual([]);
    }
  });
  it("excludes expired and unparseable access periods", () => {
    for (const oldAccessEndsAt of ["2026-10-15T00:00:00Z", "2026-10-14T00:00:00Z", "invalid"]) {
      expect(
        activeSubscriptions({ ...snapshot, receipt: { ...snapshot.receipt, oldAccessEndsAt } }, now),
      ).toEqual([]);
    }
  });
  it("does not combine the receipt with another case or subscription's account", () => {
    const account = {
      caseId: "owned-case",
      providerId: "provider_a",
      subscriptionId: "old-sub",
      billingStatus: "ACTIVE",
      accessStatus: "ACTIVE",
    } as NonNullable<CaseSnapshot["currentAccount"]>;
    expect(activeSubscriptions({ ...snapshot, currentAccount: account }, now)).toHaveLength(1);
    for (const changes of [
      { caseId: "another-owner-case" },
      { subscriptionId: "other-sub" },
      { billingStatus: "CANCELLED" },
      { accessStatus: "ENDED" },
    ]) {
      expect(
        activeSubscriptions({ ...snapshot, currentAccount: { ...account, ...changes } } as CaseSnapshot, now),
      ).toEqual([]);
    }
  });
  it("requires bound payment and service evidence before presenting a replacement as active", () => {
    const replacement = {
      ...snapshot,
      transition: {
        caseId: "owned-case",
        newSubscriptionId: "new-sub",
        acceptedPurchaseTerms: { providerId: "provider_b" },
      },
      receipt: {
        ...snapshot.receipt,
        oldBilling: "CANCELLED",
        newSubscriptionId: "new-sub",
        newBillingStatus: "ACTIVE",
        duePayment: "VERIFIED",
        paymentEvidenceId: "payment-evidence",
        capability: "VERIFIED",
        capabilityEvidenceId: "service-evidence",
      },
    } as CaseSnapshot;
    expect(activeSubscriptions(replacement, now).map((service) => service.name)).toEqual(["Margin"]);
    for (const changes of [
      { duePayment: "PENDING" },
      { paymentEvidenceId: null },
      { capability: "UNKNOWN" },
      { capabilityEvidenceId: null },
      { newSubscriptionId: "other-sub" },
    ]) {
      expect(
        activeSubscriptions(
          { ...replacement, receipt: { ...replacement.receipt, ...changes } } as CaseSnapshot,
          now,
        ),
      ).toEqual([]);
    }
    expect(
      activeSubscriptions(
        { ...replacement, transition: { ...replacement.transition!, caseId: "other-case" } },
        now,
      ),
    ).toEqual([]);
  });
  it("keeps unverified startup artwork neutral and decorative", () => {
    const html = renderToStaticMarkup(createElement(SubscriptionScene, { subscriptions: [] }));
    expect(html).toContain('aria-hidden="true"');
    expect(html).not.toMatch(/Original service|Margin|Netflix|Spotify|subscription-orb-/);
  });
});
