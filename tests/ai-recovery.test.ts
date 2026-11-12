import { afterEach, expect, it, vi } from "vitest";
import { recoverAIRateLimit, recoverBusyRead } from "../src/client/ai-recovery";
afterEach(() => vi.useRealTimers());
it.each(["review_running", "chat_running"])(
  "resumes an opening after known task admission rejections (%s)",
  async (code) => {
    vi.useFakeTimers();
    const waiting = vi.fn();
    const work = vi
      .fn()
      .mockRejectedValueOnce({ code })
      .mockRejectedValueOnce({ code })
      .mockResolvedValue("ready");
    const result = recoverBusyRead(work, new AbortController().signal, waiting);
    await vi.advanceTimersByTimeAsync(9999);
    expect(work).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("ready");
    expect(work).toHaveBeenCalledTimes(3);
    expect(waiting.mock.calls).toEqual([[true], [false]]);
  },
);
it("bounds an opening wait and cancels it without replaying unknown or funded outcomes", async () => {
  for (const error of [
    { code: "judge_request_running" },
    { code: "judge_budget_exhausted" },
    { code: "model_rate_limited" },
    { code: "subscriptions_changed" },
    new Error("network"),
  ]) {
    const work = vi.fn().mockRejectedValue(error);
    await expect(recoverBusyRead(work, new AbortController().signal, vi.fn())).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
  }
  vi.useFakeTimers();
  const error = { code: "review_running" };
  const work = vi.fn().mockRejectedValue(error);
  const result = recoverBusyRead(work, new AbortController().signal, vi.fn());
  const rejected = expect(result).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(300000);
  await rejected;
  expect(work).toHaveBeenCalledTimes(61);
  const controller = new AbortController();
  const cancelled = vi.fn().mockRejectedValue(error);
  const pending = recoverBusyRead(cancelled, controller.signal, vi.fn());
  const aborted = expect(pending).rejects.toBeDefined();
  await Promise.resolve();
  controller.abort();
  await aborted;
  await vi.advanceTimersByTimeAsync(10000);
  expect(cancelled).toHaveBeenCalledTimes(1);
});
it.each(["judge_rate_limited", "model_rate_limited"])(
  "waits for a bounded rate window and retries once (%s)",
  async (code) => {
    vi.useFakeTimers();
    const waiting = vi.fn();
    const work = vi.fn().mockRejectedValueOnce({ code, retryAfterSeconds: 2 }).mockResolvedValue("complete");
    const result = recoverAIRateLimit(work, new AbortController().signal, waiting);
    await vi.advanceTimersByTimeAsync(2000);
    expect(work).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(150);
    await expect(result).resolves.toBe("complete");
    expect(work).toHaveBeenCalledTimes(2);
    expect(waiting.mock.calls).toEqual([[true], [false]]);
  },
);
it("never retries unknown outcomes, access/spend limits, malformed waits or a second rate rejection", async () => {
  for (const error of [
    { code: "judge_budget_exhausted" },
    { code: "judge_access_required" },
    { code: "judge_request_running" },
    new Error("network"),
    { code: "judge_rate_limited", retryAfterSeconds: 600 },
    { code: "model_rate_limited", retryAfterSeconds: 600 },
  ]) {
    const work = vi.fn().mockRejectedValue(error);
    await expect(recoverAIRateLimit(work, new AbortController().signal, vi.fn())).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
  }
  vi.useFakeTimers();
  const error = { code: "judge_rate_limited", retryAfterSeconds: 1 };
  const work = vi.fn().mockRejectedValue(error);
  const result = recoverAIRateLimit(work, new AbortController().signal, vi.fn());
  const rejected = expect(result).rejects.toBe(error);
  await vi.advanceTimersByTimeAsync(1150);
  await rejected;
  expect(work).toHaveBeenCalledTimes(2);
});
it("cancels a waiting retry when its conversation closes", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const work = vi.fn().mockRejectedValue({ code: "judge_rate_limited", retryAfterSeconds: 1 });
  const result = recoverAIRateLimit(work, controller.signal, vi.fn());
  const rejected = expect(result).rejects.toBeDefined();
  await Promise.resolve();
  controller.abort();
  await rejected;
  await vi.advanceTimersByTimeAsync(2000);
  expect(work).toHaveBeenCalledTimes(1);
});
