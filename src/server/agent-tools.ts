import { and, eq } from "drizzle-orm";
import {
  validatorFor,
  type AccountSnapshot,
  type Artifact,
  type CandidateQuote,
  type CapabilityResult,
  type GetQuoteResult,
  type PlanSummary,
  type ReadAccountResult,
  type ReadArtifactResult,
  type TestCandidateResult,
} from "../shared/contracts";
import { agentTools, toolArgumentDefinitions, type AgentToolName } from "./agent-contract";
import type { Executor } from "./db";
import { artifacts, evidence } from "./db/schema";
import { evidenceIdForArtifact, type AdvisoryOption } from "./evidence";
import type { CaseRow } from "./operations";
import { fixturePlans } from "./plans";
import { benchmarkTurns, evaluateSample, getAccount, getQuote, listPlans, ProviderError } from "./providers";
import { ToolRefusal } from "./responses-loop";
import { checkSample, formatGbp, type Capability } from "./validation";

/** What the model's tool calls actually returned in one investigation; the deterministic checks work only from this. */
export interface InvestigationObservations {
  /** The current account read: its account and sample evidence IDs are one bundle of evidence. */
  account: {
    planId: string;
    providerId: PlanSummary["providerId"];
    entitlementRevision: number;
    valueSignal?: boolean;
    paidThrough?: string | null;
    billingStatus?: AccountSnapshot["billingStatus"];
    capabilityResults: CapabilityResult[];
    evidenceIds: string[];
    artifactId: string;
    observedAt: string;
  } | null;
  plans: PlanSummary[] | null;
  quotes: Map<string, CandidateQuote>;
  tests: Map<
    string,
    { capabilityResults: CapabilityResult[]; evidenceId: string; artifactId: string; observedAt: string }
  >;
  /** Every stored evidence and artifact ID handed to the model, the only ones it may cite or read. */
  evidenceIds: Set<string>;
  artifactIds: Set<string>;
  /** The short reference the model saw for each stored evidence ID, in the order they were handed over. */
  references: Map<string, string>;
}

const argumentValidators = new Map(
  Object.entries(toolArgumentDefinitions).map(([name, definition]) => [name, validatorFor(definition)]),
);

// The model sees facts, not who owns them: case, account and subscription identifiers are replaced by fixed names.
// A quote's own record ID is replaced by a plain name too, so its evidenceId is the only quote reference it can cite.
const hiddenCase = "this_case";
const accountForModel = (account: AccountSnapshot, evidenceReference: string): AccountSnapshot => ({
  ...account,
  caseId: hiddenCase,
  accountId: "current_account",
  subscriptionId: account.subscriptionId ? "current_subscription" : null,
  evidenceId: evidenceReference,
});
const artifactForModel = (artifact: Artifact): Artifact => ({ ...artifact, caseId: hiddenCase });
const quoteForModel = (quote: CandidateQuote, evidenceReference: string): CandidateQuote => ({
  ...quote,
  id: `quote_${quote.candidateId}`,
  caseId: hiddenCase,
  evidenceId: evidenceReference,
});

/**
 * The five permitted tools, bound to one case's provider accounts and its confirmed capabilities. They only read and
 * test; nothing here can buy, back up, import, cancel or change authority.
 */
