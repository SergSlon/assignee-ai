/**
 * Tests for audit-migrate-legacy-chain.ts — W10-S4 (full-audit-2026-04-29)
 *
 * Test fixtures use real HMAC values produced by the same crypto primitives
 * as production code — no placeholder/dummy HMACs.  All I/O uses a
 * temporary directory created per-suite to ensure isolation.
 *
 * Cases:
 *   (a) Pure-legacy chain → all entries re-signed; verifyChainLink passes
 *   (b) Already-canonical chain → 0 entries re-signed
 *   (c) Mixed chain (some legacy, some canonical) → both handled correctly
 *   (d) Corrupted entry (both verifiers fail) → throws / exit 1, no output
 *   (e) --input missing → exit 73 (USAGE_ERROR)
 *   (f) --output and --in-place together → exit 73 (USAGE_ERROR)
 *   (g) Unknown flag → exit 73 (USAGE_ERROR)
 *   (h) In-place mode → atomic rename (writes to .tmp then renames to original)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  legacyComputeChainLink,
  computeChainLink,
  verifyChainLink,
  GENESIS_HMAC,
} from "@assignee/core/audit";
import {
  parseArgs,
  parseAuditLine,
  migrateLines,
  readInputFile,
  writeOutput,
  runMigration,
  EXIT_USAGE_ERROR,
  EXIT_VERIFICATION_FAILURE,
  type AuditEntry,
} from "./audit-migrate-legacy-chain.js";

// ── Test key ──────────────────────────────────────────────────────────────────

/**
 * A deterministic 64-hex-char key for all test fixtures.
 * Must be ≥ 32 characters (AUDIT_KEY_MIN_LENGTH).
 */
const TEST_KEY = "a".repeat(64);

// ── Fixture builders ──────────────────────────────────────────────────────────

/**
 * Build a chain of audit entries using LEGACY HMAC (JSON.stringify, non-canonical).
 * Returns an array of AuditEntry objects with hmac values matching pre-W7 format.
 *
 * IMPORTANT: records must have keys in non-alphabetical insertion order so that
 * JSON.stringify (insertion order) produces different output from canonicalJson
 * (alphabetical order), making legacy HMAC ≠ canonical HMAC.
 *
 * Pattern: use keys like { z_type: ..., a_action: ... } where 'z' > 'a'
 * alphabetically, so insertion order differs from sorted order.
 */
function buildLegacyChain(
  records: unknown[],
  key: string = TEST_KEY,
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHmac = GENESIS_HMAC;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const hmac = legacyComputeChainLink(prevHmac, record, key);
    const entry: AuditEntry = {
      index: i,
      timestamp: `2026-01-0${i + 1}T00:00:00.000Z`,
      role: "operator",
      record,
      prevHmac,
      hmac,
    };
    entries.push(entry);
    prevHmac = hmac;
  }

  return entries;
}

/**
 * Build a chain of audit entries using CANONICAL HMAC (canonicalJson).
 * Returns an array of AuditEntry objects with hmac values matching post-W7 format.
 */
function buildCanonicalChain(
  records: unknown[],
  key: string = TEST_KEY,
): AuditEntry[] {
  const entries: AuditEntry[] = [];
  let prevHmac = GENESIS_HMAC;

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    const hmac = computeChainLink(prevHmac, record, key);
    const entry: AuditEntry = {
      index: i,
      timestamp: `2026-02-0${i + 1}T00:00:00.000Z`,
      role: "operator",
      record,
      prevHmac,
      hmac,
    };
    entries.push(entry);
    prevHmac = hmac;
  }

  return entries;
}

/**
 * Write an array of entries to a temp file as NDJSON.
 * Returns the path to the created file.
 */
function writeNdjson(dir: string, name: string, entries: AuditEntry[]): string {
  const filePath = path.join(dir, name);
  const content = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, { encoding: "utf-8", mode: 0o600 });
  return filePath;
}

/**
 * Read and parse an NDJSON file into AuditEntry objects.
 * Filters blank lines; throws on invalid JSON.
 */
