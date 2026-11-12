import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers";
import { judgeDemoCounters } from "../src/server/db/schema";
import { hashPassword } from "../src/server/auth";
import { httpLimits } from "../src/server/request-limits";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp({ httpRequestLimits: true, trustedProxyCidrs: ["127.0.0.1/32"] });
  app.ctx.config.judgeDemo = {
    username: "test-panel",
    passwordHash: await hashPassword("synthetic-panel-password"),
  };
});
beforeEach(async () => {
  await app.ctx.db.delete(judgeDemoCounters);
});
afterAll(() => app.close());

it("separates customer polling behind a trusted proxy and ignores caller-prepended addresses", async () => {
  const request = (chain: string) =>
    fetch(app.origin + "/api/deployment", { headers: { "X-Forwarded-For": chain } });
  for (let i = 0; i < httpLimits.perIpMinute; i++) {
    const response = await request(`198.51.100.${(i % 250) + 1}, 203.0.113.10`);
    expect(response.status).toBe(200);
    await response.text();
  }
  expect((await request("198.51.100.251, 203.0.113.10")).status).toBe(429);
  expect((await request("203.0.113.11")).status).toBe(200);
});

it("keeps one client's failed invitation attempts from locking out another behind the proxy", async () => {
  const first = app.browser(),
    second = app.browser();
  await first.open();
  await second.open();
  for (let i = 0; i < 5; i++)
    expect(
      (
        await first.post(
          "/api/judge/access",
          { username: "test-panel", password: "wrong" },
          { forwardedFor: `198.51.100.${i + 1}, 203.0.113.20` },
        )
      ).status,
    ).toBe(401);
  expect(
    (
      await first.post(
        "/api/judge/access",
        { username: "test-panel", password: "wrong" },
        { forwardedFor: "198.51.100.99, 203.0.113.20" },
      )
    ).status,
  ).toBe(429);
  expect(
    (
      await second.post(
        "/api/judge/access",
        { username: "test-panel", password: "synthetic-panel-password" },
        { forwardedFor: "203.0.113.21" },
      )
    ).status,
  ).toBe(200);
});

it("ignores forwarded addresses when the actual peer is outside the configured proxy networks", async () => {
  const direct = await startTestApp({ httpRequestLimits: true, trustedProxyCidrs: ["192.0.2.1/32"] });
  try {
    for (let i = 0; i < httpLimits.perIpMinute; i++) {
      const response = await fetch(direct.origin + "/api/deployment", {
        headers: { "X-Forwarded-For": `203.0.113.${i + 1}` },
      });
      expect(response.status).toBe(200);
      await response.text();
    }
    expect(
      (await fetch(direct.origin + "/api/deployment", { headers: { "X-Forwarded-For": "203.0.113.250" } }))
        .status,
    ).toBe(429);
  } finally {
    await direct.close();
  }
});
