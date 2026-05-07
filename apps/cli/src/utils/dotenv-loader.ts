/**
 * Loads `.env` from the current working directory (or a given directory)
 * and merges its values into `process.env`.
 *
 * Override policy:
 *  - ASSIGNEE_DOTENV_OVERRIDE_KEYS (the 9 access-key triples): `.env` ALWAYS
 *    wins — shell values are stale by definition after `assignee setup` rotates.
 *  - All other keys: shell wins (set only if the var is not already defined).
 *
 * @see Story — bug-setup-stale-env-credentials (Option C)
 */

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The 9 assignee-specific access-key names that `.env` always overrides,
 * even when the shell has a value for the same var. These are the only
 * names `assignee setup` rotates; everything else (AWS_REGION, BEDROCK_*,
 * ASSIGNEE_VERBOSITY, …) defers to the shell.
 */
export const ASSIGNEE_DOTENV_OVERRIDE_KEYS: readonly string[] = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_OPERATOR_SESSION_TOKEN",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_SESSION_TOKEN",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_SESSION_TOKEN",
];

const OVERRIDE_KEY_SET = new Set(ASSIGNEE_DOTENV_OVERRIDE_KEYS);

export interface DotEnvResult {
  /** Whether a `.env` file was found and processed. */
  loaded: boolean;
  /** Whether at least one of the 9 ASSIGNEE override keys was present. */
  assigneeKeysLoaded: boolean;
  /** Absolute path of the `.env` file that was loaded, or null. */
  sourcePath: string | null;
}

/**
 * Parse a `.env` file contents into a key→value map.
 *
 * Supported syntax (subset of dotenv spec):
 *   - `KEY=VALUE` — bare value
 *   - `KEY="value with spaces"` — double-quoted (quotes stripped)
 *   - `KEY='value'` — single-quoted (quotes stripped)
 *   - `# comment` at line start — skipped
 *   - Blank lines — skipped
 *   - Inline `#` comments are NOT stripped (avoids breaking session tokens
 *     that contain `#` chars — keep it simple and safe)
 *   - Malformed lines (no `=`) — warning to stderr, skipped.
 *
 * @returns parsed entries in order, empty array on empty/comment-only files.
 */
function parseDotEnv(
  content: string,
  sourcePath: string,
): Array<{ key: string; value: string }> {
  const results: Array<{ key: string; value: string }> = [];
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // Skip blank lines and comment lines.
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx < 1) {
      process.stderr.write(
        `[assignee] Warning: ${sourcePath} line ${i + 1} is malformed (no KEY=VALUE); skipping.\n`,
      );
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1);

    // Strip surrounding quotes (single or double), but only when both the
    // opening and closing characters match.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    results.push({ key, value });
  }

  return results;
}

/**
 * Loads `${cwd ?? process.cwd()}/.env` and merges it into `process.env`.
 *
 * Silent no-op when the file is absent (CI, fresh checkouts).
 * Emits a stderr warning but still loads when the file mode is not 0600.
 *
 * @param cwd - Directory to look in (defaults to `process.cwd()`).
 */
export function loadDotEnv(cwd?: string): DotEnvResult {
  const dir = cwd ?? process.cwd();
  const envPath = path.resolve(dir, ".env");

  if (!fs.existsSync(envPath)) {
    return { loaded: false, assigneeKeysLoaded: false, sourcePath: null };
  }

  // Check file permissions — warn but still load.
  if (process.platform !== "win32") {
    try {
      const stat = fs.statSync(envPath);
      const mode = stat.mode & 0o777;
      if (mode !== 0o600) {
        process.stderr.write(
          `[assignee] Warning: ${envPath} has mode ${mode.toString(8).padStart(4, "0")} — recommended: chmod 600 ${envPath}\n`,
        );
      }
    } catch {
      // stat failure is non-fatal; proceed with the load.
    }
  }

  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf-8");
  } catch (err) {
    process.stderr.write(
      `[assignee] Warning: could not read ${envPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return { loaded: false, assigneeKeysLoaded: false, sourcePath: null };
  }

  const entries = parseDotEnv(content, envPath);
  let assigneeKeysLoaded = false;

  for (const { key, value } of entries) {
    if (OVERRIDE_KEY_SET.has(key)) {
      // Always override shell value for assignee-specific access-key triples.
      process.env[key] = value;
      assigneeKeysLoaded = true;
    } else if (!(key in process.env)) {
      // Shell wins for all other keys — only set if absent.
      process.env[key] = value;
    }
  }

  return { loaded: true, assigneeKeysLoaded, sourcePath: envPath };
}