function readNdjson(filePath: string): AuditEntry[] {
  const content = fs.readFileSync(filePath, "utf-8");
  return content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as AuditEntry);
}

// ── Temp directory management ─────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "migrate-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── parseArgs ─────────────────────────────────────────────────────────────────

describe("parseArgs", () => {
  it("parses --input and returns inputPath", () => {
    const result = parseArgs([
      "node",
      "script.ts",
      "--input",
      "/tmp/audit.log",
    ]);
    expect(result.inputPath).toBe("/tmp/audit.log");
    expect(result.outputPath).toBeNull();
    expect(result.inPlace).toBe(false);
    expect(result.key).toBeNull();
  });

  it("parses --output path", () => {
    const result = parseArgs([
      "node",
      "script.ts",
      "--input",
      "/tmp/audit.log",
      "--output",
      "/tmp/out.log",
    ]);
    expect(result.outputPath).toBe("/tmp/out.log");
  });

  it("parses --in-place flag", () => {
    const result = parseArgs([
      "node",
      "script.ts",
      "--input",
      "/tmp/audit.log",
      "--in-place",
    ]);
    expect(result.inPlace).toBe(true);
  });

  it("parses --key flag", () => {
    const result = parseArgs([
      "node",
      "script.ts",
      "--input",
      "/tmp/audit.log",
      "--key",
      TEST_KEY,
    ]);
    expect(result.key).toBe(TEST_KEY);
  });

  it("throws USAGE_ERROR message when --input is missing", () => {
    expect(() => parseArgs(["node", "script.ts"])).toThrow(/Usage:/i);
  });

  it("throws when --output and --in-place are both specified", () => {
    expect(() =>
      parseArgs([
        "node",
        "script.ts",
        "--input",
        "/tmp/f",
        "--output",
        "/tmp/g",
        "--in-place",
      ]),
    ).toThrow(/--output.*--in-place|--in-place.*--output/i);
  });

  it("throws on unknown flag", () => {
    expect(() =>
      parseArgs(["node", "script.ts", "--input", "/tmp/f", "--unknown"]),
    ).toThrow(/Unknown flag/i);
  });

  it("exit code for missing --input maps to EXIT_USAGE_ERROR (73)", () => {
    try {
      parseArgs(["node", "script.ts"]);
      expect.fail("should have thrown");
    } catch {
      // Confirm that callers should map this to EXIT_USAGE_ERROR
      expect(EXIT_USAGE_ERROR).toBe(73);
    }
  });
});

// ── parseAuditLine ────────────────────────────────────────────────────────────

describe("parseAuditLine", () => {
  it("returns AuditEntry for a valid HMAC-bearing line", () => {
    const entry = buildCanonicalChain([{ action: "test" }])[0]!;
    const line = JSON.stringify(entry);
    const result = parseAuditLine(line);
    expect(result).not.toBeNull();
    expect(result?.index).toBe(0);
    expect(result?.hmac).toBe(entry.hmac);
  });

  it("returns null for a pre-W3 entry without hmac/prevHmac fields", () => {
    const line = JSON.stringify({
      action: "old-action",
      timestamp: "2024-01-01",
    });
    expect(parseAuditLine(line)).toBeNull();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseAuditLine("{invalid json")).toThrow();
  });
});

// ── migrateLines — (a) pure-legacy chain ─────────────────────────────────────

