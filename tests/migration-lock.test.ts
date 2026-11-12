import { beforeEach, expect, it, vi } from "vitest";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { migrateDatabase, type Database } from "../src/server/db";

vi.mock("drizzle-orm/node-postgres/migrator", () => ({ migrate: vi.fn() }));
beforeEach(() => vi.mocked(migrate).mockReset());

it("destroys a migration connection when releasing its session lock has an unknown outcome", async () => {
  const query = vi.fn().mockResolvedValueOnce({}).mockRejectedValueOnce(new Error("Unlock interrupted"));
  const release = vi.fn();
  const db = { $client: { connect: async () => ({ query, release }) } } as unknown as Database;
  vi.mocked(migrate).mockResolvedValueOnce(undefined);
  await expect(migrateDatabase(db)).rejects.toThrow("Unlock interrupted");
  expect(release).toHaveBeenCalledExactlyOnceWith(true);
});

it("returns the migration connection after a failed migration only when its lock was released", async () => {
  const query = vi.fn().mockResolvedValue({});
  const release = vi.fn();
  const db = { $client: { connect: async () => ({ query, release }) } } as unknown as Database;
  vi.mocked(migrate).mockRejectedValueOnce(new Error("Migration failed"));
  await expect(migrateDatabase(db)).rejects.toThrow("Migration failed");
  expect(release).toHaveBeenCalledExactlyOnceWith(false);
});