export function investigationTools(
  db: Executor,
  caseRow: CaseRow,
  requiredCapabilities: Capability[],
  recurringCeilingMinor: number,
  options: AdvisoryOption = {},
) {
  const observations: InvestigationObservations = {
    account: null,
    plans: null,
    quotes: new Map(),
    tests: new Map(),
    evidenceIds: new Set(),
    artifactIds: new Set(),
    references: new Map(),
  };

  // The model cites short references (E1, E2, ...) issued in this investigation instead of stored IDs it could mistype.
  const handOver = (evidenceIds: string[], artifactId?: string) => {
    if (artifactId) observations.artifactIds.add(artifactId);
    return evidenceIds.map((id) => {
      observations.evidenceIds.add(id);
      if (!observations.references.has(id))
        observations.references.set(id, `E${observations.references.size + 1}`);
      return observations.references.get(id)!;
    });
  };

  /** The stored evidence behind the references the model cited. Anything else is passed on unchanged for the checks to reject. */
  const resolveCitations = (cited: string[]) => {
    const storedByReference = new Map([...observations.references].map(([id, reference]) => [reference, id]));
    return cited.map((reference) => storedByReference.get(reference) ?? reference);
  };

  // A tool abandoned at the deadline stops between provider reads and never adds to the observations.
  async function readAccount(signal: AbortSignal): Promise<ReadAccountResult> {
    const account = await getAccount(db, caseRow.initialAccountId, options);
    signal.throwIfAborted();
    const sample = await evaluateSample(db, caseRow, caseRow.initialAccountId, account.planId!, options);
    const sampleEvidenceId = await evidenceIdForArtifact(db, sample.id, options);
    signal.throwIfAborted();
    const capabilityResults = checkSample(JSON.parse(sample.content), benchmarkTurns, requiredCapabilities);
    const evidenceIds = [account.evidenceId, sampleEvidenceId];
    observations.account = {
      planId: account.planId!,
      providerId: account.providerId,
      entitlementRevision: account.entitlementRevision,
      valueSignal: caseRow.scenario === "value_offer" && account.entitlementRevision > 1,
      paidThrough: account.paidThrough,
      billingStatus: account.billingStatus,
      capabilityResults,
      evidenceIds,
      artifactId: sample.id,
      observedAt: sample.createdAt,
    };
    const references = handOver(evidenceIds, sample.id);
    return {
      account: accountForModel(account, references[0]!),
      sample: artifactForModel(sample),
      capabilityResults,
      evidenceIds: references,
    };
  }

  async function testCandidate(candidateId: string, signal: AbortSignal): Promise<TestCandidateResult> {
    const plan = fixturePlans.find((candidate) => candidate.planId === candidateId);
    if (!plan || !observations.plans?.some((listed) => listed.candidateId === candidateId))
      throw new ToolRefusal(`There is no plan ${candidateId} for this case.`);
    const quote = observations.quotes.get(candidateId);
    if (
      !quote ||
      candidateId === observations.account?.planId ||
      quote.recurringTotal.amountMinor > recurringCeilingMinor ||
      (quote.offer && quote.offer.eligibility !== "ELIGIBLE")
    ) {
      throw new ToolRefusal(
        "Only a quoted plan within the confirmed renewal ceiling and eligible for purchase may be tested.",
      );
    }
    const accountId =
      plan.providerId === "provider_a" ? caseRow.initialAccountId : caseRow.replacementAccountId;
    const artifact = await evaluateSample(db, caseRow, accountId, candidateId, options);
    const evidenceId = await evidenceIdForArtifact(db, artifact.id, options);
    signal.throwIfAborted();
    const capabilityResults = checkSample(JSON.parse(artifact.content), benchmarkTurns, requiredCapabilities);
    observations.tests.set(candidateId, {
      capabilityResults,
      evidenceId,
      artifactId: artifact.id,
      observedAt: artifact.createdAt,
    });
    return {
      candidateId,
      artifact: artifactForModel(artifact),
      capabilityResults,
      evidenceIds: handOver([evidenceId], artifact.id),
    };
  }

  async function readArtifact(artifactId: string): Promise<ReadArtifactResult> {
    if (!observations.artifactIds.has(artifactId))
      throw new ToolRefusal("Only artifacts returned in this investigation can be read.");
    const [artifact] = await db
      .select()
      .from(artifacts)
      .where(
        and(
          eq(artifacts.id, artifactId),
          eq(artifacts.caseId, caseRow.id),
          eq(artifacts.advisory, options.advisory ?? false),
        ),
      );
    const cited = await db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          eq(evidence.artifactId, artifactId),
          eq(evidence.caseId, caseRow.id),
          eq(evidence.advisory, options.advisory ?? false),
        ),
      );
    const stored: Artifact = { ...artifact!, createdAt: artifact!.createdAt.toISOString() };
    return { artifact: artifactForModel(stored), evidenceIds: handOver(cited.map((row) => row.id)) };
  }

  async function execute(name: string, args: unknown, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (!argumentValidators.get(name)?.(args))
      throw new ToolRefusal(`The arguments for ${name} are not valid.`);
    const { candidateId, artifactId } = args as { candidateId?: string; artifactId?: string };
    try {
      switch (name as AgentToolName) {
        case "read_account":
          return await readAccount(signal);
        case "list_plans": {
          const plans = await listPlans(db, caseRow);
          signal.throwIfAborted();
          observations.plans = plans;
          return { plans };
        }
        case "get_quote": {
          const quote = await getQuote(db, caseRow, candidateId!, options);
          signal.throwIfAborted();
          observations.quotes.set(candidateId!, quote);
          const [reference] = handOver([quote.evidenceId]);
          return {
            quote: quoteForModel(quote, reference!),
            replacementCeiling: { currency: "GBP", amountMinor: recurringCeilingMinor },
            withinCeiling: quote.recurringTotal.amountMinor <= recurringCeilingMinor,
            ...(quote.comparison
              ? {
                  comparisonSummary: `${quote.candidateId}: checked 12-month future cost ${formatGbp(quote.comparison.candidateTotal.amountMinor)}; keeping the current plan ${formatGbp(quote.comparison.currentTotal.amountMinor)} over the SAME horizon. First charge ${formatGbp(quote.dueNowTotal.amountMinor)}; full monthly renewal ${formatGbp(quote.recurringTotal.amountMinor)}. Authored future-notice projection, not a completed payment.`,
                }
              : {}),
          } satisfies GetQuoteResult;
        }
        case "test_candidate":
          return await testCandidate(candidateId!, signal);
        case "read_artifact":
          return await readArtifact(artifactId!);
      }
    } catch (error) {
      if (error instanceof ProviderError) throw new ToolRefusal(error.message);
      throw error;
    }
  }

  const availableTools = () => {
    const candidates = [...observations.quotes.values()]
      .filter(
        (quote) =>
          quote.candidateId !== observations.account?.planId &&
          quote.recurringTotal.amountMinor <= recurringCeilingMinor &&
          (!quote.offer || quote.offer.eligibility === "ELIGIBLE"),
      )
      .map((quote) => quote.candidateId);
    // Keep the tool's name visible throughout the conversation. Adding a new
    // tool mid-conversation can leave the model believing it is unavailable.
    // Execution still requires a verified eligible quote, even before narrowing.
    return agentTools.map((tool) =>
      tool.name !== "test_candidate" || candidates.length === 0
        ? tool
        : {
            ...tool,
            parameters: {
              ...tool.parameters,
              properties: { candidateId: { type: "string", enum: candidates } },
            },
          },
    );
  };
  return { execute, observations, resolveCitations, availableTools };
}
