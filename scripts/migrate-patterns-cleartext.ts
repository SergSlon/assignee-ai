#!/usr/bin/env tsx
/**
 * W1-01 (Epic 100): migrate-patterns-cleartext.ts
 *
 * Idempotent scrubbing of the user's ~/.assignee/memory/patterns.json
 * historical record. Removes cleartext credential values that were written
 * before W1-01 introduced stripSensitiveFromElicited() at every write
 * boundary.
 *
 * Safety guarantees:
 *   - Dry-run by default: prints what WOULD be changed, writes nothing.
 *   - Backs up the original file to patterns.json.bak before any mutation.
 *   - Idempotent: running twice on an already-scrubbed file is a no-op.
 *   - No-op on missing file (exits 0 with a message).
 *   - Does NOT require live filesystem state to typecheck/build.
 *
 * Usage:
 *   npx tsx scripts/migrate-patterns-cleartext.ts             # dry-run
 *   npx tsx scripts/migrate-patterns-cleartext.ts --apply     # scrub + backup
 *   npx tsx scripts/migrate-patterns-cleartext.ts --file /path/to/patterns.json --apply
 *
 * Exit 0 — success (dry-run shows changes OR apply completed OR file absent)
 * Exit 1 — fatal error (parse failure, I/O error)
 *
 * @see scripts/audit-patterns-cleartext.ts — audit companion (CI gate)
 * @see packages/core/src/utils/redact.ts — stripSensitiveFromElicited
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";
import * as os from "os";
import { join } from "path";

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Allowlist of CFN property names that carry credential material.
 * Mirrors SENSITIVE_KEY_NAMES from checkpoint/redaction.ts and
 * SENSITIVE_KEY_ALLOWLIST from audit-patterns-cleartext.ts.
 */
const SENSITIVE_KEY_ALLOWLIST: ReadonlySet<string> = new Set([
  // RDS / DocDB / DAX / Workspaces master credentials
  "MasterUserPassword",
  "MasterPassword",
  "AdminPassword",
  "DefaultPassword",
  "DefaultUserPassword",
  // Generic top-level password
  "Password",
  // Secrets Manager secret payload
  "SecretString",
  // IAM AccessKey / STS session credentials
  "SecretAccessKey",
  "SessionToken",
  // Certificate Manager / Key Pair private key material
  "PrivateKey",
  "PrivateKeyPassphrase",
  "RSAPrivateKey",
  // EKS / cluster bootstrap tokens
  "BootstrapToken",
  // EventBridge Connection auth credentials (W1-01 annotation)
  "AuthParameters",
]);

/** Sentinel value written by stripSensitiveFromElicited(). */
const REDACTED_SENTINEL = "[REDACTED]";

/** AWS access key ID pattern — defense-in-depth value scan. */
const AKIA_PATTERN = /A[KS]IA[0-9A-Z]{16}/g;

// ── Types ─────────────────────────────────────────────────────────────────────

interface PatternRecord {
  pattern: string;
  optionsSelected?: Record<string, unknown>;
  [key: string]: unknown;
}

interface ScrubResult {
  record: PatternRecord;
  fieldsRedacted: string[];
}

// ── Scrubbing logic ───────────────────────────────────────────────────────────

function scrubRecord(record: PatternRecord): ScrubResult {
  const opts = record.optionsSelected;
  if (!opts || typeof opts !== "object") {
    return { record, fieldsRedacted: [] };
  }

  const scrubbedOpts: Record<string, unknown> = {};
  const fieldsRedacted: string[] = [];

  for (const [key, value] of Object.entries(opts)) {
    // Condition 1: sensitive key with a non-redacted string value
    if (
      SENSITIVE_KEY_ALLOWLIST.has(key) &&
      typeof value === "string" &&
      value !== REDACTED_SENTINEL
    ) {
      scrubbedOpts[key] = REDACTED_SENTINEL;
      fieldsRedacted.push(key);
      continue;
    }

    // Condition 2: defense-in-depth — AKIA/ASIA pattern in any string value
    if (typeof value === "string" && AKIA_PATTERN.test(value)) {
      AKIA_PATTERN.lastIndex = 0; // reset stateful regex
      scrubbedOpts[key] = REDACTED_SENTINEL;
      fieldsRedacted.push(`${key} (AKIA pattern)`);
      continue;
    }

    scrubbedOpts[key] = value;
  }

  if (fieldsRedacted.length === 0) {
    return { record, fieldsRedacted: [] };
  }

  return {
    record: { ...record, optionsSelected: scrubbedOpts },
    fieldsRedacted,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolvePatternsPath(): string {
  const fileIdx = process.argv.indexOf("--file");
  if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    return process.argv[fileIdx + 1]!;
  }
  return join(os.homedir(), ".assignee", "memory", "patterns.json");
}

const isApply = process.argv.includes("--apply");

// ── Main ───────────────────────────────────────────────────────────────────────

function main(): void {
  const patternsPath = resolvePatternsPath();
  const backupPath = `${patternsPath}.bak`;

  if (!existsSync(patternsPath)) {
    console.log(
      `migrate-patterns-cleartext: ${patternsPath} not found — no-op (exit 0).`,
    );
    process.exit(0);
  }

  let raw: string;
  try {
    raw = readFileSync(patternsPath, "utf-8");
  } catch (err) {
    console.error(
      `migrate-patterns-cleartext: could not read ${patternsPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  let records: PatternRecord[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(
        `migrate-patterns-cleartext: ${patternsPath} is not a JSON array — unexpected format.`,
      );
      process.exit(1);
    }
    records = parsed as PatternRecord[];
  } catch (err) {
    console.error(
      `migrate-patterns-cleartext: ${patternsPath} is not valid JSON: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const results: ScrubResult[] = records.map((r) => scrubRecord(r));
  const dirtyRecords = results.filter((r) => r.fieldsRedacted.length > 0);

  if (dirtyRecords.length === 0) {
    console.log(
      `migrate-patterns-cleartext: ${records.length} record(s) scanned — already clean (exit 0).`,
    );
    process.exit(0);
  }

  // Report what would be (or was) changed
  console.log(
    `migrate-patterns-cleartext: ${dirtyRecords.length} record(s) contain cleartext credentials:`,
  );
  for (const r of dirtyRecords) {
    console.log(
      `  pattern "${r.record.pattern}" — fields: ${r.fieldsRedacted.join(", ")}`,
    );
  }

  if (!isApply) {
    console.log(
      "\nDry-run mode (default). Run with --apply to scrub the file.",
    );
    console.log("  npx tsx scripts/migrate-patterns-cleartext.ts --apply");
    process.exit(0);
  }

  // --apply: backup then write
  try {
    copyFileSync(patternsPath, backupPath);
    console.log(`\nBackup written to: ${backupPath}`);
  } catch (err) {
    console.error(
      `migrate-patterns-cleartext: could not write backup to ${backupPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const scrubbedRecords = results.map((r) => r.record);
  try {
    writeFileSync(
      patternsPath,
      JSON.stringify(scrubbedRecords, null, 2),
      "utf-8",
    );
    console.log(
      `Scrubbed ${dirtyRecords.length} record(s) — written to: ${patternsPath}`,
    );
  } catch (err) {
    console.error(
      `migrate-patterns-cleartext: could not write scrubbed file to ${patternsPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  console.log(
    "Done. Run `npx tsx scripts/audit-patterns-cleartext.ts` to verify.",
  );
  process.exit(0);
}

main();