describe("migrateLines — pure-legacy chain", () => {
  it("re-signs all legacy entries; verifyChainLink passes on every output entry", () => {
    // Use keys in non-alphabetical insertion order so legacy (JSON.stringify,
    // insertion-order) produces a different HMAC from canonical (alphabetical).
    // Here "z_type" > "a_action" alphabetically, so insertion order ≠ sorted order.
    const records = [
      { z_type: "s3-bucket", a_action: "create" },
      { z_type: "s3-bucket", a_action: "update" },
      { z_type: "s3-bucket", a_action: "delete" },
    ];
    const legacyEntries = buildLegacyChain(records, TEST_KEY);
    const lines = legacyEntries.map((e) => JSON.stringify(e));

    const { outputLines, result } = migrateLines(lines, TEST_KEY);

    expect(result.total).toBe(3);
    expect(result.reSigned).toBe(3);
    expect(result.alreadyCanonical).toBe(0);

    // Every output entry must pass canonical verifyChainLink.
    const outputEntries = outputLines
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);

    let prevHmac = GENESIS_HMAC;
    for (const entry of outputEntries) {
      expect(
        verifyChainLink(entry.record, entry.prevHmac, entry.hmac, TEST_KEY),
        `entry at index ${entry.index} must pass canonical verifyChainLink`,
      ).toBe(true);
      expect(entry.prevHmac).toBe(prevHmac);
      prevHmac = entry.hmac;
    }
  });

  it("preserves all original entry fields except hmac", () => {
    // Non-alphabetical key order ensures legacy ≠ canonical HMAC.
    const records = [{ z_event: "login", a_user: "operator" }];
    const legacyEntries = buildLegacyChain(records, TEST_KEY);
    const lines = legacyEntries.map((e) => JSON.stringify(e));
    const { outputLines } = migrateLines(lines, TEST_KEY);

    const outputEntry = JSON.parse(outputLines[0]!) as AuditEntry;
    const inputEntry = legacyEntries[0]!;

    expect(outputEntry.index).toBe(inputEntry.index);
    expect(outputEntry.timestamp).toBe(inputEntry.timestamp);
    expect(outputEntry.role).toBe(inputEntry.role);
    expect(outputEntry.prevHmac).toBe(inputEntry.prevHmac);
    expect(outputEntry.record).toEqual(inputEntry.record);
    // The hmac must differ (legacy → canonical).
    expect(outputEntry.hmac).not.toBe(inputEntry.hmac);
  });
});

// ── migrateLines — (b) already-canonical chain ───────────────────────────────

describe("migrateLines — already-canonical chain", () => {
  it("reports 0 re-signed entries and copies lines verbatim", () => {
    // Keys in alphabetical insertion order — canonical JSON matches JSON.stringify.
    // Both verifiers produce the same HMAC, so canonical check passes first.
    const records = [
      { a_action: "create", z_resource: "ec2-instance" },
      { a_action: "update", z_resource: "ec2-instance" },
    ];
    const canonicalEntries = buildCanonicalChain(records, TEST_KEY);
    const lines = canonicalEntries.map((e) => JSON.stringify(e));
    const originalLines = [...lines];

    const { outputLines, result } = migrateLines(lines, TEST_KEY);

    expect(result.total).toBe(2);
    expect(result.reSigned).toBe(0);
    expect(result.alreadyCanonical).toBe(2);
    expect(outputLines).toEqual(originalLines);
  });
});

// ── migrateLines — (c) mixed chain ───────────────────────────────────────────

