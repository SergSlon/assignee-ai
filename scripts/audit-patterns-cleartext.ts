#!/usr/bin/env tsx
/**
 * W1-01 (Epic 100): audit-patterns-cleartext.ts
 *
 * Repeatable audit / CI parity gate. Scans the runtime
 * ~/.assignee/memory/patterns.json for credential-like strings using an
 * explicit allowlist of sensitive CFN property names (the same list used by
 * checkpoint/redaction.ts SENSITIVE_KEY_NAMES). Exits non-zero on any match
 * so CI can catch regressions where a caller forgot to apply
 * stripSensitiveFromElicited() before writing a pattern record.
 *
 * Safe to run on a clean file or a missing file — both produce exit 0.
 *
 * Usage:
 *   npx tsx scripts/audit-patterns-cleartext.ts
 *   npx tsx scripts/audit-patterns-cleartext.ts --file /path/to/patterns.json
 *
 * Exit 0 — clean (no credential strings found, or file is absent)
 * Exit 1 — one or more credential strings found (report printed to stderr)
 *
 * @see packages/core/src/utils/redact.ts — stripSensitiveFromElicited
 * @see packages/core/src/checkpoint/redaction.ts — SENSITIVE_KEY_NAMES
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import * as os from "os";

// ── Configuration ─────────────────────────────────────────────────────────────

/**
 * Allowlist of CFN property names that MUST NOT appear as keys with non-
 * redacted values in patterns.json. Mirrors SENSITIVE_KEY_NAMES from
 * checkpoint/redaction.ts.
 *
 * If a key from this list appears in optionsSelected with a value that is
 * NOT "[REDACTED]", it is a finding.
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
const AKIA_PATTERN = /A[KS]IA[0-9A-Z]{16}/;

// ── Helpers ────────────────────────────────────────────────────────────────────

interface Finding {
  patternIndex: number;
  patternId: string;
  field: string;
  reason: string;
}

interface PatternRecord {
  pattern: string;
  optionsSelected?: Record<string, unknown>;
  [key: string]: unknown;
}

function scanRecord(record: PatternRecord, index: number): Finding[] {
  const findings: Finding[] = [];
  const opts = record.optionsSelected;
  if (!opts || typeof opts !== "object") return findings;

  for (const [key, value] of Object.entries(opts)) {
    // Finding 1: sensitive key with a non-redacted string value
    if (SENSITIVE_KEY_ALLOWLIST.has(key)) {
      if (typeof value === "string" && value !== REDACTED_SENTINEL) {
        findings.push({
          patternIndex: index,
          patternId: record.pattern,
          field: key,
          reason: `sensitive key "${key}" has cleartext value (expected "${REDACTED_SENTINEL}")`,
        });
      }
    }

    // Finding 2: defense-in-depth — AKIA/ASIA pattern in any string value
    if (typeof value === "string" && AKIA_PATTERN.test(value)) {
      findings.push({
        patternIndex: index,
        patternId: record.pattern,
        field: key,
        reason: `AKIA/ASIA access key pattern detected in field "${key}"`,
      });
    }
  }

  return findings;
}

function resolvePatternsPath(): string {
  // Allow --file override for testing
  const fileIdx = process.argv.indexOf("--file");
  if (fileIdx !== -1 && process.argv[fileIdx + 1]) {
    return process.argv[fileIdx + 1]!;
  }
  return join(os.homedir(), ".assignee", "memory", "patterns.json");
}

// ── Main ───────────────────────────────────────────────────────────────────────

function main(): void {
  const patternsPath = resolvePatternsPath();

  if (!existsSync(patternsPath)) {
    console.log(
      `audit-patterns-cleartext: ${patternsPath} not found — no-op pass.`,
    );
    process.exit(0);
  }

  let raw: string;
  try {
    raw = readFileSync(patternsPath, "utf-8");
  } catch (err) {
    console.error(
      `audit-patterns-cleartext: could not read ${patternsPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  let records: PatternRecord[];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      console.error(
        `audit-patterns-cleartext: ${patternsPath} is not a JSON array — unexpected format.`,
      );
      process.exit(1);
    }
    records = parsed as PatternRecord[];
  } catch (err) {
    console.error(
      `audit-patterns-cleartext: ${patternsPath} is not valid JSON: ${(err as Error).message}`,
    );
    process.exit(1);
  }

  const allFindings: Finding[] = [];
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record) {
      allFindings.push(...scanRecord(record, i));
    }
  }

  if (allFindings.length === 0) {
    console.log(
      `audit-patterns-cleartext: ${records.length} record(s) scanned — clean (exit 0).`,
    );
    process.exit(0);
  }

  // Report findings to stderr (machine-parseable)
  process.stderr.write(
    `audit-patterns-cleartext: ${allFindings.length} finding(s) in ${patternsPath}\n`,
  );
  for (const f of allFindings) {
    process.stderr.write(
      `  [FINDING] pattern[${f.patternIndex}] "${f.patternId}" — field "${f.field}" — ${f.reason}\n`,
    );
  }
  process.stderr.write(
    "\nRun `npx tsx scripts/migrate-patterns-cleartext.ts` to scrub the file.\n",
  );

  process.exit(1);
}

main();
