import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validate } from "../src/shared/contracts";
import { ownerCookies, recoveryCodes, sessions } from "../src/server/db/schema";
import { adminLogin, reviewerLogin, startTestApp, type TestApp } from "./helpers";

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

async function loggedInBrowser(login = reviewerLogin) {
  const browser = app.browser();
  const result = await browser.login(login);
  expect(result.status).toBe(200);
  return {
    browser,
    ownerId: result.body.session.ownerId as string,
    recoveryCode: result.body.newOwnerRecoveryCode as string | null,
  };
}

describe("login and durable owners", () => {
  it("bootstraps an uncached anonymous session with a CSRF token and no recovery secret", async () => {
    const response = await app.browser().open();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(validate.sessionView(response.body)).toBe(true);
    expect(response.body).toMatchObject({ authenticated: false, role: null, ownerId: null });
    expect(JSON.stringify(response.body)).not.toMatch(/recovery/i);
  });

  it("issues secure-by-default cookies and a one-time recovery code on first login", async () => {
    const browser = app.browser();
    await browser.open();
    const response = await browser.post("/api/session", reviewerLogin);
    expect(validate.loginResult(response.body)).toBe(true);
    expect(response.body.session).toMatchObject({ authenticated: true, role: "reviewer" });
    expect(response.body.newOwnerRecoveryCode).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){5}$/);
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/val_session=.*HttpOnly.*SameSite=Lax/i);
    expect(cookies).toMatch(/val_owner=.*HttpOnly.*SameSite=Lax/i);
    expect(cookies).toMatch(/Max-Age=7776000/);
  });

  it("keeps the same owner across logout and login, without issuing another recovery code", async () => {
    const { browser, ownerId } = await loggedInBrowser();
    expect((await browser.request("DELETE", "/api/session", {})).body.authenticated).toBe(false);
    expect((await browser.get("/api/cases")).status).toBe(401);

    const again = await browser.post("/api/session", reviewerLogin);
    expect(again.body.session.ownerId).toBe(ownerId);
    expect(again.body.newOwnerRecoveryCode).toBeNull();
  });

  it("rotates the session at login so the bootstrap session cannot be reused", async () => {
    const browser = app.browser();
    await browser.open();
    const bootstrapSession = browser.cookie("val_session")!;
    await browser.post("/api/session", reviewerLogin);
    expect(browser.cookie("val_session")).not.toBe(bootstrapSession);

    browser.setCookie("val_session", bootstrapSession);
    expect((await browser.get("/api/cases")).status).toBe(401);
  });

  it("stores only hashes of cookies and recovery codes", async () => {
    const { browser, recoveryCode } = await loggedInBrowser();
    const secrets = [
      browser.cookie("val_session")!,
      browser.cookie("val_owner")!,
      recoveryCode!,
      recoveryCode!.replaceAll("-", ""),
    ];
    const stored = JSON.stringify([
      await app.ctx.db.select().from(sessions),
      await app.ctx.db.select().from(ownerCookies),
      await app.ctx.db.select().from(recoveryCodes),
    ]);
    for (const secret of secrets) expect(stored).not.toContain(secret);
  });

  it("refuses wrong credentials with one generic answer, and an unknown user takes the same path", async () => {
    const browser = app.browser();
    await browser.open();
    const wrongPassword = await browser.post("/api/session", {
      username: reviewerLogin.username,
      password: "nope",
    });
    const unknownUser = await browser.post("/api/session", { username: "nobody", password: "nope" });
    expect([wrongPassword.status, unknownUser.status]).toEqual([401, 401]);
    expect(wrongPassword.body).toEqual(unknownUser.body);
  });

  it("restricts administrator routes to the administrator role", async () => {
    const { browser: reviewer } = await loggedInBrowser();
    expect((await reviewer.get("/api/admin/operations")).status).toBe(403);
    const { browser: admin } = await loggedInBrowser(adminLogin);
    expect((await admin.get("/api/admin/operations")).status).toBe(200);
  });
});

