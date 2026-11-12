import { existsSync } from "node:fs";
import { loadConfig } from "../src/server/config";
import { connect, migrateDatabase } from "../src/server/db";

const environmentFile = process.env.VAL_ENV_FILE ?? ".env";
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
const { db, pool } = connect(loadConfig().databaseUrl);
try {
  await migrateDatabase(db);
} finally {
  await pool.end();
}
await import("../src/server/index");
