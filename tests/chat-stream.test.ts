import { expect, it } from "vitest";
import { readIngestionStream } from "../src/client/chat-stream";
import type {
  SubscriptionIngestionEvent,
  SubscriptionIngestionProgress,
  ValChatReply,
} from "../src/shared/subscriptions";

const reply: ValChatReply = {
  message: "I see Netflix in your subscriptions.",
  portfolio: {
    revision: 1,
    subscriptions: [
      {
        serviceId: "netflix",
        name: "Netflix",
        source: "manual",
        purpose: "Grey’s Anatomy",
        amountMinor: null,
        cycle: "month",
      },
    ],
  },
  draft: null,
  compareServiceId: null,
  checkedAt: null,
};
const response = (events: SubscriptionIngestionEvent[], size = 11) => {
  const bytes = new TextEncoder().encode(events.map((event) => JSON.stringify(event)).join("\n"));
  return new Response(
    new ReadableStream({
      start(controller) {
        for (let i = 0; i < bytes.length; i += size) controller.enqueue(bytes.slice(i, i + size));
        controller.close();
      },
    }),
  );
};
it("delivers progress before the final reply and handles split UTF-8, split lines and an unterminated final line", async () => {
  const events: SubscriptionIngestionProgress[] = [];
  const result = await readIngestionStream(
    response(
      [
        { type: "stage", stage: "reading" },
        { type: "subscription", subscription: reply.portfolio.subscriptions[0]! },
        { type: "result", reply },
      ],
      1,
    ),
    (event) => events.push(event),
  );
  expect(events).toEqual([
    { type: "stage", stage: "reading" },
    { type: "subscription", subscription: reply.portfolio.subscriptions[0] },
  ]);
  expect(result).toEqual(reply);
});
it("does not turn partial progress into success after a failed or interrupted check", async () => {
  await expect(
    readIngestionStream(response([{ type: "stage", stage: "reading" }]), () => {}),
  ).rejects.toThrow("interrupted");
  await expect(
    readIngestionStream(
      response([
        { type: "stage", stage: "reading" },
        { type: "error", message: "Your subscriptions changed. Reload before continuing." },
      ]),
      () => {},
    ),
  ).rejects.toThrow("subscriptions changed");
  await expect(readIngestionStream(new Response("not-json\n"), () => {})).rejects.toThrow();
});
