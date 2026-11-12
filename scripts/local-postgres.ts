import { existsSync } from "node:fs";
import { LocalPostgres } from "./embedded-postgres";

// Local development database: a real PostgreSQL server started from the embedded-postgres binaries,
// for machines without Docker or a PostgreSQL install. Data persists in .local-postgres/.
const databaseDir = ".local-postgres/data";
const port = 54329;

const server = new LocalPostgres({
  databaseDir,
  user: "val",
  password: "val-local",
  port,
  persistent: true,
  initdbFlags: ["--encoding=UTF8"],
});
if (!existsSync(`${databaseDir}/PG_VERSION`)) await server.initialise();
await server.start();
try {
  await server.createDatabase("val");
} catch (error) {
  const alreadyExists = (error as { code?: string }).code === "42P04";
  if (!alreadyExists) throw error;
}

console.log(`PostgreSQL is running. Use DATABASE_URL=postgres://val:val-local@127.0.0.1:${port}/val`);
console.log("Press Ctrl+C to stop it.");

// pg_ctl detaches the Windows database; keep this control terminal alive.
const keepAlive = setInterval(() => undefined, 60_000);
async function shutdown() {
  await server.stop();
  clearInterval(keepAlive);
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
