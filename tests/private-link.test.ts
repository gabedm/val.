import { afterEach, expect, it, vi } from "vitest";
import { capturePrivateLink, redeemPrivateLink } from "../src/client/private-link";
afterEach(() => vi.restoreAllMocks());

it("removes the token without adding browser history or losing query state", async () => {
  const token = "t".repeat(43),
    replaceState = vi.fn();
  const location = new URL("https://val.example/?start=onboarding&run=fresh#access=" + token);
  const link = capturePrivateLink(location as unknown as Location, { replaceState })!;
  expect(replaceState).toHaveBeenCalledWith(null, "", "/?start=onboarding&run=fresh#home");
  const session = vi.fn(async () => ({})),
    redeem = vi.fn(async () => ({ allowed: true }));
  const first = redeemPrivateLink(link, session, redeem),
    second = redeemPrivateLink(link, session, redeem);
  expect(first).toBe(second);
  await first;
  expect(session).toHaveBeenCalledOnce();
  expect(redeem).toHaveBeenCalledExactlyOnceWith(token);
  expect(link.token).toBe("");
  expect(
    capturePrivateLink(new URL("https://val.example/#home") as unknown as Location, { replaceState }),
  ).toBeNull();
});

it("removes malformed fragments and permits retry after an interrupted bootstrap", async () => {
  const replaceState = vi.fn();
  const bad = capturePrivateLink(new URL("https://val.example/#access=not-valid") as unknown as Location, {
    replaceState,
  })!;
  expect(bad.token).toBe("");
  expect(replaceState).toHaveBeenCalledOnce();
  const link = capturePrivateLink(
    new URL("https://val.example/#access=" + "z".repeat(43)) as unknown as Location,
    { replaceState },
  )!;
  const session = vi.fn().mockRejectedValueOnce(new Error("interrupted")).mockResolvedValue({});
  const redeem = vi.fn(async () => ({ allowed: true }));
  await expect(redeemPrivateLink(link, session, redeem)).rejects.toThrow("interrupted");
  expect(redeem).not.toHaveBeenCalled();
  await expect(redeemPrivateLink(link, session, redeem)).resolves.toEqual({ allowed: true });
  expect(redeem).toHaveBeenCalledOnce();
});
