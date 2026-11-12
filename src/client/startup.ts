import type { CaseSnapshot } from "../shared/contracts.types";

export const introDuration = 3200;
export const introExitDuration = 700;

/** Only a paid, current case without saved needs enters first-time onboarding automatically. */
export function needsOnboarding(snapshot: CaseSnapshot) {
  return (
    !snapshot.case.archivedAt &&
    !snapshot.policy &&
    snapshot.case.state === "SETUP" &&
    snapshot.receipt.oldBilling === "ACTIVE" &&
    snapshot.receipt.oldService === "ACTIVE" &&
    !!snapshot.receipt.oldSubscriptionId &&
    !!snapshot.receipt.oldAccessEndsAt &&
    Date.parse(snapshot.receipt.oldAccessEndsAt) > Date.now()
  );
}

// These markers restore navigation after a real OAuth round trip, never authentication or consent.
export function entryMarker(key: string, value?: string | null) {
  try {
    if (value === undefined) return sessionStorage.getItem(key);
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* The welcome/normal sign-in still works if browser storage is unavailable. */
  }
  return null;
}
