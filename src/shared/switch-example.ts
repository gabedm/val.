export const switchExampleConsent = "sandbox-switch-example.1";
export interface SwitchExampleView {
  company: string;
  purpose: string;
  sourceName?: string;
  phase: "not_started" | "setup" | "ready" | "switching" | "completed" | "unavailable";
  oldPriceMinor: number;
  newPriceMinor: number;
  currency: "GBP";
  setupUrl: string | null;
  switchId: string | null;
}
