import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { validatorFor, type Transcript } from "../src/shared/contracts";
import fixtures from "../fixtures/scenario-fixtures.json";
import {
  buildManifest,
  canonicalTranscriptBytes,
  checkSample,
  manifestBytes,
  manifestDifferences,
  sha256,
} from "../src/server/validation";

// The pack's canonical examples: three history records, NFC/LF normalisation, four mutations and the sorted manifest.
interface RecordExample {
  record: Transcript;
  canonicalBytes: string;
  canonicalDigest: string;
}

const examples = JSON.parse(readFileSync("docs/build-pack/preservation-examples.json", "utf8"));

describe("canonical transcript bytes and digests", () => {
  it.each(examples.records as RecordExample[])(
    "matches the pack's bytes and digest for $record.id",
    ({ record, canonicalBytes, canonicalDigest }) => {
      expect(canonicalTranscriptBytes(record)).toBe(canonicalBytes);
      expect(sha256(canonicalTranscriptBytes(record))).toBe(canonicalDigest);
    },
  );

  it("normalises to NFC and LF without trimming", () => {
    const { input, canonicalBytes, canonicalDigest } = examples.normalization;
    expect(canonicalTranscriptBytes(input)).toBe(canonicalBytes);
    expect(sha256(canonicalBytes)).toBe(canonicalDigest);
    const decomposed = {
      ...input,
      title: "Cafe\u0301\nnotes",
      turns: [{ speaker: "Jose\u0301", text: "First\nSecond\nThird" }],
    };
    expect(canonicalTranscriptBytes(decomposed)).toBe(canonicalBytes);
  });

  it("keeps surrounding whitespace significant", () => {
    const record = examples.records[0].record;
    expect(canonicalTranscriptBytes({ ...record, title: `${record.title} ` })).not.toBe(
      canonicalTranscriptBytes(record),
    );
  });

  it.each(examples.mutations as (RecordExample & { name: string })[])(
    "detects $name through the digest",
    ({ record, canonicalDigest }) => {
      const digest = sha256(canonicalTranscriptBytes(record));
      expect(digest).toBe(canonicalDigest);
      expect(digest).not.toBe(examples.records[0].canonicalDigest);
    },
  );
});

describe("history manifest", () => {
  const records = examples.records.map((entry: { record: unknown }) => entry.record);

  it("produces the pack's manifest bytes and digest", () => {
    const manifest = buildManifest(records);
    expect(manifestBytes(manifest)).toBe(examples.manifestBytes);
    expect(manifest.manifestDigest).toBe(examples.manifestDigest);
  });

  it("is unchanged by reordering whole records, and refuses repeated IDs", () => {
    expect(buildManifest([...records].reverse()).manifestDigest).toBe(examples.manifestDigest);
    expect(() => buildManifest([records[0], records[0]])).toThrow(/distinct IDs/);
  });

  it("names a missing record, a changed record and a missing turn", () => {
    const source = buildManifest(records);
    const changedSpeaker = buildManifest([examples.mutations[0].record, records[1], records[2]]);
    const missingTurn = buildManifest([examples.mutations[3].record, records[1], records[2]]);
    expect(manifestDifferences(source, buildManifest(records.slice(0, 2)))).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/count differs/),
        expect.stringMatching(/history_003 is missing/),
      ]),
    );
    expect(manifestDifferences(source, changedSpeaker)).toEqual(["history_001 differs at the destination."]);
    expect(manifestDifferences(source, missingTurn)).toEqual(["history_001 differs at the destination."]);
    expect(manifestDifferences(source, buildManifest([...records].reverse()))).toEqual([]);
  });
});

describe("benchmark sample validator", () => {
  const benchmark = fixtures.benchmark.turns;
  const labelled = {
    editableText: benchmark.map((turn) => `${turn.speaker}: ${turn.text}`).join("\n"),
    turns: benchmark.map((turn) => ({ speaker: turn.speaker as string | null, text: turn.text })),
  };
  const unlabelled = {
    editableText: benchmark.map((turn) => turn.text).join("\n"),
    turns: benchmark.map((turn) => ({ speaker: null, text: turn.text })),
  };
  const both = ["editable_text", "speaker_labels"] as const;

  it("passes an output with editable text and correct speakers", () => {
    expect(checkSample(labelled, benchmark, [...both]).map((result) => result.passes)).toEqual([true, true]);
  });

  it("passes editable text but fails speaker labels when associations are removed", () => {
    expect(checkSample(unlabelled, benchmark, [...both])).toEqual([
      expect.objectContaining({ capability: "editable_text", passes: true }),
      expect.objectContaining({ capability: "speaker_labels", passes: false }),
    ]);
  });

  it.each([
    [
      "a wrong speaker in the turns",
      {
        ...labelled,
        turns: labelled.turns.map((turn, index) => (index === 1 ? { ...turn, speaker: "Alex" } : turn)),
      },
    ],
    ["labels only in the structured turns", { ...labelled, editableText: unlabelled.editableText }],
    ["labels only in the editable text", { ...labelled, turns: unlabelled.turns }],
  ])("fails speaker labels for %s", (_label, output) => {
    expect(checkSample(output, benchmark, ["speaker_labels"])[0]!.passes).toBe(false);
  });

  it("fails editable text for a missing or changed turn", () => {
    const missing = {
      editableText: labelled.editableText.split("\n").slice(1).join("\n"),
      turns: labelled.turns.slice(1),
    };
    const changed = {
      ...labelled,
      turns: labelled.turns.map((turn, index) => (index === 0 ? { ...turn, text: "Something else." } : turn)),
    };
    expect(checkSample(missing, benchmark, ["editable_text"])[0]!.passes).toBe(false);
    expect(checkSample(changed, benchmark, ["editable_text"])[0]!.passes).toBe(false);
  });

  it("rejects hidden speaker metadata as a malformed sample", () => {
    const withHiddenSpeakers = { ...unlabelled, speakerMap: { 0: "Alex" } };
    expect(validatorFor("SampleOutput")(withHiddenSpeakers)).toBe(false);
    expect(validatorFor("SampleOutput")(unlabelled)).toBe(true);
  });
});
