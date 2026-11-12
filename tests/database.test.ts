import pg from "pg";
import { expect, it } from "vitest";

it("round-trips non-Western transcript text through PostgreSQL", async () => {
  if (!process.env.TEST_DATABASE_URL) throw new Error("Disposable test database was not configured");
  const client = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const text = "Meeting notes 🚀 中文 — café";
  try {
    await client.connect();
    const result = await client.query("SELECT $1::text AS transcript", [text]);
    expect(result.rows[0]?.transcript).toBe(text);
  } finally {
    await client.end();
  }
});
