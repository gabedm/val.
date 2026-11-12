import type { AppContext } from "./context";
import type { PoolClient } from "pg";
import { HttpError } from "./http";

const slots = new WeakMap<AppContext["db"]["$client"], number>();

/** Chat and research share an owner lock for the whole task, including gaps between model calls. */
export async function acquireModelWork(pool: AppContext["db"]["$client"], ownerId: string) {
  const used = slots.get(pool) ?? 0;
  // A held session lock must leave connections available for the task's ordinary queries.
  if (used >= Math.max(0, Math.min(3, (pool.options.max ?? 10) - 2)))
    throw new HttpError(429, "review_running", "Val is finishing another check. Please wait a moment.");
  slots.set(pool, used + 1);
  let connection: PoolClient | undefined;
  try {
    connection = await pool.connect();
    const result = await connection.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [
      `val-advice:${ownerId}`,
    ]);
    if (result.rows[0]?.locked !== true) {
      connection.release();
      connection = undefined;
      throw new HttpError(
        429,
        "review_running",
        "Val is finishing your current check. Please wait a moment.",
      );
    }
  } catch (error) {
    // A failed lock response has an uncertain outcome; destroying the connection releases any lock.
    connection?.release(true);
    slots.set(pool, (slots.get(pool) ?? 1) - 1);
    throw error;
  }
  const acquired = connection;
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    let locked = true;
    try {
      await acquired.query("select pg_advisory_unlock(hashtextextended($1, 0))", [`val-advice:${ownerId}`]);
      locked = false;
    } finally {
      acquired.release(locked);
      slots.set(pool, (slots.get(pool) ?? 1) - 1);
    }
  };
}
