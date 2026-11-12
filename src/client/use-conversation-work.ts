import { useEffect, useRef, useState } from "react";
import { createConversationWork, type ConversationWorkState } from "./conversation-work";

export function useConversationWork() {
  const [state, setState] = useState<ConversationWorkState>({ phase: "idle" });
  const ref = useRef<ReturnType<typeof createConversationWork> | null>(null);
  if (!ref.current) ref.current = createConversationWork(setState);
  const work = ref.current;
  useEffect(() => {
    work.publish();
    return () => work.cancel(false);
  }, [work]);
  return { work, state };
}
