import { randomBytes, randomUUID } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { Router, type Response } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import {
  isCurrentSubscription,
  subscriptionCatalogueId,
  type SubscriptionEntry,
} from "../shared/subscriptions";
import {
  switchConsentVersion,
  type SwitchPhase,
  type SwitchTerms,
  type SwitchCancellation,
  type SwitchEvidence,
  type SubscriptionSwitchView,
} from "../shared/subscription-switch";
import { requireLogin } from "./auth";
import type { AppContext } from "./context";
import {
  ownerSubscriptionSwitches as switches,
  ownerSubscriptions,
  ownerRecognizedServices,
  ownerPriceChecks,
  paypalWalletConnections,
} from "./db/schema";
import { HttpError } from "./http";
import { subscriptionAdviceService } from "./subscription-advice";
import { recognizeProduct } from "./subscription-recognition";
import { currentWorker } from "./worker-deployment";
import { acquireModelWork } from "./model-work";
import {
  KernelSwitchRuntime,
  SwitchRuntimeError,
  type SwitchBrowser,
  type SwitchPage,
  type SwitchAction,
} from "./switch-runtime";
import { decideSwitch, validSwitchEvidence, validSwitchActivation } from "./switch-agent";
import {
  openSwitch,
  sealSwitch,
  switchDigest,
  switchText,
  validSwitchCancellation,
  validSwitchTerms,
} from "./switch-security";
import { providerPriceUrl } from "./live-discovery";

type Side = "old" | "new";
type WorkingPhase = Exclude<SwitchPhase, "needs_user" | "awaiting_approval" | "stopped" | "completed">;
export interface SwitchState {
  preparationOnly?: boolean;
  old: SubscriptionEntry;
  oldBasis: string;
  candidate: { id: string; name: string; plan: string };
  steps: number;
  message: string;
  terms: SwitchTerms | null;
  cancellation: SwitchCancellation | null;
  approval: { digest: string; expiresAt: string; grantedAt: string | null } | null;
  purchaseDispatchedAt: string | null;
  cancelDispatchedAt: string | null;
  newProof: SwitchEvidence | null;
  oldProof: SwitchEvidence | null;
  resume: WorkingPhase | null;
  handoffSide: Side | null;
  stopped: boolean;
  failures?: number;
}
interface SwitchSecrets {
  salt: string;
  oldUrl: string;
  newUrl: string;
  browsers: Partial<Record<Side, SwitchBrowser>>;
  prepared: Partial<Record<Side, { page: SwitchPage; action: SwitchAction }>>;
}
type Row = typeof switches.$inferSelect;
const active = sql`(${switches.phase} not in ('completed','stopped') or (${switches.state}->>'purchaseDispatchedAt' is not null and ${switches.state}->'newProof' = 'null'::jsonb) or (${switches.state}->>'cancelDispatchedAt' is not null and ${switches.state}->'oldProof' = 'null'::jsonb))`;
const owned = (ownerId: string, id: string) => and(eq(switches.ownerId, ownerId), eq(switches.id, id));
const runtimeFor = (ctx: AppContext) => ctx.switchRuntime ?? new KernelSwitchRuntime(ctx.config.switching!);
const basis = (row: SubscriptionEntry) =>
  switchDigest({
    id: row.serviceId,
    name: row.name,
    amount: row.amountMinor,
    cycle: row.cycle,
    currency: row.currency ?? "GBP",
    purpose: row.purpose,
    current: isCurrentSubscription(row),
  });
const fail = (message: string) => new HttpError(409, "switch_changed", message);
const iso = () => new Date().toISOString();
const terminal = (phase: SwitchPhase) => phase === "completed" || phase === "stopped";
const unresolved = (state: SwitchState) =>
  !!((state.purchaseDispatchedAt && !state.newProof) || (state.cancelDispatchedAt && !state.oldProof));
const waitingExpired = (row: Row) =>
  ["needs_user", "awaiting_approval"].includes(row.phase) &&
  !unresolved(row.state) &&
  row.updatedAt.getTime() < Date.now() - 900_000;
const contractDigest = (row: Row, secret: SwitchSecrets) =>
  switchDigest({
    id: row.id,
    version: switchConsentVersion,
    basis: row.state.oldBasis,
    candidate: row.state.candidate,
    terms: row.state.terms,
    cancellation: row.state.cancellation,
    oldPage: secret.prepared.old?.page.digest,
    newPage: secret.prepared.new?.page.digest,
    cancelOnly: !!row.state.newProof,
  });

