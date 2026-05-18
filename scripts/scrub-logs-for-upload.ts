#!/usr/bin/env tsx
/**
 * W6-04: scrub-logs-for-upload.ts
 *
 * Thin wrapper that redacts telemetry PII / sensitive fields from log files
 * before they are uploaded as CI artefacts. Calls the otel-allowlist redactor
 * from packages/core/src/telemetry/otel-allowlist.ts (created by Worker B).
 *
 * If the Worker B redactor module is not yet available (Worker B hasn't landed),
 * this script applies a conservative built-in redaction pass as a fallback.
 *
 * Usage:
 *   npx tsx scripts/scrub-logs-for-upload.ts <log-dir>
 *   npx tsx scripts/scrub-logs-for-upload.ts ~/.assignee/logs/
 *
 * Exit 0 — redaction completed (or no files found)
 * Exit 1 — fatal I/O error
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join, extname, dirname } from "path";
import { fileURLToPath, pathToFileURL } from "url";

const __dirname =
  typeof import.meta.dirname !== "undefined"
    ? import.meta.dirname
    : dirname(fileURLToPath(import.meta.url));

const ROOT = join(__dirname, "..");

// ─────────────────────────────────────────────────────────────────────────────
// Built-in conservative redactor (fallback if Worker B module unavailable)
// ─────────────────────────────────────────────────────────────────────────────

// Patterns that should never appear in uploaded logs
const REDACT_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // AWS access key IDs (AKIA...)
  {
    pattern: /AKIA[0-9A-Z]{16}/g,
    replacement: "[REDACTED-AWS-KEY-ID]",
  },
  // AWS secret access keys (40-char base64-like)
  {
    pattern:
      /(?<=[Ss]ecret[_\s]*[Aa]ccess[_\s]*[Kk]ey['":\s]+)[A-Za-z0-9/+=]{40}/g,
    replacement: "[REDACTED-AWS-SECRET]",
  },
  // Bearer tokens
  {
    pattern: /[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/g,
    replacement: "Bearer [REDACTED-TOKEN]",
  },
  // Generic secret= or token= values
  {
    pattern:
      /((?:secret|token|password|passwd|api_?key|auth)[_\s]*[=:]\s*)[^\s,;'"}{]+/gi,
    replacement: "$1[REDACTED]",
  },
  // 12-digit AWS account IDs that aren't the placeholder
  {
    pattern:
      /(?<!210987654321|123456789012)\b[0-9]{12}\b(?!210987654321|123456789012)/g,
    replacement: "[REDACTED-ACCOUNT-ID]",
  },
  // Email addresses
  {
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    replacement: "[REDACTED-EMAIL]",
  },
];

function builtinRedact(content: string): string {
  let result = content;
  for (const { pattern, replacement } of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Try to load Worker B's otel-allowlist redactor
// ─────────────────────────────────────────────────────────────────────────────

async function tryLoadWorkerBRedactor(): Promise<
  ((content: string) => string) | null
> {
  const candidates = [
    join(ROOT, "packages/core/dist/telemetry/otel-allowlist.js"),
    join(ROOT, "packages/core/src/telemetry/otel-allowlist.ts"),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      try {
        // Windows: ESM dynamic import() requires `file://` URL form for absolute
        // paths (raw `D:\...` rejected). `pathToFileURL` is a no-op on POSIX.
        const mod = await import(pathToFileURL(candidate).href);
        if (typeof mod.redactLogContent === "function") {
          console.log(
            `Using Worker B otel-allowlist redactor from: ${candidate}`,
          );
          return mod.redactLogContent as (content: string) => string;
        }
      } catch {
        // Module failed to load — fall through to built-in
      }
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// File collection
// ─────────────────────────────────────────────────────────────────────────────

function collectLogFiles(dir: string): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) return files;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectLogFiles(full));
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if ([".log", ".json", ".txt", ".ndjson", ".jsonl"].includes(ext)) {
        files.push(full);
      }
    }
  }
  return files;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const logDir = process.argv[2];
  if (!logDir) {
    console.error("Usage: npx tsx scripts/scrub-logs-for-upload.ts <log-dir>");
    process.exit(1);
  }

  const workerBRedactor = await tryLoadWorkerBRedactor();
  const redact = workerBRedactor ?? builtinRedact;

  if (!workerBRedactor) {
    console.warn(
      "Worker B otel-allowlist module not available — using built-in conservative redactor as fallback.",
    );
  }

  const files = collectLogFiles(logDir);
  if (files.length === 0) {
    console.log(
      `scrub-logs: no log files found in ${logDir} — nothing to redact.`,
    );
    process.exit(0);
  }

  let redacted = 0;
  let errors = 0;

  for (const filePath of files) {
    try {
      const original = readFileSync(filePath, "utf8");
      const scrubbed = redact(original);
      if (scrubbed !== original) {
        writeFileSync(filePath, scrubbed, "utf8");
        redacted++;
        console.log(`  redacted: ${filePath}`);
      }
    } catch (err) {
      console.error(
        `  error processing ${filePath}: ${(err as Error).message}`,
      );
      errors++;
    }
  }

  console.log(
    `scrub-logs: ${files.length} file(s) processed — ${redacted} redacted, ${errors} error(s).`,
  );

  if (errors > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`scrub-logs: fatal error — ${err.message}`);
  process.exit(1);
});
