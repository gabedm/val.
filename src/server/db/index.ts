import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import pg from "pg";
import * as schema from "./schema";

export function connect(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 10 });
  return { pool, db: drizzle(pool, { schema }) };
}

export type Database = ReturnType<typeof connect>["db"];
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
/** Accepts either the database or an open transaction. */
export type Executor = Database | Transaction;

export async function migrateDatabase(db: Database) {
  // Multiple local services or hosted replicas can start together. Hold a database-scoped
  // session lock while the migrator reads its journal and applies its own transaction.
  const connection = await db.$client.connect();
  try {
    await connection.query("select pg_advisory_lock($1)", [93271011]);
    await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../../migrations", import.meta.url)) });
  } finally {
    let unlocked = false;
    try {
      await connection.query("select pg_advisory_unlock($1)", [93271011]);
      unlocked = true;
    } finally {
      // An uncertain unlock must not return a session lock to the pool.
      connection.release(!unlocked);
    }
  }
}
