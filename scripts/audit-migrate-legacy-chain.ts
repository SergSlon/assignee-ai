/**
 * audit-migrate-legacy-chain.ts — W10-S4 (full-audit-2026-04-29)
 *
 * Migration utility for pre-W7 audit logs that used `JSON.stringify`
 * (non-canonical) for HMAC computation.  Walks an NDJSON audit-log file,
 * re-signs every legacy entry with `computeChainLink` (canonical HMAC), and
 * writes the fully-migrated log to a new file.  The original file is never
 * modified.
 *
 * Usage:
 *   npx tsx scripts/audit-migrate-legacy-chain.ts --input <path>
 *   npx tsx scripts/audit-migrate-legacy-chain.ts --input <path> --output <path>
 *   npx tsx scripts/audit-migrate-legacy-chain.ts --input <path> --in-place
 *   npx tsx scripts/audit-migrate-legacy-chain.ts --input <path> --key <hex>
 *
 * Exit codes:
 *   0  — migration succeeded (all entries verified and written)
 *   1  — verification failure (corrupted entry; no output written)
 *   2  — file I/O error (cannot read input or write output)
 *   73 — usage error (bad CLI arguments)
 *
 * Invariants:
 *   - Imports HMAC primitives from @assignee/core/audit; no re-implementation.
 *   - Default output is `<input>.migrated` (never overwrites the original).
 *   - --in-place writes atomically via .tmp + rename.
 *   - Partial success is NOT acceptable: on any corruption, exit 1 with no output.
 *   - Does NOT call appendAuditRecord or any audit-log write path.
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as url from "node:url";
import {
  legacyVerifyChainLink,
  verifyChainLink,
  computeChainLink,
  getAuditKey,
  GENESIS_HMAC,
} from "@assignee/core/audit";

// ── Exit code constants ───────────────────────────────────────────────────────

export const EXIT_SUCCESS = 0;
export const EXIT_VERIFICATION_FAILURE = 1;
export const EXIT_IO_ERROR = 2;
export const EXIT_USAGE_ERROR = 73;

// ── Types ─────────────────────────────────────────────────────────────────────

/** A well-formed HMAC-bearing audit-log entry (must match AuditEntry in core). */
export interface AuditEntry {
  index: number;
  timestamp: string;
  role: string;
  record: unknown;
  prevHmac: string;
  hmac: string;
}

export interface MigrateResult {
  /** Total HMAC-bearing entries processed. */
  total: number;
  /** Entries that were re-signed (were legacy HMAC). */
  reSigned: number;
  /** Entries that were already canonical (kept as-is). */
  alreadyCanonical: number;
  /** Path the migrated log was written to. */
  outputPath: string;
}

export interface ParsedArgs {
  inputPath: string;
  outputPath: string | null;
  inPlace: boolean;
  key: string | null;
}

// ── CLI arg parsing ───────────────────────────────────────────────────────────

/**
 * Parse CLI arguments from process.argv (or a provided array for testing).
 *
 * Returns a `ParsedArgs` on success, or throws with a message when the
 * arguments are invalid.  The caller maps thrown errors to exit code 73.
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  // Strip the first two entries (node + script path) when present.
  const args = argv.slice(
    argv[0]?.endsWith("node") || argv[0]?.endsWith("tsx") ? 2 : 0,
  );

  let inputPath: string | null = null;
  let outputPath: string | null = null;
  let inPlace = false;
  let key: string | null = null;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "--input" || arg === "-i") {
      i++;
      if (i >= args.length || args[i]?.startsWith("-")) {
        throw new Error("--input requires a path argument");
      }
      inputPath = args[i] ?? null;
    } else if (arg === "--output" || arg === "-o") {
      i++;
      if (i >= args.length || args[i]?.startsWith("-")) {
        throw new Error("--output requires a path argument");
      }
      outputPath = args[i] ?? null;
    } else if (arg === "--in-place") {
      inPlace = true;
    } else if (arg === "--key") {
      i++;
      if (i >= args.length || args[i]?.startsWith("-")) {
        throw new Error("--key requires a hex string argument");
      }
      key = args[i] ?? null;
    } else if (arg !== undefined && !arg.startsWith("-")) {
      // positional — ignore for now
    } else if (arg !== undefined && arg.startsWith("-")) {
      throw new Error(`Unknown flag: ${arg}`);
    }
    i++;
  }

  if (!inputPath) {
    throw new Error(
      "Usage: audit-migrate-legacy-chain.ts --input <path> [--output <path> | --in-place] [--key <hex>]",
    );
  }

  if (outputPath && inPlace) {
    throw new Error("Cannot specify both --output and --in-place");
  }

  return { inputPath, outputPath, inPlace, key };
}

// ── Core migration logic ──────────────────────────────────────────────────────

/**
 * Parse a single NDJSON line into an AuditEntry.
 * Returns null when the line does not carry HMAC fields (pre-W3 preLegacy entry).
 * Throws when the line is not valid JSON.
 */
