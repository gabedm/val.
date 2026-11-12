import { existsSync } from "node:fs";
import { connect, migrateDatabase } from "../src/server/db";

const environmentFile = process.env.VAL_ENV_FILE ?? ".env";
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required.");

const { pool, db } = connect(process.env.DATABASE_URL);
await migrateDatabase(db);
await pool.end();
console.log("Migrations applied.");
