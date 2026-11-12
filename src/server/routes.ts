import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, desc, eq, sql } from "drizzle-orm";
import express, { Router, type ErrorRequestHandler, type RequestHandler } from "express";
import { validate } from "../shared/contracts";
import type { CatalogueResponse } from "../shared/contracts.types";
import { loadSession, requireAdmin, requireCsrf, requireLogin, sessionRoutes } from "./auth";
import { caseSnapshot, createCase, listCases, listEvidence, ownedCase, resetCase } from "./cases";
import type { AppContext } from "./context";
import { artifacts, cases, operations } from "./db/schema";
import { authorizeExits, createExitReview, pauseExits } from "./exits";
import { HttpError, parseBody } from "./http";
import { applyScenario, requestCheck } from "./investigation";
import { queueJob } from "./jobs";
import {
  acceptReturn,
  cancelProbeSubscription,
  retireTerminalOperation,
  startSubscription,
  toOperation,
  type OperationRow,
} from "./operations";
import { merchantForProvider } from "./plans";
import { confirmPolicy } from "./policy";
import { draftPolicy } from "./policy-draft";
import { checkout, createPreview, declinePurchase, recordConsent } from "./preview";
import { retryOperation } from "./transition";
import { webhookRoutes } from "./webhooks";
import { paypalLoginRoutes } from "./paypal-login";
import { runWhatIf } from "./what-if";
import { subscriptionRoutes } from "./subscriptions";
import { subscriptionAdviceRoutes } from "./subscription-advice";
import { reviewBatchRoutes } from "./review-batches";
import { valChatRoutes } from "./val-chat";
import { chatRequestRoutes } from "./chat-requests";
import { withMobileServices } from "./mobile-catalogue";
import { judgeAccessRoutes, requireJudgeAccess } from "./judge-access";
import { judgeBudgetStatus } from "./judge-budget";
import { bindBuildProfile } from "./build-profile";
import { requestLimits } from "./request-limits";
import { priceCheckRoutes } from "./price-checks";
import { paypalIdentityEndpoints } from "../shared/paypal-identity";
import { reportFailure } from "./logging";
import { paypalWalletRoutes } from "./paypal-wallet";
import { subscriptionInsightsRoutes } from "./subscription-insights";
import { subscriptionSwitchRoutes } from "./subscription-switch";
import { switchExampleRoutes } from "./switch-example";

