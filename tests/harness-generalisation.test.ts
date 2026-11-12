import { afterAll, beforeAll, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { startTestApp, type TestApp } from "./helpers";
import { repeatedBillingQuestionFeedback, subscriptionContext } from "../src/server/val-chat";
import type { CatalogueResponse } from "../src/shared/contracts.types";

const catalogue = JSON.parse(
  readFileSync("docs/build-pack/catalogue/catalogue.json", "utf8"),
) as CatalogueResponse["catalogue"];

it("does not ask for a clearly supplied bill again or confuse unrelated prices with that bill", () => {
  const service = { name: "Bramble Mail" };
  const question = "Could you confirm how much you pay and how often you're billed for it?";
  expect(
    repeatedBillingQuestionFeedback(question, service, [
      "I pay £12.00 a month for Bramble Mail. Can you help me?",
      "Two inboxes and twelve GB in total.",
    ]),
  ).toContain("Do not ask them to repeat that bill");
  for (const ambiguous of [
    "I pay £12 for Bramble Mail.",
    "I pay £12 a month for Another Service.",
    "I might pay £12 a month for Bramble Mail.",
    "I used to pay £12 a month for Bramble Mail.",
    "I pay £12 a month for Bramble Mail and £8 for another service.",
    "I pay £12 a month per user for Bramble Mail.",
    "Bramble Mail gives me 12GB a month.",
    "I pay USD 12 a month for Bramble Mail.",
  ])
    expect(repeatedBillingQuestionFeedback(question, service, [ambiguous])).toBeNull();
  expect(
    repeatedBillingQuestionFeedback("Does your bill include both inboxes?", service, [
      "I pay £12 a month for Bramble Mail.",
    ]),
  ).toBeNull();
  expect(
    repeatedBillingQuestionFeedback("What do you pay attention to when reading?", service, [
      "I pay £12 a month for Bramble Mail.",
    ]),
  ).toBeNull();
  expect(
    repeatedBillingQuestionFeedback(question, service, [
      "Actually, I don't know the current charge.",
      "I pay £12 a month for Bramble Mail.",
    ]),
  ).toBeNull();
});

it("supplies product facts without attaching a category questionnaire or assumed customer needs", () => {
  for (const service of catalogue.services) {
    const context = subscriptionContext(catalogue.services, { serviceId: service.id, name: service.service });
    expect(context).not.toHaveProperty("topics");
    expect(context).not.toHaveProperty("purpose");
    expect(context).not.toHaveProperty("questions");
    expect(context.capabilities).toEqual(service.capability_tags.slice(0, 12));
    expect(context.servicePurpose).toBe(service.purpose);
  }
  const unfamiliar = subscriptionContext(catalogue.services, {
    serviceId: "paypal:unfamiliar",
    name: "Orchard Research Workspace",
  });
  expect(unfamiliar.identification).toBe("unknown");
  expect(unfamiliar.capabilities).toEqual([]);
  expect(unfamiliar).not.toHaveProperty("topics");
});

let app: TestApp;
beforeAll(async () => {
  app = await startTestApp();
});
afterAll(() => app.close());

it("repairs a repeated billing question from the actual conversation without saving unconfirmed memory", async () => {
  const browser = app.browser();
  await browser.login();
  const service = catalogue.services[0]!;
  let proposals = 0;
  app.model.script = (request) => {
    const outputs = (request.input as any[])
      .filter((item) => item.type === "function_call_output")
      .map((item) => JSON.parse(item.output));
    const found = outputs.find((output) => output.services?.length)?.services[0];
    if (!found) return { call: "search_subscriptions", arguments: { query: service.service } };
    expect(request.tools).toBeUndefined();
    if (++proposals === 1)
      return {
        answer: {
          message: "How much do you pay and how often are you billed?",
          draft: null,
          compareRef: null,
          discussingRef: found.ref,
        },
      };
    expect(JSON.stringify(request.input)).toContain("Do not ask them to repeat that bill");
    return {
      answer: {
        message: "Does this capture what you need?",
        draft: { serviceRef: found.ref, amountMinor: 1200, cycle: "month", purpose: "Personal use" },
        costStatement: "£12.00 a month",
        compareRef: null,
        discussingRef: found.ref,
      },
    };
  };
  const result = await browser.post("/api/subscriptions/chat", {
    message: "Just for personal use.",
    history: [
      { from: "you", text: `I pay £12.00 a month for ${service.service}.` },
      { from: "val", text: `What do you use ${service.service} for?` },
    ],
    expectedRevision: 0,
  });
  expect(result.status).toBe(200);
  expect(proposals).toBe(2);
  expect(result.body.draft).toMatchObject({ amountMinor: 1200, cycle: "month", purpose: "Personal use" });
  expect((await browser.get("/api/subscriptions")).body.subscriptions).toEqual([]);
});

it("accepts an independently worded opening for saved subscriptions after the required account reads", async () => {
  const browser = app.browser();
  await browser.login();
  await browser.request("PUT", "/api/subscriptions", {
    expectedRevision: 0,
    subscriptions: [{ serviceId: "netflix", amountMinor: 1399, cycle: "month", purpose: "" }],
  });
  const message = "Netflix is in your saved list. What do you use it for?";
  app.model.script = (request) => {
    const reads = Array.isArray(request.input)
      ? request.input.filter((item: any) => item.type === "function_call_output")
      : [];
    expect(reads).toHaveLength(2);
    return { answer: { message, draft: null, compareRef: null } };
  };
  const result = await browser.post("/api/subscriptions/chat", {
    message: null,
    history: [],
    expectedRevision: 1,
  });
  expect(result.status).toBe(200);
  expect(result.body.message).toBe(message);
  expect(result.body.draft).toBeNull();
  expect(result.body.portfolio.subscriptions).toHaveLength(1);
});
