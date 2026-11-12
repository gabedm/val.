import { isCurrentSubscription } from "../shared/subscriptions";
import { desc, eq } from "drizzle-orm";
import { Router } from "express";
import type {
  SubscriptionCommand,
  SubscriptionEntry,
  SubscriptionImport,
  SubscriptionPortfolio,
} from "../shared/subscriptions";
import { billingCycles, portfolioLimit } from "../shared/subscriptions";
import { requireLogin } from "./auth";
import type { AppContext } from "./context";
import {
  ownerSubscriptions,
  owners,
  paypalSubscriptionLinks,
  ownerRecognizedServices,
  paypalWalletConnections,
} from "./db/schema";
import { HttpError } from "./http";
import { subscriptionBilling } from "./subscription-billing";
import { sandboxSubscriptions } from "./sandbox-demo";
import { safeProductName } from "./subscription-recognition";
import type { PaypalPlan } from "./paypal";
import { queueInitialReviews } from "./review-queue";

function parseCommand(body: unknown): SubscriptionCommand {
  const bad = () =>
    new HttpError(400, "invalid_subscription", "Check your subscription details and try again.");
  if (!body || typeof body !== "object" || Array.isArray(body)) throw bad();
  const value = body as Record<string, unknown>;
  if (
    Object.keys(value).some((key) => !["expectedRevision", "subscriptions", "startResearch"].includes(key)) ||
    (value.startResearch !== undefined && typeof value.startResearch !== "boolean") ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 0 ||
    Number(value.expectedRevision) > 2_000_000_000 ||
    !Array.isArray(value.subscriptions) ||
    value.subscriptions.length < 1 ||
    value.subscriptions.length > portfolioLimit
  )
    throw bad();
  for (const row of value.subscriptions) {
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      Object.keys(row).some((key) => !["serviceId", "amountMinor", "cycle", "purpose"].includes(key)) ||
      typeof row.serviceId !== "string" ||
      !row.serviceId ||
      row.serviceId.length > 120 ||
      !billingCycles.includes(row.cycle) ||
      typeof row.purpose !== "string" ||
      row.purpose.length > 500 ||
      (row.amountMinor !== null &&
        (!Number.isSafeInteger(row.amountMinor) || row.amountMinor < 0 || row.amountMinor > 99_999_999))
    )
      throw bad();
  }
  if (new Set(value.subscriptions.map((row) => row.serviceId)).size !== value.subscriptions.length)
    throw bad();
  return value as unknown as SubscriptionCommand;
}

export async function readSubscriptionPortfolio(
  ctx: AppContext,
  ownerId: string,
): Promise<SubscriptionPortfolio> {
  const [record] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  return record
    ? {
        revision: record.revision,
        subscriptions: record.subscriptions.filter((row) => isCurrentSubscription(row)),
      }
    : { revision: 0, subscriptions: [] };
}

