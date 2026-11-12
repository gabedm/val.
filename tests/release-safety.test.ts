import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import clientConfig, { checkClientEnvironment } from "../vite.config";
import { reportFailure } from "../src/server/logging";
import { checkTestDatabase } from "./test-database";
import { evaluationDatabaseSettings } from "../scripts/evaluation-database";

describe("browser environment protection", () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "val-env-test-"));
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  it("rejects secrets supplied directly to a build without printing their values", () => {
    vi.stubEnv("VITE_ACCESS_TOKEN", "synthetic-sensitive-value");
    if (typeof clientConfig !== "function")
      throw new Error("Expected build configuration to validate each mode.");
    expect(() => clientConfig({ mode: "production", command: "build" })).toThrow("VITE_ACCESS_TOKEN");
    expect(() => checkClientEnvironment("production", directory)).toThrow("VITE_ACCESS_TOKEN");
    try {
      checkClientEnvironment("production", directory);
    } catch (error) {
      expect(String(error)).not.toContain("synthetic-sensitive-value");
    }
  });

  it.each([".env", ".env.local", ".env.production", ".env.production.local"])(
    "rejects browser secrets in %s",
    (file) => {
      writeFileSync(join(directory, file), "VITE_PROVIDER_API_KEY=synthetic-only\n");
      expect(() => checkClientEnvironment("production", directory)).toThrow("VITE_PROVIDER_API_KEY");
    },
  );

  it("allows server credentials and harmless browser configuration", () => {
    writeFileSync(join(directory, ".env"), "OPENAI_API_KEY=synthetic-server-only\nVITE_APP_NAME=Val\n");
    expect(() => checkClientEnvironment("production", directory)).not.toThrow();
  });
  it("rejects a secret copied into a harmless-looking browser setting", () => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-private-api-credential");
    vi.stubEnv("VITE_APP_NAME", "Val: synthetic-private-api-credential");
    expect(() => checkClientEnvironment("production", directory)).toThrow("VITE_APP_NAME");
  });

  it("rejects dotenv expansion of a server credential into a browser setting", () => {
    writeFileSync(
      join(directory, ".env.production.local"),
      "SERVICE_SECRET=synthetic-private-credential\nVITE_APP_NAME=${SERVICE_SECRET}\n",
    );
    expect(() => checkClientEnvironment("production", directory)).toThrow("VITE_APP_NAME");
  });
});

describe("test database protection", () => {
  it("uses the default throwaway cluster when no external URL is supplied", () => {
    expect(() => checkTestDatabase({ DATABASE_URL: "postgres://localhost/retained" })).not.toThrow();
  });

  it("requires both a test name and an explicit acknowledgement of a disposable cluster", () => {
    expect(() => checkTestDatabase({ TEST_DATABASE_URL: "postgres://localhost/val_test" })).toThrow(
      "VAL_TEST_DATABASE_DISPOSABLE",
    );
    expect(() =>
      checkTestDatabase({
        TEST_DATABASE_URL: "postgres://localhost/retained",
        VAL_TEST_DATABASE_DISPOSABLE: "true",
      }),
    ).toThrow("must name val_test");
    expect(() =>
      checkTestDatabase({
        TEST_DATABASE_URL: "https://localhost/val_test",
        VAL_TEST_DATABASE_DISPOSABLE: "true",
      }),
    ).toThrow("PostgreSQL URL");
    expect(() =>
      checkTestDatabase({
        TEST_DATABASE_URL: "postgres://localhost/val_test_ci",
        VAL_TEST_DATABASE_DISPOSABLE: "true",
      }),
    ).not.toThrow();
  });

  it("refuses the saved application database even if credentials or URL spelling differ", () => {
    expect(() =>
      checkTestDatabase({
        DATABASE_URL: "postgres://app:synthetic@localhost/val_test?sslmode=disable",
        TEST_DATABASE_URL: "postgresql://tester:other@127.0.0.1:5432/val_test",
        VAL_TEST_DATABASE_DISPOSABLE: "true",
      }),
    ).toThrow("configured application database");
  });

  it.each(["host=127.0.0.1", "port=5432", "service=saved", "hos%74=127.0.0.1"])(
    "refuses a disguised test routing target: %s",
    (parameter) => {
      expect(() =>
        checkTestDatabase({
          TEST_DATABASE_URL: `postgres://disposable.example/val_test?${parameter}`,
          VAL_TEST_DATABASE_DISPOSABLE: "true",
        }),
      ).toThrow("routing query parameters");
    },
  );
});

describe("evaluation database protection", () => {
  it("uses a separately named evaluation database and preserves connection security options", () => {
    const settings = evaluationDatabaseSettings({
      DATABASE_URL: "postgres://localhost/application?sslmode=verify-full",
    });
    expect(settings.name).toBe("val_evals");
    expect(new URL(settings.databaseUrl).pathname).toBe("/val_evals");
    expect(new URL(settings.adminUrl).pathname).toBe("/postgres");
    expect(new URL(settings.databaseUrl).searchParams.get("sslmode")).toBe("verify-full");
    expect(
      evaluationDatabaseSettings({ EVAL_DATABASE_URL: "postgres://localhost/val_evals_release" }).name,
    ).toBe("val_evals_release");
  });

  it.each(["application", "val_test", "val_evals_unsafe-name", "val_evals%3Bdrop"])(
    "refuses evaluation records in %s",
    (name) =>
      expect(() => evaluationDatabaseSettings({ EVAL_DATABASE_URL: `postgres://localhost/${name}` })).toThrow(
        "must name val_evals",
      ),
  );

  it("refuses the application database across credentials and loopback spelling", () => {
    expect(() =>
      evaluationDatabaseSettings({
        DATABASE_URL: "postgres://application:synthetic@localhost/val_evals",
        EVAL_DATABASE_URL: "postgresql://tester:different@127.0.0.1:5432/val_evals",
      }),
    ).toThrow("configured application database");
    expect(() => evaluationDatabaseSettings({ DATABASE_URL: "postgres://localhost/val_evals" })).toThrow(
      "configured application database",
    );
  });

  it("refuses routing overrides and invalid URLs without echoing credentials", () => {
    expect(() =>
      evaluationDatabaseSettings({
        EVAL_DATABASE_URL: "postgres://localhost/val_evals?host=retained.example",
      }),
    ).toThrow("routing query parameters");
    expect(() =>
      evaluationDatabaseSettings({
        EVAL_DATABASE_URL: "https://tester:synthetic-private@example.com/val_evals",
      }),
    ).toThrow("must be a PostgreSQL URL");
  });
});

describe("private error handling", () => {
  it("logs only fixed metadata and a reference, excluding arbitrary error properties", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const error = Object.assign(new Error("synthetic-private-conversation"), {
        name: "synthetic-secret-name",
        code: "synthetic-token",
      });
      const reference = reportFailure("background_task_failed", error);
      expect(log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(log.mock.calls[0]![0])).toEqual({
        event: "background_task_failed",
        reference,
        category: "error",
      });
      expect(String(log.mock.calls[0])).not.toContain("synthetic-");
    } finally {
      log.mockRestore();
    }
  });
});
