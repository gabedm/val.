import { isCurrentSubscription } from "../shared/subscriptions";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lte, sql } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import {
  paypalWalletConsentVersion,
  paypalWalletRefreshMs,
  type PayPalWalletResult,
  type PayPalWalletStatus,
  type WalletPhase,
  type WalletCandidateCommand,
  type PayPalWalletBill,
  type PayPalWalletCandidate,
} from "../shared/paypal-wallet";
import {
  billingCycles,
  portfolioLimit,
  type BillingCycle,
  type SubscriptionEntry,
} from "../shared/subscriptions";
import { keyedHash, requireLogin } from "./auth";
import type { AppContext } from "./context";
import { currentWorker } from "./worker-deployment";
import {
  judgeDemoCounters,
  owners,
  ownerSubscriptions,
  paypalWalletConnections,
  paypalWalletReviews,
  ownerSubscriptionSwitches,
} from "./db/schema";
import { HttpError } from "./http";
import { catalogueProfile, safeProductName } from "./subscription-recognition";
import {
  KernelWalletRuntime,
  WalletRuntimeError,
  type WalletRead,
  type WalletRuntime,
} from "./paypal-wallet-runtime";
import type { StatementScope } from "./paypal-statement";
import { readSubscriptionPortfolio } from "./subscriptions";

export const walletConsentVersion = paypalWalletConsentVersion;
interface WalletSecrets {
  version: 1;
  name: string;
  profileId?: string;
  browserId?: string;
  viewerUrl?: string;
  scope: StatementScope;
  consent: typeof walletConsentVersion;
  beganAt: string;
  authenticatedAt?: string;
  initialMarkers?: string[];
  submitted?: boolean;
  submittedAt?: string;
  marker?: string;
  pending?: WalletRead;
  verified?: number;
  inactiveKeys?: string[];
  retries?: number;
}
type Connection = typeof paypalWalletConnections.$inferSelect;
class WalletLeaseLost extends Error {}
const messages: Record<WalletPhase, string> = {
  disconnected: "Connect PayPal to find your recurring payments.",
  queued: "Getting your PayPal connection ready…",
  sign_in: "Sign in on PayPal to connect your payment history.",
  preparing: "Finding subscriptions… PayPal is preparing your payment history.",
  reading: "Finding subscriptions… Checking recurring payments.",
  complete: "Your PayPal payment check is complete.",
  reconnect: "PayPal needs you to sign in again. Your saved subscriptions are safe.",
  failed: "The PayPal check couldn’t finish. Your saved subscriptions are safe.",
  disconnecting: "Removing the saved PayPal connection…",
};