/** Check only owner-bound merchant records. The model cannot supply subscription or payer IDs. */
export async function checkConnectedSubscriptions(
  ctx: AppContext,
  ownerId: string,
  signal?: AbortSignal,
): Promise<SubscriptionImport> {
  let baseline = await readSubscriptionPortfolio(ctx, ownerId);
  const sharedTests = sandboxSubscriptions(ctx.config);
  if (ctx.config.paypalWallet) {
    const [connection] = await ctx.db
      .select()
      .from(paypalWalletConnections)
      .where(eq(paypalWalletConnections.ownerId, ownerId));
    if (
      !connection ||
      connection.environment !== ctx.config.paypalWallet.environment ||
      connection.phase !== "complete"
    )
      throw new HttpError(
        409,
        "paypal_ingestion_pending",
        "Finish connecting PayPal before starting your subscription questions.",
      );
    return {
      portfolio: baseline,
      status: "checked",
      checkedAt: connection.result?.checkedAt ?? connection.updatedAt.toISOString(),
      verifiedServiceIds: baseline.subscriptions
        .filter((row) => row.paypalEvidence)
        .map((row) => row.serviceId),
      source: "wallet",
      unresolvedPayments: connection.result?.unresolvedPayments ?? 0,
      excludedPaymentGroups:
        connection.result?.candidates?.filter(
          (item) => item.choice === "not_recurring" || item.choice === "later",
        ).length ?? 0,
    };
  }
  // Live sign-in grants identity only, never access to Sandbox links or a buyer's wallet.
  if (ctx.config.paypalIdentityEnvironment === "live")
    return {
      portfolio: baseline,
      status: "identity_only",
      checkedAt: new Date().toISOString(),
      verifiedServiceIds: [],
    };
  // Only explicit owner-bound links grant import access. Historical demo cases remain history, not new portfolio entries.
  const [stored] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  // Inactive source rows retain their confirmed needs and can be restored after a verified resumption.
  if (stored) baseline = { revision: stored.revision, subscriptions: stored.subscriptions };
  const links = await ctx.db
    .select()
    .from(paypalSubscriptionLinks)
    .where(eq(paypalSubscriptionLinks.ownerId, ownerId))
    .orderBy(desc(paypalSubscriptionLinks.createdAt))
    .limit(portfolioLimit);
  const candidates =
    sharedTests ??
    links.map((link) => ({
      merchant: link.merchant,
      id: link.subscriptionId,
      planId: link.planId,
      customId: link.customId as string | null,
      serviceId: link.serviceId,
      name: link.name,
    }));
  const found = new Map<string, SubscriptionEntry>();
  const inactive = new Map<string, SubscriptionEntry>();
  const seen = new Set<string>();
  let failed = 0;
  for (const candidate of candidates) {
    if (signal?.aborted) throw new HttpError(503, "check_cancelled", "The PayPal check timed out.");
    const { merchant, id, serviceId, name } = candidate;
    if (!id || seen.has(`${merchant}:${id}`)) continue;
    seen.add(`${merchant}:${id}`);
    const client = ctx.paypal[merchant];
    if (!client) {
      failed++;
      continue;
    }
    try {
      const subscription = await client.getSubscription(id, { includePlan: true });
      if (
        subscription.id !== id ||
        subscription.plan_id !== candidate.planId ||
        (candidate.customId !== null && subscription.custom_id !== candidate.customId)
      )
        continue;
      const saved = baseline.subscriptions.find((row) => row.serviceId === serviceId);
      if (subscription.status !== "ACTIVE") {
        if (
          saved &&
          saved.source === "paypal" &&
          ["SUSPENDED", "CANCELLED", "EXPIRED"].includes(subscription.status)
        )
          inactive.set(serviceId, {
            ...saved,
            paypalStatus: subscription.status as NonNullable<SubscriptionEntry["paypalStatus"]>,
          });
        continue;
      }
      let billing: ReturnType<typeof subscriptionBilling> = null;
      let detail: Parameters<typeof subscriptionBilling>[1];
      let basePlan: Promise<PaypalPlan> | undefined;
      const readPlan = () =>
        (basePlan ??= client.getPlan(subscription.plan_id).then((plan) => {
          if (plan.id !== subscription.plan_id)
            throw new Error("The PayPal plan does not match the linked subscription");
          return plan;
        }));
      try {
        detail = subscription.plan ?? (!subscription.plan_overridden ? await readPlan() : undefined);
        if (detail?.id && detail.id !== subscription.plan_id)
          throw new Error("The expanded PayPal plan does not match");
        billing = subscriptionBilling(subscription, detail);
      } catch {
        failed++;
      }
      let paypalProduct = saved?.paypalProduct;
      try {
        const plan = detail?.product_id && detail.name ? detail : await readPlan();
        if (
          typeof plan.product_id === "string" &&
          /^[a-z\d][a-z\d._-]{5,49}$/i.test(plan.product_id) &&
          !plan.product_id.includes("..") &&
          client.getProduct
        ) {
          const product = await client.getProduct(plan.product_id);
          const productName =
            product.id === plan.product_id && typeof product.name === "string"
              ? safeProductName(product.name.split(/\s+[—–]\s+/)[0])
              : null;
          // A plan's advertised charge may differ from an override; keep money in the validated billing fields.
          const planName =
            typeof plan.name === "string"
              ? safeProductName(plan.name.split(/\s+[—–-]\s+(?=[£$€]|(?:GBP|USD|EUR)\b)/)[0])
              : null;
          if (productName) {
            const unchanged =
              paypalProduct?.name === productName && paypalProduct.planName === (planName ?? undefined);
            paypalProduct = unchanged
              ? paypalProduct
              : {
                  name: productName,
                  ...(planName ? { planName } : {}),
                  recordedAt: new Date().toISOString(),
                };
          }
        }
      } catch {
        // Optional labels never replace a verified bill or erase previously retrieved product context.
      }
      const previousBill = saved?.paypalBilling;
      const followsBill =
        saved?.amountMinor == null ||
        (!!previousBill &&
          saved.amountMinor === previousBill.amountMinor &&
          saved.cycle === previousBill.cycle);
      const paypalBilling = billing
        ? previousBill?.amountMinor === billing.amountMinor && previousBill.cycle === billing.cycle
          ? previousBill
          : { ...billing, recordedAt: new Date().toISOString() }
        : previousBill;
      const row = {
        ...(saved ?? { serviceId, amountMinor: null, cycle: "month" as const, purpose: "" }),
        ...(billing && followsBill ? billing : {}),
        name: paypalProduct?.name ?? name,
        source: "paypal" as const,
        paypalStatus: "ACTIVE" as const,
        ...(paypalProduct ? { paypalProduct } : {}),
        ...(paypalBilling ? { paypalBilling } : {}),
      };
      if (![...found.values()].some((saved) => saved.name === row.name)) found.set(serviceId, row);
    } catch {
      failed++;
    }
    if (found.size >= portfolioLimit || seen.size >= portfolioLimit) break;
  }
  let portfolio = baseline;
  if (signal?.aborted) throw new HttpError(503, "check_cancelled", "The PayPal check timed out.");
  const additions = [...found.values()]
    .filter(
      (row) =>
        !baseline.subscriptions.some((saved) => saved.serviceId === row.serviceId || saved.name === row.name),
    )
    .slice(0, Math.max(0, portfolioLimit - baseline.subscriptions.filter(isCurrentSubscription).length));
  const backfills = new Map(
    [...found, ...inactive].filter(([id, row]) =>
      baseline.subscriptions.some(
        (saved) =>
          saved.serviceId === id &&
          (saved.source !== row.source ||
            saved.paypalStatus !== row.paypalStatus ||
            saved.name !== row.name ||
            saved.amountMinor !== row.amountMinor ||
            saved.cycle !== row.cycle ||
            JSON.stringify(saved.paypalBilling) !== JSON.stringify(row.paypalBilling) ||
            JSON.stringify(saved.paypalProduct) !== JSON.stringify(row.paypalProduct)),
      ),
    ),
  );
  if (additions.length || backfills.size)
    portfolio = await ctx.db.transaction(async (tx) => {
      if (signal?.aborted) throw new HttpError(503, "check_cancelled", "The PayPal check timed out.");
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for("update");
      const [current] = await tx
        .select()
        .from(ownerSubscriptions)
        .where(eq(ownerSubscriptions.ownerId, ownerId));
      if ((current?.revision ?? 0) !== baseline.revision)
        throw new HttpError(409, "subscriptions_changed", "Your list changed. Check PayPal again.");
      const next = {
        revision: baseline.revision + 1,
        subscriptions: [
          ...baseline.subscriptions.map((row) => backfills.get(row.serviceId) ?? row),
          ...additions,
        ],
      };
      await tx
        .insert(ownerSubscriptions)
        .values({ ownerId, ...next })
        .onConflictDoUpdate({ target: ownerSubscriptions.ownerId, set: { ...next, updatedAt: new Date() } });
      return next;
    });
  return {
    ...(sharedTests ? { source: "sandbox" as const } : {}),
    portfolio: { ...portfolio, subscriptions: portfolio.subscriptions.filter(isCurrentSubscription) },
    status: failed ? (found.size ? "partial" : "unavailable") : "checked",
    checkedAt: new Date().toISOString(),
    verifiedServiceIds: [...found.keys()],
  };
}

