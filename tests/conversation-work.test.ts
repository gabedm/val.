import { expect, it, vi } from "vitest";
import { createConversationWork, type ConversationTask } from "../src/client/conversation-work";

it("takes ownership synchronously, so two clicks cannot start overlapping work", () => {
  const work = createConversationWork(vi.fn());
  const first = work.begin("chat")!;
  expect(work.begin("memory")).toBeNull();
  expect(first.current()).toBe(true);
  expect(work.busy).toBe(true);
  first.finish();
  expect(work.state).toEqual({ phase: "idle" });
  expect(first.current()).toBe(false);
});

it("resumes the correct progress display after a retry pause", () => {
  const work = createConversationWork(vi.fn());
  const task = work.begin("chat")!;
  task.waiting(true);
  expect(work.state).toMatchObject({ phase: "waiting", resume: "working" });
  task.waiting(true);
  task.research();
  expect(work.state).toMatchObject({ phase: "waiting", resume: "research" });
  task.waiting(false);
  expect(work.state).toMatchObject({ phase: "research" });
  task.waiting(false);
  expect(work.state).toMatchObject({ phase: "research" });
});

it("hands confirmed memory into research without an old finally handler clearing the new owner", () => {
  const work = createConversationWork(vi.fn());
  const save = work.begin("memory")!;
  save.finish();
  const setup = work.begin("setup")!;
  setup.research();
  const before = work.state;
  save.waiting(true);
  save.research();
  save.finish();
  expect(work.state).toBe(before);
  expect(setup.current()).toBe(true);
});

it("cancels reads on unmount without publishing or allowing late callbacks to touch a remounted run", () => {
  const publish = vi.fn();
  const work = createConversationWork(publish);
  const old = work.begin("chat")!;
  const count = publish.mock.calls.length;
  work.cancel(false);
  expect(old.signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledTimes(count);
  work.publish();
  const next = work.begin("restore")!;
  const before = work.state;
  old.finish();
  old.research();
  old.waiting(false);
  expect(work.state).toBe(before);
  expect(next.current()).toBe(true);
});

it("removes ownership before abort listeners run", () => {
  const work = createConversationWork(vi.fn());
  const old = work.begin("comparison")!;
  const observe = vi.fn(() => {
    expect(old.current()).toBe(false);
    expect(work.busy).toBe(false);
  });
  old.signal.addEventListener("abort", observe);
  work.cancel();
  work.cancel();
  expect(observe).toHaveBeenCalledTimes(1);
});

it("keeps ownership coherent under mixed starts, pauses, finishes and cancellation", () => {
  const work = createConversationWork(vi.fn());
  const tasks: ConversationTask[] = [];
  // Deliberately retain old tickets as delayed responses while exercising new tasks.
  let seed = 379;
  for (let i = 0; i < 600; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const old = tasks[seed % Math.max(1, tasks.length)];
    switch (seed % 7) {
      case 0:
      case 1: {
        const next = work.begin("chat");
        if (next) tasks.push(next);
        break;
      }
      case 2:
        old?.finish();
        break;
      case 3:
        old?.waiting(true);
        break;
      case 4:
        old?.waiting(false);
        break;
      case 5:
        old?.research();
        break;
      case 6:
        work.cancel();
        break;
    }
    const owners = tasks.filter((task) => task.current());
    expect(owners.length).toBe(work.busy ? 1 : 0);
    expect(work.state.phase === "idle").toBe(!work.busy);
  }
});