export function parseAuditLine(line: string): AuditEntry | null {
  const parsed: unknown = JSON.parse(line);
  if (
    parsed !== null &&
    typeof parsed === "object" &&
    "hmac" in parsed &&
    "prevHmac" in parsed &&
    "index" in parsed &&
    "record" in parsed
  ) {
    return parsed as AuditEntry;
  }
  // Pre-W3 entry without HMAC fields — not migratable via this path.
  return null;
}

/**
 * Migrate a list of raw NDJSON lines.
 *
 * For each HMAC-bearing entry:
 *   1. Try canonical verification first (verifyChainLink).
 *   2. If canonical passes → keep entry as-is (already canonical).
 *   3. If canonical fails but legacy passes → re-sign with computeChainLink.
 *   4. If both fail → return an error (tampered entry).
 *
 * Pre-W3 entries (no HMAC fields) are passed through unchanged.
 *
 * @returns MigrateResult on success, or throws with an error object that
 *          includes an `entryIndex` field so the caller can emit a targeted
 *          error message.
 */
export function migrateLines(
  lines: string[],
  key: string,
): { outputLines: string[]; result: Omit<MigrateResult, "outputPath"> } {
  const outputLines: string[] = [];
  let reSigned = 0;
  let alreadyCanonical = 0;
  let expectedIndex = 0;
  let totalHmacEntries = 0;

  // Two-pointer prevHmac tracking:
  //
  // A pre-W7 (legacy) chain stores each entry's `prevHmac` as the *legacy*
  // HMAC of the preceding entry (JSON.stringify, non-canonical).  When we
  // re-sign an entry with the canonical HMAC, the following entry's stored
  // `prevHmac` still references the OLD (legacy) hmac — it was written before
  // migration.  To validate the input chain without corruption errors, we must
  // track two independent cursors:
  //
  //   oldExpectedPrev — the HMAC value the NEXT entry's `prevHmac` field should
  //                     hold in the ORIGINAL log (advances to entry.hmac after
  //                     each entry, which may be a legacy or canonical HMAC).
  //
  //   newCanonicalPrev — the canonical HMAC we will write as `prevHmac` in the
  //                      NEXT output entry.  Starts at GENESIS_HMAC and is
  //                      advanced to the canonical HMAC we emit for each entry.
  //
  // For entries that are already canonical AND whose prevHmac already equals
  // newCanonicalPrev (i.e. the preceding entry was also canonical), the entry
  // can be copied verbatim.  If a preceding entry was re-signed, the following
  // entry's prevHmac must be updated to the new canonical value, and its own
  // HMAC must be recomputed — even if the entry was originally canonical.
  //
  // Counter semantics:
  //   reSigned        — entries whose stored HMAC was LEGACY (failed canonical,
  //                     passed legacy; needed a full re-sign).
  //   alreadyCanonical — entries whose stored HMAC was already CANONICAL
  //                      (passed canonical verify); prevHmac may still be
  //                      updated if a preceding entry was re-signed.
  let oldExpectedPrev = GENESIS_HMAC;
  let newCanonicalPrev = GENESIS_HMAC;

  for (const line of lines) {
    if (!line.trim()) continue;

    let entry: AuditEntry | null;
    try {
      entry = parseAuditLine(line);
    } catch {
      // Unparseable JSON — treat as corrupted.
      const err: Error & { entryIndex?: number } = new Error(
        `Invalid JSON at line ${outputLines.length + 1}: ${line.slice(0, 80)}`,
      );
      err.entryIndex = outputLines.length;
      throw err;
    }

    if (entry === null) {
      // Pre-W3 entry: pass through unchanged.
      outputLines.push(line);
      continue;
    }

    totalHmacEntries++;

    // Validate index monotonicity (cheap; no crypto work).
    if (entry.index !== expectedIndex) {
      const err: Error & { entryIndex?: number } = new Error(
        `Index gap at entry ${entry.index}: expected index ${expectedIndex}`,
      );
      err.entryIndex = entry.index;
      throw err;
    }

    // Validate prevHmac linkage against the original chain sequence.
    // On a pure-legacy chain this is the legacy HMAC of the prior entry;
    // on an already-canonical chain it is the canonical HMAC.
    if (entry.prevHmac !== oldExpectedPrev) {
      const err: Error & { entryIndex?: number } = new Error(
        `prevHmac mismatch at entry ${entry.index}: chain linkage broken`,
      );
      err.entryIndex = entry.index;
      throw err;
    }

    // Classify the entry's HMAC as canonical or legacy.
    // Canonical verification uses the entry's stored prevHmac (which may be a
    // legacy HMAC); it checks whether HMAC-SHA256(prevHmac|canonicalJson(record))
    // matches entry.hmac.
    const canonicalValid = verifyChainLink(
      entry.record,
      entry.prevHmac,
      entry.hmac,
      key,
    );

    // isLegacy: entry failed canonical but passed legacy — must be re-signed.
    let isLegacy = false;

    if (!canonicalValid) {
      // Canonical check failed — try legacy (JSON.stringify prevHmac).
      const legacyValid = legacyVerifyChainLink(
        entry.record,
        entry.prevHmac,
        entry.hmac,
        key,
      );

      if (!legacyValid) {
        // Both verifiers failed → corrupted / tampered entry.
        const err: Error & { entryIndex?: number } = new Error(
          `HMAC verification failed for entry at index ${entry.index}: ` +
            `neither canonical nor legacy HMAC matches (entry may be tampered)`,
        );
        err.entryIndex = entry.index;
        throw err;
      }

      isLegacy = true;
      reSigned++;
    } else {
      alreadyCanonical++;
    }

    // Compute the canonical HMAC for the output entry using newCanonicalPrev.
    //
    // This is ALWAYS recomputed from newCanonicalPrev because:
    //   - Legacy entries: their stored HMAC used legacyJson(record) over
    //     entry.prevHmac (the OLD legacy prev), so must be re-signed.
    //   - Canonical entries whose preceding entry was re-signed: their stored
    //     HMAC used the OLD (legacy) prevHmac — the canonical HMAC itself is
    //     correct (canonicalJson was used) but over the wrong prevHmac value.
    //     We must recompute over newCanonicalPrev to keep the chain valid.
    //   - Canonical entries where nothing changed: newCanonicalPrev equals the
    //     stored entry.prevHmac, so recomputing gives the same result as the
    //     stored hmac (verbatim copy optimisation below).
    //
    // The verbatim-copy path avoids re-emitting unchanged entries.
    const outputPrevHmac = newCanonicalPrev;
    const outputHmac = computeChainLink(outputPrevHmac, entry.record, key);

    // Emit the output entry.
    if (
      !isLegacy &&
      entry.prevHmac === outputPrevHmac &&
      entry.hmac === outputHmac
    ) {
      // Verbatim copy: entry was canonical AND prevHmac is already up-to-date.
      // (outputHmac === entry.hmac because entry was canonical over the same prevHmac)
      outputLines.push(line);
    } else {
      // Rewrite the entry with updated prevHmac and/or hmac.
      const outputEntry: AuditEntry = {
        ...entry,
        prevHmac: outputPrevHmac,
        hmac: outputHmac,
      };
      outputLines.push(JSON.stringify(outputEntry));
    }

    oldExpectedPrev = entry.hmac; // advance original-chain cursor (to stored/original hmac)
    newCanonicalPrev = outputHmac; // advance canonical cursor (to the emitted canonical hmac)
    expectedIndex++;
  }

  return {
    outputLines,
    result: {
      total: totalHmacEntries,
      reSigned,
      alreadyCanonical,
    },
  };
}