describe("browser mutations", () => {
  it("rejects a missing or wrong CSRF token and a foreign origin, with no effect", async () => {
    const { browser } = await loggedInBrowser();
    expect((await browser.post("/api/cases", { scenario: "feature_removed" }, { csrf: null })).status).toBe(
      403,
    );
    expect(
      (await browser.post("/api/cases", { scenario: "feature_removed" }, { csrf: "wrong" })).status,
    ).toBe(403);
    expect(
      (await browser.post("/api/cases", { scenario: "feature_removed" }, { origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect((await browser.get("/api/cases")).body).toEqual([]);
  });

  it("rejects unknown fields and oversized bodies", async () => {
    const { browser } = await loggedInBrowser();
    expect(
      (await browser.post("/api/cases", { scenario: "feature_removed", ownerId: "someone-else" })).status,
    ).toBe(400);
    expect((await browser.post("/api/cases", { scenario: "x".repeat(70_000) })).status).toBe(413);
  });
});

describe("ownership isolation and recovery", () => {
  it("keeps one owner's cases invisible to another owner using the same shared login", async () => {
    const first = await loggedInBrowser();
    const created = await first.browser.post("/api/cases", { scenario: "feature_removed" });
    expect(created.status).toBe(201);
    expect(validate.caseSnapshot(created.body)).toBe(true);
    const caseId = created.body.case.id as string;

    const second = await loggedInBrowser();
    expect(second.ownerId).not.toBe(first.ownerId);
    expect((await second.browser.get("/api/cases")).body).toEqual([]);
    for (const path of [`/api/cases/${caseId}`, `/api/cases/${caseId}/evidence`])
      expect((await second.browser.get(path)).status).toBe(404);
    expect((await second.browser.post(`/api/cases/${caseId}/reconcile`)).status).toBe(404);
    expect((await second.browser.post(`/api/cases/${caseId}/setup-subscription`)).status).toBe(404);
  });

  it("restores an owner's cases in a new browser through the recovery code, after role login", async () => {
    const original = await loggedInBrowser();
    const caseId = (await original.browser.post("/api/cases", { scenario: "feature_removed" })).body.case
      .id as string;
    const oldSessionCsrf = original.browser.csrf;

    const fresh = await loggedInBrowser();
    expect((await fresh.browser.get(`/api/cases/${caseId}`)).status).toBe(404);
    const recovered = await fresh.browser.post("/api/owner/recover", {
      recoveryCode: original.recoveryCode!.toLowerCase().replaceAll("-", " "),
    });
    expect(recovered.status).toBe(200);
    expect(recovered.body.ownerId).toBe(original.ownerId);
    expect((await fresh.browser.get(`/api/cases/${caseId}`)).status).toBe(200);
    expect(
      (await fresh.browser.post("/api/cases", { scenario: "feature_removed" }, { csrf: oldSessionCsrf }))
        .status,
    ).toBe(403);

    // The recovered binding is durable: logging out and in again in that browser keeps the original owner.
    await fresh.browser.request("DELETE", "/api/session", {});
    expect((await fresh.browser.post("/api/session", reviewerLogin)).body.session.ownerId).toBe(
      original.ownerId,
    );
  });

  it("never lets a recovery code replace role login", async () => {
    const original = await loggedInBrowser();
    const anonymous = app.browser();
    await anonymous.open();
    const attempt = await anonymous.post("/api/owner/recover", { recoveryCode: original.recoveryCode! });
    expect(attempt.status).toBe(401);
    expect((await anonymous.get("/api/cases")).status).toBe(401);
  });

  it("forces reauthentication when the owner cookie is missing or belongs to someone else", async () => {
    const first = await loggedInBrowser();
    const second = await loggedInBrowser();

    const swapped = app.browser();
    await swapped.open();
    await swapped.post("/api/session", reviewerLogin);
    swapped.setCookie("val_owner", second.browser.cookie("val_owner"));
    expect((await swapped.get("/api/cases")).status).toBe(401);

    first.browser.setCookie("val_owner", undefined);
    expect((await first.browser.get("/api/cases")).status).toBe(401);
  });

  it("expires a role session after 24 hours of inactivity", async () => {
    const { browser } = await loggedInBrowser();
    expect((await browser.get("/api/cases")).status).toBe(200);

    const idleSince = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await app.ctx.db.update(sessions).set({ lastSeenAt: idleSince }).where(eq(sessions.role, "reviewer"));
    expect((await browser.get("/api/cases")).status).toBe(401);
    expect((await browser.get("/api/session")).body.authenticated).toBe(false);
  });
});

describe("rate limits", () => {
  it("releases successful login attempts without spending the failure allowance", async () => {
    const isolated = await startTestApp();
    try {
      const browser = isolated.browser();
      await browser.open();
      for (let attempt = 0; attempt < 7; attempt++) {
        expect((await browser.post("/api/session", reviewerLogin)).status).toBe(200);
      }
    } finally {
      await isolated.close();
    }
  });

  it("limits simultaneous recovery guesses without changing the owner", async () => {
    const isolated = await startTestApp();
    try {
      const browser = isolated.browser();
      const login = await browser.login();
      const ownerId = login.body.session.ownerId;
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          browser.post("/api/owner/recover", { recoveryCode: `PARALLEL-GUESS-${index}` }),
        ),
      );
      expect(attempts.filter((result) => result.status === 403)).toHaveLength(5);
      expect(attempts.filter((result) => result.status === 429)).toHaveLength(7);
      expect((await browser.open()).body.ownerId).toBe(ownerId);
    } finally {
      await isolated.close();
    }
  });

  it("limits simultaneous login guesses before password verification starts", async () => {
    const isolated = await startTestApp();
    try {
      const browser = isolated.browser();
      await browser.open();
      const attempts = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          browser.post("/api/session", {
            username: reviewerLogin.username,
            password: `parallel-wrong-${index}`,
          }),
        ),
      );
      expect(attempts.filter((result) => result.status === 401)).toHaveLength(5);
      expect(attempts.filter((result) => result.status === 429)).toHaveLength(7);
      expect((await browser.post("/api/session", reviewerLogin)).status).toBe(429);
      expect((await browser.get("/api/cases")).status).toBe(401);
    } finally {
      await isolated.close();
    }
  });

  it("blocks repeated recovery guesses without revealing whether any code exists", async () => {
    const isolated = await startTestApp();
    try {
      const browser = isolated.browser();
      await browser.login();
      const results = [];
      for (let attempt = 0; attempt < 7; attempt++)
        results.push((await browser.post("/api/owner/recover", { recoveryCode: `GUESS-${attempt}` })).status);
      expect(results).toEqual([403, 403, 403, 403, 403, 429, 429]);
    } finally {
      await isolated.close();
    }
  });

  it("blocks repeated failed logins", async () => {
    const isolated = await startTestApp();
    try {
      const browser = isolated.browser();
      await browser.open();
      const results = [];
      for (let attempt = 0; attempt < 6; attempt++)
        results.push(
          (
            await browser.post("/api/session", {
              username: reviewerLogin.username,
              password: `wrong-${attempt}`,
            })
          ).status,
        );
      expect(results).toEqual([401, 401, 401, 401, 401, 429]);
      expect((await browser.post("/api/session", reviewerLogin)).status).toBe(429);
    } finally {
      await isolated.close();
    }
  });
});

