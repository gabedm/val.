import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatorFor } from "../src/shared/contracts";
import { artifacts, cases, providerAccounts, providerTranscripts } from "../src/server/db/schema";
import { storeArtifact } from "../src/server/evidence";
import {
  activateAccount,
  applyScenarioEvent,
  benchmarkTurns,
  evaluateSample,
  exitService,
  exportHistory,
  generateSubscribedSample,
  getAccount,
  getQuote,
  importHistory,
  listPlans,
  openBackup,
  ProviderError,
} from "../src/server/providers";
import { checkSample, manifestDifferences, sha256 } from "../src/server/validation";
import { newCase, startTestApp, type TestApp } from "./helpers";

// Real PostgreSQL provider workspaces; no PayPal is involved in this file.

const examples = JSON.parse(readFileSync("docs/build-pack/preservation-examples.json", "utf8"));
const bothCapabilities = ["editable_text", "speaker_labels"] as const;

let app: TestApp;
beforeAll(async () => void (app = await startTestApp()));
afterAll(() => app.close());

async function freshWorkspace(scenario: "feature_removed" | "grandfathered" = "feature_removed") {
  const { browser, caseId } = await newCase(app);
  if (scenario === "grandfathered")
    await app.ctx.db.update(cases).set({ scenario }).where(eq(cases.id, caseId));
  const [caseRow] = await app.ctx.db.select().from(cases).where(eq(cases.id, caseId));
  return { browser, caseRow: caseRow! };
}

const check = (content: string) => checkSample(JSON.parse(content), benchmarkTurns, [...bothCapabilities]);
const passing = (results: ReturnType<typeof check>) =>
  Object.fromEntries(results.map((result) => [result.capability, result.passes]));

describe("healthy workspaces", () => {
  it("seeds Provider A with its current plan and the three pack history records, and Provider B empty", async () => {
    const { caseRow } = await freshWorkspace();
    const a = await getAccount(app.ctx.db, caseRow.initialAccountId);
    const b = await getAccount(app.ctx.db, caseRow.replacementAccountId);
    expect(validatorFor("AccountSnapshot")(a)).toBe(true);
    expect(a).toMatchObject({
      providerId: "provider_a",
      planId: "a_01",
      entitlementRevision: 1,
      accessStatus: "ACTIVE",
    });
    expect(b).toMatchObject({ providerId: "provider_b", planId: null, accessStatus: "TRIAL" });

    const sourceHistory = await exportHistory(app.ctx.db, caseRow, caseRow.initialAccountId, "backup");
    expect(sourceHistory.manifest.manifestDigest).toBe(examples.manifestDigest);
    expect(sourceHistory.manifest.records).toEqual(examples.manifest.records);
    expect(
      (await exportHistory(app.ctx.db, caseRow, caseRow.replacementAccountId, "backup")).manifest.count,
    ).toBe(0);
  });

  it("gives the current plan a genuinely passing output before any event", async () => {
    const { caseRow } = await freshWorkspace();
    const sample = await evaluateSample(app.ctx.db, caseRow, caseRow.initialAccountId, "a_01");
    expect(validatorFor("Artifact")(sample)).toBe(true);
    expect(passing(check(sample.content))).toEqual({ editable_text: true, speaker_labels: true });
  });
});

describe("entitlement events (T02, T08)", () => {
  it("removes speaker labels from newly generated output for only the current plan, and only once", async () => {
    const { caseRow } = await freshWorkspace("feature_removed");
    expect(await applyScenarioEvent(app.ctx.db, caseRow)).toBe(true);
    expect(await applyScenarioEvent(app.ctx.db, caseRow)).toBe(false);

    const account = await getAccount(app.ctx.db, caseRow.initialAccountId);
    expect(account.entitlementRevision).toBe(2);
    const current = await evaluateSample(app.ctx.db, caseRow, caseRow.initialAccountId, "a_01");
    const upgrade = await evaluateSample(app.ctx.db, caseRow, caseRow.initialAccountId, "a_02");
    expect(passing(check(current.content))).toEqual({ editable_text: true, speaker_labels: false });
    expect(passing(check(upgrade.content))).toEqual({ editable_text: true, speaker_labels: true });
    expect(
      (await listPlans(app.ctx.db, caseRow)).find((plan) => plan.planId === "a_01")!.marketingText,
    ).not.toMatch(/speaker/i);
  });

  it("changes only the public offering for a grandfathered account, whose output still passes", async () => {
    const { caseRow } = await freshWorkspace("grandfathered");
    await applyScenarioEvent(app.ctx.db, caseRow);
    const [account] = await app.ctx.db
      .select()
      .from(providerAccounts)
      .where(eq(providerAccounts.id, caseRow.initialAccountId));
    expect(account).toMatchObject({
      publicSpeakerLabels: false,
      accountSpeakerLabels: true,
      entitlementRevision: 2,
    });
    const current = await evaluateSample(app.ctx.db, caseRow, caseRow.initialAccountId, "a_01");
    expect(passing(check(current.content))).toEqual({ editable_text: true, speaker_labels: true });
    expect(
      (await listPlans(app.ctx.db, caseRow)).find((plan) => plan.planId === "a_01")!.marketingText,
    ).not.toMatch(/speaker/i);
  });
});