export function switchView(ctx: AppContext, row: Row): SubscriptionSwitchView {
  const secret = row.secrets ? openSwitch<SwitchSecrets>(ctx.config, row.ownerId, row.id, row.secrets) : null;
  const preparationOnly = !!(row.state.preparationOnly || ctx.config.switching?.preparationOnly);
  const handoffSide =
    row.phase === "needs_user"
      ? row.state.handoffSide
      : preparationOnly && row.phase === "awaiting_approval"
        ? "new"
        : null;
  const handoff = handoffSide ? secret?.browsers[handoffSide] : null;
  return {
    id: row.id,
    revision: row.revision,
    phase: row.phase,
    oldName: row.state.old.name,
    newName: row.state.candidate.name,
    message: row.state.message,
    terms: row.state.terms,
    cancellation: row.state.cancellation
      ? {
          currency: row.state.cancellation.currency,
          quote: row.state.cancellation.quote,
          feeMinor: row.state.cancellation.feeMinor,
          effectiveOn: row.state.cancellation.effectiveOn,
        }
      : null,
    approvalDigest: row.phase === "awaiting_approval" ? (row.state.approval?.digest ?? null) : null,
    approvalExpiresAt: row.state.approval?.expiresAt ?? null,
    newActive: !!row.state.newProof,
    oldCancelled: !!row.state.oldProof,
    unresolved: unresolved(row.state),
    preparationOnly,
    handoff: handoff
      ? {
          url: handoff.url,
          provider: handoffSide === "old" ? row.state.old.name : row.state.candidate.name,
        }
      : null,
    createdAt: row.createdAt.toISOString(),
  };
}

async function getOwned(ctx: AppContext, ownerId: string, id: string) {
  const [row] = await ctx.db.select().from(switches).where(owned(ownerId, id));
  if (!row) throw new HttpError(404, "not_found", "This switch was not found.");
  return row;
}

export async function startSwitch(
  ctx: AppContext,
  catalogue: CatalogueResponse["catalogue"],
  ownerId: string,
  command: { serviceId: string; optionId: string; expectedRevision: number; consent: string },
) {
  const config = ctx.config.switching;
  if (!config || !ctx.model)
    throw new HttpError(503, "switch_unavailable", "Connected switching is unavailable in this build.");
  if (command.consent !== switchConsentVersion) throw fail("Review the current switching permission.");
  const [portfolio] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const old = portfolio?.subscriptions.find(
    (row) => row.serviceId === command.serviceId && isCurrentSubscription(row),
  );
  if (!portfolio || portfolio.revision !== command.expectedRevision || !old)
    throw fail("Your subscriptions changed. Refresh before switching.");
  const saved = (
    await subscriptionAdviceService(ctx, catalogue).savedAdvice(
      ownerId,
      portfolio.revision,
      old.serviceId,
      true,
    )
  ).get(old.serviceId);
  const option = saved?.advice.comparisons?.find(
    (row) =>
      row.serviceId === command.optionId &&
      !row.owned &&
      (row.fit !== "conditional" || config.preparationOnly) &&
      saved.advice.options.some((option) => option.serviceId === row.serviceId),
  );
  if (
    !option ||
    (!config.preparationOnly &&
      (option.priceEstimated ||
        option.prepaid ||
        option.introductoryCycles ||
        option.scheduledChanges?.length))
  )
    throw fail("Refresh this comparison. This offer needs a current, supported checkout before switching.");
  const newUrl = option.sources.map(providerPriceUrl).find((url): url is string => !!url);
  const [profile] = await ctx.db
    .select()
    .from(ownerRecognizedServices)
    .where(
      and(eq(ownerRecognizedServices.ownerId, ownerId), eq(ownerRecognizedServices.serviceId, old.serviceId)),
    );
  let oldUrl = profile?.profile.sources
    .map((row) => providerPriceUrl(row.url))
    .find((url): url is string => !!url);
  if (!oldUrl)
    oldUrl = catalogue.services
      .find((service) => service.id === subscriptionCatalogueId(old, catalogue.services))
      ?.sources.map((source) => providerPriceUrl(source.url))
      .find((url): url is string => !!url);
  if (!oldUrl && config.environment === "live") {
    const release = await acquireModelWork(ctx.db.$client, ownerId);
    try {
      oldUrl = (await recognizeProduct(ctx, ownerId, [], old.name)).sources
        .map((row) => providerPriceUrl(row.url))
        .find((url): url is string => !!url);
    } finally {
      await release();
    }
  }
  if (
    !newUrl ||
    !oldUrl ||
    (config.environment === "sandbox" &&
      [oldUrl, newUrl].some((url) => !config.testOrigins.includes(new URL(url).origin)))
  )
    throw fail(
      "This build can execute switches only on its connected test providers. Your current subscriptions have not changed.",
    );
  return prepareSelectedSwitch(ctx, ownerId, command.expectedRevision, {
    oldServiceId: old.serviceId,
    candidate: { id: option.serviceId, name: option.name, plan: option.plan },
    oldUrl,
    newUrl,
  });
}

