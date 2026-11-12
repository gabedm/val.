import { connect } from "../../src/server/db";
import type { AppContext } from "../../src/server/context";
import type { CatalogueResponse } from "../../src/shared/contracts.types";
import { runReviewBatch } from "../../src/server/review-batches";
import { ModelStandIn } from "../model-standin";
import { checkTestDatabase } from "../test-database";

type Input = {
  config: AppContext["config"];
  catalogue: CatalogueResponse["catalogue"];
  interrupt: boolean;
  now?: string;
};

process.once("message", async ({ config, catalogue, interrupt, now }: Input) => {
  if (now) Date.now = () => Date.parse(now);
  checkTestDatabase(process.env);
  if (!process.env.TEST_DATABASE_URL || config.databaseUrl !== process.env.TEST_DATABASE_URL)
    throw new Error("Worker tests require the explicitly disposable test database.");
  const { db, pool } = connect(config.databaseUrl);
  const model = new ModelStandIn();
  let completed = 0;
  const researched = new Set<string>();
  model.script = async (request) => {
    const input = request.input as { content?: string }[];
    try {
      const name = JSON.parse(input[0]?.content ?? "{}").subscription?.originalLabel;
      if (typeof name === "string") researched.add(name);
    } catch { /* Consistency prompts may contain prose rather than the comparison JSON. */ }
    if (interrupt && completed === 1) {
      process.send?.({ kind: "interrupted", calls: model.requests.length });
      await new Promise(() => {});
    }
    return { answer: { summary: "No suitable lower-cost match.", options: [], uncertainties: [] } };
  };
  const ctx: AppContext = { db, config, model, paypal: { A: null, B: null }, planMapping: {} };
  try {
    while (await runReviewBatch(ctx, catalogue, now ? new Date(now) : new Date())) {
      completed++;
      if (completed > 5) throw new Error("Unexpected review retry loop.");
    }
    process.send?.({ kind: "complete", calls: model.requests.length, researched: [...researched] });
  } catch {
    process.send?.({ kind: "failed" });
    process.exitCode = 1;
  } finally {
    await pool.end();
    process.disconnect?.();
  }
});
