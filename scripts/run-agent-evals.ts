import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { modelFromEnvironment } from "../src/server/model-client";
import pg from "pg";
import { agentVersion } from "../src/server/agent-contract";
import { openaiEnvFile, anthropicEnvFile } from "../src/server/config";
import { connect, migrateDatabase } from "../src/server/db";
import {
  evaluateConfiguration,
  freshBatch,
  type EvaluationEntry,
  type EvaluationRecord,
} from "../src/server/evaluation";
import { fixedBatch } from "./agent-fixtures";
import { evaluationDatabaseSettings } from "./evaluation-database";

// Evaluation against the configured model API. It has its own database and synthetic workspaces;
// it cannot reach PayPal, checkout or any customer case.
//
//   npm run evals -- version
//   npm run evals -- fixed [--repeats 3] [--only id] [--out evidence/evaluations/<label>]
//   npm run evals -- fresh --configs <directory of configuration .json files> [--out evidence/evaluations/<label>]

for (const file of [".env", openaiEnvFile, anthropicEnvFile]) if (existsSync(file)) process.loadEnvFile(file);

const { positionals, values: options } = parseArgs({
  allowPositionals: true,
  options: {
    repeats: { type: "string", default: "3" },
    only: { type: "string" },
    out: { type: "string" },
    configs: { type: "string" },
    "with-value": { type: "boolean", default: false },
    "fail-fast": { type: "boolean", default: false },
  },
});
const command = positionals[0];

const sha256Of = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

async function evaluationDatabaseUrl(): Promise<string> {
  const settings = evaluationDatabaseSettings(process.env);
  const admin = new pg.Client({ connectionString: settings.adminUrl });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(settings.name)}`);
  } catch (error) {
    if ((error as { code?: string }).code !== "42P04") throw error;
  } finally {
    await admin.end();
  }
  return settings.databaseUrl;
}

function summarize(records: EvaluationRecord[]) {
  const sum = (pick: (record: EvaluationRecord) => number) =>
    records.reduce((total, record) => total + pick(record), 0);
  const usage = (record: EvaluationRecord) =>
    [record.policyDraft.usage, record.investigation?.usage].filter(
      (item) => item !== undefined && item !== null,
    );
  return {
    runs: records.length,
    passed: records.filter((record) => record.result === "PASS").length,
    failed: records
      .filter((record) => record.result === "FAIL")
      .map((record) => ({ fixture: record.fixture, run: record.run, failures: record.failures })),
    byFixture: Object.fromEntries(
      [...new Set(records.map((record) => record.fixture))].map((id) => [
        id,
        records.filter((record) => record.fixture === id).map((record) => record.result),
      ]),
    ),
    modelCalls: sum((record) => usage(record).reduce((total, item) => total + item.modelCalls, 0)),
    inputTokens: sum((record) => usage(record).reduce((total, item) => total + item.inputTokens, 0)),
    outputTokens: sum((record) => usage(record).reduce((total, item) => total + item.outputTokens, 0)),
    reasoningTokens: sum((record) => usage(record).reduce((total, item) => total + item.reasoningTokens, 0)),
    elapsedMs: {
      total: sum((record) => record.elapsedMs),
      max: Math.max(...records.map((record) => record.elapsedMs)),
    },
    toolCallsMax: Math.max(...records.map((record) => record.investigation?.trace.length ?? 0)),
  };
}

async function runBatch(
  entries: { entry: EvaluationEntry; run: number }[],
  outDirectory: string,
  label: string,
) {
  if (entries.length === 0) throw new Error("Nothing to run; an empty batch is not evidence.");
  if (existsSync(outDirectory) && readdirSync(outDirectory).length > 0)
    throw new Error("The evaluation output directory is not empty; preserve its previous evidence.");
  const model = modelFromEnvironment();
  if (!model) throw new Error("The configured model provider needs its server-side key.");
  mkdirSync(outDirectory, { recursive: true });
  const { pool, db } = connect(await evaluationDatabaseUrl());
  await migrateDatabase(db);
  // Operator-only evaluator uses its own database/budget; it is not a judge API route.
  const ctx = { db, model, config: { judgeDemo: null } };

  const records: EvaluationRecord[] = [];
  for (const { entry, run } of entries) {
    const record = await evaluateConfiguration(ctx, entry, run);
    records.push(record);
    writeFileSync(join(outDirectory, `${entry.id}-run${run}.json`), JSON.stringify(record, null, 2));
    console.log(
      `${record.result}  ${entry.id} run ${run}  ${(record.elapsedMs / 1000).toFixed(1)}s${record.failures.length ? `  ${record.failures[0]}` : ""}`,
    );
    if (record.result === "FAIL" && options["fail-fast"]) break;
  }
  const summary = {
    label,
    finishedAt: new Date().toISOString(),
    version: agentVersion(model),
    plannedRuns: entries.length,
    complete: records.length === entries.length,
    ...summarize(records),
  };
  writeFileSync(join(outDirectory, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${summary.runs} passed. Written to ${outDirectory}`);
  if (summary.failed.length > 0) process.exitCode = 1;
  await pool.end();
}

if (command === "version") {
  console.log(
    JSON.stringify(
      {
        ...agentVersion(modelFromEnvironment()),
        fixedFixturesSha256: sha256Of("scripts/agent-fixtures.ts"),
        challengerSchemaSha256: sha256Of("src/shared/challenger.schema.json"),
      },
      null,
      2,
    ),
  );
} else if (command === "fixed") {
  await runBatch(
    fixedBatch({ ...options, includeValue: options["with-value"] }),
    options.out ?? "evidence/value/fixed",
    options["with-value"] ? "original fixed30 plus six paid-value repetitions" : "fixed fixtures",
  );
} else if (command === "fresh") {
  if (!options.configs) throw new Error("fresh needs --configs <directory>.");
  const directory = options.configs;
  const files = readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const entries = freshBatch(
    files.map((name) => ({ name, content: readFileSync(join(directory, name), "utf8") })),
  );
  await runBatch(entries, options.out ?? "evidence/evaluations/fresh", "fresh configurations");
} else {
  console.error(
    "Usage: npm run evals -- version | fixed [--repeats 3] [--only id] [--out dir] | fresh --configs dir [--out dir]",
  );
  process.exit(1);
}
