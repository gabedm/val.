import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { validate } from "../shared/contracts";
import type {
  AccountSnapshot,
  Artifact,
  CandidateQuote,
  HistoryManifest,
  ImportResult,
  PlanSummary,
  SampleOutput,
  ServiceExitResult,
  Transcript,
} from "../shared/contracts";
import fixtures from "../../fixtures/scenario-fixtures.json";
import type { Executor } from "./db";
import { cases, operations, providerAccounts, providerTranscripts, quotes } from "./db/schema";
import { recordEvidence, storeArtifact, type AdvisoryOption } from "./evidence";
import type { CaseRow } from "./operations";
import { fixturePlans } from "./plans";
import { projectValue } from "./recommendation";
import { buildManifest, manifestDifferences, type ManifestContent } from "./validation";

export const benchmarkTurns = fixtures.benchmark.turns;

/** A provider refused or failed a local operation; nothing was changed. */
export class ProviderError extends Error {}

export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type BackupPackage = {
  manifest: ManifestContent & { manifestDigest: string };
  transcripts: Transcript[];
};

const planText: Record<string, { label: string; marketingText: (publicSpeakerLabels: boolean) => string }> = {
  a_01: {
    label: "Original service A · plan 1",
    marketingText: (labels) =>
      labels ? "Editable call transcripts with speaker labels." : "Editable call transcripts.",
  },
  a_02: {
    label: "Original service A · plan 2",
    marketingText: () => "Editable call transcripts with speaker labels and shared workspaces.",
  },
  b_01: { label: "Margin B · plan 1", marketingText: () => "Export your call transcripts as editable text." },
  b_02: {
    label: "Margin B · plan 2",
    marketingText: () => "Export your call transcripts as editable text with speaker labels.",
  },
  b_03: {
    label: "Margin B · paid introductory offer",
    marketingText: () => "Editable work with paid introductory terms; check the full quote.",
  },
};

const planAvailable = (caseRow: CaseRow, planId: string, revision: number) =>
  planId !== "b_03" ||
  !!caseRow.evaluation?.plans["b_03"] ||
  (caseRow.scenario === "value_offer" && revision > fixtures.initialState.entitlementRevision);
const valueEvent = (() => {
  const event = fixtures.scenarios.find((scenario) => scenario.id === "value_offer");
  if (
    !event ||
    !("renewalMinor" in event) ||
    typeof event.renewalMinor !== "number" ||
    !("noticeOffsetDays" in event) ||
    typeof event.noticeOffsetDays !== "number" ||
    !("offerValidDays" in event) ||
    typeof event.offerValidDays !== "number"
  )
    throw new Error("The value case is missing its dated merchant notice.");
  return {
    renewalMinor: event.renewalMinor,
    noticeOffsetDays: event.noticeOffsetDays,
    offerValidDays: event.offerValidDays,
  };
})();
const daysAfter = (date: Date, days: number) => new Date(date.getTime() + days * 86_400_000);

/** An induced price change moves the public quote for plan b_02 by this amount and bumps its revision. */
const inducedPriceChangeMinor = 200;

async function loadAccount(tx: Executor, accountId: string): Promise<ProviderAccountRow> {
  const [account] = await tx.select().from(providerAccounts).where(eq(providerAccounts.id, accountId));
  if (!account) throw new ProviderError("No such provider account.");
  return account;
}

/** Healthy workspaces for a new case: Provider A with its current plan and three history records, Provider B empty. */
export async function seedWorkspaces(tx: Executor, caseRow: CaseRow) {
  const initial = fixtures.initialState;
  await tx.insert(providerAccounts).values([
    {
      id: caseRow.initialAccountId,
      caseId: caseRow.id,
      providerId: "provider_a",
      planId: "a_01",
      ...initial,
      accessStatus: "ACTIVE",
    },
    {
      id: caseRow.replacementAccountId,
      caseId: caseRow.id,
      providerId: "provider_b",
      planId: null,
      entitlementRevision: 1,
      publicSpeakerLabels: false,
      accountSpeakerLabels: false,
      historyRetained: false,
      accessStatus: "TRIAL",
    },
  ]);
  await tx
    .insert(providerTranscripts)
    .values(fixtures.history.map((record) => ({ accountId: caseRow.initialAccountId, ...record })));
}

