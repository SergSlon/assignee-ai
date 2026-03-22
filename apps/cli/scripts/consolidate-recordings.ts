#!/usr/bin/env tsx
/**
 * Consolidation script: merges individual recording files into a single scenario bundle.
 *
 * Usage:
 *   pnpm tsx scripts/consolidate-recordings.ts <runId> <scenario-name>
 *
 * Example:
 *   pnpm tsx scripts/consolidate-recordings.ts abc-123 create-s3-bucket
 *
 * Output:
 *   apps/cli/src/test-fixtures/e2e-fixtures/<scenario-name>.json
 *
 * @see Story 9.7 — Request/Response Recording Interceptor
 */

import * as fs from "node:fs";
import * as path from "node:path";

const [runId, scenarioName] = process.argv.slice(2);

if (!runId || !scenarioName) {
  console.error(
    "Usage: pnpm tsx scripts/consolidate-recordings.ts <runId> <scenario-name>",
  );
  process.exit(1);
}

const recordingsDir = path.resolve(
  __dirname,
  "..",
  "src",
  "test-fixtures",
  "recordings",
  runId,
);

if (!fs.existsSync(recordingsDir)) {
  console.error(`Recording directory not found: ${recordingsDir}`);
  process.exit(1);
}

const files = fs
  .readdirSync(recordingsDir)
  .filter((f) => f.endsWith(".json") && f !== "_manifest.json")
  .sort();

if (files.length === 0) {
  console.error(`No recording files found in ${recordingsDir}`);
  process.exit(1);
}

interface RecordedCall {
  type: string;
  timestamp: string;
  durationMs: number;
  [key: string]: unknown;
}

const calls: RecordedCall[] = [];
let totalDurationMs = 0;

for (const file of files) {
  const filePath = path.join(recordingsDir, file);
  const content = fs.readFileSync(filePath, "utf-8");
  const call = JSON.parse(content) as RecordedCall;
  calls.push(call);
  totalDurationMs += call.durationMs ?? 0;
}

// Sort by timestamp
calls.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

const bundle = {
  scenario: scenarioName,
  recordedAt: calls[0]?.timestamp ?? new Date().toISOString(),
  totalDurationMs,
  calls,
};

const outputDir = path.resolve(
  __dirname,
  "..",
  "src",
  "test-fixtures",
  "e2e-fixtures",
);
fs.mkdirSync(outputDir, { recursive: true });

const outputPath = path.join(outputDir, `${scenarioName}.json`);
fs.writeFileSync(outputPath, JSON.stringify(bundle, null, 2) + "\n");

console.log(`Consolidated ${calls.length} calls into ${outputPath}`);
