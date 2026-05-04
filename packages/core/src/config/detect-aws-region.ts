/**
 * Sync helper that reads the default region from ~/.aws/config without
 * making any AWS SDK / HTTP calls. Used by DEFAULT_AWS_REGION in
 * config-schema.ts to pick a sensible default before falling through
 * to "us-east-1".
 *
 * PR-016 / W24b-S3: prevents GovCloud / China operators from silently
 * inheriting a commercial us-east-1 default that doesn't exist in their
 * partition.
 *
 * Design constraints:
 * - Sync fs-read only — must not add startup latency via SDK calls.
 * - Fault-tolerant — must never throw: absent file, unreadable file,
 *   malformed INI → return undefined gracefully.
 * - No dependency on @aws-sdk/* — keeps packages/core lightweight.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Read the `region` setting from the `[default]` profile in
 * `~/.aws/config` (or the path given by `AWS_CONFIG_FILE`).
 *
 * Returns the region string if found, or `undefined` when:
 * - the file does not exist
 * - the file is unreadable
 * - the `[default]` profile is absent
 * - no `region =` line is present under `[default]`
 * - the region value is empty / whitespace-only
 */
export function detectAwsConfigDefaultRegion(): string | undefined {
  try {
    const configPath =
      process.env["AWS_CONFIG_FILE"] ??
      path.join(os.homedir(), ".aws", "config");

    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
    } catch {
      // File absent or unreadable — not an error.
      return undefined;
    }

    return parseDefaultRegionFromConfig(raw);
  } catch {
    // Belt-and-suspenders: any unexpected error → undefined, never throw.
    return undefined;
  }
}

/**
 * Parse the region from an AWS config file string.
 * Exported for unit testing without touching the real filesystem.
 *
 * Supports the standard INI format:
 *   [default]
 *   region = us-west-2
 *
 * Also handles the "profile default" heading used in some tooling:
 *   [profile default]
 *   region = us-west-2
 */
export function parseDefaultRegionFromConfig(
  content: string,
): string | undefined {
  const lines = content.split(/\r?\n/);

  let inDefaultProfile = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Section header
    if (line.startsWith("[")) {
      // Match [default] or [profile default]
      inDefaultProfile = line === "[default]" || line === "[profile default]";
      continue;
    }

    if (!inDefaultProfile) continue;

    // key = value line
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim().toLowerCase();
    if (key !== "region") continue;

    const value = line.slice(eqIdx + 1).trim();
    if (value.length === 0) return undefined;

    // Strip inline comments (everything from the first # or ; onward),
    // matching AWS CLI ini-parser behaviour. F012.
    const cleaned = value.replace(/[#;].*$/, "").trim();
    if (cleaned.length === 0) return undefined;

    return cleaned;
  }

  return undefined;
}