export async function listPlans(tx: Executor, caseRow: CaseRow): Promise<PlanSummary[]> {
  const account = await loadAccount(tx, caseRow.initialAccountId);
  return fixturePlans
    .filter((plan) => planAvailable(caseRow, plan.planId, account.entitlementRevision))
    .map((plan) => ({
      candidateId: plan.planId,
      providerId: plan.providerId,
      planId: plan.planId,
      label: planText[plan.planId]!.label,
      marketingText:
        caseRow.evaluation?.plans[plan.planId]?.marketingText ??
        planText[plan.planId]!.marketingText(account.publicSpeakerLabels),
    }));
}

/** Provider A's public notice after its entitlement event. It describes the listing change, never the account's own output. */
const entitlementNotice =
  "Original service A has updated plan 1: speaker labels are no longer listed as included.";

/** The provider notice an investigation starts from, or null when nothing has been announced. Untrusted text. */
export async function providerNotice(tx: Executor, caseRow: CaseRow): Promise<string | null> {
  if (caseRow.evaluation) return caseRow.evaluation.notice || null;
  const account = await loadAccount(tx, caseRow.initialAccountId);
  if (account.entitlementRevision <= fixtures.initialState.entitlementRevision) return null;
  if (caseRow.scenario === "value_offer")
    return `Original service’s authored plan notice announces GBP ${(valueEvent.renewalMinor / 100).toFixed(2)} per month from ${daysAfter(caseRow.createdAt, valueEvent.noticeOffsetDays).toISOString()}. It is not a PayPal charge or a change to your already paid period.`;
  return entitlementNotice;
}

/** Reads an account and records the observation as evidence, so later checks can cite and age it. */
export async function getAccount(
  tx: Executor,
  accountId: string,
  options: AdvisoryOption = {},
): Promise<AccountSnapshot> {
  const account = await loadAccount(tx, accountId);
  const billing = account.subscriptionId
    ? (
        await tx
          .select({ billingStatus: operations.billingStatus })
          .from(operations)
          .where(and(eq(operations.caseId, account.caseId), eq(operations.remoteId, account.subscriptionId)))
      )[0]
    : undefined;
  const [evaluationCase] =
    !billing && account.providerId === "provider_a" && account.paidThrough
      ? await tx.select({ evaluation: cases.evaluation }).from(cases).where(eq(cases.id, account.caseId))
      : [];
  const snapshot = {
    caseId: account.caseId,
    providerId: account.providerId,
    accountId: account.id,
    planId: account.planId,
    subscriptionId: account.subscriptionId,
    entitlementRevision: account.entitlementRevision,
    accessStatus: account.accessStatus,
    billingStatus:
      billing?.billingStatus ??
      (evaluationCase?.evaluation?.valueCase?.source === "AUTHORED_EVALUATION" ? "ACTIVE" : "NONE"),
    paidThrough: account.paidThrough?.toISOString() ?? null,
    accessEndsAt: account.accessEndsAt?.toISOString() ?? null,
  } as const;
  const observed = await recordEvidence(
    tx,
    {
      caseId: account.caseId,
      kind: "account",
      providerId: account.providerId,
      accountId: account.id,
      planId: account.planId ?? undefined,
      entitlementRevision: account.entitlementRevision,
      summary: `${account.providerId} account is ${account.accessStatus}, entitlement revision ${account.entitlementRevision}.`,
      detail: snapshot,
    },
    options,
  );
  return { ...snapshot, observedAt: observed.observedAt.toISOString(), evidenceId: observed.id };
}