/** Encrypt connection state and bind it to its owner and PayPal environment. */
export function sealWalletState(ctx: AppContext, ownerId: string, environment: string, value: unknown) {
  const keyId = ctx.config.walletEncryption?.activeId ?? "legacy";
  const secret =
    keyId === "legacy"
      ? (ctx.config.dataSecret ?? ctx.config.sessionSecret)
      : ctx.config.walletEncryption!.keys[keyId]!;
  const key = createHash("sha256")
    .update("val-wallet-encryption.1\0" + secret)
    .digest();
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(ownerId + "\0" + environment + "\0v2\0" + keyId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return `v2.${keyId}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
}
export function openWalletState(
  ctx: AppContext,
  ownerId: string,
  environment: string,
  value: string,
): WalletSecrets {
  try {
    const parts = value.split(".");
    const legacy = parts.length === 1;
    if (!legacy && (parts.length !== 3 || parts[0] !== "v2")) throw new Error();
    const keyId = legacy ? "legacy" : parts[1]!;
    const secret =
      keyId === "legacy"
        ? (ctx.config.dataSecret ?? ctx.config.sessionSecret)
        : ctx.config.walletEncryption?.keys[keyId];
    if (!secret) throw new Error();
    const bytes = Buffer.from(legacy ? value : parts[2]!, "base64url");
    const key = createHash("sha256")
      .update("val-wallet-encryption.1\0" + secret)
      .digest();
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(ownerId + "\0" + environment + (legacy ? "" : "\0v2\0" + keyId)));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const state = JSON.parse(
      Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"),
    ) as WalletSecrets;
    if (
      state.version !== 1 ||
      state.consent !== walletConsentVersion ||
      !/^val-wallet-[a-f0-9-]+$/.test(state.name)
    )
      throw new Error();
    return state;
  } catch {
    throw new HttpError(
      503,
      "paypal_connection_unavailable",
      "The saved PayPal connection could not be opened.",
    );
  }
}

const runtimeFor = (ctx: AppContext): WalletRuntime => {
  if (!ctx.config.paypalWallet)
    throw new HttpError(
      503,
      "paypal_wallet_unavailable",
      "PayPal payment ingestion isn’t configured on this installation.",
    );
  return ctx.walletRuntime ?? new KernelWalletRuntime(ctx.config.paypalWallet);
};
const checkedConnection = async (ctx: AppContext, ownerId: string) => {
  const [row] = await ctx.db
    .select()
    .from(paypalWalletConnections)
    .where(eq(paypalWalletConnections.ownerId, ownerId));
  if (row && row.environment !== ctx.config.paypalWallet?.environment)
    throw new HttpError(
      409,
      "paypal_wallet_environment",
      "This connection belongs to another PayPal environment.",
    );
  return row;
};
async function paymentReviews(ctx: AppContext, ownerId: string, environment: string, keys: string[]) {
  if (!keys.length) return new Map<string, typeof paypalWalletReviews.$inferSelect>();
  const saved = await ctx.db
    .select()
    .from(paypalWalletReviews)
    .where(
      and(
        eq(paypalWalletReviews.ownerId, ownerId),
        eq(paypalWalletReviews.environment, environment as "sandbox" | "live"),
        inArray(paypalWalletReviews.paymentKey, keys),
      ),
    );
  return new Map(saved.map((item) => [item.paymentKey, item]));
}
export async function walletStatus(ctx: AppContext, ownerId: string): Promise<PayPalWalletStatus> {
  const row = ctx.config.paypalWallet ? await checkedConnection(ctx, ownerId) : undefined;
  const phase = row?.phase ?? "disconnected";
  const secrets =
    row?.secrets && ["sign_in", "reconnect"].includes(phase)
      ? openWalletState(ctx, ownerId, row.environment, row.secrets)
      : null;
  const portfolio = await readSubscriptionPortfolio(ctx, ownerId);
  const candidates = row?.result?.candidates ?? [];
  const saved = await paymentReviews(
    ctx,
    ownerId,
    row?.environment ?? "",
    candidates.map((item) => item.key),
  );
  return {
    enabled: !!ctx.config.paypalWallet,
    phase,
    message: messages[phase],
    signInUrl: secrets?.viewerUrl ?? null,
    checkedAt: row?.result?.checkedAt ?? null,
    pollAfterMs: phase === "preparing" ? 5000 : 2000,
    portfolio,
    findings: row?.result
      ? {
          ledgerRecords: row.result.ledgerRecords,
          recurringGroups: row.result.bills.length,
          unresolvedPayments: row.result.unresolvedPayments,
        }
      : null,
    candidates: candidates.map(({ choice: _choice, reviewRevision: _revision, ...evidence }) => {
      const review = saved.get(evidence.key);
      const visible = portfolio.subscriptions.some((item) => item.paypalEvidence?.key === evidence.key);
      return {
        ...evidence,
        reviewRevision: review?.revision ?? 0,
        ...(review && (visible || !billingCycles.includes(review.choice as BillingCycle))
          ? { choice: review.choice }
          : {}),
      };
    }),
  };
}

export async function startWalletConnection(ctx: AppContext, ownerId: string) {
  runtimeFor(ctx);
  await ctx.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('val-wallet-admission'))`);
    const [existing] = await tx
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, ownerId))
      .for("update");
    let resumed: WalletSecrets | null = null;
    if (existing) {
      if (existing.environment !== ctx.config.paypalWallet!.environment)
        throw new HttpError(
          409,
          "paypal_wallet_environment",
          "Disconnect the previous PayPal environment first.",
        );
      if (!["failed", "reconnect", "complete"].includes(existing.phase)) return;
      if (
        existing.phase === "complete" &&
        existing.result &&
        Date.now() - Date.parse(existing.result.checkedAt) < paypalWalletRefreshMs
      )
        return;
      if (existing.leaseUntil && existing.leaseUntil.getTime() > Date.now()) return;
      resumed = existing.secrets
        ? openWalletState(ctx, ownerId, existing.environment, existing.secrets)
        : null;
      if (resumed) {
        resumed.beganAt = new Date().toISOString();
        resumed.authenticatedAt = undefined;
        resumed.retries = 0;
        if (existing.phase === "complete") {
          resumed.initialMarkers = undefined;
          resumed.submitted = false;
          resumed.marker = undefined;
          resumed.pending = undefined;
          resumed.verified = 0;
        }
      }
    }
    const day = new Date().toISOString().slice(0, 10);
    for (const [key, limit] of [
      [`wallet:global:${day}`, ctx.config.paypalWallet!.dailyImports],
      [`wallet:owner:${keyedHash(ctx.config, ownerId)}:${day}`, 3],
    ] as const) {
      const [counter] = await tx.select().from(judgeDemoCounters).where(eq(judgeDemoCounters.key, key));
      if ((counter?.calls ?? 0) >= limit)
        throw new HttpError(
          429,
          "paypal_wallet_limit",
          "The PayPal connection allowance has been reached. Please try tomorrow.",
        );
      await tx
        .insert(judgeDemoCounters)
        .values({ key, calls: 1 })
        .onConflictDoUpdate({
          target: judgeDemoCounters.key,
          set: { calls: sql`${judgeDemoCounters.calls}+1` },
        });
    }
    const now = new Date(),
      start = new Date(now);
    start.setUTCFullYear(start.getUTCFullYear() - 2);
    if (start.getUTCMonth() !== now.getUTCMonth()) start.setUTCDate(0);
    const state: WalletSecrets = resumed ?? {
      version: 1,
      name: "val-wallet-" + randomUUID(),
      scope: { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) },
      consent: walletConsentVersion,
      beganAt: now.toISOString(),
    };
    if (existing?.phase === "complete")
      state.scope = { start: start.toISOString().slice(0, 10), end: now.toISOString().slice(0, 10) };
    await tx
      .insert(paypalWalletConnections)
      .values({
        ownerId,
        environment: ctx.config.paypalWallet!.environment,
        phase: "queued",
        nextAttemptAt: now,
        secrets: sealWalletState(ctx, ownerId, ctx.config.paypalWallet!.environment, state),
      })
      .onConflictDoUpdate({
        target: paypalWalletConnections.ownerId,
        set: {
          phase: "queued",
          secrets: sealWalletState(ctx, ownerId, ctx.config.paypalWallet!.environment, state),
          nextAttemptAt: now,
          failureCode: null,
        },
      });
  });
}