describe("quotes and Provider B output (T03-T05)", () => {
  it("quotes the four authored monthly totals with nothing extra due", async () => {
    const { caseRow } = await freshWorkspace();
    const totals: Record<string, number> = {};
    for (const plan of await listPlans(app.ctx.db, caseRow)) {
      const quote = await getQuote(app.ctx.db, caseRow, plan.candidateId);
      expect(validatorFor("CandidateQuote")(quote)).toBe(true);
      expect(quote).toMatchObject({
        interval: "MONTH",
        intervalCount: 1,
        taxMinor: 0,
        feesMinor: 0,
        revision: 1,
      });
      expect(quote.dueNowTotal).toEqual(quote.recurringTotal);
      totals[plan.candidateId] = quote.recurringTotal.amountMinor;
    }
    expect(totals).toEqual({ a_01: 1200, a_02: 1900, b_01: 900, b_02: 1400 });
  });

  it("rejects the basic Provider B plan on its actual output while its marketing still advertises export", async () => {
    const { caseRow } = await freshWorkspace();
    const basic = await evaluateSample(app.ctx.db, caseRow, caseRow.replacementAccountId, "b_01");
    const suitable = await evaluateSample(app.ctx.db, caseRow, caseRow.replacementAccountId, "b_02");
    expect(passing(check(basic.content))).toEqual({ editable_text: true, speaker_labels: false });
    expect(passing(check(suitable.content))).toEqual({ editable_text: true, speaker_labels: true });
    expect(JSON.parse(basic.content).turns.every((turn: { speaker: unknown }) => turn.speaker === null)).toBe(
      true,
    );
    expect(
      (await listPlans(app.ctx.db, caseRow)).find((plan) => plan.planId === "b_01")!.marketingText,
    ).toMatch(/export/i);
  });

  it("uses one export path: the subscribed output is byte-identical to the evaluated output once the plan is active", async () => {
    const { caseRow } = await freshWorkspace();
    await expect(
      generateSubscribedSample(app.ctx.db, caseRow, caseRow.replacementAccountId),
    ).rejects.toBeInstanceOf(ProviderError);
    const evaluated = await evaluateSample(app.ctx.db, caseRow, caseRow.replacementAccountId, "b_02");
    await activateAccount(app.ctx.db, caseRow.replacementAccountId, {
      planId: "b_02",
      subscriptionId: "I-TEST",
    });
    const subscribed = await generateSubscribedSample(app.ctx.db, caseRow, caseRow.replacementAccountId);
    expect(subscribed.content).toBe(evaluated.content);
    expect(subscribed.sha256).toBe(sha256(subscribed.content));
  });

  it("stops speaker associations in the actual export when the output fault is on, leaving the marketing text alone", async () => {
    const { caseRow } = await freshWorkspace();
    const faulty = { ...caseRow, faults: { output_failure: true } };
    const sample = await evaluateSample(app.ctx.db, faulty, caseRow.replacementAccountId, "b_02");
    expect(passing(check(sample.content))).toEqual({ editable_text: true, speaker_labels: false });
    expect(
      (await listPlans(app.ctx.db, faulty)).find((plan) => plan.planId === "b_02")!.marketingText,
    ).toMatch(/speaker labels/);
  });

  it("raises the quote revision when the price fault is on, for the affected plan only", async () => {
    const { caseRow } = await freshWorkspace();
    const faulty = { ...caseRow, faults: { price_change: true } };
    expect(await getQuote(app.ctx.db, faulty, "b_02")).toMatchObject({
      revision: 2,
      recurringTotal: { amountMinor: 1600 },
    });
    expect(await getQuote(app.ctx.db, faulty, "b_01")).toMatchObject({
      revision: 1,
      recurringTotal: { amountMinor: 900 },
    });
  });
});

