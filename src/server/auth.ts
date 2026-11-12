import { createHmac, randomBytes, randomUUID, scrypt, type BinaryLike } from "node:crypto";
import { parseCookie } from "cookie";
import { eq, lt } from "drizzle-orm";
import { Router, type Request, type RequestHandler, type Response } from "express";
import type { SessionView } from "../shared/contracts";
import { validate } from "../shared/contracts";
import type { Config } from "./config";
import type { AppContext } from "./context";
import { ownerCookies, owners, recoveryCodes, sessions } from "./db/schema";
import { HttpError, parseBody, safeEqual } from "./http";

const sessionCookie = (config: Config) => `${config.cookieNamespace ?? "val"}_session`;
const ownerCookie = (config: Config) => `${config.cookieNamespace ?? "val"}_owner`;
const sessionIdleMs = 24 * 60 * 60 * 1000;
const ownerCookieMs = 90 * 24 * 60 * 60 * 1000;

type Role = NonNullable<SessionView["role"]>;

/** A valid server-side session; role and ownerId stay null until login succeeds. */
export interface Auth {
  sessionIdHash: string;
  role: Role | null;
  ownerId: string | null;
  csrfToken: string;
}

export interface LoggedIn extends Auth {
  role: Role;
  ownerId: string;
}

declare global {
  namespace Express {
    interface Locals {
      auth: Auth | null;
    }
  }
}

/** Hashes secret lookup values; immutable PayPal request bodies separately retain their return token for replay. */
export function keyedHash(config: Config, secret: string): string {
  return createHmac("sha256", config.dataSecret ?? config.sessionSecret)
    .update(secret)
    .digest("hex");
}

/** Session rotation expires login grants without changing durable account lookup keys. */
export function sessionHash(config: Config, secret: string): string {
  return createHmac("sha256", config.sessionSecret).update(secret).digest("hex");
}

export const newToken = () => randomBytes(32).toString("base64url");

const recoveryAlphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function newRecoveryCode(): string {
  const characters = Array.from(randomBytes(24), (byte) => recoveryAlphabet[byte % 32]);
  return Array.from({ length: 6 }, (_, group) => characters.slice(group * 4, group * 4 + 4).join("")).join(
    "-",
  );
}

const normalizeRecoveryCode = (code: string) => code.toUpperCase().replace(/[^0-9A-Z]/g, "");

function derive(password: string, salt: BinaryLike): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** Produces the `scrypt$salt$hash` string kept in JUDGE_PASSWORD_HASH and ADMIN_PASSWORD_HASH. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64")}$${(await derive(password, salt)).toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !salt || !hash) return false;
  return safeEqual((await derive(password, Buffer.from(salt, "base64"))).toString("base64"), hash);
}

/** Looks the user up and hashes in every case, so unknown usernames take as long as wrong passwords. */
const placeholderHash = hashPassword("no such account");

async function matchAccount(config: Config, username: string, password: string): Promise<Role | null> {
  const accounts: [Role, Config["judge"]][] = [
    ["reviewer", config.judge],
    ["admin", config.admin],
  ];
  const account = accounts.find(([, candidate]) => candidate.username === username);
  const passwordMatches = await verifyPassword(
    password,
    account?.[1].passwordHash ?? (await placeholderHash),
  );
  return account && passwordMatches ? account[0] : null;
}

/** Reserves attempts before asynchronous verification; failures expire, and successful attempts release their slot. */
function createFailureLimiter(maxFailures: number, windowMs: number) {
  const failures = new Map<string, number[]>();
  const pending = new Map<string, number>();
  const recent = (key: string) => (failures.get(key) ?? []).filter((at) => Date.now() - at < windowMs);
  return {
    begin(key: string) {
      const inFlight = pending.get(key) ?? 0;
      if (recent(key).length + inFlight >= maxFailures)
        throw new HttpError(429, "rate_limited", "Too many failed attempts; try again later.");
      pending.set(key, inFlight + 1);
      return (failed: boolean) => {
        const remaining = pending.get(key)! - 1;
        if (remaining) pending.set(key, remaining);
        else pending.delete(key);
        if (failed) failures.set(key, [...recent(key), Date.now()]);
      };
    },
  };
}