function validRead(value: WalletRead, scope: StatementScope) {
  if (
    !value ||
    !Array.isArray(value.bills) ||
    (value.candidates !== undefined && !Array.isArray(value.candidates))
  )
    return false;
  const entries = [...value.bills, ...(value.candidates ?? [])];
  return (
    Object.keys(value).every((key) =>
      ["ledgerRecords", "unresolvedPayments", "bills", "candidates"].includes(key),
    ) &&
    Number.isSafeInteger(value.ledgerRecords) &&
    value.ledgerRecords >= 0 &&
    value.ledgerRecords <= 50_000 &&
    Number.isSafeInteger(value.unresolvedPayments) &&
    value.unresolvedPayments >= 0 &&
    value.unresolvedPayments <= value.ledgerRecords &&
    entries.length <= portfolioLimit &&
    value.bills.every((bill) => bill?.cycle !== null) &&
    (value.candidates ?? []).every((bill) => bill?.cycle === null) &&
    new Set(entries.map((bill) => bill?.key)).size === entries.length &&
    entries.every(
      (bill) =>
        bill &&
        Object.keys(bill).every((key) =>
          [
            "key",
            "merchant",
            "currency",
            "amountMinor",
            "cycle",
            "paymentCount",
            "lastPaidOn",
            "agreementStatus",
            "agreementRef",
          ].includes(key),
        ) &&
        /^[a-f0-9]{64}$/.test(bill.key) &&
        safeProductName(bill.merchant) &&
        /^[A-Z]{3}$/.test(bill.currency) &&
        Number.isSafeInteger(bill.amountMinor) &&
        bill.amountMinor > 0 &&
        bill.amountMinor <= 99_999_999 &&
        (bill.cycle === null
          ? typeof bill.agreementRef === "string"
          : billingCycles.includes(bill.cycle as BillingCycle)) &&
        Number.isSafeInteger(bill.paymentCount) &&
        bill.paymentCount >= (bill.cycle === null ? 1 : bill.cycle === "year" ? 2 : 3) &&
        bill.paymentCount <= value.ledgerRecords &&
        bill.agreementStatus === "inferred" &&
        /^20\d{2}-\d{2}-\d{2}$/.test(bill.lastPaidOn) &&
        Number.isFinite(Date.parse(bill.lastPaidOn)) &&
        new Date(bill.lastPaidOn).toISOString().slice(0, 10) === bill.lastPaidOn &&
        bill.lastPaidOn >= scope.start &&
        bill.lastPaidOn <= scope.end &&
        (bill.agreementRef === null || /^[IB]-[A-Z0-9]{10,24}$/.test(bill.agreementRef)),
    )
  );
}

