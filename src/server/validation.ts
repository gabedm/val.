import { createHash } from "node:crypto";
import type {
  CapabilityResult,
  ExitTerms,
  ManifestRecord,
  Money,
  Overlap,
  PaidOffer,
  PurchaseTerms,
  SampleOutput,
  Transcript,
  TranscriptTurn,
  ValueComparison,
} from "../shared/contracts";

/** Provider and tool artifacts above this size are unavailable evidence, never truncated. */
export const maxArtifactBytes = 16 * 1024;

export const sha256 = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");

export const formatGbp = (minorUnits: number) => `GBP ${(minorUnits / 100).toFixed(2)}`;

const normalizeText = (value: string) => value.normalize("NFC").replace(/\r\n|\r/g, "\n");

/**
 * The exact bytes behind a transcript's canonicalDigest: id, title, then ordered speaker/text turns,
 * every string NFC-normalised with LF line endings and no trimming.
 */
export function canonicalTranscriptBytes(record: Transcript): string {
  return JSON.stringify({
    id: normalizeText(record.id),
    title: normalizeText(record.title),
    turns: record.turns.map((turn) => ({
      speaker: normalizeText(turn.speaker),
      text: normalizeText(turn.text),
    })),
  });
}

export interface ManifestContent {
  version: 1;
  count: number;
  records: ManifestRecord[];
}