function cookieOptions(config: Config, maxAgeMs: number) {
  return {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeMs,
  };
}

/** Drops sessions past their idle window and owner cookies past their expiry; nothing else depends on these rows. */
export async function pruneExpiredIdentity(ctx: AppContext, now = new Date()) {
  await ctx.db.delete(sessions).where(lt(sessions.lastSeenAt, new Date(now.getTime() - sessionIdleMs)));
  await ctx.db.delete(ownerCookies).where(lt(ownerCookies.expiresAt, now));
}

async function ownerFromCookie(ctx: AppContext, token: string | undefined): Promise<string | null> {
  if (!token) return null;
  const [cookie] = await ctx.db
    .select()
    .from(ownerCookies)
    .where(eq(ownerCookies.tokenHash, keyedHash(ctx.config, token)));
  return cookie && cookie.expiresAt.getTime() > Date.now() ? cookie.ownerId : null;
}

export async function issueOwnerCookie(ctx: AppContext, res: Response, ownerId: string) {
  const token = newToken();
  await ctx.db.insert(ownerCookies).values({
    tokenHash: keyedHash(ctx.config, token),
    ownerId,
    expiresAt: new Date(Date.now() + ownerCookieMs),
  });
  res.cookie(ownerCookie(ctx.config), token, cookieOptions(ctx.config, ownerCookieMs));
}

async function createOwner(ctx: AppContext, res: Response) {
  const ownerId = randomUUID();
  const recoveryCode = newRecoveryCode();
  await ctx.db.transaction(async (tx) => {
    await tx.insert(owners).values({ id: ownerId });
    await tx
      .insert(recoveryCodes)
      .values({ ownerId, codeHash: keyedHash(ctx.config, normalizeRecoveryCode(recoveryCode)) });
  });
  await issueOwnerCookie(ctx, res, ownerId);
  return { ownerId, recoveryCode };
}

export async function startSession(
  ctx: AppContext,
  res: Response,
  identity: { role: Role | null; ownerId: string | null },
): Promise<Auth> {
  const token = newToken();
  const csrfToken = newToken();
  const sessionIdHash = sessionHash(ctx.config, token);
  await ctx.db.insert(sessions).values({ idHash: sessionIdHash, csrfToken, ...identity });
  res.cookie(sessionCookie(ctx.config), token, cookieOptions(ctx.config, sessionIdleMs));
  return { sessionIdHash, csrfToken, ...identity };
}

/**
 * Resolves the request's session. A session is valid only while it is within its idle window and,
 * once logged in, still matches the browser's owner cookie; otherwise it is discarded.
 */
async function findSession(ctx: AppContext, req: Request): Promise<Auth | null> {
  const cookies = parseCookie(req.headers.cookie ?? "");
  if (!cookies[sessionCookie(ctx.config)]) return null;
  const sessionIdHash = sessionHash(ctx.config, cookies[sessionCookie(ctx.config)]!);
  const [session] = await ctx.db.select().from(sessions).where(eq(sessions.idHash, sessionIdHash));
  if (!session) return null;

  const idle = Date.now() - session.lastSeenAt.getTime() > sessionIdleMs;
  const ownerMismatch =
    session.ownerId !== null &&
    session.ownerId !== (await ownerFromCookie(ctx, cookies[ownerCookie(ctx.config)]));
  if (idle || ownerMismatch) {
    await ctx.db.delete(sessions).where(eq(sessions.idHash, sessionIdHash));
    return null;
  }
  await ctx.db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.idHash, sessionIdHash));
  return { sessionIdHash, role: session.role, ownerId: session.ownerId, csrfToken: session.csrfToken };
}

export const loadSession =
  (ctx: AppContext): RequestHandler =>
  async (req, res, next) => {
    res.locals.auth = await findSession(ctx, req);
    next();
  };

/** Browser mutations need the same origin and the session's CSRF token. PayPal webhooks are mounted before this. */
export const requireCsrf =
  (ctx: AppContext): RequestHandler =>
  (req, res, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
    const token = req.get("x-csrf-token");
    const auth = res.locals.auth;
    if (req.get("origin") !== ctx.config.appOrigin)
      throw new HttpError(403, "bad_origin", "Request origin not accepted.");
    if (!auth || !token || !safeEqual(token, auth.csrfToken))
      throw new HttpError(403, "bad_csrf", "Missing or invalid CSRF token.");
    next();
  };

