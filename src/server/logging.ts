import { randomUUID } from "node:crypto";

type FailureEvent = "request_failed" | "background_task_failed" | "job_failed" | "job_heartbeat_failed";

/** Provider and database errors can contain credentials or customer text. Log metadata only. */
export function reportFailure(event: FailureEvent, error: unknown): string {
  const reference = randomUUID();
  const category =
    error instanceof TypeError
      ? "type_error"
      : error instanceof SyntaxError
        ? "syntax_error"
        : error instanceof RangeError
          ? "range_error"
          : error instanceof Error
            ? "error"
            : "unknown";
  console.error(JSON.stringify({ event, reference, category }));
  return reference;
}
