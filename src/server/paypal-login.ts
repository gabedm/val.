import { randomUUID } from "node:crypto";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { Router } from "express";
import { validate } from "../shared/contracts";
import { issueOwnerCookie, keyedHash, sessionHash, newToken, startSession } from "./auth";
import type { AppContext } from "./context";
import { loginAttempts, loginIdentities, owners, sessions } from "./db/schema";
import { HttpError, parseBody } from "./http";
import { paypalIdentityEndpoints } from "../shared/paypal-identity";
import type { Config } from "./config";
import { sandboxSubscriptions } from "./sandbox-demo";

export const paypalLoginCallback = "/api/auth/paypal/callback";
/** Bind an attempt to both its issuing environment and app, as well as its browser session. */
export function paypalLoginStateHash(config: Config, state: string) {
  return sessionHash(
    config,
    `paypal-login:${config.paypalIdentityEnvironment ?? "sandbox"}:${config.paypalLogin?.clientId}:${state}`,
  );
}

/** Identity only. No subscriptions, payment scopes or existing-owner linking. */
export function paypalLoginRoutes(ctx: AppContext, identityFetch: typeof fetch = fetch) {
  const router = Router();
  router.post("/auth/paypal/demo", async (req, res) => {
    parseBody(validate.emptyCommand, req.body);
    if (
      !ctx.config.paypalSandboxDemoEntry ||
      ctx.config.paypalIdentityEnvironment === "live" ||
      ctx.config.buildProfile === "public" ||
      ctx.config.paypalWallet ||
      !sandboxSubscriptions(ctx.config)
    )
      throw new HttpError(404, "sandbox_entry_unavailable", "Sandbox demo entry is not available.");
    const auth = res.locals.auth;
    if (!auth || auth.role) throw new HttpError(409, "login_state", "Log out before starting another demo.");
    const ownerId = await ctx.db.transaction(async (tx) => {
      const [bootstrap] = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.idHash, auth.sessionIdHash))
        .for("update");
      if (!bootstrap || bootstrap.role || bootstrap.ownerId)
        throw new HttpError(409, "login_state", "This demo entry has already been used.");
      const id = randomUUID();
      await tx.insert(owners).values({ id });
      await tx.delete(sessions).where(eq(sessions.idHash, auth.sessionIdHash));
      return id;
    });
    // Demo visitors never share an owner or receive a fabricated PayPal identity.
    // Billing is fetched separately from the configured Sandbox agreements.
    await issueOwnerCookie(ctx, res, ownerId);
    await startSession(ctx, res, { role: "reviewer", ownerId });
    res.json({ demo: true, environment: "sandbox" });
  });
  router.get("/auth/providers", (_req, res) =>
    res.json({ paypal: !!ctx.config.paypalLogin, google: false, apple: false }),
  );

  router.post("/auth/paypal", async (req, res) => {
    parseBody(validate.emptyCommand, req.body);
    const auth = res.locals.auth;
    if (!auth || auth.role) throw new HttpError(409, "login_state", "Log out before choosing another login.");
    const config = ctx.config.paypalLogin;
    if (!config)
      throw new HttpError(
        503,
        "login_unavailable",
        "PayPal sign-in isn’t configured on this installation yet.",
      );
    await ctx.db.delete(loginAttempts).where(lt(loginAttempts.expiresAt, new Date()));
    const state = newToken();
    // One outstanding attempt per session: a newer attempt invalidates the old tab's state.
    const stateHash = paypalLoginStateHash(ctx.config, state);
    await ctx.db
      .insert(loginAttempts)
      .values({ stateHash, sessionIdHash: auth.sessionIdHash, expiresAt: new Date(Date.now() + 10 * 60_000) })
      .onConflictDoUpdate({
        target: loginAttempts.sessionIdHash,
        set: { stateHash, expiresAt: new Date(Date.now() + 10 * 60_000) },
      });
    const environment = ctx.config.paypalIdentityEnvironment ?? "sandbox";
    const url = new URL(paypalIdentityEndpoints[environment].connect);
    url.search = new URLSearchParams({
      flowEntry: "static",
      client_id: config.clientId,
      response_type: "code",
      scope: "openid",
      redirect_uri: ctx.config.appOrigin + paypalLoginCallback,
      state,
      fullPage: "true",
    }).toString();
    res.json({ approvalUrl: url.toString(), environment });
  });

  router.get("/auth/paypal/callback", async (req, res) => {
    const failed = (reason = "failed") => res.redirect(303, `/?login=${reason}`);
    const auth = res.locals.auth;
    const state = req.query.state;
    if (!ctx.config.paypalLogin || !auth || auth.role || typeof state !== "string" || state.length > 256)
      return void failed("expired");
    // Consume atomically before external calls. Failure, cancellation and replay cannot reuse this state.
    const [attempt] = await ctx.db
      .delete(loginAttempts)
      .where(
        and(
          eq(loginAttempts.stateHash, paypalLoginStateHash(ctx.config, state)),
          eq(loginAttempts.sessionIdHash, auth.sessionIdHash),
          gt(loginAttempts.expiresAt, new Date()),
        ),
      )
      .returning();
    if (!attempt) return void failed("expired");
    if (req.query.error) return void failed("cancelled");
    const code = req.query.code;
    if (typeof code !== "string" || !code || code.length > 4096) return void failed();
    try {
      const { clientId, clientSecret } = ctx.config.paypalLogin;
      const environment = ctx.config.paypalIdentityEnvironment ?? "sandbox";
      const identityApi = paypalIdentityEndpoints[environment].api;
      const tokenResponse = await identityFetch(`${identityApi}/v1/oauth2/token`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: ctx.config.appOrigin + paypalLoginCallback,
        }),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (!tokenResponse.ok) return void failed();
      const token = (await tokenResponse.json()) as { access_token?: unknown; token_type?: unknown };
      if (
        typeof token.access_token !== "string" ||
        !token.access_token ||
        typeof token.token_type !== "string" ||
        token.token_type.toLowerCase() !== "bearer"
      )
        return void failed();
      const profileResponse = await identityFetch(
        `${identityApi}/v1/identity/oauth2/userinfo?schema=openid`,
        {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal: AbortSignal.timeout(15_000),
          redirect: "error",
        },
      );
      if (!profileResponse.ok) return void failed();
      const profile = (await profileResponse.json()) as { user_id?: unknown; sub?: unknown };
      const subject = profile.user_id ?? profile.sub;
      if (typeof subject !== "string" || !subject || subject.length > 1024) return void failed();
      // A shared Sandbox buyer demonstrates billing, not a shared customer account.
      // Each fresh demo login gets its own portfolio; normal PayPal identity is unchanged.
      const demo = sandboxSubscriptions(ctx.config);
      const subjectHash = keyedHash(
        ctx.config,
        `paypal-${environment}:${clientId}:${subject}${demo ? `:judge-attempt:${attempt.sessionIdHash}` : ""}`,
      );
      const ownerId = await ctx.db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${subjectHash}))`);
        const [existing] = await tx
          .select()
          .from(loginIdentities)
          .where(eq(loginIdentities.subjectHash, subjectHash));
        if (existing) return existing.ownerId;
        const id = randomUUID();
        await tx.insert(owners).values({ id });
        await tx.insert(loginIdentities).values({ subjectHash, ownerId: id });
        return id;
      });
      await issueOwnerCookie(ctx, res, ownerId);
      await ctx.db.delete(sessions).where(eq(sessions.idHash, auth.sessionIdHash));
      await startSession(ctx, res, { role: "reviewer", ownerId });
      res.redirect(303, "/");
    } catch {
      // Never echo provider payloads, authorization codes, tokens or payer profile data.
      failed();
    }
  });
  return router;
}