function mergedWalletRows(
  current: SubscriptionEntry[],
  result: Pick<PayPalWalletResult, "bills" | "inactiveKeys" | "checkedAt">,
  services: CatalogueResponse["catalogue"]["services"],
  reconcileMissing = false,
) {
  const rows = [...current];
  const observed = new Set(result.bills.map((bill) => bill.key));
  const checkedAt = Date.parse(result.checkedAt);
  for (let index = 0; reconcileMissing && index < rows.length; index++) {
    const row = rows[index]!;
    const evidence = row.paypalEvidence;
    if (!evidence || observed.has(evidence.key) || evidence.agreementStatus === "inactive") continue;
    const ageDays = (checkedAt - Date.parse(evidence.lastPaidOn)) / 86400_000;
    const toleranceDays = row.cycle === "year" ? 400 : 45;
    // Only a newer completed import can withdraw support for a recurring charge.
    // Preserve both the payment permission and the person's saved needs.
    if (checkedAt > Date.parse(evidence.checkedAt) && ageDays > toleranceDays) {
      rows[index] = {
        ...row,
        paypalEvidence: { ...evidence, recurrenceStale: true, checkedAt: result.checkedAt },
      };
    }
  }
  for (const key of result.inactiveKeys ?? []) {
    const index = rows.findIndex((row) => row.paypalEvidence?.key === key);
    if (index >= 0)
      rows[index] = {
        ...rows[index]!,
        paypalEvidence: { ...rows[index]!.paypalEvidence!, agreementStatus: "inactive" },
      };
  }
  for (const bill of result.bills) {
    const serviceId = "pp_" + bill.key.slice(0, 40),
      index = rows.findIndex((row) => row.serviceId === serviceId),
      saved = rows[index];
    const profile = catalogueProfile(services, { serviceId, name: bill.merchant });
    const product =
      profile.identification === "matched"
        ? services.find((service) => service.service === profile.displayName)
        : undefined;
    const followsBill =
      !saved ||
      saved.amountMinor === null ||
      (saved.amountMinor === saved.paypalBilling?.amountMinor && saved.cycle === saved.paypalBilling.cycle);
    const sameBill =
      saved?.paypalBilling?.amountMinor === bill.amountMinor && saved.paypalBilling.cycle === bill.cycle;
    const cycleBasis = followsBill
      ? (bill.cycleBasis ?? "payment_history")
      : (saved.paypalEvidence?.cycleBasis ?? "payment_history");
    const sameEvidence =
      !saved?.paypalEvidence?.recurrenceStale &&
      saved?.paypalEvidence?.paymentCount === bill.paymentCount &&
      saved.paypalEvidence.lastPaidOn === bill.lastPaidOn &&
      saved.paypalEvidence.agreementStatus === bill.agreementStatus &&
      (saved.paypalEvidence.cycleBasis ?? "payment_history") === cycleBasis;
    const row: SubscriptionEntry = {
      ...(saved ?? { serviceId, purpose: "" }),
      serviceId,
      name: product?.service ?? bill.merchant,
      source: "paypal",
      currency: bill.currency,
      ...(saved?.providerState?.status === "cancelled" &&
      bill.lastPaidOn > saved.providerState.verifiedAt.slice(0, 10)
        ? { providerState: { ...saved.providerState, status: "review" as const } }
        : {}),
      ...(product ? { productServiceId: product.id } : {}),
      amountMinor: followsBill ? bill.amountMinor : saved!.amountMinor,
      cycle: followsBill ? bill.cycle : saved!.cycle,
      // A person can confirm the last charge; that does not make its cadence provider-verified.
      paypalBilling:
        bill.cycleBasis === "owner_confirmation"
          ? saved?.paypalBilling
          : sameBill
            ? saved!.paypalBilling
            : { amountMinor: bill.amountMinor, cycle: bill.cycle, recordedAt: result.checkedAt },
      paypalEvidence: sameEvidence
        ? saved!.paypalEvidence
        : {
            ...(saved?.paypalEvidence?.excludedByOwner ? { excludedByOwner: true } : {}),
            key: bill.key,
            merchant: bill.merchant,
            paymentCount: bill.paymentCount,
            lastPaidOn: bill.lastPaidOn,
            agreementStatus: bill.agreementStatus,
            checkedAt: result.checkedAt,
            ...(cycleBasis === "owner_confirmation" ? { cycleBasis } : {}),
          },
    };
    if (index >= 0) rows[index] = row;
    else rows.push(row);
  }
  if (rows.filter((row) => isCurrentSubscription(row)).length > portfolioLimit)
    throw new HttpError(
      409,
      "paypal_portfolio_limit",
      "This import exceeds the supported portfolio size. Your saved list was preserved.",
    );
  return rows;
}

/** Merge only evidence; a new bill never creates or completes the person's usage memory. */
export async function mergeWalletResult(
  ctx: AppContext,
  ownerId: string,
  result: PayPalWalletResult,
  services: CatalogueResponse["catalogue"]["services"],
  leaseToken?: string,
) {
  await ctx.db.transaction(async (tx) => {
    await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for("update");
    if (leaseToken) {
      const [connection] = await tx
        .select()
        .from(paypalWalletConnections)
        .where(
          and(
            eq(paypalWalletConnections.ownerId, ownerId),
            eq(paypalWalletConnections.leaseToken, leaseToken),
          ),
        )
        .for("update");
      if (!connection || connection.phase === "disconnecting") throw new WalletLeaseLost();
    }
    const [current] = await tx
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, ownerId));
    const rows = mergedWalletRows(current?.subscriptions ?? [], result, services, true);
    if (JSON.stringify(rows) === JSON.stringify(current?.subscriptions ?? [])) return;
    const next = { revision: (current?.revision ?? 0) + 1, subscriptions: rows, updatedAt: new Date() };
    await tx
      .insert(ownerSubscriptions)
      .values({ ownerId, ...next })
      .onConflictDoUpdate({ target: ownerSubscriptions.ownerId, set: next });
  });
}

