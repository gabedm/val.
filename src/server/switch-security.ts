import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { parse } from "tldts";
import type { Config } from "./config";
import { providerPriceUrl, currencyAmounts } from "./live-discovery";
import type { SwitchCancellation, SwitchTerms } from "../shared/subscription-switch";

// JSONB may reorder object keys. Approval hashes must survive storage and process restarts.
export const switchDigest = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");
export const switchText = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
export function switchDomain(value: string) {
  const safe = providerPriceUrl(value);
  if (!safe) throw new Error("Invalid provider address");
  const host = new URL(safe).hostname;
  const result = parse(host, { allowPrivateDomains: true });
  return result.domain && (result.isIcann || result.isPrivate) ? result.domain : host;
}
export function switchUrlAllowed(value: string, domains: string[], paymentOrigin?: string) {
  const safe = providerPriceUrl(value);
  if (!safe) return false;
  const url = new URL(safe);
  return (
    url.origin === paymentOrigin ||
    domains.some((domain) => url.hostname === domain || url.hostname.endsWith("." + domain))
  );
}
export function sealSwitch<T>(config: Config, owner: string, id: string, value: T) {
  const keyId = config.walletEncryption?.activeId ?? "legacy";
  const secret =
    keyId === "legacy" ? (config.dataSecret ?? config.sessionSecret) : config.walletEncryption!.keys[keyId]!;
  const iv = randomBytes(12),
    cipher = createCipheriv(
      "aes-256-gcm",
      createHash("sha256")
        .update("val-switch.1\0" + secret)
        .digest(),
      iv,
    );
  cipher.setAAD(Buffer.from(`${owner}\0${id}\0${keyId}`));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return `s1.${keyId}.${Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url")}`;
}
export function openSwitch<T>(config: Config, owner: string, id: string, envelope: string): T {
  const [version, keyId, encoded, ...extra] = envelope.split(".");
  if (version !== "s1" || !keyId || !encoded || extra.length) throw Error("Unavailable switch connection");
  const secret =
    keyId === "legacy" ? (config.dataSecret ?? config.sessionSecret) : config.walletEncryption?.keys[keyId];
  if (!secret) throw Error("Unavailable switch connection");
  const bytes = Buffer.from(encoded, "base64url"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      createHash("sha256")
        .update("val-switch.1\0" + secret)
        .digest(),
      bytes.subarray(0, 12),
    );
  decipher.setAAD(Buffer.from(`${owner}\0${id}\0${keyId}`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
  ) as T;
}
const money = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000_000;
export function validSwitchTerms(value: SwitchTerms, page: string, name: string) {
  if (
    !value ||
    typeof value.quote !== "string" ||
    !value.quote.trim() ||
    value.quote.length > 1200 ||
    !switchText(page).includes(switchText(value.quote))
  )
    return false;
  if (
    ![value.chargeMinor, value.renewalMinor, value.upfrontMinor].every(money) ||
    !["GBP", "USD", "EUR"].includes(value.currency) ||
    !["month", "year", "30_days"].includes(value.cycle) ||
    !Number.isSafeInteger(value.minimumTermMonths) ||
    value.minimumTermMonths < 0 ||
    value.minimumTermMonths > 60
  )
    return false;
  if (
    typeof value.name !== "string" ||
    typeof value.plan !== "string" ||
    !value.plan.trim() ||
    value.plan.length > 180 ||
    switchText(value.name).toLowerCase() !== switchText(name).toLowerCase()
  )
    return false;
  if (!switchText(value.quote).toLowerCase().includes(switchText(value.plan).toLowerCase())) return false;
  if (
    value.minimumTermMonths === 0
      ? !/\b(?:no minimum term|cancel (?:at )?any ?time|0.month minimum)\b/i.test(value.quote)
      : !new RegExp("\\b" + value.minimumTermMonths + "[ -]month (?:minimum|commitment|term)", "i").test(
          value.quote,
        )
  )
    return false;
  if (value.upfrontMinor === 0 && !/\b(?:no|zero|0) (?:setup|joining|upfront) fee\b/i.test(value.quote))
    return false;
  // Complex promotions need their own consent contract; never flatten them into a steady recurring price.
  if (
    /\b(?:trial|introductory|thereafter|first\s+\d+|discount|coupon|from\s+[£$€]|equivalent|per month.*billed annually)\b/i.test(
      value.quote,
    )
  )
    return false;
  if (value.chargeMinor !== value.renewalMinor + value.upfrontMinor) return false;
  if (value.chargeMinor === 0 && value.renewalMinor === 0)
    return /\bfree\b/i.test(value.quote) && !/\btrial\b/i.test(value.quote);
  const amounts = currencyAmounts(value.quote, value.currency);
  return (
    amounts.includes(value.chargeMinor) &&
    amounts.includes(value.renewalMinor) &&
    (value.upfrontMinor === 0 || amounts.includes(value.upfrontMinor)) &&
    switchCycleQuoted(value.quote, value.cycle) &&
    /\b(?:due now|pay now|today|charged now)\b/i.test(value.quote) &&
    /\b(?:renew\w*|billed|charged)\b/i.test(value.quote)
  );
}
export function switchCycleQuoted(quote: string, cycle: SwitchTerms["cycle"]) {
  const pattern =
    cycle === "year"
      ? /\b(?:annually|yearly|every year|per year|a year)\b|\/\s*(?:yr|year)\b/i
      : cycle === "30_days"
        ? /\b(?:every|per) 30 days\b|\/\s*30 days\b/i
        : /\b(?:monthly|every month|per month|a month)\b|\/\s*(?:mo|month)\b/i;
  return pattern.test(quote);
}
export function validSwitchCancellation(value: SwitchCancellation, page: string) {
  const date = new Date(String(value?.effectiveOn) + "T00:00:00Z");
  return (
    !!value &&
    typeof value.reference === "string" &&
    /^ref_[a-f0-9]{16}$/.test(value.reference) &&
    typeof value.quote === "string" &&
    value.quote.length <= 1200 &&
    switchText(page).includes(switchText(value.quote)) &&
    value.quote.includes(value.reference) &&
    /\b(?:cancel\w*|end\w*|renew\w*)\b/i.test(value.quote) &&
    money(value.feeMinor) &&
    ["GBP", "USD", "EUR"].includes(value.currency) &&
    /^20\d{2}-\d{2}-\d{2}$/.test(value.effectiveOn) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value.effectiveOn &&
    quotedSwitchDate(value.quote, date) &&
    (value.feeMinor > 0
      ? currencyAmounts(value.quote, value.currency).includes(value.feeMinor)
      : /\b(?:no|zero|0) (?:cancellation |exit )?fee\b/i.test(value.quote))
  );
}

function quotedSwitchDate(quote: string, date: Date) {
  const normalize = (value: string) =>
    switchText(value).toLowerCase().replace(/[,.-]/g, " ").replace(/\s+/g, " ");
  const forms = [date.toISOString().slice(0, 10)];
  for (const locale of ["en-GB", "en-US"])
    for (const month of ["short", "long"] as const)
      forms.push(
        new Intl.DateTimeFormat(locale, { day: "numeric", month, year: "numeric", timeZone: "UTC" }).format(
          date,
        ),
      );
  return forms.some((form) => normalize(quote).includes(normalize(form)));
}
