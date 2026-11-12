import { afterEach, expect, it, vi } from "vitest";
import { api } from "../src/client/api";
import { paypalWalletRefreshMs, type PayPalWalletStatus } from "../src/shared/paypal-wallet";

const status = (phase: PayPalWalletStatus["phase"], checkedAt: string | null): PayPalWalletStatus => ({
  enabled: true,
  phase,
  message: "Synthetic wallet status",
  signInUrl: null,
  checkedAt,
  pollAfterMs: 2000,
  portfolio: { revision: 0, subscriptions: [] },
  findings: null,
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("does not start a refresh when a delayed status reply arrives after the screen closes", async () => {
  let reply!: (value: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>(
    () =>
      new Promise<Response>((resolve) => {
        reply = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const opening = api.openPayPalWallet(controller.signal);
  controller.abort();
  reply(Response.json(status("complete", new Date(Date.now() - paypalWalletRefreshMs - 1000).toISOString())));
  await expect(opening).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).toHaveBeenCalledOnce();
  expect(fetch.mock.calls[0]?.[0]).toBe("/api/paypal/wallet");
});

it("refreshes an expired completed check once, retaining the same cancellation signal", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json(status("complete", new Date(Date.now() - paypalWalletRefreshMs - 1000).toISOString())),
    )
    .mockResolvedValueOnce(Response.json(status("queued", null)));
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  expect((await api.openPayPalWallet(controller.signal)).phase).toBe("queued");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[0]).toBe("/api/paypal/wallet/connect");
  expect(fetch.mock.calls.every(([, init]) => init.signal === controller.signal)).toBe(true);
});

it.each(["disconnected", "failed", "reconnect", "complete"] as const)(
  "opening %s does not silently connect a new wallet or retry a failed one",
  async (phase) => {
    const fetch = vi.fn().mockResolvedValue(Response.json(status(phase, new Date().toISOString())));
    vi.stubGlobal("fetch", fetch);
    expect((await api.openPayPalWallet(new AbortController().signal)).phase).toBe(phase);
    expect(fetch).toHaveBeenCalledOnce();
  },
);

it("does not dispatch wallet requests whose caller has already been cancelled", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  for (const request of [
    api.paypalWallet,
    api.connectPayPalWallet,
    api.checkPayPalWallet,
    api.disconnectPayPalWallet,
  ])
    await expect(request(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    api.reviewPayPalPayment(
      {
        key: "a".repeat(64),
        checkedAt: new Date().toISOString(),
        expectedRevision: 0,
        expectedReviewRevision: 0,
        choice: "month",
      },
      controller.signal,
    ),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});
