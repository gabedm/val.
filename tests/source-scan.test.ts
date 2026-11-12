import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it } from "vitest";

const scanner = fileURLToPath(new URL("../scripts/security-source-scan.mjs", import.meta.url));
const temporaryRoot = resolve(tmpdir());
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(temporaryRoot, "val-source-scan-"));
  execFileSync("git", ["init", "--quiet"], { cwd: directory, windowsHide: true });
  mkdirSync(join(directory, "private"));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, ".gitignore"), "private/\n.env\n");
  writeFileSync(join(directory, "src/app.ts"), 'export const title = "Val";\n');
});
afterEach(() => {
  if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith("val-source-scan-"))
    throw new Error("Refusing cleanup outside the disposable scanner fixture.");
  rmSync(directory, { recursive: true, force: true });
});
const run = (...args: string[]) =>
  spawnSync(process.execPath, [scanner, ...args], { cwd: directory, encoding: "utf8", windowsHide: true });
const secret = () => "synthetic-canary-" + randomUUID();

it.each(["DATA_SECRET", "WALLET_ENCRYPTION_KEYS"])(
  "detects copied %s material without printing it",
  (name) => {
    const value = secret();
    const environmentValue = name === "DATA_SECRET" ? value : JSON.stringify({ current: value });
    writeFileSync(join(directory, ".env"), `${name}=${environmentValue}\n`);
    writeFileSync(join(directory, "src/app.ts"), JSON.stringify(value));
    const result = run();
    expect(result.status).toBe(2);
    expect(result.stdout + result.stderr).not.toContain(value);
  },
);

it("scans an isolated ignored build and refuses a missing explicit bundle", () => {
  const value = secret();
  writeFileSync(join(directory, ".env"), `SESSION_SECRET=${value}\n`);
  mkdirSync(join(directory, "private/candidate"));
  writeFileSync(join(directory, "private/candidate/app.js"), JSON.stringify(value));
  const result = run("--bundle-dir=private/candidate");
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stdout).bundleFiles).toBe(1);
  expect(result.stdout + result.stderr).not.toContain(value);
  expect(run("--bundle-dir=private/missing").status).not.toBe(0);
});

it.each(["wallet-test-login.json", "sandbox-judge-preview-state.json"])(
  "detects a copied nested local password from %s without printing the password",
  (file) => {
    const value = secret();
    writeFileSync(join(directory, "private", file), JSON.stringify({ reviewer: { password: value } }));
    writeFileSync(
      join(directory, "src/app.ts"),
      `export const accidentallyCopied = ${JSON.stringify(value)};\n`,
    );
    const result = run();
    expect(result.status).toBe(2);
    const report = readFileSync(join(directory, "private/security/source-scan-current.json"), "utf8");
    expect(JSON.parse(report).findings).toEqual([{ scope: "working-tree-or-bundle", file: "src/app.ts" }]);
    expect(result.stdout + result.stderr + report).not.toContain(value);
  },
);

it("detects a credential-bearing database URL copied from ignored server configuration", () => {
  const value = `postgres://service:${secret()}@db.example.test/val`;
  writeFileSync(join(directory, ".env"), "DATABASE_URL=" + value + "\n");
  writeFileSync(join(directory, "src/app.ts"), JSON.stringify({ connection: value }));
  const result = run();
  expect(result.status).toBe(2);
  expect(result.stdout + result.stderr).not.toContain(value);
});

it("keeps ignored credentials private when they are absent from the source and bundle", () => {
  const value = secret();
  writeFileSync(join(directory, "private/wallet-test-login.json"), JSON.stringify({ password: value }));
  const result = run();
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).findings).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(value);
});

it("fails safely on malformed credential configuration without printing its contents", () => {
  const value = secret();
  writeFileSync(join(directory, "private/wallet-test-login.json"), `{"password": "${value}" BROKEN`);
  const result = run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Could not read local credential configuration");
  expect(result.stdout + result.stderr).not.toContain(value);
});
