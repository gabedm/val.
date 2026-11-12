export type ConversationOperation =
  "chat" | "setup" | "memory" | "schedule" | "comparison" | "findings" | "restore";
type ActiveWork = { id: number; operation: ConversationOperation };
export type ConversationWorkState =
  | { phase: "idle" }
  | (ActiveWork & { phase: "working" | "research" })
  | (ActiveWork & { phase: "waiting"; resume: "working" | "research" });

export interface ConversationTask {
  signal: AbortSignal;
  current: () => boolean;
  research: () => void;
  waiting: (waiting: boolean) => void;
  finish: () => void;
}

/** One task owns the conversation. Late callbacks cannot finish or change a newer task. */
export function createConversationWork(publish: (state: ConversationWorkState) => void) {
  let state: ConversationWorkState = { phase: "idle" };
  let active: { id: number; controller: AbortController } | null = null;
  let nextId = 0;
  const update = (next: ConversationWorkState) => {
    state = next;
    publish(next);
  };
  return {
    get busy() {
      return active !== null;
    },
    get state() {
      return state;
    },
    publish: () => publish(state),
    begin(operation: ConversationOperation): ConversationTask | null {
      if (active) return null;
      const id = ++nextId;
      const controller = new AbortController();
      active = { id, controller };
      const current = () => active?.id === id && !controller.signal.aborted;
      update({ phase: "working", id, operation });
      return {
        signal: controller.signal,
        current,
        research() {
          if (!current() || state.phase === "idle") return;
          update(
            state.phase === "waiting"
              ? { ...state, resume: "research" }
              : { phase: "research", id, operation },
          );
        },
        waiting(waiting) {
          if (!current() || state.phase === "idle") return;
          if (waiting && state.phase !== "waiting")
            update({ phase: "waiting", id, operation, resume: state.phase });
          else if (!waiting && state.phase === "waiting") update({ phase: state.resume, id, operation });
        },
        finish() {
          if (!current()) return;
          active = null;
          update({ phase: "idle" });
        },
      };
    },
    cancel(notify = true) {
      const previous = active;
      active = null;
      state = { phase: "idle" };
      if (notify) publish(state);
      previous?.controller.abort();
    },
  };
}