describe("history backup and import (T12, T13)", () => {
  it("imports the backup into Provider B and proves it by re-reading Provider B's own content", async () => {
    const { caseRow } = await freshWorkspace();
    const { manifest, transcripts } = await exportHistory(
      app.ctx.db,
      caseRow,
      caseRow.initialAccountId,
      "backup",
    );
    const backup = {
      manifest: {
        version: 1 as const,
        count: manifest.count,
        records: manifest.records,
        manifestDigest: manifest.manifestDigest,
      },
      transcripts,
    };

    const result = await importHistory(
      app.ctx.db,
      caseRow,
      caseRow.replacementAccountId,
      "import-key",
      backup,
    );
    expect(validatorFor("ImportResult")(result)).toBe(true);
    expect(result.matchesSource).toBe(true);
    expect(result.destinationManifest.accountId).toBe(caseRow.replacementAccountId);
    expect(result.destinationManifest.manifestDigest).toBe(examples.manifestDigest);
    expect(result.destinationManifest.artifactId).not.toBe(manifest.artifactId);
  });

  it("keeps raw artifact hashes separate from canonical digests", async () => {
    const { caseRow } = await freshWorkspace();
    const { manifest } = await exportHistory(app.ctx.db, caseRow, caseRow.initialAccountId, "backup");
    const [stored] = await app.ctx.db.select().from(artifacts).where(eq(artifacts.id, manifest.artifactId));
    expect(stored!.sha256).toBe(sha256(stored!.content));
    expect(stored!.sha256).not.toBe(manifest.manifestDigest);
  });

  it("exposes a destination that later changed, which a copied source manifest would never reveal", async () => {
    const { caseRow } = await freshWorkspace();
    const source = await exportHistory(app.ctx.db, caseRow, caseRow.initialAccountId, "backup");
    const backup = {
      manifest: {
        version: 1 as const,
        count: source.manifest.count,
        records: source.manifest.records,
        manifestDigest: source.manifest.manifestDigest,
      },
      transcripts: source.transcripts,
    };
    const imported = await importHistory(
      app.ctx.db,
      caseRow,
      caseRow.replacementAccountId,
      "import-key",
      backup,
    );
    expect(imported.matchesSource).toBe(true);

    await app.ctx.db
      .update(providerTranscripts)
      .set({ title: "Changed after import" })
      .where(eq(providerTranscripts.id, "history_002"));
    const reread = await exportHistory(app.ctx.db, caseRow, caseRow.replacementAccountId, "import");
    expect(manifestDifferences(backup.manifest, reread.manifest)).toEqual([
      "history_002 differs at the destination.",
    ]);
  });

  it("refuses a backup whose transcripts no longer match its manifest", async () => {
    const { caseRow } = await freshWorkspace();
    const { manifest, transcripts } = await exportHistory(
      app.ctx.db,
      caseRow,
      caseRow.initialAccountId,
      "backup",
    );
    const tampered = {
      manifest: {
        version: 1,
        count: manifest.count,
        records: manifest.records,
        manifestDigest: manifest.manifestDigest,
      },
      transcripts: transcripts.map((record, index) =>
        index === 0 ? { ...record, title: "Edited" } : record,
      ),
    };
    expect(() => openBackup({ content: JSON.stringify(tampered) })).toThrow(/does not match its manifest/);
  });

  it("writes nothing to Provider B when the import fault refuses it", async () => {
    const { caseRow } = await freshWorkspace();
    const { manifest, transcripts } = await exportHistory(
      app.ctx.db,
      caseRow,
      caseRow.initialAccountId,
      "backup",
    );
    const backup = {
      manifest: {
        version: 1 as const,
        count: manifest.count,
        records: manifest.records,
        manifestDigest: manifest.manifestDigest,
      },
      transcripts,
    };
    await expect(
      importHistory(
        app.ctx.db,
        { ...caseRow, faults: { import_failure: true } },
        caseRow.replacementAccountId,
        "import-key",
        backup,
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(
      await app.ctx.db
        .select()
        .from(providerTranscripts)
        .where(eq(providerTranscripts.accountId, caseRow.replacementAccountId)),
    ).toHaveLength(0);
  });

  it("refuses oversized artifacts instead of truncating them into passing evidence", async () => {
    const { caseRow } = await freshWorkspace();
    await expect(
      storeArtifact(app.ctx.db, caseRow.id, JSON.stringify({ editableText: "x".repeat(17 * 1024) })),
    ).rejects.toThrow(/16 KiB/);
  });
});

describe("service exit", () => {
  it("schedules Provider A's exit at the saved boundary without describing access as closed", async () => {
    const { caseRow } = await freshWorkspace();
    const boundary = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000);
    const result = await exitService(app.ctx.db, caseRow, caseRow.initialAccountId, "exit-key", boundary);
    expect(validatorFor("ServiceExitResult")(result)).toBe(true);
    expect(result).toMatchObject({ status: "SCHEDULED", accessEndsAt: boundary.toISOString() });
    expect(await getAccount(app.ctx.db, caseRow.initialAccountId)).toMatchObject({
      accessStatus: "EXIT_SCHEDULED",
      accessEndsAt: boundary.toISOString(),
    });
  });

  it("reports ENDED only when the boundary has already passed, and refuses on the timeout fault", async () => {
    const { caseRow } = await freshWorkspace();
    expect(
      (
        await exitService(
          app.ctx.db,
          caseRow,
          caseRow.initialAccountId,
          "exit-key",
          new Date(Date.now() - 1000),
        )
      ).status,
    ).toBe("ENDED");
    const second = await freshWorkspace();
    await expect(
      exitService(
        app.ctx.db,
        { ...second.caseRow, faults: { timeout: true } },
        second.caseRow.initialAccountId,
        "exit-key",
        new Date(Date.now() + 1000),
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(await getAccount(app.ctx.db, second.caseRow.initialAccountId)).toMatchObject({
      accessStatus: "ACTIVE",
      accessEndsAt: null,
    });
  });
});