/** The owner confirms an observed charge; neither a mandate nor a model can invent its cadence. */
async function reviewWalletCandidate(
  ctx: AppContext,
  ownerId: string,
  command: WalletCandidateCommand,
  services: CatalogueResponse["catalogue"]["services"],
) {
  await ctx.db.transaction(async (tx) => {
    await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for("update");
    const [connection] = await tx
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, ownerId))
      .for("update");
    if (
      !connection ||
      connection.environment !== ctx.config.paypalWallet?.environment ||
      connection.phase !== "complete" ||
      connection.result?.checkedAt !== command.checkedAt
    )
      throw new HttpError(
        409,
        "paypal_review_changed",
        "Your PayPal check changed. Refresh these payments before choosing.",
      );
    const result = structuredClone(connection.result);
    const candidate = result.candidates?.find((item) => item.key === command.key);
    if (!candidate)
      throw new HttpError(404, "paypal_payment_not_found", "That payment is not available for review.");
    const [current] = await tx
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, ownerId));
    const existing = current?.subscriptions.find((item) => item.paypalEvidence?.key === candidate.key);
    const [review] = await tx
      .select()
      .from(paypalWalletReviews)
      .where(
        and(
          eq(paypalWalletReviews.ownerId, ownerId),
          eq(paypalWalletReviews.environment, connection.environment as "sandbox" | "live"),
          eq(paypalWalletReviews.paymentKey, candidate.key),
        ),
      );
    let unchanged = false;
    if (review?.choice === command.choice) {
      unchanged = !!(billingCycles.includes(command.choice as BillingCycle)
        ? existing &&
          !existing.paypalEvidence?.excludedByOwner &&
          !existing.paypalEvidence?.recurrenceStale &&
          existing.amountMinor === candidate.lastPaymentMinor &&
          existing.cycle === command.choice
        : !existing || existing.paypalEvidence?.excludedByOwner);
    }
    const reviewRevision = review?.revision ?? 0;
    if (command.expectedReviewRevision !== reviewRevision) {
      // An immediate duplicate can return the saved result; an older ABA replay cannot.
      if (unchanged && command.expectedReviewRevision === reviewRevision - 1) return;
      throw new HttpError(
        409,
        "paypal_review_changed",
        "This payment was reviewed in another tab. Refresh before choosing again.",
      );
    }
    if (unchanged) return;
    if (reviewRevision >= 2_000_000_000)
      throw new HttpError(
        409,
        "paypal_review_limit",
        "This payment has reached its review limit. Your saved choice was preserved.",
      );
    if ((current?.revision ?? 0) !== command.expectedRevision)
      throw new HttpError(
        409,
        "subscription_revision",
        "Your subscriptions changed. Refresh before confirming this payment.",
      );
    let rows = [...(current?.subscriptions ?? [])];
    const serviceId = "pp_" + candidate.key.slice(0, 40);
    if (billingCycles.includes(command.choice as BillingCycle)) {
      const bill: PayPalWalletBill = {
        key: candidate.key,
        merchant: candidate.merchant,
        currency: candidate.currency,
        amountMinor: candidate.lastPaymentMinor,
        cycle: command.choice as BillingCycle,
        paymentCount: candidate.paymentCount,
        lastPaidOn: candidate.lastPaidOn,
        agreementStatus: "active",
        cycleBasis: "owner_confirmation",
      };
      rows = mergedWalletRows(rows, { bills: [bill], checkedAt: result.checkedAt }, services).map((item) =>
        item.serviceId === serviceId
          ? {
              ...item,
              amountMinor: bill.amountMinor,
              cycle: bill.cycle,
              paypalEvidence: {
                ...item.paypalEvidence!,
                cycleBasis: "owner_confirmation",
                excludedByOwner: false,
              },
            }
          : item,
      );
    } else {
      rows = rows.map((item) =>
        item.serviceId === serviceId
          ? { ...item, paypalEvidence: { ...item.paypalEvidence!, excludedByOwner: true } }
          : item,
      );
    }
    if (rows.filter((item) => isCurrentSubscription(item)).length > portfolioLimit)
      throw new HttpError(
        409,
        "paypal_portfolio_limit",
        "This list has reached its supported size. Your saved payments were preserved.",
      );
    if (JSON.stringify(rows) !== JSON.stringify(current?.subscriptions ?? [])) {
      const next = { revision: (current?.revision ?? 0) + 1, subscriptions: rows, updatedAt: new Date() };
      await tx
        .insert(ownerSubscriptions)
        .values({ ownerId, ...next })
        .onConflictDoUpdate({ target: ownerSubscriptions.ownerId, set: next });
    }
    candidate.choice = command.choice;
    candidate.reviewRevision = reviewRevision + 1;
    await tx
      .insert(paypalWalletReviews)
      .values({
        ownerId,
        environment: connection.environment as "sandbox" | "live",
        paymentKey: candidate.key,
        choice: command.choice,
        revision: candidate.reviewRevision,
      })
      .onConflictDoUpdate({
        target: [
          paypalWalletReviews.ownerId,
          paypalWalletReviews.environment,
          paypalWalletReviews.paymentKey,
        ],
        set: { choice: command.choice, revision: candidate.reviewRevision, updatedAt: new Date() },
      });
    await tx
      .update(paypalWalletConnections)
      .set({ result, updatedAt: new Date() })
      .where(eq(paypalWalletConnections.ownerId, ownerId));
  });
}