export function subscriptionRoutes(ctx: AppContext, services: { id: string; service: string }[]) {
  const router = Router();
  router.get("/subscriptions", async (_req, res) => {
    const { ownerId } = requireLogin(res);
    res.json(await readSubscriptionPortfolio(ctx, ownerId));
  });
  router.post("/subscriptions/import", async (req, res) => {
    const { ownerId } = requireLogin(res);
    if (!req.body || Object.keys(req.body).length)
      throw new HttpError(400, "invalid_request", "This check takes no subscription identifiers.");
    res.json(await checkConnectedSubscriptions(ctx, ownerId));
  });
  router.put("/subscriptions", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseCommand(req.body);
    const result = await ctx.db.transaction(async (tx) => {
      // Lock the owner even on the first save, so simultaneous tabs cannot overwrite each other.
      await tx.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId)).for("update");
      const [previous] = await tx
        .select()
        .from(ownerSubscriptions)
        .where(eq(ownerSubscriptions.ownerId, ownerId));
      if ((previous?.revision ?? 0) !== command.expectedRevision)
        throw new HttpError(
          409,
          "subscriptions_changed",
          "Your subscriptions changed in another tab. Reload before saving.",
        );
      const registered = await tx
        .select()
        .from(ownerRecognizedServices)
        .where(eq(ownerRecognizedServices.ownerId, ownerId));
      const subscriptions: SubscriptionEntry[] = command.subscriptions.map((row) => {
        const service = services.find((service) => service.id === row.serviceId);
        const imported = previous?.subscriptions.find(
          (saved) => saved.serviceId === row.serviceId && (saved.source !== "manual" || saved.providerState),
        );
        if (imported?.paypalEvidence?.excludedByOwner)
          throw new HttpError(
            409,
            "subscription_excluded",
            "You excluded this payment. Review your PayPal connection before saving it again.",
          );
        if (
          imported?.providerState?.status === "cancelled" ||
          (imported?.paypalStatus !== undefined && imported.paypalStatus !== "ACTIVE") ||
          imported?.paypalEvidence?.agreementStatus === "inactive"
        )
          throw new HttpError(
            409,
            "subscription_inactive",
            "This subscription is no longer active. Reload your list before saving.",
          );
        if (imported?.paypalEvidence?.recurrenceStale)
          throw new HttpError(
            409,
            "subscription_unconfirmed",
            "Recent payments no longer establish this recurring bill. Refresh your PayPal connection before saving it again.",
          );
        const identified = registered.find((item) => item.serviceId === row.serviceId);
        if (!service && !imported && !identified)
          throw new HttpError(400, "unknown_service", "Ask Val about this subscription first.");
        return {
          ...row,
          name: imported?.name ?? service?.service ?? identified!.name,
          source: imported?.source ?? "manual",
          ...(imported?.providerState ? { providerState: imported.providerState } : {}),
          purpose: row.purpose.trim(),
          ...(imported?.paypalBilling ? { paypalBilling: imported.paypalBilling } : {}),
          ...(imported?.paypalStatus ? { paypalStatus: imported.paypalStatus } : {}),
          ...(imported?.paypalProduct ? { paypalProduct: imported.paypalProduct } : {}),
          ...(imported?.currency ? { currency: imported.currency } : {}),
          ...(imported?.productServiceId ? { productServiceId: imported.productServiceId } : {}),
          ...(imported?.paypalEvidence ? { paypalEvidence: imported.paypalEvidence } : {}),
        };
      });
      // Archived source records retain their confirmed needs; browser writes cannot discard them.
      subscriptions.push(...(previous?.subscriptions.filter((row) => !isCurrentSubscription(row)) ?? []));
      const names = new Map<string, SubscriptionEntry>();
      for (const row of subscriptions.filter((item) => isCurrentSubscription(item))) {
        const before = names.get(row.name.toLowerCase());
        if (
          before &&
          !(
            before.paypalEvidence &&
            row.paypalEvidence &&
            before.paypalEvidence.key !== row.paypalEvidence.key
          )
        )
          throw new HttpError(400, "duplicate_subscription", "That subscription is already in your list.");
        names.set(row.name.toLowerCase(), row);
      }
      const next = { revision: command.expectedRevision + 1, subscriptions };
      await tx
        .insert(ownerSubscriptions)
        .values({ ownerId, ...next })
        .onConflictDoUpdate({ target: ownerSubscriptions.ownerId, set: { ...next, updatedAt: new Date() } });
      if (command.startResearch) await queueInitialReviews(tx, ownerId, next, services);
      return {
        ...next,
        subscriptions: next.subscriptions.filter((row) => isCurrentSubscription(row)),
      };
    });
    res.json(result);
  });
  return router;
}
