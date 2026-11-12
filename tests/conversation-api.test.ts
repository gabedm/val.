import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { recoverAIRateLimit } from "../src/client/ai-recovery";

afterEach(() => vi.unstubAllGlobals());

it("retains a streaming request's pre-dispatch retry delay so onboarding can recover once", async () => {
  vi.useFakeTimers();
  const reply = {
    message: "Tell me what matters.",
    portfolio: { revision: 0, subscriptions: [] },
    draft: null,
    compareServiceId: null,
    checkedAt: null,
  };
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "judge_rate_limited", message: "Short pause" }), {
        status: 429,
        headers: { "Retry-After": "2" },
      }),
    )
    .mockResolvedValueOnce(
      new Response(JSON.stringify(reply), { headers: { "Content-Type": "application/json" } }),
    );
  vi.stubGlobal("fetch", fetch);
  try {
    const waiting = vi.fn();
    const task = recoverAIRateLimit(
      () => api.ingestSubscriptions(0, () => {}, new AbortController().signal),
      new AbortController().signal,
      waiting,
    );
    const result = expect(task).resolves.toEqual(reply);
    await vi.advanceTimersByTimeAsync(2150);
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(waiting.mock.calls).toEqual([[true], [false]]);
  } finally {
    vi.useRealTimers();
  }
});

it("forwards cancellation to every conversation read, including chat and provider checks", async () => {
  const fetch = vi.fn(async () => new Response("{}", { headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetch);
  const { signal } = new AbortController();
  await api.valChat("an unexpected natural answer", [], 4, [], null, signal);
  await api.subscriptions(signal);
  await api.subscriptionAdvice("outside-list", 4, false, undefined, signal);
  await api.subscriptionReviews(4, signal);
  await api.reviewBatch(4, signal);
  expect(fetch).toHaveBeenCalledTimes(5);
  for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][])
    expect(init.signal).toBe(signal);
});

it("does not start canceled work or accept a response canceled during decoding", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(api.subscriptions(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  const pending = new AbortController();
  fetch.mockResolvedValue({
    ok: true,
    json: async () => {
      pending.abort();
      return {};
    },
  });
  await expect(api.subscriptions(pending.signal)).rejects.toMatchObject({ name: "AbortError" });
});

it("submits confirmed writes once without linking them to a departing view's cancellation", async () => {
  const fetch = vi.fn(async () => new Response("{}"));
  vi.stubGlobal("fetch", fetch);
  await api.saveSubscriptions({ expectedRevision: 4, subscriptions: [] });
  await api.savePriceChecks(
    { serviceIds: ["outside-list"], cadence: null, expectedRevisions: { "outside-list": 0 } },
    4,
  );
  await api.startReviewBatch(4);
  expect(fetch).toHaveBeenCalledTimes(3);
  for (const [, init] of fetch.mock.calls as unknown as [string, RequestInit][])
    expect(init.signal).toBeUndefined();
  expect(
    JSON.parse((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).expectedRevision,
  ).toBe(4);
});