export function requireLogin(res: Response): LoggedIn {
  const auth = res.locals.auth;
  if (!auth?.role || !auth.ownerId) throw new HttpError(401, "login_required", "Log in to continue.");
  return auth as LoggedIn;
}

export function requireAdmin(res: Response): LoggedIn {
  const auth = requireLogin(res);
  if (auth.role !== "admin") throw new HttpError(403, "admin_only", "Administrator access required.");
  return auth;
}

const sessionView = (auth: Auth): SessionView => ({
  authenticated: auth.role !== null,
  role: auth.role,
  ownerId: auth.ownerId,
  csrfToken: auth.csrfToken,
});

/** GET/POST/DELETE /api/session and POST /api/owner/recover. */
export function sessionRoutes(ctx: AppContext): Router {
  const router = Router();
  const loginLimiter = createFailureLimiter(5, 15 * 60 * 1000);
  const recoveryLimiter = createFailureLimiter(5, 15 * 60 * 1000);

  router.get("/session", async (_req, res) => {
    res.json(sessionView(res.locals.auth ?? (await startSession(ctx, res, { role: null, ownerId: null }))));
  });

  router.post("/session", async (req, res) => {
    if (ctx.config.buildProfile === "public" || ctx.config.paypalIdentityEnvironment === "live")
      throw new HttpError(404, "password_login_disabled", "Continue with PayPal to log in.");
    const ip = req.ip ?? "unknown";
    const { username, password } = parseBody(validate.loginCommand, req.body);
    const finishAttempt = loginLimiter.begin(ip);
    let role: Role | null = null;
    try {
      role = await matchAccount(ctx.config, username, password);
    } finally {
      finishAttempt(role === null);
    }
    if (!role) {
      throw new HttpError(401, "invalid_credentials", "Username or password not accepted.");
    }

    // A browser keeps its owner across logins; only a browser without a valid owner cookie gets a new one.
    let ownerId = await ownerFromCookie(ctx, parseCookie(req.headers.cookie ?? "")[ownerCookie(ctx.config)]);
    let newOwnerRecoveryCode: string | null = null;
    if (!ownerId) ({ ownerId, recoveryCode: newOwnerRecoveryCode } = await createOwner(ctx, res));

    await ctx.db.delete(sessions).where(eq(sessions.idHash, res.locals.auth!.sessionIdHash));
    const session = await startSession(ctx, res, { role, ownerId });
    res.json({ session: sessionView(session), newOwnerRecoveryCode });
  });

  router.delete("/session", async (req, res) => {
    parseBody(validate.emptyCommand, req.body ?? {});
    await ctx.db.delete(sessions).where(eq(sessions.idHash, res.locals.auth!.sessionIdHash));
    res.json(sessionView(await startSession(ctx, res, { role: null, ownerId: null })));
  });

  router.post("/owner/recover", async (req, res) => {
    if (ctx.config.buildProfile === "public" || ctx.config.paypalIdentityEnvironment === "live")
      throw new HttpError(404, "recovery_disabled", "Use your PayPal account to return to Val.");
    const auth = requireLogin(res);
    const ip = req.ip ?? "unknown";
    const { recoveryCode } = parseBody(validate.recoveryCommand, req.body);
    const codeHash = keyedHash(ctx.config, normalizeRecoveryCode(recoveryCode));
    const finishAttempt = recoveryLimiter.begin(ip);
    let recovery: typeof recoveryCodes.$inferSelect | undefined;
    try {
      [recovery] = await ctx.db.select().from(recoveryCodes).where(eq(recoveryCodes.codeHash, codeHash));
    } finally {
      finishAttempt(recovery === undefined);
    }
    if (!recovery) {
      throw new HttpError(403, "recovery_failed", "Recovery code not accepted.");
    }

    await issueOwnerCookie(ctx, res, recovery.ownerId);
    await ctx.db
      .update(sessions)
      .set({ ownerId: recovery.ownerId })
      .where(eq(sessions.idHash, auth.sessionIdHash));
    res.json(sessionView({ ...auth, ownerId: recovery.ownerId }));
  });

  return router;
}