/** A server-checked selection, not a browser-supplied alternative or payment approval. */
export async function prepareSelectedSwitch(
  ctx: AppContext,
  ownerId: string,
  expectedRevision: number,
  selection: { oldServiceId: string; candidate: SwitchState["candidate"]; oldUrl: string; newUrl: string },
) {
  const config = ctx.config.switching;
  if (!config || !ctx.model)
    throw new HttpError(503, "switch_unavailable", "Connected switching is unavailable.");
  const [portfolio] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const old = portfolio?.subscriptions.find(
    (row) => row.serviceId === selection.oldServiceId && isCurrentSubscription(row),
  );
  if (!old || portfolio!.revision !== expectedRevision || !old.purpose.trim())
    throw fail("Review the current subscription and saved needs before switching.");
  const { oldUrl, newUrl, candidate: option } = selection;
  if (
    [oldUrl, newUrl].some((value) => {
      const url = URL.parse(value);
      return (
        !url ||
        url.protocol !== "https:" ||
        !!url.username ||
        !!url.password ||
        value.length > 3000 ||
        (config.environment === "sandbox" && !config.testOrigins.includes(url.origin))
      );
    })
  )
    throw fail("This provider is not enabled for this switching connection.");
  const id = randomUUID();
  const state: SwitchState = {
    preparationOnly: !!config.preparationOnly,
    old,
    oldBasis: basis(old),
    candidate: option,
    steps: 0,
    message: "I’m checking current provider terms and preparing your switch. I’ll ask before any purchase.",
    terms: null,
    cancellation: null,
    approval: null,
    purchaseDispatchedAt: null,
    cancelDispatchedAt: null,
    newProof: null,
    oldProof: null,
    resume: null,
    handoffSide: null,
    stopped: false,
  };
  const secret: SwitchSecrets = {
    salt: randomBytes(32).toString("hex"),
    oldUrl,
    newUrl,
    browsers: {},
    prepared: {},
  };
  const result = await ctx.db.transaction(async (tx) => {
    if (!(await currentWorker(ctx, tx))) throw fail("This version is being updated. Please retry.");
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('val-wallet-admission'))`);
    const [existing] = await tx
      .select()
      .from(switches)
      .where(and(eq(switches.ownerId, ownerId), active));
    if (existing) {
      if (existing.state.old.serviceId !== old.serviceId || existing.state.candidate.id !== option.id)
        throw new HttpError(
          409,
          "switch_in_progress",
          "Finish or stop your current switch before starting another.",
        );
      return existing;
    }
    const [usage] = await tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(switches)
      .where(sql`${switches.createdAt} > now() - interval '24 hours'`);
    const [ownerUsage] = await tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(switches)
      .where(and(eq(switches.ownerId, ownerId), sql`${switches.createdAt} > now() - interval '24 hours'`));
    // The query below uses the driver's rows so no resource can be admitted outside the shared wallet lock.
    const capacity = await tx.execute(
      sql`select (select count(*) from ${paypalWalletConnections} where browser_reserved) + coalesce((select sum(browser_slots) from ${switches}),0) as count`,
    );
    if (
      (usage?.count ?? 0) >= config.dailyAttempts ||
      (ownerUsage?.count ?? 0) >= 3 ||
      Number(capacity.rows[0]?.count ?? 0) + 2 >
        Math.min(config.maxConcurrent, ctx.config.paypalWallet?.maxConcurrent ?? config.maxConcurrent)
    )
      throw new HttpError(429, "switch_busy", "The connected browser allowance is busy. Please try later.");
    const [current] = await tx
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, ownerId))
      .for("update");
    if (!current || current.revision !== portfolio!.revision)
      throw fail("Your subscriptions changed. Refresh before switching.");
    const [created] = await tx
      .insert(switches)
      .values({
        id,
        ownerId,
        phase: "preparing_old",
        state,
        browserSlots: 2,
        secrets: sealSwitch(ctx.config, ownerId, id, secret),
      })
      .returning();
    return created!;
  });
  return switchView(ctx, result);
}

export function subscriptionSwitchRoutes(
  ctx: AppContext,
  catalogue: CatalogueResponse["catalogue"],
  scope?: (res: Response) => Promise<{ ctx: AppContext; ownerId: string }>,
) {
  const router = Router();
  const resolve = scope ?? (async (res: Response) => ({ ctx, ownerId: requireLogin(res).ownerId }));
  router.get("/subscriptions/switches", async (_req, res) => {
    const { ctx, ownerId } = await resolve(res);
    const rows = await ctx.db
      .select()
      .from(switches)
      .where(eq(switches.ownerId, ownerId))
      .orderBy(desc(switches.createdAt))
      .limit(20);
    res.json(rows.map((row) => switchView(ctx, row)));
  });
  router.post("/subscriptions/switches", async (req, res) => {
    const { ctx, ownerId } = await resolve(res),
      body = req.body;
    if (
      !body ||
      Object.keys(body).sort().join() !== "consent,expectedRevision,optionId,serviceId" ||
      typeof body.serviceId !== "string" ||
      body.serviceId.length > 120 ||
      typeof body.optionId !== "string" ||
      body.optionId.length > 120 ||
      !Number.isSafeInteger(body.expectedRevision)
    )
      throw new HttpError(400, "invalid_request", "Choose a saved alternative.");
    res.json(await startSwitch(ctx, catalogue, ownerId, body));
  });
  router.get("/subscriptions/switches/:id", async (req, res) => {
    const { ctx, ownerId } = await resolve(res);
    res.json(switchView(ctx, await getOwned(ctx, ownerId, String(req.params.id))));
  });
  for (const action of ["approve", "resume", "stop"] as const)
    router.post(`/subscriptions/switches/:id/${action}`, async (req, res) => {
      const { ctx, ownerId } = await resolve(res);
      const row = await getOwned(ctx, ownerId, String(req.params.id));
      const expectedKeys = action === "approve" ? "confirmed,consent,digest,revision" : "revision";
      if (
        !req.body ||
        Object.keys(req.body).sort().join() !== expectedKeys ||
        !Number.isSafeInteger(req.body.revision)
      )
        throw new HttpError(400, "invalid_request", "Review the current switch.");
      const updated = await ctx.db.transaction(async (tx) => {
        const allowedWorker = await currentWorker(ctx, tx);
        if (action !== "stop" && !allowedWorker) throw fail("This version is being updated. Please retry.");
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('val-wallet-admission'))`);
        const [current] = await tx.select().from(switches).where(owned(ownerId, row.id)).for("update");
        if (
          !current ||
          current.revision !== req.body.revision ||
          (action !== "stop" && current.leaseUntil && current.leaseUntil.getTime() > Date.now())
        )
          throw fail("This switch is progressing. Refresh its status.");
        const state = structuredClone(current.state);
        let phase = current.phase;
        if (action === "approve") {
          if (ctx.config.switching?.preparationOnly || state.preparationOnly)
            throw new HttpError(
              409,
              "switch_preparation_only",
              "This connection can prepare a switch, but purchases and cancellations are off.",
            );
          if (
            phase !== "awaiting_approval" ||
            req.body.confirmed !== true ||
            req.body.consent !== switchConsentVersion ||
            !state.approval ||
            state.approval.digest !== req.body.digest ||
            Date.parse(state.approval.expiresAt) <= Date.now() ||
            !current.secrets ||
            contractDigest(current, openSwitch(ctx.config, ownerId, current.id, current.secrets)) !==
              state.approval.digest ||
            !(await currentWorker(ctx, tx))
          )
            throw fail("The terms changed or expired. Refresh before approving.");
          const [portfolio] = await tx
            .select()
            .from(ownerSubscriptions)
            .where(eq(ownerSubscriptions.ownerId, ownerId))
            .for("share");
          if (
            !portfolio?.subscriptions.some(
              (item) => item.serviceId === state.old.serviceId && basis(item) === state.oldBasis,
            )
          )
            throw fail(
              "Your old subscription or needs changed. Stop this switch and refresh the comparison.",
            );
          state.approval.grantedAt = iso();
          phase = state.newProof ? "cancelling_old" : "purchasing";
          state.message = state.newProof
            ? "Your replacement is active. I’m checking the approved cancellation."
            : "You approved these terms. I’m starting your replacement.";
        } else if (action === "resume") {
          if (phase === "stopped" && unresolved(state) && current.secrets) {
            const capacity = await tx.execute(
              sql`select (select count(*) from ${paypalWalletConnections} where browser_reserved) + coalesce((select sum(browser_slots) from ${switches}),0) as count`,
            );
            if (
              current.browserSlots === 0 &&
              Number(capacity.rows[0]?.count ?? 0) + 2 > (ctx.config.switching?.maxConcurrent ?? 0)
            )
              throw new HttpError(429, "switch_busy", "The connected browsers are busy. Please try later.");
            current.browserSlots = 2;
            phase = state.cancelDispatchedAt ? "verifying_old" : "verifying_new";
            state.stopped = false;
            state.approval = null;
          } else if (phase === "awaiting_approval") {
            phase = state.newProof ? "preparing_old" : "preparing_new";
            state.approval = null;
          } else {
            if (phase !== "needs_user" || !state.resume)
              throw fail("This switch is not waiting for your input.");
            phase = state.resume;
          }
          state.resume = null;
          state.handoffSide = null;
          state.failures = 0;
          state.message = "I’m checking the provider again.";
        } else {
          if (terminal(phase)) return current;
          phase = "stopped";
          state.stopped = true;
          state.message = unresolved(state)
            ? "I’ve stopped further actions. A submitted purchase or cancellation still needs verification. I’ll close the provider browsers; checking its result later will never repeat the action."
            : state.newProof
              ? "Your replacement is active and saved. I’ve stopped before cancelling the old subscription."
              : "Stopped. I did not submit a purchase or cancellation.";
        }
        const [result] = await tx
          .update(switches)
          .set({
            phase,
            browserSlots: current.browserSlots,
            state,
            revision: current.revision + 1,
            nextAttemptAt: new Date(),
            updatedAt: new Date(),
          })
          .where(owned(ownerId, row.id))
          .returning();
        return result!;
      });
      res.json(switchView(ctx, updated));
    });
  return router;
}