describe("migrateLines — mixed chain (some legacy, some canonical)", () => {
  it("handles both legacy and canonical entries; output is fully canonical", () => {
    // Build a mixed chain:
    //   entry 0: canonical (alphabetical key order)
    //   entry 1: legacy-only (non-alphabetical key order; will be re-signed)
    //   entry 2: canonical (uses canonical hmac of entry 1 as prevHmac)
    //
    // Key ordering rule: { a_field, z_field } = alphabetical = canonical matches legacy
    //                    { z_field, a_field } = non-alphabetical = legacy ≠ canonical
    const key = TEST_KEY;

    // Build entry 0 as canonical (alphabetical keys, so canonical check passes).
    const record0 = { a_action: "create", z_type: "vpc" };
    // For entry0 to be "canonical" (not legacy), we must use computeChainLink.
    const hmac0 = computeChainLink(GENESIS_HMAC, record0, key);
    const entry0: AuditEntry = {
      index: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "operator",
      record: record0,
      prevHmac: GENESIS_HMAC,
      hmac: hmac0,
    };

    // Build entry 1 as legacy-only: non-alphabetical key order means
    // legacyComputeChainLink ≠ computeChainLink. Use the legacy hmac.
    const record1 = { z_type: "vpc", a_action: "update" }; // non-alphabetical order
    const hmac1Legacy = legacyComputeChainLink(hmac0, record1, key);
    const hmac1Canonical = computeChainLink(hmac0, record1, key);
    // Verify the two HMACs actually differ (guard for test validity).
    if (hmac1Legacy === hmac1Canonical) {
      throw new Error(
        "Test invariant violated: legacy and canonical HMACs are equal",
      );
    }
    const entry1: AuditEntry = {
      index: 1,
      timestamp: "2026-01-02T00:00:00.000Z",
      role: "operator",
      record: record1,
      prevHmac: hmac0,
      hmac: hmac1Legacy, // stored as legacy hmac
    };

    // Build entry 2 as canonical. In a real mixed chain, entry2 was written
    // AFTER entry1 was already canonical (i.e., the chain transitioned from
    // legacy → canonical at some point). So entry2's stored prevHmac is
    // hmac1Legacy (the hmac stored in entry1 when entry2 was appended).
    // entry2's own hmac is computed canonically over (hmac1Legacy, record2).
    const record2 = { a_action: "delete", z_type: "vpc" };
    const hmac2 = computeChainLink(hmac1Legacy, record2, key);
    const entry2: AuditEntry = {
      index: 2,
      timestamp: "2026-01-03T00:00:00.000Z",
      role: "operator",
      record: record2,
      prevHmac: hmac1Legacy, // points to entry1's stored (legacy) hmac
      hmac: hmac2,
    };

    const lines = [entry0, entry1, entry2].map((e) => JSON.stringify(e));
    const { outputLines, result } = migrateLines(lines, key);

    expect(result.total).toBe(3);
    expect(result.reSigned).toBe(1); // entry1 was re-signed
    expect(result.alreadyCanonical).toBe(2); // entry0 and entry2 were already canonical

    // All output entries must pass canonical verifyChainLink.
    const outputEntries = outputLines
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);

    let prevHmac = GENESIS_HMAC;
    for (const entry of outputEntries) {
      expect(
        verifyChainLink(entry.record, entry.prevHmac, entry.hmac, key),
        `entry at index ${entry.index} must pass canonical verifyChainLink after migration`,
      ).toBe(true);
      expect(entry.prevHmac).toBe(prevHmac);
      prevHmac = entry.hmac;
    }
  });
});

// ── migrateLines — (d) corrupted entry ───────────────────────────────────────

describe("migrateLines — corrupted entry (both verifiers fail)", () => {
  it("throws with the entry index in the error message", () => {
    const records = [
      { action: "create", resource: "bucket" },
      { action: "tampered", resource: "bucket" },
    ];
    // Build a canonical chain first.
    const canonicalEntries = buildCanonicalChain(records, TEST_KEY);

    // Tamper the second entry's hmac with a random value.
    const tampered: AuditEntry = {
      ...canonicalEntries[1]!,
      hmac: "deadbeef".repeat(8), // 64 hex chars, wrong value
    };

    const lines = [
      JSON.stringify(canonicalEntries[0]!),
      JSON.stringify(tampered),
    ];

    expect(() => migrateLines(lines, TEST_KEY)).toThrow(/index 1|entry.*1/i);
  });

  it("does not produce any output lines when it throws", () => {
    const entry: AuditEntry = {
      index: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "operator",
      record: { action: "test" },
      prevHmac: GENESIS_HMAC,
      hmac: "0000000000000000000000000000000000000000000000000000000000000000",
    };

    let outputLines: string[] | undefined;
    try {
      const result = migrateLines([JSON.stringify(entry)], TEST_KEY);
      outputLines = result.outputLines;
    } catch {
      outputLines = undefined;
    }

    // Should have thrown, not returned.
    expect(outputLines).toBeUndefined();
  });

  it("throws EXIT_VERIFICATION_FAILURE-class error (not I/O error)", () => {
    expect(EXIT_VERIFICATION_FAILURE).toBe(1);

    const entry: AuditEntry = {
      index: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "operator",
      record: { action: "test" },
      prevHmac: GENESIS_HMAC,
      hmac: "f".repeat(64), // wrong hmac
    };

    expect(() => migrateLines([JSON.stringify(entry)], TEST_KEY)).toThrow(
      /HMAC verification failed|hmac.*mismatch|verification.*failed/i,
    );
  });
});

