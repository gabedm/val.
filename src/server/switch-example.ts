import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Router } from "express";
import type { CatalogueResponse } from "../shared/contracts.types";
import { switchExampleConsent, type SwitchExampleView } from "../shared/switch-example";
import { switchConsentVersion } from "../shared/subscription-switch";
import { requireLogin } from "./auth";
import type { AppContext } from "./context";
import { owners, ownerSubscriptions, ownerSwitchExamples, ownerSubscriptionSwitches } from "./db/schema";
import { HttpError } from "./http";
import { createModelFundingGroup, modelForOwner } from "./judge-budget";
import { switchDigest } from "./switch-security";
import { isCurrentSubscription, type SubscriptionEntry } from "../shared/subscriptions";
import { prepareSelectedSwitch, subscriptionSwitchRoutes } from "./subscription-switch";

type Example = typeof ownerSwitchExamples.$inferSelect;
interface Plan {
  name: string;
  plan: string;
  amountMinor: number;
  currency: "GBP";
}
interface ProviderState {
  company: string;
  old: Plan & { status: string; subscriptionId: string | null };
  replacement: Plan;
  setupUrl: string | null;
  oldEntry: string;
  newEntry: string;
}
const unavailable = () =>
  new HttpError(
    503,
    "switch_example_unavailable",
    "The Sandbox example is unavailable. Your subscriptions have not changed.",
  );
const sourceBasis = (row: SubscriptionEntry) =>
  switchDigest({
    id: row.serviceId,
    name: row.name,
    purpose: row.purpose,
    amount: row.amountMinor,
    currency: row.currency,
    cycle: row.cycle,
  });