// ── File I/O ──────────────────────────────────────────────────────────────────

/**
 * Read the input file and return its lines (split on newline, trailing empty
 * line filtered out).
 */
export async function readInputFile(inputPath: string): Promise<string[]> {
  const content = await fsPromises.readFile(inputPath, "utf-8");
  return content.split("\n");
}

/**
 * Write migrated output to disk.
 *
 * - If `inPlace` is true: write to `<inputPath>.tmp` then rename atomically.
 * - Otherwise: write directly to `outputPath`.
 */
export async function writeOutput(
  outputPath: string,
  outputLines: string[],
  inPlace: boolean,
  inputPath: string,
): Promise<void> {
  const content = outputLines.join("\n");

  if (inPlace) {
    const tmpPath = `${inputPath}.tmp`;
    await fsPromises.writeFile(tmpPath, content, {
      encoding: "utf-8",
      mode: 0o600,
    });
    await fsPromises.rename(tmpPath, outputPath);
  } else {
    await fsPromises.writeFile(outputPath, content, {
      encoding: "utf-8",
      mode: 0o600,
    });
  }
}

// ── Main migration orchestrator ───────────────────────────────────────────────

/**
 * Run the full migration: parse args, read input, migrate, write output.
 *
 * Exported for use in tests.  All I/O errors are caught and converted to
 * `process.exit(EXIT_IO_ERROR)` calls internally only when running as main.
 * In test context, callers catch thrown errors.
 */