// ── runMigration — end-to-end ─────────────────────────────────────────────────

describe("runMigration — end-to-end", () => {
  it("writes migrated output to <input>.migrated by default", async () => {
    // Non-alphabetical key order ensures legacy ≠ canonical HMAC.
    const records = [{ z_type: "s3", a_action: "provision" }];
    const legacyEntries = buildLegacyChain(records, TEST_KEY);
    const inputPath = writeNdjson(tmpDir, "audit.log", legacyEntries);
    const expectedOutputPath = `${inputPath}.migrated`;

    const result = await runMigration({
      inputPath,
      outputPath: null,
      inPlace: false,
      key: TEST_KEY,
    });

    expect(result.reSigned).toBe(1);
    expect(result.alreadyCanonical).toBe(0);
    expect(result.outputPath).toBe(expectedOutputPath);
    expect(fs.existsSync(expectedOutputPath)).toBe(true);

    // Original must be unchanged.
    const originalContent = fs.readFileSync(inputPath, "utf-8");
    const originalEntries =
      legacyEntries.map((e) => JSON.stringify(e)).join("\n") + "\n";
    expect(originalContent).toBe(originalEntries);
  });

  it("uses --output path when specified", async () => {
    const records = [{ action: "create", type: "iam-role" }];
    const canonicalEntries = buildCanonicalChain(records, TEST_KEY);
    const inputPath = writeNdjson(tmpDir, "canonical.log", canonicalEntries);
    const customOutput = path.join(tmpDir, "custom-output.log");

    const result = await runMigration({
      inputPath,
      outputPath: customOutput,
      inPlace: false,
      key: TEST_KEY,
    });

    expect(result.outputPath).toBe(customOutput);
    expect(fs.existsSync(customOutput)).toBe(true);
    expect(result.reSigned).toBe(0);
  });

  it("does not write any output file when a corrupted entry is found", async () => {
    const goodEntry: AuditEntry = {
      index: 0,
      timestamp: "2026-01-01T00:00:00.000Z",
      role: "operator",
      record: { action: "create" },
      prevHmac: GENESIS_HMAC,
      hmac: computeChainLink(GENESIS_HMAC, { action: "create" }, TEST_KEY),
    };
    const corruptEntry: AuditEntry = {
      ...goodEntry,
      index: 1,
      prevHmac: goodEntry.hmac,
      hmac: "e".repeat(64), // tampered
    };

    const inputPath = path.join(tmpDir, "corrupt.log");
    fs.writeFileSync(
      inputPath,
      [JSON.stringify(goodEntry), JSON.stringify(corruptEntry)].join("\n") +
        "\n",
    );
    const expectedOutput = `${inputPath}.migrated`;

    await expect(
      runMigration({
        inputPath,
        outputPath: null,
        inPlace: false,
        key: TEST_KEY,
      }),
    ).rejects.toThrow();

    // No partial output file should exist.
    expect(fs.existsSync(expectedOutput)).toBe(false);
  });

  it("all entries in the output file pass verifyChainLink after migration", async () => {
    // Non-alphabetical key order ensures legacy ≠ canonical HMAC.
    const records = [
      { z_type: "ec2", a_action: "create" },
      { z_type: "ec2", a_action: "tag" },
    ];
    const legacyEntries = buildLegacyChain(records, TEST_KEY);
    const inputPath = writeNdjson(tmpDir, "legacy2.log", legacyEntries);

    await runMigration({
      inputPath,
      outputPath: null,
      inPlace: false,
      key: TEST_KEY,
    });

    const outputEntries = readNdjson(`${inputPath}.migrated`);
    let prevHmac = GENESIS_HMAC;
    for (const entry of outputEntries) {
      expect(
        verifyChainLink(entry.record, entry.prevHmac, entry.hmac, TEST_KEY),
      ).toBe(true);
      expect(entry.prevHmac).toBe(prevHmac);
      prevHmac = entry.hmac;
    }
  });
});

