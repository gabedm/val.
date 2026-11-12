import { afterAll, beforeAll, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./helpers";
import { ownerSubscriptions } from "../src/server/db/schema";

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());
const outputs = (request: any) =>
  request.input
    .filter((item: any) => item.type === "function_call_output")
    .map((item: any) => JSON.parse(item.output));

it("allows a semantic topic change despite an active unfamiliar payment, without an unrelated lookup", async () => {
  const browser = app.browser();
  const login = await browser.login();
  await app.ctx.db.insert(ownerSubscriptions).values({
    ownerId: login.body.session.ownerId,
    revision: 1,
    subscriptions: [
      {
        serviceId: "opaque:club",
        name: "Harbour Club",
        source: "paypal",
        amountMinor: 2400,
        cycle: "month",
        purpose: "",
      },
      {
        serviceId: "spotify",
        name: "Spotify",
        source: "paypal",
        amountMinor: 1299,
        cycle: "month",
        purpose: "",
      },
    ],
  });
  const before = app.model.requests.length;
  app.model.script = (request) => {
    const memory = outputs(request)[0];
    expect(memory.activeRef).toBe("saved:0");
    expect(memory).not.toHaveProperty("suggestedRef");
    expect(memory).not.toHaveProperty("requiredProductRef");
    expect(memory.unresolvedProductRefs).toEqual(["saved:0"]);
    expect(request.tool_choice).toBe("auto");
    expect(request.instructions).toContain("previous focus, not a mandatory target");
    return {
      answer: {
        message: "Does this capture what you need for your music?",
        discussingRef: "saved:1",
        compareRef: null,
        draft: {
          serviceRef: "saved:1",
          amountMinor: 1299,
          cycle: "month",
          purpose: "Music at work on a laptop. Ads are fine; no downloads needed.",
        },
      },
    };
  };
  const reply = await browser.post("/api/subscriptions/chat", {
    message:
      "leave that club one a sec. the music one is just on my work laptop, ads fine, never download anything",
    history: [{ from: "val", text: "What is your club membership for?" }],
    activeServiceId: "opaque:club",
    expectedRevision: 1,
  });
  expect(reply.status).toBe(200);
  expect(reply.body.draft.serviceId).toBe("spotify");
  expect(app.model.requests.length - before).toBe(1);
  expect(
    (await browser.get("/api/subscriptions")).body.subscriptions.every((row: any) => row.purpose === ""),
  ).toBe(true);
});

it.each(["say that again pls", "sorry, missed that", "could you put that another way?"])(
  "lets model-interpreted clarification progress without a phrase whitelist: %s",
  async (message) => {
    const browser = app.browser();
    await browser.login();
    const question = "Do you use it away from Wi-Fi?";
    const before = app.model.requests.length;
    app.model.script = () => ({
      answer: {
        message: question,
        repeatRequested: true,
        draft: null,
        compareRef: null,
      },
    });
    const reply = await browser.post("/api/subscriptions/chat", {
      message,
      history: [{ from: "val", text: question }],
      expectedRevision: 0,
    });
    expect(reply.status).toBe(200);
    expect(reply.body.message).toBe(question);
    expect(reply.body.draft).toBeNull();
    expect(app.model.requests.length - before).toBe(1);
    expect((await browser.get("/api/subscriptions")).body.revision).toBe(0);
  },
);

it("carries an earlier combined answer into the next memory proposal and preserves the separate confirmation", async () => {
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [
      { serviceId: "netflix", amountMinor: 1399, cycle: "month", purpose: "Drama on one screen, no ads." },
      { serviceId: "spotify", amountMinor: 1299, cycle: "month", purpose: "" },
    ],
  });
  const combined =
    "drama, one screen and no ads for tv. music is just on the laptop, ads dont bother me and no downloads";
  app.model.script = (request) => {
    expect(JSON.stringify(request.input)).toContain(combined);
    expect(request.instructions).toContain("using already-supplied answers");
    return {
      answer: {
        message: "And is this right for your music?",
        discussingRef: "saved:1",
        compareRef: null,
        draft: {
          serviceRef: "saved:1",
          amountMinor: 1299,
          cycle: "month",
          purpose: "Music on a laptop. Ads are acceptable and offline downloads are not needed.",
        },
      },
    };
  };
  const reply = await browser.post("/api/subscriptions/chat", {
    message: "What else do you need to know about my subscriptions?",
    expectedRevision: 1,
    history: [
      { from: "you", text: combined },
      { from: "val", text: "Does this capture your viewing needs?" },
      { from: "you", text: "Remember this for Netflix." },
      { from: "val", text: "I’ll remember that for Netflix." },
    ],
  });
  expect(reply.status).toBe(200);
  expect(reply.body.draft.serviceId).toBe("spotify");
  expect(reply.body.draft.purpose).toContain("offline downloads are not needed");
  const saved = (await browser.get("/api/subscriptions")).body;
  expect(saved.revision).toBe(1);
  expect(saved.subscriptions[1].purpose).toBe("");
});

it("does not mistake naturally worded schedule confirmation for a missing usage-memory proposal", async () => {
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [{ serviceId: "spotify", amountMinor: 1299, cycle: "month", purpose: "Music at work" }],
  });
  const before = app.model.requests.length;
  app.model.script = () => ({
    answer: {
      message: "Does this look right?",
      draft: null,
      compareRef: null,
      scheduleDraft: { serviceRefs: ["saved:0"], cadence: { every: 1, unit: "week" } },
    },
  });
  const reply = await browser.post("/api/subscriptions/chat", {
    message: "the music one every week please",
    expectedRevision: 1,
    history: [{ from: "val", text: "Does this look right?" }],
  });
  expect(reply.status).toBe(200);
  expect(reply.body.draft).toBeNull();
  expect(reply.body.scheduleDraft).toMatchObject({
    serviceIds: ["spotify"],
    cadence: { every: 1, unit: "week" },
  });
  expect(app.model.requests.length - before).toBe(1);
  expect((await browser.get("/api/subscriptions/price-checks")).body.schedules).toEqual([]);
});
