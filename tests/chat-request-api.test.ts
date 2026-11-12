import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import type { ValChatCommand, ValChatRequest } from "../src/shared/subscriptions";
const command: ValChatCommand = { message: "ad free, just me", history: [], expectedRevision: 0 };
const reply = {
  message: "Here is your proposed memory.",
  portfolio: { revision: 0, subscriptions: [] },
  draft: null,
  compareServiceId: null,
  checkedAt: null,
};
const row = (extra: Partial<ValChatRequest> = {}): ValChatRequest => ({
  id: "job-id",
  createdAt: new Date().toISOString(),
  status: "queued",
  command,
  progress: [],
  reply: null,
  error: null,
  ...extra,
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("recognises an empty request history on a genuinely fresh login", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(null)));
  await expect(api.latestChatRequest()).resolves.toBeNull();
});

it("retries a lost create response with the exact same request ID and command", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Network disconnected"))
    .mockResolvedValueOnce(Response.json(row({ status: "complete", reply, id: "previously-created-id" })));
  vi.stubGlobal("fetch", fetch);
  const task = api.durableValChat("original-id", command, new AbortController().signal);
  const result = expect(task).resolves.toEqual(reply);
  await vi.advanceTimersByTimeAsync(500);
  await result;
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
  expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ id: "original-id", command });
});

it("polls the returned job ID when the server reattaches a duplicate command", async () => {
  vi.useFakeTimers();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json(row({ id: "existing-id" })))
    .mockResolvedValueOnce(Response.json(row({ id: "existing-id", status: "complete", reply })));
  vi.stubGlobal("fetch", fetch);
  const result = expect(api.durableValChat("new-id", command, new AbortController().signal)).resolves.toEqual(
    reply,
  );
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(fetch.mock.calls[1]![0]).toBe("/api/subscriptions/chat/requests/existing-id");
});

it("reattaches after refresh with reads only, tolerates disconnects and rate limits, and delivers progress once", async () => {
  vi.useFakeTimers();
  const progress = { type: "complete", serviceId: "arbitrary", name: "Arbitrary service" } as any;
  const fetch = vi
    .fn()
    .mockRejectedValueOnce(new TypeError("Offline"))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "request_rate_limited", message: "Wait" }), {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    )
    .mockResolvedValueOnce(Response.json(row({ status: "running", progress: [progress] })))
    .mockResolvedValueOnce(Response.json(row({ status: "complete", reply, progress: [progress] })));
  const onProgress = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const result = expect(
    api.resumeChatRequest("existing", new AbortController().signal, onProgress),
  ).resolves.toEqual(reply);
  await vi.advanceTimersByTimeAsync(5000);
  await result;
  expect(fetch).toHaveBeenCalledTimes(4);
  expect(fetch.mock.calls.every(([, init]) => init.method === "GET")).toBe(true);
  expect(onProgress).toHaveBeenCalledExactlyOnceWith(progress);
});

it("stops polling a departing browser without cancelling server work or starting another turn", async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValue(Response.json(row()));
  vi.stubGlobal("fetch", fetch);
  const stop = new AbortController();
  const task = api.resumeChatRequest("existing", stop.signal);
  const result = expect(task).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(10);
  stop.abort();
  await result;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it.each(["failed", "superseded"] as const)(
  "exposes a terminal %s job without replaying it",
  async (status) => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json(
        row({
          status,
          error: {
            status: 409,
            code: "subscriptions_changed",
            message: "Please review your subscriptions.",
          },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(api.resumeChatRequest("existing", new AbortController().signal)).rejects.toMatchObject({
      code: "subscriptions_changed",
      completedChatRequest: true,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("fails immediately for a malformed completed result instead of polling for five minutes", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(row({ status: "complete" }))));
  await expect(api.resumeChatRequest("existing", new AbortController().signal)).rejects.toMatchObject({
    code: "invalid_response",
    completedChatRequest: true,
  });
});

it("bounds a stalled polling connection and reconnects to the existing job", async () => {
  vi.useFakeTimers();
  const timeout = vi
    .spyOn(AbortSignal, "timeout")
    .mockImplementation(() => AbortSignal.abort(new DOMException("Connection timed out", "TimeoutError")));
  const fetch = vi
    .fn()
    .mockImplementationOnce(async (_path, options) => {
      throw options.signal.reason;
    })
    .mockImplementationOnce(async () => {
      timeout.mockRestore();
      return Response.json(row({ status: "complete", reply }));
    });
  vi.stubGlobal("fetch", fetch);
  const result = expect(api.resumeChatRequest("existing", new AbortController().signal)).resolves.toEqual(
    reply,
  );
  // Let the reconnect use a fresh transport deadline rather than the aborted first one.
  await vi.advanceTimersByTimeAsync(0);
  timeout.mockRestore();
  await vi.advanceTimersByTimeAsync(1000);
  await result;
  expect(fetch.mock.calls.every(([, options]) => options.method === "GET")).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(2);
});
