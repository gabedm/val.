import { expect, it, vi } from "vitest";
import { ApiError } from "../src/client/api";
import {
  recoverCommittedWrite,
  memoryWriteMatches,
  memoryAlreadySaved,
  scheduleWriteMatches,
} from "../src/client/confirmed-write";
import type { ConversationProposal } from "../src/client/conversation-proposal";
import type { PriceCheckSchedule } from "../src/shared/price-checks";

const memory: Extract<ConversationProposal, { kind: "memory" }> = {
  kind: "memory",
  revision: 7,
  draft: {
    serviceId: "music",
    name: "Music",
    source: "paypal",
    amountMinor: 1200,
    cycle: "month",
    purpose: "Offline music",
  },
};
const saved = { revision: 8, subscriptions: [memory.draft] };
it("recognises a restored unchanged proposal at the saved revision without pretending a new write happened", () => {
  const current = { ...saved, revision: memory.revision };
  expect(memoryAlreadySaved(memory, current)).toBe(true);
  expect(memoryWriteMatches(memory, current)).toBe(false);
  expect(memoryAlreadySaved(memory, { ...current, revision: memory.revision - 1 })).toBe(false);
  expect(
    memoryAlreadySaved(memory, {
      ...current,
      subscriptions: [{ ...memory.draft, purpose: "Offline music and podcasts" }],
    }),
  ).toBe(false);
});

it.each([
  new TypeError("Connection closed after commit"),
  new ApiError(200, "invalid_response", "Truncated response after commit"),
])("acknowledges a committed memory after an unreadable response: %s", async (lost) => {
  const write = vi.fn().mockRejectedValue(lost),
    read = vi.fn().mockResolvedValue(saved);
  expect(
    await recoverCommittedWrite<typeof saved>(write, read, (value) => memoryWriteMatches(memory, value)),
  ).toEqual(saved);
  expect(write).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(1);
});
it("recovers a stale-revision retry only when the intended memory is already present", async () => {
  const conflict = new ApiError(409, "subscriptions_changed", "Reload");
  expect(
    await recoverCommittedWrite(
      async () => {
        throw conflict;
      },
      async () => saved,
      (value) => memoryWriteMatches(memory, value),
    ),
  ).toEqual(saved);
  for (const value of [
    { ...saved, revision: 7 },
    { ...saved, subscriptions: [{ ...memory.draft, purpose: "A different need" }] },
    { ...saved, subscriptions: [{ ...memory.draft, amountMinor: 1800 }] },
    { ...saved, subscriptions: [] },
  ])
    expect(memoryWriteMatches(memory, value)).toBe(false);
});
it("preserves a genuine conflict or unreadable outcome instead of pretending a save succeeded", async () => {
  const conflict = new ApiError(409, "subscriptions_changed", "Reload");
  await expect(
    recoverCommittedWrite(
      async () => {
        throw conflict;
      },
      async () => saved,
      () => false,
    ),
  ).rejects.toBe(conflict);
  await expect(
    recoverCommittedWrite(
      async () => {
        throw conflict;
      },
      async () => {
        throw Error("Offline");
      },
      () => true,
    ),
  ).rejects.toBe(conflict);
});
it("does not read back or replay a request rejected for missing authority", async () => {
  const denied = new ApiError(403, "bad_csrf", "Sign in again");
  const write = vi.fn().mockRejectedValue(denied),
    read = vi.fn().mockResolvedValue(saved);
  await expect(recoverCommittedWrite(write, read, () => true)).rejects.toBe(denied);
  expect(write).toHaveBeenCalledTimes(1);
  expect(read).not.toHaveBeenCalled();
});
it("reconciles a committed schedule without resetting its next-check date or accepting another cadence", async () => {
  const proposal: Extract<ConversationProposal, { kind: "schedule" }> = {
    kind: "schedule",
    revision: 7,
    draft: { serviceIds: ["music"], expectedRevisions: { music: 3 }, cadence: { every: 1, unit: "week" } },
  };
  const row: PriceCheckSchedule = {
    serviceId: "music",
    revision: 4,
    cadence: { every: 1, unit: "week" },
    status: "scheduled",
    nextCheckAt: "2026-11-16T12:00:00Z",
    lastCheckedAt: null,
    advice: null,
  };
  const write = vi.fn().mockRejectedValue(new TypeError("Lost response"));
  const result = await recoverCommittedWrite(
    write,
    async () => ({ schedules: [row] }),
    (value) => scheduleWriteMatches(proposal, value.schedules),
  );
  expect(result.schedules[0]!.nextCheckAt).toBe(row.nextCheckAt);
  expect(write).toHaveBeenCalledTimes(1);
  expect(scheduleWriteMatches(proposal, [{ ...row, revision: 3 }])).toBe(false);
  expect(scheduleWriteMatches(proposal, [{ ...row, cadence: null }])).toBe(false);
  expect(
    scheduleWriteMatches({ ...proposal, draft: { ...proposal.draft, cadence: null } }, [
      { ...row, cadence: null, status: "paused" },
    ]),
  ).toBe(true);
});