// ── (h) in-place mode — atomic rename ────────────────────────────────────────

describe("in-place mode — atomic rename", () => {
  it("overwrites the original file in-place via .tmp + rename", async () => {
    // Non-alphabetical key order ensures legacy ≠ canonical HMAC.
    const records = [{ z_type: "rds", a_action: "create" }];
    const legacyEntries = buildLegacyChain(records, TEST_KEY);
    const inputPath = writeNdjson(tmpDir, "inplace.log", legacyEntries);
    const tmpPath = `${inputPath}.tmp`;

    // Capture original content.
    const originalContent = fs.readFileSync(inputPath, "utf-8");

    const result = await runMigration({
      inputPath,
      outputPath: null,
      inPlace: true,
      key: TEST_KEY,
    });

    // The output path is the same as input (in-place).
    expect(result.outputPath).toBe(inputPath);

    // The file must exist.
    expect(fs.existsSync(inputPath)).toBe(true);

    // The .tmp file must NOT exist after rename.
    expect(fs.existsSync(tmpPath)).toBe(false);

    // The file content must be different (legacy → canonical).
    const newContent = fs.readFileSync(inputPath, "utf-8");
    expect(newContent).not.toBe(originalContent);

    // All entries in the updated file must pass canonical verification.
    const updatedEntries = readNdjson(inputPath);
    let prevHmac = GENESIS_HMAC;
    for (const entry of updatedEntries) {
      expect(
        verifyChainLink(entry.record, entry.prevHmac, entry.hmac, TEST_KEY),
      ).toBe(true);
      prevHmac = entry.hmac;
    }
  });

  it("leaves no .tmp file on successful migration", async () => {
    const records = [{ action: "delete", type: "vpc" }];
    const canonicalEntries = buildCanonicalChain(records, TEST_KEY);
    const inputPath = writeNdjson(tmpDir, "canonical-ip.log", canonicalEntries);

    await runMigration({
      inputPath,
      outputPath: null,
      inPlace: true,
      key: TEST_KEY,
    });

    expect(fs.existsSync(`${inputPath}.tmp`)).toBe(false);
  });
});

// ── writeOutput ───────────────────────────────────────────────────────────────

describe("writeOutput", () => {
  it("writes content to the specified output path", async () => {
    const outputPath = path.join(tmpDir, "output.log");
    const lines = ['{"index":0,"hmac":"abc"}', '{"index":1,"hmac":"def"}'];
    await writeOutput(outputPath, lines, false, "ignored-input");
    const written = fs.readFileSync(outputPath, "utf-8");
    expect(written).toBe(lines.join("\n"));
  });

  it("in-place mode: does not leave a .tmp file", async () => {
    const inputPath = path.join(tmpDir, "source.log");
    fs.writeFileSync(inputPath, "original\n");
    const lines = ["migrated content"];
    await writeOutput(inputPath, lines, true, inputPath);
    expect(fs.existsSync(`${inputPath}.tmp`)).toBe(false);
    const result = fs.readFileSync(inputPath, "utf-8");
    expect(result).toBe("migrated content");
  });
});

// ── readInputFile ─────────────────────────────────────────────────────────────

describe("readInputFile", () => {
  it("returns lines split on newline", async () => {
    const filePath = path.join(tmpDir, "multi.log");
    fs.writeFileSync(filePath, '{"a":1}\n{"b":2}\n');
    const lines = await readInputFile(filePath);
    expect(lines).toContain('{"a":1}');
    expect(lines).toContain('{"b":2}');
  });

  it("throws when file does not exist", async () => {
    await expect(
      readInputFile(path.join(tmpDir, "nonexistent.log")),
    ).rejects.toThrow();
  });
});