/** Records are listed in ID order, so reordering whole records never changes the manifest. */
export function buildManifest(records: Transcript[]): ManifestContent & { manifestDigest: string } {
  const ids = records.map((record) => normalizeText(record.id));
  if (new Set(ids).size !== ids.length) throw new Error("History records must have distinct IDs.");
  const manifestRecords = records
    .map((record) => ({
      id: normalizeText(record.id),
      canonicalDigest: sha256(canonicalTranscriptBytes(record)),
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const content: ManifestContent = { version: 1, count: manifestRecords.length, records: manifestRecords };
  return { ...content, manifestDigest: sha256(manifestBytes(content)) };
}

export const manifestBytes = (content: ManifestContent) =>
  JSON.stringify({
    version: content.version,
    count: content.count,
    records: content.records.map((record) => ({ id: record.id, canonicalDigest: record.canonicalDigest })),
  });

/** Empty when the destination has exactly the source's records; otherwise each difference is named. */
export function manifestDifferences(
  source: ManifestContent & { manifestDigest: string },
  destination: ManifestContent & { manifestDigest: string },
): string[] {
  const differences: string[] = [];
  if (source.count !== destination.count)
    differences.push(
      `Record count differs: ${source.count} at the source, ${destination.count} at the destination.`,
    );
  const destinationDigests = new Map(
    destination.records.map((record) => [record.id, record.canonicalDigest]),
  );
  for (const record of source.records) {
    const found = destinationDigests.get(record.id);
    if (found === undefined) differences.push(`${record.id} is missing at the destination.`);
    else if (found !== record.canonicalDigest) differences.push(`${record.id} differs at the destination.`);
  }
  if (source.manifestDigest !== destination.manifestDigest && differences.length === 0)
    differences.push("Manifest digests differ.");
  return differences;
}

export type Capability = CapabilityResult["capability"];

/**
 * Checks one sample against the benchmark. Both representations are inspected: the editable text lines
 * and the observed ordered turns. Speaker labels count only when both carry them; no hidden metadata exists
 * to rescue an output (the sample shape rejects extra fields).
 */
export function checkSample(
  output: SampleOutput,
  benchmark: TranscriptTurn[],
  required: Capability[],
): CapabilityResult[] {
  const lines = output.editableText.split("\n").map(normalizeText);
  return required.map((capability) => {
    const problem =
      capability === "editable_text"
        ? textProblem(output, lines, benchmark)
        : speakerProblem(output, lines, benchmark);
    return { capability, passes: problem === null, reason: problem ?? "Output matches the benchmark." };
  });
}

function textProblem(output: SampleOutput, lines: string[], benchmark: TranscriptTurn[]): string | null {
  if (output.turns.length !== benchmark.length || lines.length !== benchmark.length)
    return "Output does not contain every benchmark turn.";
  for (const [index, expected] of benchmark.entries()) {
    const expectedText = normalizeText(expected.text);
    if (normalizeText(output.turns[index]!.text) !== expectedText || !lines[index]!.endsWith(expectedText))
      return `Turn ${index + 1} text differs from the benchmark.`;
  }
  return null;
}

function speakerProblem(output: SampleOutput, lines: string[], benchmark: TranscriptTurn[]): string | null {
  if (output.turns.length !== benchmark.length || lines.length !== benchmark.length)
    return "Output does not contain every benchmark turn.";
  for (const [index, expected] of benchmark.entries()) {
    const speaker = normalizeText(expected.speaker);
    if (output.turns[index]!.speaker === null || normalizeText(output.turns[index]!.speaker!) !== speaker)
      return `Turn ${index + 1} has no correct speaker label.`;
    if (!lines[index]!.startsWith(`${speaker}: `))
      return `Editable text line ${index + 1} does not carry the speaker label.`;
  }
  return null;
}

/**
 * Material terms are hashed as JSON built in the contract's property order, so the hash never depends on how a
 * record happened to be assembled. Preview/review IDs, expiry times and evidence IDs are deliberately excluded.
 */
const orderedMoney = (money: Money) => ({ currency: money.currency, amountMinor: money.amountMinor });
export const orderedOffer = (offer: PaidOffer) => ({
  introductoryAmount: orderedMoney(offer.introductoryAmount),
  introductoryCycles: offer.introductoryCycles,
  regularAmount: orderedMoney(offer.regularAmount),
  validFrom: offer.validFrom,
  eligibleUntil: offer.eligibleUntil,
  firstChargeBasis: offer.firstChargeBasis,
  eligibility: offer.eligibility,
  setupFee: orderedMoney(offer.setupFee),
  commitmentMonths: offer.commitmentMonths,
});
export const orderedComparison = (comparison: ValueComparison) => ({
  assessedAt: comparison.assessedAt,
  horizonMonths: comparison.horizonMonths,
  oldNextBillingAt: comparison.oldNextBillingAt,
  renewalEffectiveAt: comparison.renewalEffectiveAt,
  announcedRenewal: orderedMoney(comparison.announcedRenewal),
  currentTotal: orderedMoney(comparison.currentTotal),
  candidateTotal: orderedMoney(comparison.candidateTotal),
  netSavingMinor: comparison.netSavingMinor,
  basis: comparison.basis,
});

const orderedOverlap = (overlap: Overlap) => ({
  oldPaidAmount: orderedMoney(overlap.oldPaidAmount),
  oldPaidThrough: overlap.oldPaidThrough,
  newDueNow: orderedMoney(overlap.newDueNow),
  possibleOldRenewal: overlap.possibleOldRenewal && orderedMoney(overlap.possibleOldRenewal),
  oldNextBillingTime: overlap.oldNextBillingTime,
  explanation: overlap.explanation,
});

export const orderedPurchaseTerms = (terms: PurchaseTerms) => ({
  candidateId: terms.candidateId,
  providerId: terms.providerId,
  planId: terms.planId,
  quoteRevision: terms.quoteRevision,
  dueNow: orderedMoney(terms.dueNow),
  recurring: orderedMoney(terms.recurring),
  interval: terms.interval,
  intervalCount: terms.intervalCount,
  oldSubscriptionId: terms.oldSubscriptionId,
  oldAccessEndsAt: terms.oldAccessEndsAt,
  overlap: orderedOverlap(terms.overlap),
  ...(terms.offer ? { offer: orderedOffer(terms.offer) } : {}),
  ...(terms.comparison ? { comparison: orderedComparison(terms.comparison) } : {}),
  backupManifestDigest: terms.backupManifestDigest,
});

export const orderedExitTerms = (terms: ExitTerms) => ({
  newSubscriptionId: terms.newSubscriptionId,
  oldSubscriptionId: terms.oldSubscriptionId,
  effectiveRecurring: orderedMoney(terms.effectiveRecurring),
  oldAccessEndsAt: terms.oldAccessEndsAt,
  overlap: orderedOverlap(terms.overlap),
  ...(terms.offer ? { offer: orderedOffer(terms.offer) } : {}),
  ...(terms.comparison ? { comparison: orderedComparison(terms.comparison) } : {}),
  backupManifestDigest: terms.backupManifestDigest,
  importManifestDigest: terms.importManifestDigest,
  remainingExits: terms.remainingExits,
});

/** The exact payload that is hashed and stored, and its SHA-256. */
function hashed(payload: object) {
  const hashPayload = JSON.stringify(payload);
  return { hashPayload, hash: sha256(hashPayload) };
}

export const previewHashOf = (input: {
  caseId: string;
  ownerId: string;
  recommendationId: string;
  policyRevision: number;
  materialTerms: PurchaseTerms;
}) =>
  hashed({
    caseId: input.caseId,
    ownerId: input.ownerId,
    recommendationId: input.recommendationId,
    policyRevision: input.policyRevision,
    materialTerms: orderedPurchaseTerms(input.materialTerms),
  });

export const reviewHashOf = (input: {
  caseId: string;
  ownerId: string;
  transitionId: string;
  policyRevision: number;
  materialTerms: ExitTerms;
}) =>
  hashed({
    caseId: input.caseId,
    ownerId: input.ownerId,
    transitionId: input.transitionId,
    policyRevision: input.policyRevision,
    materialTerms: orderedExitTerms(input.materialTerms),
  });