async function selectedSource(ctx: AppContext, ownerId: string, id: string) {
  const [portfolio] = await ctx.db
    .select()
    .from(ownerSubscriptions)
    .where(eq(ownerSubscriptions.ownerId, ownerId));
  const item = portfolio?.subscriptions.find((row) => row.serviceId === id && isCurrentSubscription(row));
  if (!item?.purpose.trim())
    throw new HttpError(409, "switch_example_needs", "Tell Val what matters for this subscription first.");
  return { item, revision: portfolio!.revision };
}
function config(ctx: AppContext) {
  const value = ctx.config.switchExample;
  if (
    !value ||
    ctx.config.buildProfile !== "judge" ||
    !ctx.config.judgeDemo ||
    ctx.config.paypalIdentityEnvironment === "live" ||
    !ctx.config.switching ||
    !ctx.config.merchants.A
  )
    throw new HttpError(404, "not_found", "This example is unavailable.");
  return value;
}
async function owned(ctx: AppContext, ownerId: string) {
  const [row] = await ctx.db
    .select()
    .from(ownerSwitchExamples)
    .where(eq(ownerSwitchExamples.ownerId, ownerId));
  if (row && row.providerOrigin !== config(ctx).providerOrigin) throw unavailable();
  return row;
}
function plan(value: any): value is Plan {
  return (
    !!value &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    value.name.length <= 120 &&
    typeof value.plan === "string" &&
    value.plan.length > 0 &&
    value.plan.length <= 120 &&
    Number.isSafeInteger(value.amountMinor) &&
    value.amountMinor > 0 &&
    value.amountMinor <= 1000 &&
    value.currency === "GBP"
  );
}
async function provider(ctx: AppContext, path: string, body?: object): Promise<ProviderState> {
  const settings = config(ctx);
  let response: globalThis.Response;
  try {
    response = await fetch(settings.providerOrigin + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${settings.operatorKey}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw unavailable();
  }
  const value = (await response.json().catch(() => null)) as any;
  if (!response.ok || value?.company !== settings.company || !plan(value?.old) || !plan(value?.replacement))
    throw unavailable();
  if (
    !["NOT_CREATED", "APPROVAL_PENDING", "ACTIVE", "CANCELLED", "SUSPENDED", "EXPIRED"].includes(
      value.old.status,
    ) ||
    (value.old.subscriptionId !== null && !/^I-[A-Z0-9]{10,24}$/.test(value.old.subscriptionId))
  )
    throw unavailable();
  for (const key of ["oldEntry", "newEntry"]) {
    const url = URL.parse(value[key]);
    if (
      !url ||
      url.origin !== settings.providerOrigin ||
      url.pathname !== "/connect" ||
      !url.hash ||
      url.href.length > 2500
    )
      throw unavailable();
  }
  if (value.setupUrl !== null) {
    const url = URL.parse(value.setupUrl);
    if (!url || url.origin !== "https://www.sandbox.paypal.com" || url.username || url.password)
      throw unavailable();
  }
  return value;
}
async function snapshot(ctx: AppContext, row?: Example) {
  return provider(ctx, row ? `/operator/sessions/${row.sessionId}` : "/operator/catalogue");
}

/** The example spends its parent's existing allowance; a child is never an access grant. */
function execution(ctx: AppContext, row: Example): AppContext {
  const settings = config(ctx);
  if (settings.providerOrigin !== row.providerOrigin || !ctx.model) throw unavailable();
  const funding = createModelFundingGroup(ctx, row.ownerId);
  const funded = (model: NonNullable<AppContext["model"]>) =>
    modelForOwner({ ...ctx, model }, row.ownerId, { concurrentRequests: 2, fundingGroup: funding });
  return {
    ...ctx,
    model: funded(ctx.model),
    conversationModel: ctx.conversationModel ? funded(ctx.conversationModel) : null,
    config: {
      ...ctx.config,
      judgeDemo: null,
      aiBudgetMicros: null,
      switching: {
        ...ctx.config.switching!,
        environment: "sandbox",
        preparationOnly: false,
        testOrigins: [row.providerOrigin],
      },
    },
  };
}
const installed = new WeakSet<AppContext>();
function install(ctx: AppContext) {
  if (installed.has(ctx)) return;
  installed.add(ctx);
  const previous = ctx.switchContextForOwner;
  ctx.switchContextForOwner = async (ownerId) => {
    if (ctx.config.switchExample) {
      const [row] = await ctx.db
        .select()
        .from(ownerSwitchExamples)
        .where(eq(ownerSwitchExamples.exampleOwnerId, ownerId));
      if (row) return execution(ctx, row);
    }
    return previous?.(ownerId);
  };
}
async function view(ctx: AppContext, row?: Example): Promise<SwitchExampleView> {
  const settings = config(ctx),
    state = await snapshot(ctx, row);
  let phase: SwitchExampleView["phase"] = !row
    ? "not_started"
    : state.old.status === "ACTIVE"
      ? "ready"
      : "setup";
  if (row?.switchId) {
    const [job] = await ctx.db
      .select()
      .from(ownerSubscriptionSwitches)
      .where(eq(ownerSubscriptionSwitches.id, row.switchId));
    if (!job || job.ownerId !== row.exampleOwnerId) throw unavailable();
    phase = job.phase === "completed" ? "completed" : "switching";
  } else if (row && !["APPROVAL_PENDING", "ACTIVE"].includes(state.old.status)) phase = "unavailable";
  return {
    company: settings.company,
    purpose: row?.purpose ?? settings.purpose,
    ...(row?.sourceName ? { sourceName: row.sourceName } : {}),
    phase,
    oldPriceMinor: state.old.amountMinor,
    newPriceMinor: state.replacement.amountMinor,
    currency: "GBP",
    setupUrl: state.setupUrl,
    switchId: row?.switchId ?? null,
  };
}
export function switchExampleRoutes(ctx: AppContext, catalogue: CatalogueResponse["catalogue"]) {
  install(ctx);
  const router = Router();
  router.get("/switch-example", async (_req, res) => {
    const { ownerId } = requireLogin(res);
    config(ctx);
    res.json(await view(ctx, await owned(ctx, ownerId)));
  });
  router.post("/switch-example", async (req, res) => {
    const { ownerId } = requireLogin(res),
      settings = config(ctx);
    if (
      !req.body ||
      Object.keys(req.body).some((key) => !["consent", "serviceId", "expectedRevision"].includes(key)) ||
      req.body.consent !== switchExampleConsent ||
      (req.body.serviceId !== undefined &&
        (typeof req.body.serviceId !== "string" ||
          !req.body.serviceId.trim() ||
          req.body.serviceId.length > 120 ||
          !Number.isSafeInteger(req.body.expectedRevision)))
    )
      throw new HttpError(400, "invalid_request", "Choose the Sandbox example to continue.");
    const source = req.body.serviceId ? await selectedSource(ctx, ownerId, req.body.serviceId) : null;
    if (source && source.revision !== req.body.expectedRevision)
      throw new HttpError(409, "revision_conflict", "Your subscriptions changed. Refresh before switching.");
    const row = await ctx.db.transaction(async (tx) => {
      await tx.select().from(owners).where(eq(owners.id, ownerId)).for("update");
      const [existing] = await tx
        .select()
        .from(ownerSwitchExamples)
        .where(eq(ownerSwitchExamples.ownerId, ownerId));
      if (existing) {
        if (
          source &&
          (existing.sourceServiceId !== source.item.serviceId ||
            existing.sourceBasis !== sourceBasis(source.item))
        )
          throw new HttpError(
            409,
            "switch_example_in_progress",
            "This Sandbox example already belongs to another saved selection.",
          );
        return existing;
      }
      const exampleOwnerId = randomUUID();
      await tx.insert(owners).values({ id: exampleOwnerId });
      const [created] = await tx
        .insert(ownerSwitchExamples)
        .values({
          ownerId,
          exampleOwnerId,
          sessionId: randomUUID(),
          providerOrigin: settings.providerOrigin,
          company: settings.company,
          purpose: source?.item.purpose ?? settings.purpose,
          sourceServiceId: source?.item.serviceId ?? null,
          sourceName: source?.item.name ?? null,
          sourceBasis: source ? sourceBasis(source.item) : null,
        })
        .returning();
      return created!;
    });
    if (row.providerOrigin !== settings.providerOrigin) throw unavailable();
    await provider(ctx, "/operator/sessions", {
      id: row.sessionId,
      ...(row.sourceName ? { name: row.sourceName, purpose: row.purpose } : {}),
    });
    res.json(await view(ctx, row));
  });
  router.post("/switch-example/start", async (req, res) => {
    const { ownerId } = requireLogin(res);
    config(ctx);
    if (!req.body || Object.keys(req.body).join() !== "consent" || req.body.consent !== switchConsentVersion)
      throw new HttpError(400, "invalid_request", "Review the switching permission.");
    const row = await owned(ctx, ownerId);
    if (!row) throw unavailable();
    if (row.switchId) return res.json(await view(ctx, row));
    if (row.sourceServiceId) {
      const source = await selectedSource(ctx, ownerId, row.sourceServiceId);
      if (sourceBasis(source.item) !== row.sourceBasis)
        throw new HttpError(
          409,
          "switch_example_changed",
          "Your saved needs changed. Review the selection before switching.",
        );
    }
    const state = await snapshot(ctx, row);
    if (state.old.status !== "ACTIVE" || !state.old.subscriptionId)
      throw new HttpError(409, "switch_example_setup", "Complete PayPal Sandbox setup first.");
    const oldId = "sandbox-example-current",
      newId = "sandbox-example-replacement";
    await ctx.db
      .insert(ownerSubscriptions)
      .values({
        ownerId: row.exampleOwnerId,
        revision: 1,
        subscriptions: [
          {
            serviceId: oldId,
            name: `${state.old.name} ${state.old.plan}`,
            amountMinor: state.old.amountMinor,
            currency: "GBP",
            cycle: "month",
            purpose: row.purpose,
            source: "paypal",
            paypalProduct: {
              name: state.old.name,
              planName: state.old.plan,
              recordedAt: new Date().toISOString(),
            },
          },
        ],
      })
      .onConflictDoNothing();
    const [portfolio] = await ctx.db
      .select()
      .from(ownerSubscriptions)
      .where(eq(ownerSubscriptions.ownerId, row.exampleOwnerId));
    const result = await prepareSelectedSwitch(execution(ctx, row), row.exampleOwnerId, portfolio!.revision, {
      oldServiceId: oldId,
      candidate: { id: newId, name: state.replacement.name, plan: state.replacement.plan },
      oldUrl: state.oldEntry,
      newUrl: state.newEntry,
    });
    await ctx.db
      .update(ownerSwitchExamples)
      .set({ switchId: result.id })
      .where(eq(ownerSwitchExamples.ownerId, ownerId));
    res.json(await view(ctx, { ...row, switchId: result.id }));
  });
  router.use(
    "/switch-example",
    subscriptionSwitchRoutes(ctx, catalogue, async (res) => {
      const parent = requireLogin(res).ownerId;
      config(ctx);
      const row = await owned(ctx, parent);
      if (!row) throw new HttpError(404, "not_found", "This example was not found.");
      return { ctx: execution(ctx, row), ownerId: row.exampleOwnerId };
    }),
  );
  return router;
}