async function publishSwitch(ctx: AppContext, row: Row) {
  await ctx.db.transaction(async (tx) => {
    const [stored] = await tx.select().from(switches).where(owned(row.ownerId, row.id)).for("share");
    if (!stored?.state.newProof || !stored.state.terms) return;
    const state = stored.state,
      terms = state.terms!;
    const [portfolio] = await tx
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, row.ownerId))
      .for("update");
    if (!portfolio) throw Error("Missing switch portfolio");
    const id = `connected_${row.id}`;
    let changed = false;
    const entries = portfolio.subscriptions.map((item) => {
      if (
        item.serviceId !== state.old.serviceId ||
        !state.oldProof ||
        (item.providerState?.switchId === row.id && item.providerState.status === "cancelled")
      )
        return item;
      changed = true;
      return {
        ...item,
        providerState: {
          switchId: row.id,
          status: "cancelled" as const,
          verifiedAt: state.oldProof.observedAt,
          endsOn: state.cancellation!.effectiveOn,
        },
      };
    });
    if (!entries.some((item) => item.serviceId === id)) {
      entries.push({
        serviceId: id,
        name: state.candidate.name,
        amountMinor: terms.renewalMinor,
        currency: terms.currency,
        cycle: terms.cycle,
        purpose: state.old.purpose,
        source: "provider",
        providerState: { switchId: row.id, status: "active", verifiedAt: state.newProof!.observedAt },
      });
      changed = true;
    }
    if (!changed) return;
    await tx
      .update(ownerSubscriptions)
      .set({ revision: portfolio.revision + 1, subscriptions: entries, updatedAt: new Date() })
      .where(eq(ownerSubscriptions.ownerId, row.ownerId));
    if (state.oldProof) {
      const [schedule] = await tx
        .select()
        .from(ownerPriceChecks)
        .where(
          and(eq(ownerPriceChecks.ownerId, row.ownerId), eq(ownerPriceChecks.serviceId, state.old.serviceId)),
        )
        .for("update");
      if (schedule) {
        await tx
          .insert(ownerPriceChecks)
          .values({
            ownerId: row.ownerId,
            serviceId: id,
            revision: 1,
            cadence: schedule.cadence,
            anchorAt: schedule.anchorAt,
            nextCheckAt:
              schedule.cadence && schedule.status !== "paused" ? (schedule.nextCheckAt ?? new Date()) : null,
            status: schedule.cadence && schedule.status !== "paused" ? "scheduled" : "paused",
          })
          .onConflictDoNothing();
        await tx
          .update(ownerPriceChecks)
          .set({
            revision: schedule.revision + 1,
            status: "paused",
            nextCheckAt: null,
            retryAt: null,
            leaseToken: null,
            leaseUntil: null,
          })
          .where(
            and(
              eq(ownerPriceChecks.ownerId, row.ownerId),
              eq(ownerPriceChecks.serviceId, state.old.serviceId),
            ),
          );
      }
    }
  });
}

