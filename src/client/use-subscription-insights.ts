import { useEffect, useState } from "react";
import type { SubscriptionInsights } from "../shared/subscription-insights";
import { api, ApiError } from "./api";
import { errorText } from "./ui";

export type InsightState =
  | { phase: "loading" }
  | { phase: "ready"; value: SubscriptionInsights; refreshError?: string; needsReload?: boolean }
  | { phase: "error"; message: string; needsReload: boolean };

export function useSubscriptionInsights(ownerId: string, revision: number) {
  const key = `${ownerId}:${revision}`;
  const [state, setState] = useState<InsightState & { key: string }>({ key, phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading = false;
    setState({ key, phase: "loading" });
    const read = async () => {
      if (reading || controller.signal.aborted || document.visibilityState === "hidden") return;
      reading = true;
      let nextPoll = 30_000;
      try {
        const value = await api.subscriptionInsights(revision, controller.signal);
        if (controller.signal.aborted) return;
        if (value.revision !== revision)
          throw new ApiError(
            409,
            "subscriptions_changed",
            "Your subscriptions changed. Reload to see the latest results.",
          );
        setState({ key, phase: "ready", value });
        if (
          (value.batch && ["queued", "running", "paused"].includes(value.batch.status)) ||
          value.schedules.some((row) => row.status === "checking")
        )
          nextPoll = 5_000;
      } catch (error) {
        if (controller.signal.aborted) return;
        const message = errorText(error);
        const needsReload = error instanceof ApiError && error.code === "subscriptions_changed";
        setState((previous) =>
          previous.key === key && previous.phase === "ready" && !needsReload
            ? { ...previous, refreshError: message }
            : { key, phase: "error", message, needsReload },
        );
        if (needsReload) nextPoll = 0;
      } finally {
        reading = false;
        if (!controller.signal.aborted && nextPoll) timer = setTimeout(() => void read(), nextPoll);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState !== "hidden") void read();
    };
    void read();
    document.addEventListener("visibilitychange", visible);
    return () => {
      controller.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [key, revision, attempt]);
  const view: InsightState = state.key === key ? state : { phase: "loading" };
  return { state: view, retry: () => setAttempt((n) => n + 1) };
}