export async function runMigration(args: ParsedArgs): Promise<MigrateResult> {
  const { inputPath, inPlace } = args;

  // Resolve the key.
  let key: string;
  if (args.key) {
    key = args.key;
  } else {
    // getAuditKey() reads ASSIGNEE_AUDIT_KEY or generates a per-process key.
    key = getAuditKey();
  }

  // Determine the output path.
  const outputPath =
    args.outputPath ?? (inPlace ? inputPath : `${inputPath}.migrated`);

  // Read input.
  const lines = await readInputFile(inputPath);

  // Migrate (may throw on corruption).
  const { outputLines, result } = migrateLines(lines, key);

  // Write output.
  await writeOutput(outputPath, outputLines, inPlace, inputPath);

  return { ...result, outputPath };
}

// ── CLI entry point ───────────────────────────────────────────────────────────

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) ===
    path.resolve(url.fileURLToPath(import.meta.url));

if (isMain) {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`audit-migrate-legacy-chain: ${msg}\n`);
    process.exit(EXIT_USAGE_ERROR);
  }

  runMigration(args)
    .then((result) => {
      process.stdout.write(
        `${result.reSigned} entries re-signed, ` +
          `${result.alreadyCanonical} entries already canonical, ` +
          `output: ${result.outputPath}\n`,
      );
      process.exit(EXIT_SUCCESS);
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      // Determine exit code: verification errors vs I/O errors.
      const isIoError =
        err instanceof Error &&
        "code" in err &&
        typeof (err as NodeJS.ErrnoException).code === "string" &&
        ["ENOENT", "EACCES", "EISDIR", "EPERM", "ENOTDIR"].includes(
          (err as NodeJS.ErrnoException).code ?? "",
        );

      if (isIoError) {
        process.stderr.write(`audit-migrate-legacy-chain: I/O error: ${msg}\n`);
        process.exit(EXIT_IO_ERROR);
      } else {
        process.stderr.write(`audit-migrate-legacy-chain: error: ${msg}\n`);
        process.exit(EXIT_VERIFICATION_FAILURE);
      }
    });
}
