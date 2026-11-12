import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalPostgres } from "../scripts/embedded-postgres";
import { checkTestDatabase } from "./test-database";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer().listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Integration tests use a throwaway PostgreSQL cluster unless a disposable external
 * cluster has been explicitly acknowledged. Saved application databases are refused.
 */
export default async function setup() {
  checkTestDatabase(process.env);
  if (process.env.TEST_DATABASE_URL) return;

  const databaseDir = mkdtempSync(join(tmpdir(), "val-test-postgres-"));
  const port = await freePort();
  const server = new LocalPostgres({
    databaseDir,
    user: "val",
    password: "val-test",
    port,
    persistent: false,
    initdbFlags: ["--encoding=UTF8"],
    onLog: () => undefined,
  });
  await server.initialise();
  await server.start();
  await server.createDatabase("val_test");
  process.env.TEST_DATABASE_URL = `postgres://val:val-test@127.0.0.1:${port}/val_test`;

  return async () => {
    await server.stop();
    rmSync(databaseDir, { recursive: true, force: true });
  };
}
