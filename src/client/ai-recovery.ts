function wait(ms: number, signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      signal.removeEventListener("abort", abort);
      abort();
    }
  });
}

/** Only read-only AI work may wait for a rejection made before acquiring the owner's task lock. */
export async function recoverBusyRead<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  onWaiting: (waiting: boolean) => void,
): Promise<T> {
  const deadline = Date.now() + 5 * 60_000;
  let waiting = false;
  try {
    for (;;) {
      signal.throwIfAborted();
      try {
        return await work();
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          !["review_running", "chat_running"].includes(String(error.code)) ||
          Date.now() + 5000 > deadline
        )
          throw error;
        if (!waiting) {
          waiting = true;
          onWaiting(true);
        }
        await wait(5000, signal);
      }
    }
  } finally {
    if (waiting) onWaiting(false);
  }
}

/** Retry one known pre-dispatch rate rejection. Unknown outcomes, spend and access failures are never replayed. */
export async function recoverAIRateLimit<T>(
  work: () => Promise<T>,
  signal: AbortSignal,
  onWaiting: (waiting: boolean) => void,
): Promise<T> {
  signal.throwIfAborted();
  try {
    return await work();
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["judge_rate_limited", "model_rate_limited"].includes(String(error.code))
    )
      throw error;
    const seconds = "retryAfterSeconds" in error ? Number(error.retryAfterSeconds) : NaN;
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 60) throw error;
    onWaiting(true);
    try {
      await wait(seconds * 1000 + 150, signal);
      signal.throwIfAborted();
      return await work();
    } finally {
      onWaiting(false);
    }
  }
}