export async function getQuote(
  tx: Executor,
  caseRow: CaseRow,
  candidateId: string,
  options: AdvisoryOption = {},
): Promise<CandidateQuote> {
  const plan = fixturePlans.find((candidate) => candidate.planId === candidateId);
  const current =
    caseRow.scenario === "value_offer" || candidateId === "b_03"
      ? await loadAccount(tx, caseRow.initialAccountId)
      : null;
  if (
    !plan ||
    !planAvailable(
      caseRow,
      candidateId,
      current?.entitlementRevision ?? fixtures.initialState.entitlementRevision,
    )
  )
    throw new ProviderError(`Unknown candidate ${candidateId}.`);
  const observedAt = new Date();
  const priceChanged = Boolean(caseRow.faults.price_change) && candidateId === "b_02";
  const recurringMinor = plan.recurringMinor + (priceChanged ? inducedPriceChangeMinor : 0);
  const introductory =
    plan.introductoryMinor !== undefined && plan.introductoryCycles !== undefined
      ? { minor: plan.introductoryMinor, cycles: plan.introductoryCycles }
      : null;
  const dueNowMinor = introductory ? introductory.minor : recurringMinor;
  const replacement = introductory ? await loadAccount(tx, caseRow.replacementAccountId) : null;
  // PayPal reports transaction times to whole seconds. Author the offer window at
  // that same precision so an immediate legitimate payment cannot predate it.
  const offerStart = new Date(Math.floor(caseRow.createdAt.getTime() / 1000) * 1000);
  const offerEnd = daysAfter(offerStart, valueEvent.offerValidDays);
  const eligibility =
    caseRow.scenario === "value_offer" &&
    current!.entitlementRevision > fixtures.initialState.entitlementRevision &&
    !replacement?.subscriptionId &&
    observedAt >= offerStart &&
    observedAt < offerEnd
      ? "ELIGIBLE"
      : "INELIGIBLE";
  const offer: CandidateQuote["offer"] = introductory
    ? {
        introductoryAmount: { currency: "GBP", amountMinor: introductory.minor },
        introductoryCycles: introductory.cycles,
        regularAmount: { currency: "GBP", amountMinor: recurringMinor },
        validFrom: offerStart.toISOString(),
        eligibleUntil: offerEnd.toISOString(),
        firstChargeBasis: "BUYER_APPROVAL",
        eligibility,
        setupFee: { currency: "GBP", amountMinor: 0 },
        commitmentMonths: 0,
      }
    : undefined;
  const projected =
    caseRow.scenario === "value_offer" &&
    current &&
    current.entitlementRevision > fixtures.initialState.entitlementRevision &&
    current.planId === "a_01" &&
    current.paidThrough &&
    current.paidThrough > observedAt
      ? projectValue({
          assessedAt: new Date(
            Date.UTC(observedAt.getUTCFullYear(), observedAt.getUTCMonth(), observedAt.getUTCDate()),
          ).toISOString(),
          oldNextBillingAt: current.paidThrough.toISOString(),
          renewalEffectiveAt: daysAfter(caseRow.createdAt, valueEvent.noticeOffsetDays).toISOString(),
          currentMinor: fixtures.providerPlans[0]!.recurringMinor,
          announcedMinor: valueEvent.renewalMinor,
          candidateMinor: recurringMinor,
          introductoryMinor: dueNowMinor,
          introductoryCycles: offer?.introductoryCycles ?? 0,
          feesMinor: offer?.setupFee.amountMinor ?? 0,
        })
      : null;
  const comparison =
    projected && candidateId === current?.planId
      ? { ...projected, candidateTotal: projected.currentTotal, netSavingMinor: 0 }
      : projected;
  const observed = await recordEvidence(
    tx,
    {
      caseId: caseRow.id,
      kind: "quote",
      providerId: plan.providerId,
      planId: plan.planId,
      summary: offer
        ? `${plan.planId} charges GBP ${(dueNowMinor / 100).toFixed(2)} for ${offer.introductoryCycles} paid months, then GBP ${(recurringMinor / 100).toFixed(2)} monthly. ${eligibility === "ELIGIBLE" ? "Offer eligibility observed." : "Offer not available to this account."}`
        : `${plan.planId} costs GBP ${(recurringMinor / 100).toFixed(2)} a month with nothing due beyond the first month.${comparison ? " Future Original service cost is an authored notice, not a PayPal charge." : ""}`,
      detail: {
        dueNowMinor,
        recurringMinor,
        offer,
        comparison,
        priceSource: comparison ? "authored_merchant_notice_projection" : "authored_plan_quote",
      },
    },
    options,
  );
  const quote = {
    id: randomUUID(),
    caseId: caseRow.id,
    candidateId,
    providerId: plan.providerId,
    planId: plan.planId,
    revision: priceChanged ? 2 : caseRow.scenario === "value_offer" ? current!.entitlementRevision : 1,
  } as const;
  await tx.insert(quotes).values({
    ...quote,
    recurringMinor,
    dueNowMinor,
    offer,
    comparison,
    evidenceId: observed.id,
    observedAt: observed.observedAt,
    advisory: options.advisory ?? false,
  });
  const money = { currency: "GBP", amountMinor: recurringMinor } as const;
  return {
    ...quote,
    recurringTotal: money,
    dueNowTotal: { currency: "GBP", amountMinor: dueNowMinor },
    interval: "MONTH",
    intervalCount: 1,
    taxMinor: 0,
    feesMinor: 0,
    ...(offer ? { offer } : {}),
    ...(caseRow.scenario === "value_offer" ? { comparison } : {}),
    observedAt: observed.observedAt.toISOString(),
    evidenceId: observed.id,
  };
}

