#!/usr/bin/env tsx
/**
 * Reject new occurrences of the AWS-docs denylisted placeholder account ID
 * `123456789012` in wizard plugin source files. The placeholder-ARN preflight
 * guard at
 * `packages/core/src/graph/nodes/preflight-guard/guards/placeholder-arn.ts`
 * blocks any ARN containing this account ID at runtime — wizards must teach
 * what preflight blocks, not the other way around. Wizard placeholders use
 * the literal `<your-12-digit-account-id>` (angle brackets included) so paste-
 * as-is fails earlier with a clearer ARN-shape validation message.
 *
 * Test files retain `123456789012` as a legitimate negative-test fixture
 * (proves the preflight guard rejects it) — they're excluded from the scan.
 */

import { promises as fs } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const SCAN_ROOT = join(ROOT, "packages/core/src/resource-plugins/plugins");
const FORBIDDEN = "123456789012";

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(path);
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts")
    ) {
      yield path;
    }
  }
}

async function main(): Promise<void> {
  const violations: { file: string; line: number; text: string }[] = [];

  for await (const path of walk(SCAN_ROOT)) {
    const content = await fs.readFile(path, "utf-8");
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(FORBIDDEN)) {
        violations.push({
          file: relative(ROOT, path),
          line: i + 1,
          text: lines[i]!.trim(),
        });
      }
    }
  }

  if (violations.length > 0) {
    console.error(
      `audit-placeholder-account-ids: found ${violations.length} occurrence(s) of the AWS-docs denylisted placeholder account ID "${FORBIDDEN}" in production wizard sources:\n`,
    );
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  ${v.text}`);
    }
    console.error(
      `\nReplace with "<your-12-digit-account-id>" so the placeholder is unambiguously a placeholder; the placeholder-ARN preflight guard blocks "${FORBIDDEN}" at runtime so leaving it in wizard hints contradicts the guard.`,
    );
    process.exit(1);
  }

  console.log(
    `audit-placeholder-account-ids: scanned ${SCAN_ROOT.replace(ROOT, "")} — zero occurrences of denylisted placeholder account ID.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
