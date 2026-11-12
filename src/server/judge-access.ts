import { parseCookie } from "cookie";
import { createHash, timingSafeEqual } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Router, type Request, type RequestHandler } from "express";
import { validate } from "../shared/contracts";
import { keyedHash, sessionHash, newToken, verifyPassword } from "./auth";
import type { AppContext } from "./context";
import { judgeDemoAccess, judgeDemoCounters, judgeDemoOwners } from "./db/schema";
import { HttpError, parseBody } from "./http";

const accessMs = 8 * 60 * 60_000;
type AccessKind = "judge" | "owner" | "share";
const cookieName = (ctx: AppContext, kind: AccessKind) =>
  `${ctx.config.cookieNamespace ?? "val"}_${kind}_access`;
const tokenHash = (ctx: AppContext, kind: AccessKind, token: string) =>
  sessionHash(
    ctx.config,
    kind === "owner"
      ? `owner:${token}`
      : kind === "share"
        ? `share:${ctx.config.privateShareLink?.sha256}:${token}`
        : token,
  );

async function access(ctx: AppContext, req: Request, kind?: AccessKind) {
  if (!ctx.config.judgeDemo || ctx.config.judgeAccessPaused)
    return { expiresAt: new Date(Date.now() + accessMs) };
  const cookies = parseCookie(req.headers.cookie ?? "");
  for (const candidate of kind ? [kind] : (["judge", "owner", "share"] as const)) {
    if (candidate === "owner" && !ctx.config.ownerAccess) continue;
    if (
      candidate === "share" &&
      (!ctx.config.privateShareLink || ctx.config.privateShareLink.expiresAt.getTime() <= Date.now())
    )
      continue;
    const token = cookies[cookieName(ctx, candidate)];
    if (!token) continue;
    const [grant] = await ctx.db
      .select()
      .from(judgeDemoAccess)
      .where(eq(judgeDemoAccess.tokenHash, tokenHash(ctx, candidate, token)));
    if (grant && grant.expiresAt.getTime() > Date.now()) return grant;
  }
  return null;
}