/**
 * What a plan's export actually does. An evaluation workspace states it per plan; otherwise Provider A's current plan
 * follows the account's entitlement, and Provider B follows its authored plan unless the output fault strips speakers.
 */
function exportBehavior(
  caseRow: CaseRow,
  account: ProviderAccountRow,
  planId: string,
): { editableText: boolean; speakerLabels: boolean } {
  const configured = caseRow.evaluation?.plans[planId];
  if (configured) return configured;
  const authored = fixtures.providerPlans.find((plan) => plan.planId === planId)!;
  if (account.providerId === "provider_a")
    return {
      editableText: authored.editableText,
      speakerLabels: planId === account.planId ? account.accountSpeakerLabels : authored.speakerLabels,
    };
  return {
    editableText: authored.editableText,
    speakerLabels: authored.speakerLabels && !caseRow.faults.output_failure,
  };
}

/** The one export implementation behind trial evaluations, subscribed output and the offline evaluator's ground truth. */
export function renderSample(caseRow: CaseRow, account: ProviderAccountRow, planId: string): SampleOutput {
  const { editableText, speakerLabels } = exportBehavior(caseRow, account, planId);
  const lineFor = (turn: { speaker: string; text: string }) =>
    speakerLabels ? `${turn.speaker}: ${turn.text}` : turn.text;
  return {
    editableText: editableText ? benchmarkTurns.map(lineFor).join("\n") : "",
    turns: benchmarkTurns.map((turn) => ({ speaker: speakerLabels ? turn.speaker : null, text: turn.text })),
  };
}

async function storeSample(
  tx: Executor,
  caseRow: CaseRow,
  account: ProviderAccountRow,
  planId: string,
  mode: "evaluated" | "subscribed",
  options: AdvisoryOption = {},
): Promise<Artifact> {
  const output = renderSample(caseRow, account, planId);
  if (!validate.sampleOutput(output)) throw new ProviderError("The provider produced a malformed sample.");
  const artifact = await storeArtifact(tx, caseRow.id, JSON.stringify(output), "application/json", options);
  await recordEvidence(
    tx,
    {
      caseId: caseRow.id,
      kind: "sample",
      providerId: account.providerId,
      accountId: account.id,
      planId,
      entitlementRevision: account.entitlementRevision,
      artifactId: artifact.id,
      summary: `${mode === "subscribed" ? "Subscribed" : "Evaluation"} sample generated for ${planId}.`,
      detail: { mode },
    },
    options,
  );
  return artifact;
}

/** Sample access is disclosed demo access: any plan can be evaluated without being purchased. */
export async function evaluateSample(
  tx: Executor,
  caseRow: CaseRow,
  accountId: string,
  candidateId: string,
  options: AdvisoryOption = {},
): Promise<Artifact> {
  if (!planText[candidateId]) throw new ProviderError(`Unknown candidate ${candidateId}.`);
  return storeSample(tx, caseRow, await loadAccount(tx, accountId), candidateId, "evaluated", options);
}

export async function generateSubscribedSample(
  tx: Executor,
  caseRow: CaseRow,
  accountId: string,
): Promise<Artifact> {
  const account = await loadAccount(tx, accountId);
  if (account.accessStatus !== "ACTIVE" || !account.planId || !account.subscriptionId)
    throw new ProviderError("Subscribed output needs an activated account.");
  return storeSample(tx, caseRow, account, account.planId, "subscribed");
}

export async function readTranscripts(tx: Executor, accountId: string): Promise<Transcript[]> {
  const rows = await tx
    .select()
    .from(providerTranscripts)
    .where(eq(providerTranscripts.accountId, accountId))
    .orderBy(providerTranscripts.id);
  return rows.map(({ id, title, turns }) => ({ id, title, turns }));
}

