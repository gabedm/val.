import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelFromEnvironment } from "../src/server/model-client";
import {
  confirmedFields,
  openingQuestion,
  preferencePurpose,
  preferenceQuestion,
  type PreferenceTurn,
} from "../src/client/preferencesChat";
import { agentVersion } from "../src/server/agent-contract";
import { runPolicyDraft } from "../src/server/policy-draft";
import type { PolicyDraft } from "../src/shared/contracts.types";

// Explicit, model-only live check: no database, merchant, purchase, cancellation or confirmed preferences.
for (const file of [".env", "private/openai.env", "private/anthropic.env"])
  if (existsSync(file)) process.loadEnvFile(file);
const configuredModel = modelFromEnvironment();
assert(configuredModel, "The selected AI provider needs its server-side key.");
const model = configuredModel;
const output = join("evidence", "onboarding", new Date().toISOString().replace(/[:.]/g, "-"));
mkdirSync(output, { recursive: true });
let calls = 0;
async function turn(name: string, turns: PreferenceTurn[], answer: string, draft: PolicyDraft | null) {
  const next = [...turns, { question: preferenceQuestion(draft), answer }];
  const purpose = preferencePurpose(next);
  const result = await runPolicyDraft(model, purpose);
  const file = join(output, `${++calls}-${name}.json`);
  // Save the raw structured answer separately from our assertions, including failed attempts.
  writeFileSync(file, JSON.stringify({ version: agentVersion(model), input: purpose, ...result }, null, 2));
  assert(result.draft, `No valid model draft: inspect ${file}`);
  return { turns: next, draft: result.draft };
}

let state = await turn("needs", [], "I need to edit my notes after meetings.", null);
assert.equal(confirmedFields(state.draft), null);
assert.equal(state.draft.allowInvestigation, null);
assert.equal(state.draft.preserveHistory, null);
state = await turn("budget", state.turns, "£15 a month, including the full renewal.", state.draft);
assert.equal(state.draft.recurringCeiling?.amountMinor, 1500);
assert.equal(state.draft.allowInvestigation, null);
const beforePermission = state;
state = await turn("permission-refused", state.turns, "No, don't check other plans yet.", state.draft);
assert.equal(confirmedFields(state.draft)?.allowInvestigation, false);
assert.equal(confirmedFields(state.draft)?.preserveHistory, false);
assert.equal(confirmedFields(state.draft)?.recurringCeiling.amountMinor, 1500);
const granted = await turn(
  "permission-granted",
  beforePermission.turns,
  "Yes, please.",
  beforePermission.draft,
);
assert.equal(confirmedFields(granted.draft)?.allowInvestigation, true);

const unsupported = await turn(
  "unsupported",
  [],
  "I need editable notes and automatic French translation. My limit is £15 a month including renewal. You may check and test connected alternatives; ask me before buying or cancelling.",
  null,
);
assert(unsupported.draft.unsupportedRequirements.length > 0);
assert.equal(confirmedFields(unsupported.draft), null);
const stillUnsupported = await turn(
  "unsupported-retained",
  unsupported.turns,
  "Make my budget £12 instead.",
  unsupported.draft,
);
assert(stillUnsupported.draft.unsupportedRequirements.length > 0);
assert.equal(confirmedFields(stillUnsupported.draft), null);
const revised = await turn(
  "unsupported-withdrawn",
  stillUnsupported.turns,
  "I no longer need translation. Just editable notes, £12 per month including renewal. You may check and test connected plans, but ask before buying or cancelling.",
  stillUnsupported.draft,
);
assert.equal(confirmedFields(revised.draft)?.allowInvestigation, true);
assert.equal(confirmedFields(revised.draft)?.recurringCeiling.amountMinor, 1200);
const transfer = await turn(
  "transfer-out-of-scope",
  [],
  "I need editable notes, £15 a month including renewal, and Val must preserve and transfer all of my saved work to the new service. You may test plans.",
  null,
);
assert.equal(confirmedFields(transfer.draft), null);
assert(transfer.draft.preserveHistory === true || transfer.draft.unsupportedRequirements.length > 0);
writeFileSync(
  join(output, "verdict.json"),
  JSON.stringify(
    {
      passed: true,
      calls,
      openingQuestion,
      version: agentVersion(model),
      scope: "Genuine model interpretation and bounded Q&A. No financial actions or saved policies.",
    },
    null,
    2,
  ),
);
console.log(`Live onboarding passed: ${calls} model calls. Evidence: ${output}`);
