/**
 * Environment variable overrides for AssigneeConfig values.
 * Reads ASSIGNEE_* env vars and returns a structured partial config.
 *
 * Supported variables:
 * - ASSIGNEE_DEFAULT_REGION → defaults.region
 * - ASSIGNEE_AUTO_FIX → preferences.auto_fix (ask|apply|skip)
 * - ASSIGNEE_OUTPUT_FORMAT → preferences.output_format (table|json)
 * - ASSIGNEE_VERBOSITY → preferences.verbosity (quiet|normal|verbose)
 * - ASSIGNEE_DEFAULT_TAGS → defaults.tags (comma-separated key=value)
 *
 * Does NOT touch ASSIGNEE_CONFIG_DIR (handled by user-config-loader.ts).
 *
 * @see Story 27.7 — Environment Variable Overrides
 */

import {
  AutoFixMode,
  type AssigneeConfig,
  type AutoFixModeType,
} from "@assignee/core";
import { log, LOG_ACTIONS } from "../utils/logger.js";

const VALID_AUTO_FIX = new Set([
  AutoFixMode.ASK,
  AutoFixMode.APPLY,
  AutoFixMode.SKIP,
]);
const VALID_OUTPUT_FORMAT = new Set(["table", "json"]);
const VALID_VERBOSITY = new Set(["quiet", "normal", "verbose"]);

/**
 * Validate an enum env var value against allowed set.
 * Logs warning and returns undefined on invalid value.
 */
function validateEnum(
  envName: string,
  value: string,
  allowed: Set<string>,
): string | undefined {
  if (allowed.has(value)) {
    return value;
  }

  log({
    ts: new Date().toISOString(),
    runId: "system",
    level: "warn",
    action: LOG_ACTIONS.CONFIG_LOADED,
    extras: {
      reason: `Ignoring ${envName}='${value}' — expected: ${[...allowed].join(", ")}`,
    },
  });
  return undefined;
}

/**
 * Parse comma-separated key=value pairs into a Record.
 * - Trims whitespace from both key and value
 * - Skips entries without '=' (logs warning)
 * - Skips entries with empty key
 * - Allows empty value (e.g., "flag=" → { flag: "" })
 */
export function parseTags(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const entries = raw.split(",");

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: {
          reason: `Skipping malformed tag entry (no '='): '${trimmed}'`,
        },
      });
      continue;
    }

    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    if (!key) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: {
          reason: `Skipping tag entry with empty key: '${trimmed}'`,
        },
      });
      continue;
    }

    result[key] = value;
  }

  return result;
}

/**
 * Load config values from ASSIGNEE_* environment variables.
 * Returns a partial AssigneeConfig with only the fields that were set.
 * Unset or invalid env vars are omitted from the result.
 *
 * This is synchronous — reads directly from process.env.
 */
export function loadEnvOverrides(
  env: Record<string, string | undefined> = process.env,
): Partial<AssigneeConfig> {
  const result: Partial<AssigneeConfig> = {};

  // ASSIGNEE_DEFAULT_REGION → defaults.region
  const region = env["ASSIGNEE_DEFAULT_REGION"];
  if (region !== undefined && region !== "") {
    if (!result.defaults) result.defaults = {};
    result.defaults.region = region;
  }

  // ASSIGNEE_DEFAULT_TAGS → defaults.tags
  const tagsRaw = env["ASSIGNEE_DEFAULT_TAGS"];
  if (tagsRaw !== undefined && tagsRaw !== "") {
    const tags = parseTags(tagsRaw);
    if (Object.keys(tags).length > 0) {
      if (!result.defaults) result.defaults = {};
      result.defaults.tags = tags;
    }
  }

  // ASSIGNEE_AUTO_FIX → preferences.auto_fix
  const autoFix = env["ASSIGNEE_AUTO_FIX"];
  if (autoFix !== undefined && autoFix !== "") {
    const valid = validateEnum("ASSIGNEE_AUTO_FIX", autoFix, VALID_AUTO_FIX);
    if (valid) {
      if (!result.preferences) result.preferences = {};
      result.preferences.auto_fix = valid as AutoFixModeType;
    }
  }

  // ASSIGNEE_OUTPUT_FORMAT → preferences.output_format
  const outputFormat = env["ASSIGNEE_OUTPUT_FORMAT"];
  if (outputFormat !== undefined && outputFormat !== "") {
    const valid = validateEnum(
      "ASSIGNEE_OUTPUT_FORMAT",
      outputFormat,
      VALID_OUTPUT_FORMAT,
    );
    if (valid) {
      if (!result.preferences) result.preferences = {};
      result.preferences.output_format = valid as "table" | "json";
    }
  }

  // ASSIGNEE_VERBOSITY → preferences.verbosity
  const verbosity = env["ASSIGNEE_VERBOSITY"];
  if (verbosity !== undefined && verbosity !== "") {
    const valid = validateEnum(
      "ASSIGNEE_VERBOSITY",
      verbosity,
      VALID_VERBOSITY,
    );
    if (valid) {
      if (!result.preferences) result.preferences = {};
      result.preferences.verbosity = valid as "quiet" | "normal" | "verbose";
    }
  }

  return result;
}