describe("browser hardening and identity housekeeping", () => {
  it("sends anti-framing, nosniff and no-referrer headers on every response", async () => {
    for (const path of ["/api/session", "/healthz"]) {
      const response = await app.browser().request("GET", path);
      expect(response.status).toBe(200);
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("x-powered-by")).toBeNull();
      expect(response.headers.get("strict-transport-security")).toBeNull();
    }
  });

  it("prunes idle sessions and expired owner cookies but keeps live ones", async () => {
    const { pruneExpiredIdentity } = await import("../src/server/auth");
    const live = await loggedInBrowser();
    const stale = await loggedInBrowser();
    const db = app.ctx.db;
    const [staleSession] = await db.select().from(sessions).where(eq(sessions.ownerId, stale.ownerId));
    await db
      .update(sessions)
      .set({ lastSeenAt: new Date(Date.now() - 25 * 60 * 60 * 1000) })
      .where(eq(sessions.idHash, staleSession!.idHash));
    await db
      .update(ownerCookies)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(ownerCookies.ownerId, stale.ownerId));

    await pruneExpiredIdentity(app.ctx);

    expect(await db.select().from(sessions).where(eq(sessions.ownerId, stale.ownerId))).toHaveLength(0);
    expect(await db.select().from(ownerCookies).where(eq(ownerCookies.ownerId, stale.ownerId))).toHaveLength(
      0,
    );
    expect(await db.select().from(sessions).where(eq(sessions.ownerId, live.ownerId))).toHaveLength(1);
    expect(await db.select().from(ownerCookies).where(eq(ownerCookies.ownerId, live.ownerId))).toHaveLength(
      1,
    );
    expect((await stale.browser.open()).body).toMatchObject({ authenticated: false });
    expect((await live.browser.open()).body).toMatchObject({ authenticated: true, ownerId: live.ownerId });
  });
});
