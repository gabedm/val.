import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createApp } from "../src/server/routes";
import { startTestApp, type TestApp } from "./helpers";

let app: TestApp;
let server: Server;
let origin: string;
beforeAll(async () => {
  app = await startTestApp();
  const directory = mkdtempSync(join(tmpdir(), "val-static-cache-"));
  mkdirSync(join(directory, "assets"));
  writeFileSync(join(directory, "index.html"), "<!doctype html><title>Val</title>");
  writeFileSync(join(directory, "assets", "index-Ab12cd34.js"), "export const value = 1;");
  writeFileSync(join(directory, "assets", "settings.js"), "export const value = 2;");
  server = createServer(createApp(app.ctx, directory)).listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await app.close();
});

it("caches hashed assets without making HTML, unhashed files or account responses immutable", async () => {
  const asset = await fetch(`${origin}/assets/index-Ab12cd34.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
  expect(await asset.text()).toContain("value = 1");
  for (const path of ["/", "/assets/settings.js", "/api/session", "/paypal/return"]) {
    const response = await fetch(origin + path);
    expect(response.headers.get("cache-control")).not.toContain("immutable");
    if (path.startsWith("/api/") || path.startsWith("/paypal/"))
      expect(response.headers.get("cache-control")).toBe("no-store");
    await response.arrayBuffer();
  }
});
