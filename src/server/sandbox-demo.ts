import type { Config } from "./config";

export interface SandboxSubscriptionBinding {
  merchant: "A" | "B";
  id: string;
  planId: string;
  customId: string;
  serviceId: string;
  name: string;
}

/** Operator-owned test agreements. This never accepts identifiers from a browser or model. */
export function readSandboxSubscriptions(value: string | undefined): SandboxSubscriptionBinding[] | null {
  if (!value?.trim()) return null;
  let records: unknown;
  try {
    records = JSON.parse(value);
  } catch {
    throw new Error("Invalid Sandbox subscription configuration");
  }
  if (
    !Array.isArray(records) ||
    !records.length ||
    records.length > 20 ||
    records.some(
      (row) =>
        !row ||
        typeof row !== "object" ||
        Array.isArray(row) ||
        Object.keys(row).sort().join(",") !== "customId,id,merchant,name,planId,serviceId" ||
        !["A", "B"].includes(row.merchant) ||
        typeof row.id !== "string" ||
        !/^I-[A-Z0-9]{10,24}$/.test(row.id) ||
        typeof row.planId !== "string" ||
        !/^P-[A-Z0-9]{10,40}$/.test(row.planId) ||
        typeof row.customId !== "string" ||
        !row.customId.trim() ||
        row.customId.length > 256 ||
        typeof row.serviceId !== "string" ||
        !/^[a-z0-9][a-z0-9-]{1,79}$/.test(row.serviceId) ||
        typeof row.name !== "string" ||
        !row.name.trim() ||
        row.name.length > 100 ||
        /[\r\n@]/.test(row.name),
    ) ||
    new Set(records.map((row) => `${row.merchant}:${row.id}`)).size !== records.length ||
    new Set(records.map((row) => row.serviceId)).size !== records.length ||
    new Set(records.map((row) => row.name.trim().toLowerCase())).size !== records.length
  )
    throw new Error("Invalid Sandbox subscription configuration");
  return records;
}

export function sandboxSubscriptions(config: Config) {
  const records = config.paypalSandboxSubscriptions;
  if (!records?.length) return null;
  const url = URL.parse(config.appOrigin);
  const localOwnerTesting =
    config.buildProfile === "owner" &&
    url?.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (config.buildProfile !== "judge" && !localOwnerTesting) ||
    (config.paypalIdentityEnvironment ?? "sandbox") !== "sandbox" ||
    !config.judgeDemo ||
    config.paypalWallet
  )
    throw new Error("Shared test subscriptions require isolated Sandbox judge or loopback owner testing");
  return records;
}