const defaultClientDir = fileURLToPath(new URL("../../dist/client", import.meta.url));
const catalogue = withMobileServices(
  JSON.parse(
    readFileSync(new URL("../../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
  ) as CatalogueResponse["catalogue"],
);
const catalogueResponse: CatalogueResponse = { catalogue, logos: {} };

/** Disposable Sandbox plans for verifying both merchant return paths. */
const probePlanIds = { A: "a_01", B: "b_02" } as const;

/** Faults supported by the administrator's isolated test workflow. */
const supportedFaults = { price_change: true, output_failure: true, import_failure: true, timeout: true };

/** Browser hardening for every response: no framing of consent screens, no MIME sniffing, no referrer leaks, HSTS when served over HTTPS. */
const securityHeaders =
  (ctx: AppContext): RequestHandler =>
  (_req, res, next) => {
    res.set({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://www.paypalobjects.com; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'; form-action 'self' ${new URL(paypalIdentityEndpoints[ctx.config.paypalIdentityEnvironment ?? "sandbox"].connect).origin}`,
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    });
    if (ctx.config.secureCookies) res.set("Strict-Transport-Security", "max-age=15552000; includeSubDomains");
    next();
  };

export function createApp(ctx: AppContext, clientDir?: string, identityFetch: typeof fetch = fetch) {
  const financialTools =
    !ctx.config.paypalSandboxSubscriptions?.length &&
    ctx.config.buildProfile !== "public" &&
    ctx.config.paypalIdentityEnvironment !== "live" &&
    ctx.config.paypalWallet?.environment !== "live";
  clientDir ??= defaultClientDir;
  const app = express();
  app.disable("x-powered-by");
  // Express walks right-to-left and stops at the first untrusted peer; ingress must append the real client.
  app.set("trust proxy", ctx.config.trustedProxyCidrs?.length ? ctx.config.trustedProxyCidrs : false);
  app.use(securityHeaders(ctx));
  const ready = bindBuildProfile(ctx);
  // Retain the failure for requests without producing an unhandled rejection during startup.
  void ready.catch(() => {});
  app.use(async (_req, _res, next) => {
    await ready;
    next();
  });
  app.use((req, _res, next) => {
    let path: string;
    try {
      path = decodeURIComponent(req.path).replace(/\\/g, "/");
    } catch {
      throw new HttpError(400, "bad_path", "Request path not accepted.");
    }
    const segments = path.split("/").filter(Boolean);
    if (
      segments.some((part) => part.startsWith(".")) ||
      ["private", "node_modules", "sources"].includes(segments[0] ?? "")
    )
      throw new HttpError(404, "not_found", "No such resource.");
    next();
  });

  app.get("/healthz", async (_req, res) => {
    await ctx.db.execute(sql`select 1`);
    res.json({ status: "ok" });
  });
  app.use("/logos", (_req, res) => {
    res.sendStatus(404);
  });

  const api = Router();
  api.use((_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  api.use(requestLimits(ctx));
  api.get("/deployment", (_req, res) =>
    res.json({
      passwordAccess: ctx.config.buildProfile !== "public" && ctx.config.paypalIdentityEnvironment !== "live",
      financialTools,
      ...(ctx.config.switching
        ? {
            kernelSwitching: {
              environment: ctx.config.switching.environment,
              testOrigins: ctx.config.switching.testOrigins,
              preparationOnly: !!ctx.config.switching.preparationOnly,
            },
          }
        : {}),
      paypalIdentityEnvironment: ctx.config.paypalIdentityEnvironment ?? "sandbox",
      ...(ctx.config.paypalWallet ? { paypalWallet: true } : {}),
      ...(ctx.config.paypalSandboxSubscriptions?.length ? { paypalSandboxDemo: true } : {}),
      ...(ctx.config.paypalSandboxDemoEntry ? { paypalSandboxDemoEntry: true } : {}),
      ...(ctx.config.switchExample ? { switchExample: { company: ctx.config.switchExample.company } } : {}),
    }),
  );
  if (financialTools) api.use(webhookRoutes(ctx));
  api.use(express.json({ limit: "64kb" }));
  api.use(loadSession(ctx), requireCsrf(ctx));
  api.use(sessionRoutes(ctx));
  api.use(judgeAccessRoutes(ctx));
  api.use(requireJudgeAccess(ctx));
  if (ctx.config.buildProfile !== "public")
    api.get("/judge/usage", async (_req, res) => {
      requireAdmin(res);
      res.json(await judgeBudgetStatus(ctx));
    });
  api.use(paypalLoginRoutes(ctx, identityFetch));
  api.use(paypalWalletRoutes(ctx, catalogue.services));
  api.use(subscriptionRoutes(ctx, catalogue.services));
  api.use(subscriptionAdviceRoutes(ctx, catalogue));
  api.use(reviewBatchRoutes(ctx, catalogue));
  api.use(priceCheckRoutes(ctx, catalogue));
  api.use(valChatRoutes(ctx, catalogue));
  api.use(chatRequestRoutes(ctx, catalogue));
  api.use(subscriptionInsightsRoutes(ctx, catalogue));
  api.use(subscriptionSwitchRoutes(ctx, catalogue));
  api.use(switchExampleRoutes(ctx, catalogue));
  if (!financialTools) {
    api.get("/cases", (_req, res) => {
      requireLogin(res);
      res.json([]);
    });
    api.get("/catalogue", (_req, res) => {
      requireLogin(res);
      res.json(catalogueResponse);
    });
  } else {
    api.use(caseRoutes(ctx));
    api.use(adminRoutes(ctx));
  }
  api.use((_req, _res) => {
    throw new HttpError(404, "not_found", "No such API endpoint.");
  });
  app.use("/api", api);

  // PayPal return pages are served by the client bridge. They must not be cached or leak the return token.
  app.use("/paypal", (_req, res, next) => {
    res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
    next();
  });
  if (existsSync(clientDir)) {
    app.use(
      express.static(clientDir, {
        setHeaders(res, file) {
          // Only content-addressed build assets survive a new release unchanged.
          // HTML, account responses and PayPal returns retain their existing policy.
          if (/[/\\]assets[/\\][^/\\]+-[\w-]{8,}\.[\w]+$/.test(file))
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        },
      }),
    );
    app.get("/{*path}", (_req, res) => res.sendFile("index.html", { root: clientDir }));
  }

  app.use(errorResponse);
  return app;
}

const errorResponse: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof HttpError) {
    if (error.retryAfterSeconds) res.set("Retry-After", String(error.retryAfterSeconds));
    return void res.status(error.status).json({ error: error.code, message: error.message });
  }
  const clientError = error && typeof error.status === "number" && error.status >= 400 && error.status < 500;
  if (clientError)
    return void res
      .status(error.status)
      .json({ error: "bad_request", message: "Request could not be read." });
  const reference = reportFailure("request_failed", error);
  res.status(500).json({ error: "internal_error", message: "Something went wrong.", reference });
};

function caseRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/cases", async (_req, res) => {
    const { ownerId } = requireLogin(res);
    res.json(await listCases(ctx.db, ownerId));
  });

  router.post("/cases", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const { scenario } = parseBody(validate.createCaseCommand, req.body);
    res.status(201).json(await caseSnapshot(ctx.db, await createCase(ctx.db, ownerId, scenario)));
  });

  router.get("/cases/:id", async (req, res) => {
    const { ownerId } = requireLogin(res);
    res.json(await caseSnapshot(ctx.db, await ownedCase(ctx.db, ownerId, req.params.id)));
  });

  router.get("/catalogue", (_req, res) => {
    requireLogin(res);
    res.json(catalogueResponse);
  });

  router.get("/cases/:id/evidence", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    res.json(await listEvidence(ctx.db, caseRow.id));
  });

  router.post("/cases/:id/setup-subscription", async (req, res) => {
    const { ownerId } = requireLogin(res);
    parseBody(validate.emptyCommand, req.body);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    if (caseRow.state !== "SETUP" || caseRow.archivedAt)
      throw new HttpError(409, "setup_unavailable", "This case is not waiting for its initial subscription.");
    res.json(await startSubscription(ctx, { caseRow, kind: "setup_create", planId: "a_01", probe: false }));
  });

  router.post("/cases/:id/setup-subscription/return", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    res.json(
      await acceptReturn(ctx, {
        caseRow,
        kind: "setup_create",
        command: parseBody(validate.returnCommand, req.body),
      }),
    );
  });

  router.post("/cases/:id/checkout/return", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    res.json(
      await acceptReturn(ctx, {
        caseRow,
        kind: "replacement_create",
        command: parseBody(validate.returnCommand, req.body),
      }),
    );
  });

  router.post("/cases/:id/policy-draft", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const { purpose } = parseBody(validate.draftCommand, req.body);
    res.json(await draftPolicy(ctx, await ownedCase(ctx.db, ownerId, req.params.id), purpose));
  });

  router.put("/cases/:id/policy", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    res.json(await confirmPolicy(ctx, caseRow, parseBody(validate.policyCommand, req.body)));
  });

  router.post("/cases/:id/check", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.checkCommand, req.body);
    res.json(
      await requestCheck(
        ctx,
        await ownedCase(ctx.db, ownerId, req.params.id),
        command.expectedPolicyRevision,
      ),
    );
  });

  router.post("/cases/:id/what-if", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.whatIfCommand, req.body);
    res.json(await runWhatIf(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/scenario", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.scenarioCommand, req.body);
    res.json(await applyScenario(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/preview", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.previewCommand, req.body);
    res.json(await createPreview(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/consents", async (req, res) => {
    const auth = requireLogin(res);
    const command = parseBody(validate.consentCommand, req.body);
    res
      .status(201)
      .json(
        await recordConsent(
          ctx,
          await ownedCase(ctx.db, auth.ownerId, req.params.id),
          { sessionId: auth.sessionIdHash },
          command,
        ),
      );
  });

  router.post("/cases/:id/decline", async (req, res) => {
    const { ownerId } = requireLogin(res);
    parseBody(validate.emptyCommand, req.body);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    await declinePurchase(ctx, caseRow);
    res.json(await caseSnapshot(ctx.db, await ownedCase(ctx.db, ownerId, caseRow.id)));
  });

  router.post("/cases/:id/checkout", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.checkoutCommand, req.body);
    res.json(await checkout(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/exit-review", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.exitReviewCommand, req.body);
    res.json(await createExitReview(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/exit-authorizations", async (req, res) => {
    const auth = requireLogin(res);
    const command = parseBody(validate.exitAuthorizationCommand, req.body);
    const authorization = await authorizeExits(
      ctx,
      await ownedCase(ctx.db, auth.ownerId, req.params.id),
      { sessionId: auth.sessionIdHash },
      command,
    );
    await queueJob(ctx.db, authorization.caseId, `exit-authorization:${authorization.id}`);
    res.status(201).json(authorization);
  });

  router.post("/cases/:id/pause-exits", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.pauseExitsCommand, req.body);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    await pauseExits(ctx, caseRow, command);
    res.json(await caseSnapshot(ctx.db, await ownedCase(ctx.db, ownerId, caseRow.id)));
  });

  router.post("/cases/:id/retry", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const command = parseBody(validate.retryCommand, req.body);
    res.json(await retryOperation(ctx, await ownedCase(ctx.db, ownerId, req.params.id), command));
  });

  router.post("/cases/:id/reset", async (req, res) => {
    const { ownerId } = requireLogin(res);
    parseBody(validate.resetCommand, req.body);
    const fresh = await resetCase(ctx.db, await ownedCase(ctx.db, ownerId, req.params.id));
    res.status(201).json(await caseSnapshot(ctx.db, fresh));
  });

  router.post("/cases/:id/reconcile", async (req, res) => {
    const { ownerId } = requireLogin(res);
    parseBody(validate.emptyCommand, req.body);
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    const job = await queueJob(ctx.db, caseRow.id, `manual:${randomUUID()}`);
    res.json({ jobId: job.id, caseId: caseRow.id });
  });

  router.get("/artifacts/:id", async (req, res) => {
    const { ownerId } = requireLogin(res);
    const [artifact] = await ctx.db
      .select({ mimeType: artifacts.mimeType, content: artifacts.content, id: artifacts.id })
      .from(artifacts)
      .innerJoin(cases, eq(cases.id, artifacts.caseId))
      .where(and(eq(artifacts.id, req.params.id), eq(cases.ownerId, ownerId)));
    if (!artifact) throw new HttpError(404, "artifact_not_found", "No such artifact.");
    res.set({
      "Content-Type": artifact.mimeType,
      "Content-Disposition": `attachment; filename="artifact-${artifact.id}.json"`,
      "X-Content-Type-Options": "nosniff",
    });
    res.send(artifact.content);
  });

  return router;
}

/** Operations still waiting on a write result, a payment verdict or (for probes) cancellation. */
function isUnresolved(operation: OperationRow): boolean {
  if (operation.retiredAt) return false;
  const createsSubscription = operation.kind === "setup_create" || operation.kind === "replacement_create";
  if (!createsSubscription) return operation.status !== "SUCCEEDED";
  if (operation.status === "FAILED") return false;
  if (operation.billingStatus === "CANCELLED" || operation.billingStatus === "EXPIRED") return false;
  return operation.probe || operation.status !== "SUCCEEDED" || operation.paymentStatus !== "VERIFIED";
}

function adminRoutes(ctx: AppContext): Router {
  const router = Router();

  router.get("/admin/operations", async (_req, res) => {
    requireAdmin(res);
    const recent = await ctx.db.select().from(operations).orderBy(desc(operations.createdAt)).limit(200);
    res.json(recent.filter(isUnresolved).map(toOperation));
  });

  /** Creates a disposable Sandbox subscription to check return bridges and payment evidence. */
  router.post("/admin/cases/:id/probe-subscription/:providerId", async (req, res) => {
    const { ownerId } = requireAdmin(res);
    parseBody(validate.emptyCommand, req.body);
    const merchant = merchantForProvider(req.params.providerId);
    if (!merchant) throw new HttpError(404, "unknown_provider", "Unknown provider.");
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    const kind = merchant === "A" ? "setup_create" : "replacement_create";
    res.json(await startSubscription(ctx, { caseRow, kind, planId: probePlanIds[merchant], probe: true }));
  });

  router.post("/admin/cases/:id/fault", async (req, res) => {
    const { ownerId } = requireAdmin(res);
    const { fault, enabled } = parseBody(validate.faultCommand, req.body);
    if (!(fault in supportedFaults))
      throw new HttpError(409, "fault_unavailable", "This test fault is not supported.");
    const caseRow = await ownedCase(ctx.db, ownerId, req.params.id);
    await ctx.db
      .update(cases)
      .set({ faults: { ...caseRow.faults, [fault]: enabled } })
      .where(eq(cases.id, caseRow.id));
    res.json(await caseSnapshot(ctx.db, await ownedCase(ctx.db, ownerId, caseRow.id)));
  });

  router.post("/admin/operations/:id/cleanup", async (req, res) => {
    requireAdmin(res);
    const { expectedClaimGeneration } = parseBody(validate.cleanupCommand, req.body);
    res.json(await retireTerminalOperation(ctx, { operationId: req.params.id, expectedClaimGeneration }));
  });

  router.post("/admin/operations/:id/probe-cancel", async (req, res) => {
    const { ownerId } = requireAdmin(res);
    parseBody(validate.emptyCommand, req.body);
    res.json(toOperation(await cancelProbeSubscription(ctx, { ownerId, operationId: req.params.id })));
  });

  return router;
}
