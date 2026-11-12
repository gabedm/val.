export const mainTabs = [
  ["home", "Val", "chat"],
  ["subscriptions", "Subscriptions", "home"],
  ["account", "Account", "person"],
] as const;

export type ChatIntent = "needs" | "monitoring";
export function chatTarget(route: string): { serviceId: string; intent?: ChatIntent } | null {
  if (!route.startsWith("val/")) return null;
  const [encoded, intent, ...extra] = route.slice(4).split("/");
  if (!encoded || extra.length || (intent !== undefined && intent !== "needs" && intent !== "monitoring"))
    return null;
  try {
    const serviceId = decodeURIComponent(encoded);
    return serviceId.trim() && serviceId.length <= 120
      ? { serviceId, ...(intent ? { intent: intent as ChatIntent } : {}) }
      : null;
  } catch {
    return null;
  }
}
export function subscriptionTarget(route: string) {
  if (!route.startsWith("subscription/")) return null;
  try {
    const id = decodeURIComponent(route.slice(13));
    return id.trim() && id.length <= 120 ? id : null;
  } catch {
    return null;
  }
}
export const subscriptionPath = (id: string) => `subscription/${encodeURIComponent(id)}`;
export const switchTarget = (route: string) =>
  /^switch\/[a-f0-9-]{36}$/.test(route) ? route.slice(7) : null;
export const subscriptionChatPath = (id: string, intent?: ChatIntent) =>
  `val/${encodeURIComponent(id)}${intent ? `/${intent}` : ""}`;
export function activeProductTab(route: string) {
  if (route === "home" || chatTarget(route)) return "home";
  if (["account", "you", "tools"].includes(route)) return "account";
  if (
    ["subscriptions", "discover", "activity", "browse", "switch-example"].includes(route) ||
    subscriptionTarget(route) ||
    switchTarget(route) ||
    route.startsWith("service/") ||
    isPaymentRoute(route)
  )
    return "subscriptions";
  return null;
}

/** Old bookmarks may open a saved payment, but never create a new fixture or replace portfolio onboarding. */
export function productRoute(
  raw: string,
  caseId: string | null,
  admin: boolean,
  publicBuild: boolean,
  freshOnboarding = false,
) {
  if (freshOnboarding && !isPaymentRoute(raw) && raw !== "tools") return "home";
  if (["", "welcome", "onboarding"].includes(raw)) return "home";
  if (raw === "discover") return "subscriptions";
  if (raw === "you") return "account";
  if (["home", "subscriptions", "account", "activity", "browse", "switch-example"].includes(raw)) return raw;
  if (raw.startsWith("service/") && raw.length > 8) return raw;
  if (chatTarget(raw) || subscriptionTarget(raw) || switchTarget(raw)) return raw;
  if (raw === "tools") return admin && !publicBuild ? raw : "account";
  if (isPaymentRoute(raw))
    return caseId && !publicBuild ? raw : raw === "preferences" ? "home" : "subscriptions";
  return "subscriptions";
}

export function isPaymentRoute(route: string) {
  return ["case", "preferences", "options", "review", "recovery"].includes(route);
}
