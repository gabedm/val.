import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestApp, type Browser, type TestApp } from "./helpers";
import { ownerChatRequests, ownerSubscriptionReviews, ownerSubscriptions } from "../src/server/db/schema";
import { runChatRequest, stopChatRequests } from "../src/server/chat-requests";
import type { CatalogueResponse } from "../src/shared/contracts.types";
import type { ValChatCommand, ValChatReply } from "../src/shared/subscriptions";

const catalogue = JSON.parse(
  readFileSync(new URL("../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
) as CatalogueResponse;
let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
  app.model.script = () => ({
    answer: { message: "What would you like to compare?", draft: null, compareRef: null },
  });
});
afterAll(async () => {
  await app.close();
});
async function browser() {
  const b = app.browser();
  await b.login();
  return b;
}
const command = (message: string): ValChatCommand => ({ message, history: [], expectedRevision: 0 });
async function wait(b: Browser, id: string) {
  for (let i = 0; i < 100; i++) {
    const row = await b.get(`/api/subscriptions/chat/requests/${id}`);
    expect(row.status).toBe(200);
    if (["complete", "failed", "superseded"].includes(row.body.status)) return row.body;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("Chat did not finish");
}

it("returns one funded result for duplicate submissions, including a lost create response", async () => {
  const b = await browser();
  const id = randomUUID();
  const before = app.model.requests.length;
  const body = { id, command: command("A new question, typed naturally.") };
  const requests = await Promise.all(
    Array.from({ length: 8 }, () => b.post("/api/subscriptions/chat/requests", body)),
  );
  expect(requests.every((row) => row.status === 200 && row.body.id === id)).toBe(true);
  expect((await wait(b, id)).status).toBe("complete");
  const differentId = await b.post("/api/subscriptions/chat/requests", { ...body, id: randomUUID() });
  expect(differentId.body.id).toBe(id);
  expect(app.model.requests.length - before).toBe(1);
  expect(
    (await b.post("/api/subscriptions/chat/requests", { ...body, command: command("Changed text") })).status,
  ).toBe(409);
});

it("keeps job commands and results private to their authenticated owner", async () => {
  const first = await browser(),
    second = await browser();
  const id = randomUUID();
  await first.post("/api/subscriptions/chat/requests", { id, command: command("Owner A private question") });
  await wait(first, id);
  expect((await second.get(`/api/subscriptions/chat/requests/${id}`)).status).toBe(404);
  expect((await second.get("/api/subscriptions/chat/latest")).body).toBeNull();
  expect(
    (
      await second.post("/api/subscriptions/chat/requests", {
        id,
        command: command("Owner B distinct question"),
      })
    ).status,
  ).toBe(200);
  expect((await wait(second, id)).command.message).toBe("Owner B distinct question");
  expect((await first.get("/api/subscriptions/chat/latest")).body.command.message).toBe(
    "Owner A private question",
  );
  expect(
    (
      await first.post(
        "/api/subscriptions/chat/requests",
        { id: randomUUID(), command: command("Missing CSRF") },
        { csrf: null },
      )
    ).status,
  ).toBe(403);
});

it("recovers a reply saved before a worker restart without another model call", async () => {
  const b = await browser();
  const id = randomUUID();
  await b.post("/api/subscriptions/chat/requests", { id, command: command("Resume my reply after restart") });
  const completed = await wait(b, id);
  expect(completed.status).toBe("complete");
  const ownerId = (await b.get("/api/session")).body.ownerId;
  await app.ctx.db
    .update(ownerChatRequests)
    .set({ status: "running", reply: null, leaseToken: randomUUID(), leaseUntil: new Date(0) })
    .where(and(eq(ownerChatRequests.ownerId, ownerId), eq(ownerChatRequests.id, id)));
  const restarted = await startTestApp({ databaseUrl: app.ctx.config.databaseUrl, paypal: app.paypal });
  try {
    await runChatRequest(restarted.ctx, catalogue.catalogue);
    expect(restarted.model.requests).toHaveLength(0);
    expect((await b.get(`/api/subscriptions/chat/requests/${id}`)).body.reply).toEqual(completed.reply);
  } finally {
    await restarted.close();
  }
});

it("preserves a departing worker's checkpoint while waiting for its conversation lock", async () => {
  const b = await browser();
  const ownerId = (await b.get("/api/session")).body.ownerId;
  // Let the preceding HTTP tests' fire-and-forget kicks leave their claim transactions.
  await new Promise((r) => setTimeout(r, 100));
  const id = randomUUID(),
    reviewId = randomUUID();
  const typed = command("Continue after an interrupted connection");
  await app.ctx.db.insert(ownerChatRequests).values({
    ownerId,
    id,
    commandHash: "synthetic",
    command: typed,
    status: "running",
    attempts: 1,
    reviewId,
    leaseToken: randomUUID(),
    leaseUntil: new Date(0),
    nextAttemptAt: new Date(0),
    deadlineAt: new Date(Date.now() + 60_000),
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const lock = await app.ctx.db.$client.connect();
  const before = app.model.requests.length;
  await lock.query("select pg_advisory_lock(hashtextextended($1,0))", [`val-advice:${ownerId}`]);
  const reply: ValChatReply = {
    message: "A recovered answer.",
    portfolio: { revision: 0, subscriptions: [] },
    draft: null,
    compareServiceId: null,
    checkedAt: null,
  };
  try {
    await runChatRequest(app.ctx, catalogue.catalogue);
    const [queued] = await app.ctx.db
      .select()
      .from(ownerChatRequests)
      .where(and(eq(ownerChatRequests.ownerId, ownerId), eq(ownerChatRequests.id, id)));
    expect(queued).toMatchObject({ status: "queued", attempts: 1, reviewId });
    await app.ctx.db.insert(ownerSubscriptionReviews).values({
      id: reviewId,
      ownerId,
      portfolioRevision: 0,
      serviceId: "__chat__",
      version: {},
      input: typed,
      result: { completed: true, reply },
    });
  } finally {
    await lock.query("select pg_advisory_unlock(hashtextextended($1,0))", [`val-advice:${ownerId}`]);
    lock.release();
  }
  await app.ctx.db
    .update(ownerChatRequests)
    .set({ nextAttemptAt: new Date(0) })
    .where(and(eq(ownerChatRequests.ownerId, ownerId), eq(ownerChatRequests.id, id)));
  await runChatRequest(app.ctx, catalogue.catalogue);
  expect((await b.get(`/api/subscriptions/chat/requests/${id}`)).body.reply).toEqual(reply);
  expect(app.model.requests.length).toBe(before);
});

it("does not serve an old proposal after the portfolio changes", async () => {
  const b = await browser();
  const ownerId = (await b.get("/api/session")).body.ownerId;
  const id = randomUUID();
  await b.post("/api/subscriptions/chat/requests", { id, command: command("Discuss my current needs") });
  await wait(b, id);
  await app.ctx.db.insert(ownerSubscriptions).values({ ownerId, revision: 1, subscriptions: [] });
  const superseded = await b.get(`/api/subscriptions/chat/requests/${id}`);
  expect(superseded.body).toMatchObject({
    status: "superseded",
    reply: null,
    error: { code: "subscriptions_changed" },
  });
});

it("keeps the installation spend cap in force for queued jobs", async () => {
  const b = await browser();
  const id = randomUUID();
  const before = app.model.requests.length;
  const original = app.ctx.config.aiBudgetMicros;
  app.ctx.config.aiBudgetMicros = 1;
  try {
    await b.post("/api/subscriptions/chat/requests", { id, command: command("No extra spending allowed") });
    expect(await wait(b, id)).toMatchObject({ status: "failed", error: { code: "judge_budget_exhausted" } });
    expect(app.model.requests.length).toBe(before);
  } finally {
    app.ctx.config.aiBudgetMicros = original;
  }
});

it("limits concurrent chat work globally and rejects a different pending turn for the same owner", async () => {
  const browsers = await Promise.all([browser(), browser(), browser()]);
  const ids = browsers.map(() => randomUUID());
  let active = 0,
    peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const previous = app.model.script;
  app.model.script = async () => {
    active++;
    peak = Math.max(peak, active);
    await gate;
    active--;
    return { answer: { message: "Reply ready.", draft: null, compareRef: null } };
  };
  try {
    await Promise.all(
      browsers.map((b, i) =>
        b.post("/api/subscriptions/chat/requests", {
          id: ids[i],
          command: command(`Distinct queued question ${i}`),
        }),
      ),
    );
    for (let i = 0; i < 50 && active < 2; i++) await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(2);
    expect(
      (
        await browsers[0]!.post("/api/subscriptions/chat/requests", {
          id: randomUUID(),
          command: command("A conflicting pending turn"),
        })
      ).status,
    ).toBe(429);
    release();
    for (let i = 0; i < 3; i++) await wait(browsers[i]!, ids[i]!);
    expect(peak).toBe(2);
  } finally {
    release();
    app.model.script = previous;
  }
});

it("expires queued work without calling a model", async () => {
  const isolated = await startTestApp();
  await stopChatRequests(isolated.ctx);
  try {
    const b = isolated.browser();
    await b.login();
    const id = randomUUID();
    const ownerId = (await b.get("/api/session")).body.ownerId;
    await b.post("/api/subscriptions/chat/requests", { id, command: command("Old queued question") });
    await isolated.ctx.db
      .update(ownerChatRequests)
      .set({ deadlineAt: new Date(0) })
      .where(and(eq(ownerChatRequests.ownerId, ownerId), eq(ownerChatRequests.id, id)));
    const restarted = await startTestApp({ databaseUrl: isolated.ctx.config.databaseUrl });
    try {
      await runChatRequest(restarted.ctx, catalogue.catalogue);
      expect(restarted.model.requests).toHaveLength(0);
      expect((await b.get(`/api/subscriptions/chat/requests/${id}`)).body.error.code).toBe("chat_expired");
    } finally {
      await restarted.close();
    }
  } finally {
    await isolated.close();
  }
});
