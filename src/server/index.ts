import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { pruneExpiredIdentity } from "./auth";
import { loadConfig, openaiEnvFile, anthropicEnvFile, googleEnvFile } from "./config";
import { createModelClient } from "./model-client";
import { GeminiModelClient } from "./gemini-model";
import type { AppContext } from "./context";
import { connect } from "./db";
import { runQueuedJobs, queuePendingReconciliations } from "./jobs";
import { runCaseJob } from "./casework";
import { createPaypalClients } from "./paypal";
import { readPlanMapping } from "./plans";
import { createApp } from "./routes";
import { bindBuildProfile } from "./build-profile";
import { runDuePriceCheck } from "./price-checks";
import { runReviewBatch } from "./review-batches";
import { withMobileServices } from "./mobile-catalogue";
import type { CatalogueResponse } from "../shared/contracts.types";
import { readFileSync } from "node:fs";
import { reportFailure } from "./logging";
import { runWalletJobs } from "./paypal-wallet";
import { activateWorker, currentWorker } from "./worker-deployment";
import { runSwitchJobs } from "./subscription-switch";
import { runChatRequest, stopChatRequests } from "./chat-requests";

const environmentFile = process.env.VAL_ENV_FILE ?? ".env";
if (existsSync(environmentFile)) process.loadEnvFile(environmentFile);
// Local owner credentials may live in ignored files. Deployment values win.
if (process.env.VAL_BUILD_PROFILE === "owner")
  for (const file of [googleEnvFile, openaiEnvFile, anthropicEnvFile])
    if (existsSync(file)) process.loadEnvFile(file);
const config = loadConfig();
const financialTools =
  !config.paypalSandboxSubscriptions?.length &&
  config.buildProfile !== "public" &&
  config.paypalIdentityEnvironment !== "live" &&
  config.paypalWallet?.environment !== "live";
const { pool, db } = connect(config.databaseUrl);
const model = createModelClient(config);
const mapping = !financialTools
  ? {}
  : config.buildProfile === "judge"
    ? process.env.VAL_PLAN_MAPPING_FILE
      ? readPlanMapping(process.env.VAL_PLAN_MAPPING_FILE)
      : {}
    : readPlanMapping();
const ctx: AppContext = {
  db,
  config,
  paypal: createPaypalClients(config.merchants),
  planMapping: mapping,
  model,
  conversationModel: model instanceof GeminiModelClient ? model.forConversation() : model,
};
await bindBuildProfile(ctx);
ctx.worker = await activateWorker(db, process.env.K_SERVICE, process.env.K_REVISION);

if (config.paypalIdentityEnvironment !== "live" && !config.paypalWallet)
  for (const merchant of ["A", "B"] as const) {
    if (!config.merchants[merchant])
      console.warn(
        `PayPal sandbox merchant ${merchant} is not configured; its subscriptions are unavailable.`,
      );
  }
if (config.paypalWallet)
  console.log(
    `PayPal ${config.paypalWallet.environment} statement ingestion is configured; payment execution is disabled for live wallets.`,
  );
else if (config.paypalIdentityEnvironment === "live")
  console.log(
    "PayPal live identity is configured; wallet subscription access and payment execution are unavailable.",
  );
if (!model)
  console.warn("The configured AI provider has no key; drafting and investigations will report review.");
if (financialTools && Object.keys(ctx.planMapping).length === 0)
  console.warn("No PayPal plan mapping found for this build.");

/** Runs a task on an interval without overlapping itself or crashing the server on error. */
function every(milliseconds: number, task: () => Promise<unknown>) {
  let running = false;
  return setInterval(async () => {
    if (running) return;
    running = true;
    try {
      if (!(await currentWorker(ctx))) return;
      await task();
    } catch (error) {
      reportFailure("background_task_failed", error);
    } finally {
      running = false;
    }
  }, milliseconds);
}

const jobLoop = !financialTools
  ? null
  : every(2_000, () => runQueuedJobs(ctx, (job, commit) => runCaseJob(ctx, job, commit)));
const pendingLoop = every(30_000, async () => {
  if (financialTools) await queuePendingReconciliations(ctx);
  await pruneExpiredIdentity(ctx);
});
const priceCatalogue = withMobileServices(
  JSON.parse(
    readFileSync(new URL("../../docs/build-pack/catalogue/catalogue.json", import.meta.url), "utf8"),
  ) as CatalogueResponse["catalogue"],
);
const priceLoop = every(60_000, () => runDuePriceCheck(ctx, priceCatalogue));
const reviewLoop = every(2_000, () => runReviewBatch(ctx, priceCatalogue));
const walletLoop = every(2_000, () => runWalletJobs(ctx, priceCatalogue.services));
const switchLoop = every(2_000, () => runSwitchJobs(ctx));
const chatLoop = every(1_000, () => runChatRequest(ctx, priceCatalogue));

const server = createServer(createApp(ctx)).listen(config.port, config.host, () =>
  console.log(`Val listening on ${config.appOrigin}`),
);

function stopLoops() {
  if (jobLoop) clearInterval(jobLoop);
  clearInterval(pendingLoop);
  clearInterval(priceLoop);
  clearInterval(reviewLoop);
  clearInterval(walletLoop);
  clearInterval(switchLoop);
  clearInterval(chatLoop);
}
server.once("error", (error) => {
  stopLoops();
  reportFailure("background_task_failed", error);
  process.exitCode = 1;
  void stopChatRequests(ctx).then(() => pool.end());
});
function shutdown() {
  stopLoops();
  void stopChatRequests(ctx);
  server.close(
    () =>
      void stopChatRequests(ctx)
        .then(() => pool.end())
        .then(() => console.log("Val stopped.")),
  );
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