async function lease(ctx: AppContext, ownerId: string) {
  return ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) return null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('val-wallet-admission'))`);
    const [row] = await tx
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, ownerId))
      .for("update");
    if (
      !row ||
      !row.secrets ||
      row.environment !== ctx.config.paypalWallet?.environment ||
      ["complete", "disconnected"].includes(row.phase) ||
      row.nextAttemptAt.getTime() > Date.now() ||
      (row.leaseUntil && row.leaseUntil.getTime() > Date.now())
    )
      return null;
    if (row.phase === "queued" && !row.browserReserved) {
      const [active] = await tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(paypalWalletConnections)
        .where(eq(paypalWalletConnections.browserReserved, true));
      const [switches] = await tx
        .select({ count: sql<number>`coalesce(sum(${ownerSubscriptionSwitches.browserSlots}),0)::integer` })
        .from(ownerSubscriptionSwitches);
      if ((active?.count ?? 0) + (switches?.count ?? 0) >= ctx.config.paypalWallet!.maxConcurrent)
        return null;
    }
    const token = randomUUID();
    await tx
      .update(paypalWalletConnections)
      .set({
        leaseToken: token,
        leaseUntil: new Date(Date.now() + 120_000),
        ...(row.phase === "queued" ? { phase: "sign_in" as const, browserReserved: true } : {}),
      })
      .where(eq(paypalWalletConnections.ownerId, ownerId));
    return { ...row, phase: row.phase === "queued" ? ("sign_in" as const) : row.phase, token };
  });
}

export async function runWalletOwner(
  ctx: AppContext,
  ownerId: string,
  services: CatalogueResponse["catalogue"]["services"],
) {
  if (!ctx.config.paypalWallet) return;
  const row = await lease(ctx, ownerId);
  if (!row) return;
  const runtime = runtimeFor(ctx);
  let state: WalletSecrets | null = null;
  const heartbeat = setInterval(() => {
    void ctx.db
      .update(paypalWalletConnections)
      .set({ leaseUntil: new Date(Date.now() + 120_000) })
      .where(
        and(eq(paypalWalletConnections.ownerId, ownerId), eq(paypalWalletConnections.leaseToken, row.token)),
      )
      .catch(() => {});
  }, 20_000);
  const save = async (
    phase: WalletPhase,
    afterMs = 1500,
    extra: Partial<Connection> = {},
    { failedAttempt = false }: { failedAttempt?: boolean } = {},
  ) => {
    if (state && !failedAttempt) state.retries = 0;
    const updated = await ctx.db
      .update(paypalWalletConnections)
      .set({
        phase,
        secrets: state ? sealWalletState(ctx, ownerId, row.environment, state) : null,
        nextAttemptAt: new Date(Date.now() + afterMs),
        updatedAt: new Date(),
        ...(!failedAttempt ? { failureCode: null } : {}),
        ...extra,
      })
      .where(
        and(
          eq(paypalWalletConnections.ownerId, ownerId),
          eq(paypalWalletConnections.leaseToken, row.token),
          phase === "disconnecting" ? undefined : sql`${paypalWalletConnections.phase}<>'disconnecting'`,
        ),
      )
      .returning({ ownerId: paypalWalletConnections.ownerId });
    if (!updated.length) throw new WalletLeaseLost();
  };
  try {
    state = row.secrets ? openWalletState(ctx, ownerId, row.environment, row.secrets) : null;
    if (!state) throw new WalletRuntimeError("layout_changed");
    if (row.phase === "disconnecting") {
      if (state.browserId) await runtime.deleteBrowser(state.browserId);
      await runtime.deleteBrowser(state.name);
      await runtime.deleteProfile(state.profileId ?? state.name);
      await ctx.db
        .delete(paypalWalletConnections)
        .where(
          and(
            eq(paypalWalletConnections.ownerId, ownerId),
            eq(paypalWalletConnections.leaseToken, row.token),
          ),
        );
      return;
    }
    if (row.phase === "failed") {
      if (state.browserId) {
        await runtime.deleteBrowser(state.browserId);
        state.browserId = undefined;
        state.viewerUrl = undefined;
      }
      await runtime.deleteBrowser(state.name);
      if (Date.now() - Date.parse(state.beganAt) > 7 * 86400_000) {
        await runtime.deleteProfile(state.profileId ?? state.name);
        state = null;
      }
      await save("failed", 24 * 3600_000, { browserReserved: false });
      return;
    }
    // Waiting for sign-in does not consume the import window. Reauthentication
    // cannot extend the two-hour limit measured from the connection attempt's start.
    if (
      Date.now() - Date.parse(state.authenticatedAt ?? state.beganAt) > 60 * 60_000 ||
      Date.now() - Date.parse(state.beganAt) > 2 * 60 * 60_000
    ) {
      if (state.browserId) await runtime.deleteBrowser(state.browserId);
      await runtime.deleteBrowser(state.name);
      state.browserId = undefined;
      state.viewerUrl = undefined;
      await save("failed", 0, { failureCode: "expired", browserReserved: false });
      return;
    }
    if (!state.profileId) {
      state.profileId = await runtime.profile(state.name);
      await save(row.phase);
    }
    if (!state.browserId) {
      const browser = await runtime.browser(state.name, state.profileId);
      state.browserId = browser.id;
      state.viewerUrl = browser.url;
      await save("sign_in");
      return;
    }
    if (row.phase === "sign_in" || row.phase === "reconnect") {
      if (!(await runtime.authenticated(state.browserId))) {
        await save("sign_in", 3000);
        return;
      }
      state.authenticatedAt ??= new Date().toISOString();
      await save(state.pending ? "reading" : "preparing");
      return;
    }
    if (row.phase === "preparing") {
      const reports = await runtime.reports(state.browserId, state.scope);
      if (!state.submitted) {
        state.initialMarkers = reports.map((report) => report.marker);
        await runtime.prepareReport(state.browserId, state.scope);
        state.submitted = true;
        state.submittedAt = new Date().toISOString();
        // Record the unknown-outcome guard BEFORE the external creation click.
        await save("preparing", 5000);
        await runtime.submitReport(state.browserId, state.scope);
        return;
      }
      const matches = reports.filter((report) =>
        state!.marker ? report.marker === state!.marker : !state!.initialMarkers?.includes(report.marker),
      );
      if (matches.length > 1) throw new WalletRuntimeError("layout_changed");
      if (!matches.length) {
        await save("preparing", 10_000);
        return;
      }
      state.marker = matches[0]!.marker;
      await save(matches[0]!.ready ? "reading" : "preparing", matches[0]!.ready ? 1000 : 15_000);
      return;
    }
    if (row.phase === "reading") {
      if (!state.pending) {
        if (!state.marker) throw new WalletRuntimeError("layout_changed");
        const value = await runtime.readReport(
          state.browserId,
          state.scope,
          state.marker,
          keyedHash(ctx.config, `wallet-groups:${ownerId}:${row.environment}`),
        );
        if (!validRead(value, state.scope)) throw new WalletRuntimeError("layout_changed");
        state.pending = value;
        state.verified = 0;
        state.inactiveKeys = [];
        await save("reading");
        return;
      }
      const payments = [...state.pending.bills, ...(state.pending.candidates ?? [])];
      for (let count = 0; count < 2 && (state.verified ?? 0) < payments.length; count++) {
        const bill = payments[state.verified ?? 0]!;
        if (bill.agreementRef) {
          const status = await runtime.agreement(state.browserId, bill.agreementRef);
          if (status === "inactive") state.inactiveKeys!.push(bill.key);
          else if (status === "active") bill.agreementStatus = "active";
          else throw new WalletRuntimeError("layout_changed");
        }
        state.verified = (state.verified ?? 0) + 1;
        await save("reading");
      }
      if ((state.verified ?? 0) < payments.length) return;
      const reviews = await paymentReviews(
        ctx,
        ownerId,
        row.environment,
        payments.map((item) => item.key),
      );
      const toCandidate = (item: (typeof payments)[number]): PayPalWalletCandidate => {
        const review = reviews.get(item.key);
        return {
          key: item.key,
          merchant: item.merchant,
          currency: item.currency,
          lastPaymentMinor: item.amountMinor,
          paymentCount: item.paymentCount,
          lastPaidOn: item.lastPaidOn,
          reviewRevision: review?.revision ?? 0,
          ...(review ? { choice: review.choice } : {}),
          ...(item.cycle ? { historyCycle: item.cycle } : {}),
        };
      };
      const candidates: PayPalWalletCandidate[] = (state.pending.candidates ?? [])
        .filter((item) => item.agreementStatus === "active" && !state!.inactiveKeys!.includes(item.key))
        .map(toCandidate);
      for (const item of state.pending.bills)
        if (
          reviews.has(item.key) &&
          item.agreementStatus === "active" &&
          !state.inactiveKeys!.includes(item.key)
        )
          candidates.push(toCandidate(item));
      const excluded = new Set(
        [...reviews.values()]
          .filter((item) => item.choice === "not_recurring" || item.choice === "later")
          .map((item) => item.paymentKey),
      );
      const result: PayPalWalletResult = {
        bills: state.pending.bills
          .filter((bill) => !state!.inactiveKeys!.includes(bill.key) && !excluded.has(bill.key))
          .map(({ agreementRef: _reference, ...bill }) => bill),
        candidates,
        inactiveKeys: state.inactiveKeys,
        ledgerRecords: state.pending.ledgerRecords,
        unresolvedPayments: state.pending.unresolvedPayments,
        checkedAt: new Date().toISOString(),
      };
      await runtime.deleteBrowser(state.browserId);
      state.browserId = undefined;
      state.viewerUrl = undefined;
      await mergeWalletResult(ctx, ownerId, result, services, row.token);
      state.pending = undefined;
      await save("complete", 0, { result, failureCode: null, browserReserved: false });
    }
  } catch (error) {
    if (error instanceof WalletLeaseLost) return;
    if (!state) {
      // Preserve the encrypted record for recovery rather than discarding resource identifiers.
      await ctx.db
        .update(paypalWalletConnections)
        .set({
          phase: "failed",
          failureCode: "state_unavailable",
          nextAttemptAt: new Date(Date.now() + 86400_000),
        })
        .where(
          and(
            eq(paypalWalletConnections.ownerId, ownerId),
            eq(paypalWalletConnections.leaseToken, row.token),
          ),
        );
      return;
    }
    if (error instanceof WalletRuntimeError && error.code === "not_found") {
      state.browserId = undefined;
      state.viewerUrl = undefined;
      await save("reconnect", 3000);
    } else if (error instanceof WalletRuntimeError && error.code === "auth_required")
      await save("reconnect", 3000);
    else {
      if (error instanceof WalletRuntimeError && error.code === "not_submitted") {
        state.submitted = false;
        state.submittedAt = undefined;
        state.initialMarkers = undefined;
      }
      state.retries = (state.retries ?? 0) + 1;
      if (state.retries >= 5 && row.phase !== "disconnecting") {
        let removed = false;
        try {
          if (state.browserId) await runtime.deleteBrowser(state.browserId);
          await runtime.deleteBrowser(state.name);
          state.browserId = undefined;
          state.viewerUrl = undefined;
          removed = true;
        } catch {}
        await save(
          "failed",
          30_000,
          { failureCode: "source_unavailable", browserReserved: !removed },
          { failedAttempt: true },
        );
      } else await save(row.phase, 10_000, { failureCode: "retrying" }, { failedAttempt: true });
    }
  } finally {
    clearInterval(heartbeat);
    await ctx.db
      .update(paypalWalletConnections)
      .set({ leaseToken: null, leaseUntil: null })
      .where(
        and(eq(paypalWalletConnections.ownerId, ownerId), eq(paypalWalletConnections.leaseToken, row.token)),
      );
  }
}

export async function runWalletJobs(ctx: AppContext, services: CatalogueResponse["catalogue"]["services"]) {
  if (!ctx.config.paypalWallet) return;
  const now = new Date();
  const rows = await ctx.db
    .select({ ownerId: paypalWalletConnections.ownerId })
    .from(paypalWalletConnections)
    .where(
      and(
        eq(paypalWalletConnections.environment, ctx.config.paypalWallet.environment),
        lte(paypalWalletConnections.nextAttemptAt, now),
        sql`${paypalWalletConnections.secrets} is not null and ${paypalWalletConnections.phase} not in ('complete','disconnected')`,
        sql`(${paypalWalletConnections.leaseUntil} is null or ${paypalWalletConnections.leaseUntil} <= ${now})`,
        // Blocked admissions must not fill the batch ahead of work that can release a slot.
        // The locked lease check remains authoritative if capacity changes after this read.
        sql`(${paypalWalletConnections.phase} <> 'queued' or ${paypalWalletConnections.browserReserved}
          or (select count(*) from ${paypalWalletConnections} active_wallet where active_wallet.browser_reserved)
            + coalesce((select sum(browser_slots) from ${ownerSubscriptionSwitches}),0)
            < ${ctx.config.paypalWallet.maxConcurrent})`,
      ),
    )
    .orderBy(
      desc(paypalWalletConnections.browserReserved),
      asc(paypalWalletConnections.nextAttemptAt),
      asc(paypalWalletConnections.ownerId),
    )
    .limit(10);
  for (const row of rows) await runWalletOwner(ctx, row.ownerId, services);
}

export function paypalWalletRoutes(ctx: AppContext, services: CatalogueResponse["catalogue"]["services"]) {
  const router = Router();
  router.get("/paypal/wallet", async (_req, res) =>
    res.json(await walletStatus(ctx, requireLogin(res).ownerId)),
  );
  router.post("/paypal/wallet/connect", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (!req.body || Object.keys(req.body).length !== 1 || req.body.consent !== walletConsentVersion)
      throw new HttpError(
        400,
        "paypal_wallet_consent",
        "Choose Connect PayPal to connect your payment history.",
      );
    await startWalletConnection(ctx, ownerId);
    await runWalletOwner(ctx, ownerId, services);
    res.json(await walletStatus(ctx, ownerId));
  });
  router.post("/paypal/wallet/check", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (!req.body || Object.keys(req.body).length)
      throw new HttpError(400, "invalid_request", "This check takes no payment identifiers.");
    await runWalletOwner(ctx, ownerId, services);
    res.json(await walletStatus(ctx, ownerId));
  });
  router.post("/paypal/wallet/review", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const value = req.body as WalletCandidateCommand | null;
    if (
      !value ||
      Array.isArray(value) ||
      Object.keys(value).some(
        (key) => !["key", "checkedAt", "expectedRevision", "expectedReviewRevision", "choice"].includes(key),
      ) ||
      typeof value.key !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.key) ||
      typeof value.checkedAt !== "string" ||
      value.checkedAt.length > 40 ||
      !Number.isSafeInteger(value.expectedRevision) ||
      value.expectedRevision < 0 ||
      value.expectedRevision > 2_000_000_000 ||
      !Number.isSafeInteger(value.expectedReviewRevision) ||
      value.expectedReviewRevision < 0 ||
      value.expectedReviewRevision > 2_000_000_000 ||
      ![...billingCycles, "not_recurring", "later"].includes(value.choice)
    )
      throw new HttpError(400, "invalid_paypal_review", "Choose how to handle this PayPal payment.");
    await reviewWalletCandidate(ctx, ownerId, value, services);
    res.json(await walletStatus(ctx, ownerId));
  });
  router.delete("/paypal/wallet", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (!req.body || Object.keys(req.body).length)
      throw new HttpError(400, "invalid_request", "This command takes no connection identifiers.");
    await checkedConnection(ctx, ownerId);
    await ctx.db
      .update(paypalWalletConnections)
      .set({ phase: "disconnecting", nextAttemptAt: new Date() })
      .where(eq(paypalWalletConnections.ownerId, ownerId));
    await runWalletOwner(ctx, ownerId, services);
    res.json(await walletStatus(ctx, ownerId));
  });
  return router;
}