export function judgeAccessRoutes(ctx: AppContext) {
  const router = Router();
  router.get("/judge/access", async (req, res) =>
    res.json({
      required: !!ctx.config.judgeDemo && !ctx.config.judgeAccessPaused,
      allowed: !!(await access(ctx, req)),
      ...(ctx.config.privateShareLink ? { privateLink: true } : {}),
    }),
  );
  router.post("/judge/access-link", async (req, res) => {
    const config = ctx.config.privateShareLink;
    if (!ctx.config.judgeDemo || !config)
      throw new HttpError(404, "private_link_unavailable", "This private link is unavailable.");
    const body = req.body;
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      typeof body.access !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.access)
    )
      throw new HttpError(403, "private_link_invalid", "This private link is unavailable or has expired.");
    const key = `share-link:${keyedHash(ctx.config, req.ip ?? "unknown")}`;
    const now = new Date(),
      cutoff = new Date(now.getTime() - 15 * 60_000);
    const [window] = await ctx.db
      .insert(judgeDemoCounters)
      .values({ key, calls: 1, windowStartedAt: now })
      .onConflictDoUpdate({
        target: judgeDemoCounters.key,
        set: {
          calls: sql`case when ${judgeDemoCounters.windowStartedAt} < ${cutoff} then 1 else ${judgeDemoCounters.calls} + 1 end`,
          windowStartedAt: sql`case when ${judgeDemoCounters.windowStartedAt} < ${cutoff} then ${now} else ${judgeDemoCounters.windowStartedAt} end`,
        },
        setWhere: sql`${judgeDemoCounters.windowStartedAt} < ${cutoff} or ${judgeDemoCounters.calls} < 20`,
      })
      .returning();
    if (!window)
      throw new HttpError(429, "private_link_limited", "Too many attempts. Try again in 15 minutes.");
    const digest = createHash("sha256").update(body.access).digest();
    if (
      config.expiresAt.getTime() <= Date.now() ||
      !timingSafeEqual(digest, Buffer.from(config.sha256, "hex"))
    )
      throw new HttpError(403, "private_link_invalid", "This private link is unavailable or has expired.");
    await ctx.db
      .update(judgeDemoCounters)
      .set({ calls: sql`greatest(${judgeDemoCounters.calls} - 1, 0)` })
      .where(
        and(eq(judgeDemoCounters.key, key), eq(judgeDemoCounters.windowStartedAt, window.windowStartedAt)),
      );
    const token = newToken();
    const expiresAt = new Date(Math.min(Date.now() + accessMs, config.expiresAt.getTime()));
    await ctx.db.insert(judgeDemoAccess).values({ tokenHash: tokenHash(ctx, "share", token), expiresAt });
    res.cookie(cookieName(ctx, "share"), token, {
      httpOnly: true,
      secure: ctx.config.secureCookies,
      sameSite: "lax",
      path: "/",
      maxAge: expiresAt.getTime() - Date.now(),
    });
    res.json({ allowed: true });
  });
  router.get("/owner/access", async (req, res) => {
    if (!ctx.config.ownerAccess)
      throw new HttpError(404, "owner_access_unavailable", "Owner access is not configured.");
    res.json({ required: !ctx.config.judgeAccessPaused, allowed: !!(await access(ctx, req, "owner")) });
  });
  for (const kind of ["judge", "owner"] as const)
    router.post(`/${kind}/access`, async (req, res) => {
      const config = kind === "owner" ? ctx.config.ownerAccess : ctx.config.judgeDemo;
      if (!config) {
        if (kind === "owner")
          throw new HttpError(404, "owner_access_unavailable", "Owner access is not configured.");
        return void res.json({ allowed: true });
      }
      const { username, password } = parseBody(validate.loginCommand, req.body);
      if (username.length > 100 || password.length > 256)
        throw new HttpError(400, "judge_login_invalid", "Username or password not accepted.");
      const key = `login:${keyedHash(ctx.config, req.ip ?? "unknown")}`;
      const now = new Date();
      const cutoff = new Date(now.getTime() - 15 * 60_000);
      const [window] = await ctx.db
        .insert(judgeDemoCounters)
        .values({ key, calls: 1, windowStartedAt: now })
        .onConflictDoUpdate({
          target: judgeDemoCounters.key,
          set: {
            calls: sql`case when ${judgeDemoCounters.windowStartedAt} < ${cutoff} then 1 else ${judgeDemoCounters.calls} + 1 end`,
            windowStartedAt: sql`case when ${judgeDemoCounters.windowStartedAt} < ${cutoff} then ${now} else ${judgeDemoCounters.windowStartedAt} end`,
          },
          setWhere: sql`${judgeDemoCounters.windowStartedAt} < ${cutoff} or ${judgeDemoCounters.calls} < 5`,
        })
        .returning();
      if (!window)
        throw new HttpError(
          429,
          "judge_login_limited",
          "Too many sign-in attempts. Try again in 15 minutes.",
        );
      const valid = await verifyPassword(password, config.passwordHash);
      if (!valid || username !== config.username)
        throw new HttpError(401, "judge_login_invalid", "Username or password not accepted.");
      // Reserve before hashing so concurrent guesses are bounded; successful visitors release their slot.
      await ctx.db
        .update(judgeDemoCounters)
        .set({ calls: sql`greatest(${judgeDemoCounters.calls} - 1, 0)` })
        .where(
          and(eq(judgeDemoCounters.key, key), eq(judgeDemoCounters.windowStartedAt, window.windowStartedAt)),
        );
      const token = newToken();
      const expiresAt = new Date(Date.now() + accessMs);
      await ctx.db.insert(judgeDemoAccess).values({ tokenHash: tokenHash(ctx, kind, token), expiresAt });
      res.cookie(cookieName(ctx, kind), token, {
        httpOnly: true,
        secure: ctx.config.secureCookies,
        sameSite: "lax",
        path: "/",
        maxAge: accessMs,
      });
      res.json({ allowed: true });
    });
  return router;
}

/** An arbitrary PayPal sign-in or new browser owner cannot bypass the separate demo invitation. */
export const requireJudgeAccess =
  (ctx: AppContext): RequestHandler =>
  async (req, res, next) => {
    if (!ctx.config.judgeDemo) return next();
    const grant = await access(ctx, req);
    if (!grant)
      throw new HttpError(403, "judge_access_required", "Log in with your access details to try Val.");
    const ownerId = res.locals.auth?.ownerId;
    if (ownerId)
      await ctx.db
        .insert(judgeDemoOwners)
        .values({ ownerId, expiresAt: grant.expiresAt })
        .onConflictDoUpdate({ target: judgeDemoOwners.ownerId, set: { expiresAt: grant.expiresAt } });
    next();
  };