/** Exports an account's history with its manifest, storing both as one artifact. `kind` says why it was read. */
export async function exportHistory(
  tx: Executor,
  caseRow: CaseRow,
  accountId: string,
  kind: "backup" | "import",
): Promise<{ manifest: HistoryManifest; transcripts: Transcript[] }> {
  const account = await loadAccount(tx, accountId);
  const transcripts = await readTranscripts(tx, accountId);
  const content = buildManifest(transcripts);
  const artifact = await storeArtifact(
    tx,
    caseRow.id,
    JSON.stringify({ manifest: content, transcripts } satisfies BackupPackage),
  );
  const observed = await recordEvidence(tx, {
    caseId: caseRow.id,
    kind,
    providerId: account.providerId,
    accountId,
    artifactId: artifact.id,
    summary: `${kind === "backup" ? "Backup of" : "Re-read of"} ${account.providerId} history: ${content.count} records, manifest ${content.manifestDigest.slice(0, 12)}.`,
    detail: { manifestDigest: content.manifestDigest },
  });
  const manifest: HistoryManifest = {
    id: observed.id,
    caseId: caseRow.id,
    providerId: account.providerId,
    accountId,
    ...content,
    artifactId: artifact.id,
    observedAt: observed.observedAt.toISOString(),
  };
  return { manifest, transcripts };
}

/** A stored backup is trusted only if its transcripts still produce the manifest it claims. */
export function openBackup(artifact: Pick<Artifact, "content">): BackupPackage {
  const backup = JSON.parse(artifact.content) as BackupPackage;
  const recomputed = buildManifest(backup.transcripts);
  const differences = manifestDifferences(backup.manifest, recomputed);
  if (differences.length > 0)
    throw new ProviderError(`The backup does not match its manifest: ${differences[0]}`);
  return backup;
}

/**
 * Copies a verified backup into a destination account in one local transaction, then re-reads the destination.
 * matchesSource comes from that independent re-read, never from the manifest that was copied.
 */
export async function importHistory(
  tx: Executor,
  caseRow: CaseRow,
  accountId: string,
  operationKey: string,
  backup: BackupPackage,
): Promise<ImportResult> {
  if (caseRow.faults.import_failure)
    throw new ProviderError("Provider B rejected the import (induced fault).");
  await tx.insert(providerTranscripts).values(backup.transcripts.map((record) => ({ accountId, ...record })));
  await tx.update(providerAccounts).set({ historyRetained: true }).where(eq(providerAccounts.id, accountId));
  const { manifest: destinationManifest } = await exportHistory(tx, caseRow, accountId, "import");
  const matchesSource = manifestDifferences(backup.manifest, destinationManifest).length === 0;
  return { operationKey, destinationManifest, matchesSource, evidenceId: destinationManifest.id };
}

export async function activateAccount(
  tx: Executor,
  accountId: string,
  input: { planId: string; subscriptionId: string },
): Promise<AccountSnapshot> {
  await tx
    .update(providerAccounts)
    .set({ accessStatus: "ACTIVE", planId: input.planId, subscriptionId: input.subscriptionId })
    .where(eq(providerAccounts.id, accountId));
  return getAccount(tx, accountId);
}

/** Schedules the end of service at the saved paid-through time; access continues until then. */
export async function exitService(
  tx: Executor,
  caseRow: CaseRow,
  accountId: string,
  operationKey: string,
  accessEndsAt: Date,
): Promise<ServiceExitResult> {
  if (caseRow.faults.timeout)
    throw new ProviderError("Provider A timed out while scheduling the exit (induced fault).");
  const status = accessEndsAt.getTime() <= Date.now() ? "ENDED" : "SCHEDULED";
  await tx
    .update(providerAccounts)
    .set({ accessStatus: status === "ENDED" ? "ENDED" : "EXIT_SCHEDULED", accessEndsAt })
    .where(eq(providerAccounts.id, accountId));
  const observed = await recordEvidence(tx, {
    caseId: caseRow.id,
    kind: "service_exit",
    providerId: "provider_a",
    accountId,
    summary: `Provider A service exit ${status.toLowerCase()}; access ends ${accessEndsAt.toISOString()}.`,
  });
  return {
    operationKey,
    accountId,
    status,
    accessEndsAt: accessEndsAt.toISOString(),
    observedAt: observed.observedAt.toISOString(),
    evidenceId: observed.id,
  };
}

/**
 * Applies the case's chosen authored notice or entitlement event once. Revision guards repetition without changing
 * an existing subscription's payment or PayPal plan. Returns whether the account observation changed.
 */
export async function applyScenarioEvent(tx: Executor, caseRow: CaseRow): Promise<boolean> {
  const event = fixtures.scenarios.find((scenario) => scenario.id === caseRow.scenario)!;
  const account = await loadAccount(tx, caseRow.initialAccountId);
  if (account.entitlementRevision >= event.afterEvent.entitlementRevision) return false;
  await tx.update(providerAccounts).set(event.afterEvent).where(eq(providerAccounts.id, account.id));
  return true;
}