/** One step per durable lease; writes are marked sent before crossing the network. */
export async function runSwitchJobs(ctx: AppContext, targetId?: string) {
  if (!ctx.config.switching) return 0;
  const [candidate] = await ctx.db
    .select()
    .from(switches)
    .where(
      and(
        targetId ? eq(switches.id, targetId) : undefined,
        sql`${switches.nextAttemptAt} <= now() and (${switches.leaseUntil} is null or ${switches.leaseUntil} <= now()) and ((${switches.phase} not in ('needs_user','awaiting_approval','completed','stopped')) or (${switches.phase} in ('completed','stopped') and ${switches.browserSlots} > 0) or (${switches.phase} in ('needs_user','awaiting_approval') and ${switches.updatedAt} < now() - interval '15 minutes' and not ((${switches.state}->>'purchaseDispatchedAt' is not null and ${switches.state}->'newProof' = 'null'::jsonb) or (${switches.state}->>'cancelDispatchedAt' is not null and ${switches.state}->'oldProof' = 'null'::jsonb))))`,
      ),
    )
    .orderBy(switches.nextAttemptAt)
    .limit(1);
  if (!candidate) return 0;
  ctx = (await ctx.switchContextForOwner?.(candidate.ownerId)) ?? ctx;
  if (!ctx.config.switching) return 0;
  const connection = await ctx.db.$client.connect();
  let locked = false,
    releaseModel: (() => Promise<void>) | undefined;
  try {
    const claim = await connection.query("select pg_try_advisory_lock(hashtextextended($1,0)) as locked", [
      `val-switch:${candidate.id}`,
    ]);
    if (!claim.rows[0]?.locked) return 0;
    locked = true;
    let row = await ctx.db.transaction(async (tx) => {
      if (!(await currentWorker(ctx, tx))) return null;
      const [value] = await tx.select().from(switches).where(eq(switches.id, candidate.id)).for("update");
      if (
        !value ||
        value.nextAttemptAt.getTime() > Date.now() ||
        (value.leaseUntil && value.leaseUntil.getTime() > Date.now()) ||
        (["needs_user", "awaiting_approval"].includes(value.phase) && !waitingExpired(value))
      )
        return null;
      const [leased] = await tx
        .update(switches)
        .set({ leaseToken: randomUUID(), leaseUntil: new Date(Date.now() + 180_000) })
        .where(eq(switches.id, value.id))
        .returning();
      return leased!;
    });
    if (!row?.secrets) return 0;
    const runtime = runtimeFor(ctx),
      secret = openSwitch<SwitchSecrets>(ctx.config, row.ownerId, row.id, row.secrets);
    const save = async (phase: SwitchPhase, message: string, delay = 1000) => {
      row!.state.message = message;
      const updated = await ctx.db.transaction(async (tx) => {
        if (!(await currentWorker(ctx, tx))) throw Error("Switch worker changed");
        const [value] = await tx
          .update(switches)
          .set({
            phase,
            state: row!.state,
            secrets: sealSwitch(ctx.config, row!.ownerId, row!.id, secret),
            revision: row!.revision + 1,
            nextAttemptAt: new Date(Date.now() + delay),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(switches.id, row!.id),
              eq(switches.leaseToken, row!.leaseToken!),
              eq(switches.revision, row!.revision),
            ),
          )
          .returning();
        return value;
      });
      if (!updated) throw Error("Switch lease changed");
      row = updated;
      return updated;
    };
    const pause = async (message: string, side?: Side) => {
      row!.state.resume = row!.phase as WorkingPhase;
      row!.state.handoffSide = side ?? null;
      if (side && secret.browsers[side]) await runtime.handoff(secret.browsers[side]!);
      await save("needs_user", message);
    };
    try {
      await publishSwitch(ctx, row);
      if (terminal(row.phase)) {
        // Named resources cover an interrupted create whose response was never saved.
        for (const side of ["old", "new"] as const) {
          const browser = secret.browsers[side] ?? {
            id: `val-switch-${row.id}-${side}`,
            profile: `val-switch-${row.id}-${side}`,
            url: "",
          };
          await runtime.cleanup(browser);
          delete secret.browsers[side];
        }
        row.browserSlots = 0;
        await ctx.db
          .update(switches)
          .set({
            browserSlots: 0,
            secrets: unresolved(row.state)
              ? sealSwitch(ctx.config, row.ownerId, row.id, { ...secret, prepared: {} })
              : null,
            leaseUntil: null,
            leaseToken: null,
          })
          .where(and(eq(switches.id, row.id), eq(switches.leaseToken, row.leaseToken!)));
        return 1;
      }
      if (
        (ctx.config.switching.preparationOnly || row.state.preparationOnly) &&
        ["purchasing", "cancelling_old"].includes(row.phase)
      ) {
        row.state.approval = null;
        await save(
          "stopped",
          "This connection prepares switches only. No further purchase or cancellation will be submitted.",
        );
        return 1;
      }
      if (waitingExpired(row)) {
        row.state.stopped = true;
        row.state.approval = null;
        await save(
          "stopped",
          "This switch expired while waiting for input. Your last verified provider status is saved; no further action will be submitted.",
        );
        return 1;
      }
      if (row.state.steps >= 60 || Date.now() - row.createdAt.getTime() > 3_600_000) {
        await pause(
          "I’ve paused this switch rather than guess. Any submitted action will only be checked, never repeated.",
        );
        return 1;
      }
      const side: Side = ["preparing_old", "cancelling_old", "verifying_old"].includes(row.phase)
        ? "old"
        : "new";
      {
        const paymentOrigin =
          ctx.config.switching.environment === "sandbox"
            ? "https://www.sandbox.paypal.com"
            : "https://www.paypal.com";
        secret.browsers[side] = await runtime.create(
          `val-switch-${row.id}-${side}`,
          side === "old" ? secret.oldUrl : secret.newUrl,
          paymentOrigin,
          secret.salt,
        );
        await save(row.phase, row.state.message);
      }
      const browser = secret.browsers[side]!;
      const page = await runtime.observe(browser);
      if (page.needsUser) {
        await pause(
          "Please sign in or complete PayPal’s approval in the provider browser, then return here. I never enter passwords, verification codes or payment details.",
          side,
        );
        return 1;
      }
      if (row.phase === "purchasing" || row.phase === "cancelling_old") {
        const purchase = row.phase === "purchasing";
        const sent = purchase ? row.state.purchaseDispatchedAt : row.state.cancelDispatchedAt;
        const next = purchase ? "verifying_new" : "verifying_old";
        if (sent) {
          await save(next, "I’m checking the submitted action. I will not submit it again.");
          return 1;
        }
        const prepared = secret.prepared[side],
          approval = row.state.approval;
        if (
          !purchase &&
          (!row.state.newProof || Date.now() - Date.parse(row.state.newProof.observedAt) > 120_000)
        ) {
          await save("verifying_new", "I’m confirming the replacement is still active before cancelling.");
          return 1;
        }
        if (
          !approval?.grantedAt ||
          Date.parse(approval.expiresAt) <= Date.now() ||
          !prepared ||
          prepared.page.digest !== page.digest
        ) {
          row.state.approval = null;
          await save(
            purchase ? "preparing_new" : "preparing_old",
            "The checkout or cancellation page changed. I’ll ask you to review the new terms before acting.",
          );
          return 1;
        }
        const [portfolio] = await ctx.db
          .select()
          .from(ownerSubscriptions)
          .where(eq(ownerSubscriptions.ownerId, row.ownerId));
        if (
          !portfolio?.subscriptions.some(
            (item) => item.serviceId === row!.state.old.serviceId && basis(item) === row!.state.oldBasis,
          ) ||
          !(await currentWorker(ctx))
        ) {
          await pause("Your subscription details changed. I’ve paused before submitting anything.");
          return 1;
        }
        if (purchase) row.state.purchaseDispatchedAt = iso();
        else row.state.cancelDispatchedAt = iso();
        await save(next, "The action is being submitted once. I’ll verify its result next.");
        try {
          await runtime.act(browser, page, prepared.action, true);
        } catch (error) {
          if (error instanceof SwitchRuntimeError && error.code === "page_changed") {
            if (purchase) row.state.purchaseDispatchedAt = null;
            else row.state.cancelDispatchedAt = null;
            row.state.approval = null;
            await save(
              purchase ? "preparing_new" : "preparing_old",
              "The page changed before the click. Please review the refreshed terms.",
            );
          }
          // A timeout after dispatch is uncertain, not a failed purchase. The next step is read-only.
        }
        return 1;
      }
      releaseModel = await acquireModelWork(ctx.db.$client, row.ownerId);
      const task =
        row.phase === "preparing_old"
          ? "prepare_old"
          : row.phase === "preparing_new"
            ? "prepare_new"
            : row.phase === "verifying_new"
              ? "verify_new"
              : "verify_old";
      const decision = await decideSwitch(ctx, row.ownerId, {
        task,
        name: side === "old" ? row.state.old.name : row.state.candidate.name,
        plan: side === "old" ? row.state.old.name : row.state.candidate.plan,
        page,
        ...(side === "old" && row.state.cancellation ? { reference: row.state.cancellation.reference } : {}),
        terms: row.state.terms,
        purpose: row.state.old.purpose,
        currency: side === "old" ? (row.state.old.currency ?? "GBP") : undefined,
      });
      row.state.steps++;
      if (decision.kind === "handoff") {
        await pause(
          "I need you to review this provider page before I can continue. " + decision.reason,
          side,
        );
        return 1;
      }
      if (["click", "fill", "select", "refresh"].includes(decision.kind)) {
        if (decision.kind !== "refresh" && !page.controls.some((control) => control.ref === decision.ref))
          throw Error("Unobserved browser control");
        await runtime.act(
          browser,
          page,
          { kind: decision.kind as SwitchAction["kind"], ref: decision.ref, text: decision.text },
          false,
        );
        await save(row.phase, "I’m checking the provider’s next page.");
        return 1;
      }
      const prepareApproval = async () => {
        row!.state.approval = {
          digest: contractDigest(row!, secret),
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          grantedAt: null,
        };
        await save(
          "awaiting_approval",
          row!.state.preparationOnly || ctx.config.switching?.preparationOnly
            ? "I’ve prepared the current terms for review. Purchases and cancellations are off for this connection."
            : row!.state.newProof
              ? "Your replacement is active. Review these refreshed cancellation terms before I end the old subscription."
              : "Review the exact charge, renewal and cancellation terms. I’ll only cancel the old subscription after the replacement is confirmed active.",
        );
      };
      if (
        task === "prepare_old" &&
        decision.kind === "ready_cancel" &&
        decision.cancellation &&
        validSwitchCancellation(decision.cancellation, page.text) &&
        switchText(page.text).toLowerCase().includes(switchText(row.state.old.name).toLowerCase()) &&
        page.controls.some((control) => control.ref === decision.ref)
      ) {
        row.state.cancellation = decision.cancellation;
        secret.prepared.old = { page, action: { kind: "click", ref: decision.ref, text: "" } };
        if (row.state.newProof) await prepareApproval();
        else
          await save(
            "preparing_new",
            "I have the old cancellation terms. I’m preparing the replacement without purchasing.",
          );
      } else if (
        task === "prepare_new" &&
        decision.kind === "ready_purchase" &&
        decision.terms &&
        validSwitchTerms(decision.terms, page.text, row.state.candidate.name) &&
        switchText(decision.terms.plan).toLowerCase() ===
          switchText(row.state.candidate.plan).toLowerCase() &&
        page.controls.some((control) => control.ref === decision.ref)
      ) {
        row.state.terms = decision.terms;
        secret.prepared.new = { page, action: { kind: "click", ref: decision.ref, text: "" } };
        await prepareApproval();
      } else if (
        task === "verify_new" &&
        decision.kind === "active" &&
        row.state.purchaseDispatchedAt &&
        row.state.terms &&
        validSwitchActivation(decision.evidence, page.text, row.state.terms)
      ) {
        row.state.newProof = { ...decision.evidence!, observedAt: iso() };
        await save(
          "cancelling_old",
          "Your replacement is confirmed active. I’m now checking the old cancellation.",
        );
        await publishSwitch(ctx, row);
      } else if (
        task === "verify_old" &&
        decision.kind === "cancelled" &&
        row.state.cancelDispatchedAt &&
        row.state.newProof &&
        validSwitchEvidence(decision.evidence, page.text, "cancelled", row.state.cancellation?.reference)
      ) {
        row.state.oldProof = { ...decision.evidence!, observedAt: iso() };
        await save(
          "completed",
          "Your replacement is active and the old renewal is cancelled. I’ve kept your saved needs.",
        );
        await publishSwitch(ctx, row);
      } else
        await pause(
          "I couldn’t establish the exact terms or account status from this page. I’ve paused rather than purchase, cancel or claim success without evidence.",
          side,
        );
    } catch {
      row.state.failures = (row.state.failures ?? 0) + 1;
      if (!terminal(row.phase) && row.state.failures <= 2)
        await save(
          row.phase,
          "The provider is taking a moment. I’ll retry the check without repeating a submitted purchase or cancellation.",
          5000 * row.state.failures,
        );
      else if (!terminal(row.phase))
        await pause(
          "The provider check couldn’t finish. Your progress is saved. If an action was submitted, I’ll check its result without repeating it.",
        );
      else await save(row.phase, row.state.message, 60_000);
    } finally {
      await ctx.db
        .update(switches)
        .set({ leaseToken: null, leaseUntil: null })
        .where(and(eq(switches.id, row.id), eq(switches.leaseToken, row.leaseToken!)));
    }
    return 1;
  } finally {
    try {
      await releaseModel?.();
    } finally {
      let broken = false;
      try {
        if (locked)
          await connection.query("select pg_advisory_unlock(hashtextextended($1,0))", [
            `val-switch:${candidate.id}`,
          ]);
      } catch {
        broken = true;
      } finally {
        connection.release(broken);
      }
    }
  }
}
