import { timingSafeEqual } from "node:crypto";
import type { ValidateFunction } from "ajv/dist/2020.js";

/** An error whose status and code are safe to show the browser. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 426 | 429 | 503,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

/** Validates a request body against its shared-schema definition. */
export function parseBody<T>(validate: ValidateFunction<T>, body: unknown): T {
  if (!validate(body))
    throw new HttpError(
      400,
      "invalid_request",
      `Request body rejected: ${validate.errors?.[0]?.message ?? "invalid"}.`,
    );
  return body;
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
