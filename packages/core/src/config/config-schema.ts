/**
 * Config schema and validation for AssigneeConfig.
 * Defines TypeScript interfaces and runtime validation for the unified
 * config format used by user config (~/.config/assignee/config.yaml),
 * project config (.assignee/config.yaml), and org policy files.
 *
 * @see Story 27.1 — Config Schema + Validation
 */

import { ConfigurationError } from "../errors.js";

// ── TypeScript Interfaces ────────────────────────────────────────────────

/** Naming convention configuration. */
export interface ConfigNaming {
  /** Prefix applied to resource names, e.g. "mycompany-" */
  prefix?: string;
  /** Suffix applied to resource names, e.g. "-prod" */
  suffix?: string;
}

/** Global default values applied across all resource types. */
export interface ConfigDefaults {
  /** Default AWS region, e.g. "us-east-1" */
  region?: string;
  /** Default tags applied to all resources */
  tags?: Record<string, string>;
  /** Naming convention configuration */
  naming?: ConfigNaming;
}

/** User preference settings. */
export interface ConfigPreferences {
  /** How to handle best practice auto-fixes. Default: "ask" */
  auto_fix?: "ask" | "apply" | "skip";
  /** Output format for CLI results. Default: "table" */
  output_format?: "table" | "json";
  /** Verbosity level. Default: "normal" */
  verbosity?: "quiet" | "normal" | "verbose";
}

/**
 * Top-level AssigneeConfig schema.
 * Used by user config, project config, and org policy files.
 * Extensible — future keys like `optimization.*` can be added without breaking.
 */
export interface AssigneeConfig {
  /** Global defaults (region, tags, naming) */
  defaults?: ConfigDefaults;
  /** User preferences (auto_fix, output_format, verbosity) */
  preferences?: ConfigPreferences;
  /** Org policy section (for local-only org files) */
  org_policy?: Record<string, Record<string, unknown>>;
}

// ── Default Values ───────────────────────────────────────────────────────

/** Default AWS region when none is configured or provided via AWS_REGION env var. */
export const DEFAULT_AWS_REGION = "us-east-1";

/** Default values for all preference fields. */
export const CONFIG_DEFAULTS: Required<ConfigPreferences> = {
  auto_fix: "ask",
  output_format: "table",
  verbosity: "normal",
} as const;

// ── Enum Validation Sets ─────────────────────────────────────────────────

const VALID_AUTO_FIX = new Set(["ask", "apply", "skip"]);
const VALID_OUTPUT_FORMAT = new Set(["table", "json"]);
const VALID_VERBOSITY = new Set(["quiet", "normal", "verbose"]);

// ── Validation ───────────────────────────────────────────────────────────

/**
 * Validate and coerce a raw parsed object into a typed AssigneeConfig.
 * Unknown/extra keys are silently ignored (forward-compatible).
 * Returns CONFIG_DEFAULTS merged with valid parsed fields.
 *
 * @param raw - Parsed YAML/JSON object (or undefined/null for empty file)
 * @returns Validated AssigneeConfig with defaults applied
 * @throws ConfigurationError with human-readable field path on invalid enum values
 */
export function validateConfig(raw: unknown): AssigneeConfig {
  // Empty/undefined input returns all defaults
  if (raw === null || raw === undefined) {
    return { preferences: { ...CONFIG_DEFAULTS } };
  }

  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigurationError(
      "Config must be an object (got " +
        (Array.isArray(raw) ? "array" : typeof raw) +
        ")",
    );
  }

  const obj = raw as Record<string, unknown>;
  const result: AssigneeConfig = {};

  // ── Validate defaults section ──
  if (obj["defaults"] !== undefined) {
    if (typeof obj["defaults"] !== "object" || obj["defaults"] === null) {
      throw new ConfigurationError("defaults: must be an object");
    }
    const defaults = obj["defaults"] as Record<string, unknown>;
    const validated: ConfigDefaults = {};

    if (defaults["region"] !== undefined) {
      if (typeof defaults["region"] !== "string") {
        throw new ConfigurationError("defaults.region: must be a string");
      }
      validated.region = defaults["region"];
    }

    if (defaults["tags"] !== undefined) {
      if (
        typeof defaults["tags"] !== "object" ||
        defaults["tags"] === null ||
        Array.isArray(defaults["tags"])
      ) {
        throw new ConfigurationError(
          "defaults.tags: must be an object (key-value pairs)",
        );
      }
      validated.tags = defaults["tags"] as Record<string, string>;
    }

    if (defaults["naming"] !== undefined) {
      if (
        typeof defaults["naming"] !== "object" ||
        defaults["naming"] === null
      ) {
        throw new ConfigurationError("defaults.naming: must be an object");
      }
      const naming = defaults["naming"] as Record<string, unknown>;
      validated.naming = {};
      if (naming["prefix"] !== undefined) {
        validated.naming.prefix = String(naming["prefix"]);
      }
      if (naming["suffix"] !== undefined) {
        validated.naming.suffix = String(naming["suffix"]);
      }
    }

    result.defaults = validated;
  }

  // ── Validate preferences section ──
  const prefRaw =
    obj["preferences"] !== undefined ? obj["preferences"] : undefined;

  const prefs: ConfigPreferences = { ...CONFIG_DEFAULTS };

  if (prefRaw !== undefined) {
    if (typeof prefRaw !== "object" || prefRaw === null) {
      throw new ConfigurationError("preferences: must be an object");
    }
    const p = prefRaw as Record<string, unknown>;

    if (p["auto_fix"] !== undefined) {
      if (!VALID_AUTO_FIX.has(String(p["auto_fix"]))) {
        throw new ConfigurationError(
          `preferences.auto_fix: invalid value '${p["auto_fix"]}', expected ask | apply | skip`,
        );
      }
      prefs.auto_fix = String(p["auto_fix"]) as ConfigPreferences["auto_fix"];
    }

    if (p["output_format"] !== undefined) {
      if (!VALID_OUTPUT_FORMAT.has(String(p["output_format"]))) {
        throw new ConfigurationError(
          `preferences.output_format: invalid value '${p["output_format"]}', expected table | json`,
        );
      }
      prefs.output_format = String(
        p["output_format"],
      ) as ConfigPreferences["output_format"];
    }

    if (p["verbosity"] !== undefined) {
      if (!VALID_VERBOSITY.has(String(p["verbosity"]))) {
        throw new ConfigurationError(
          `preferences.verbosity: invalid value '${p["verbosity"]}', expected quiet | normal | verbose`,
        );
      }
      prefs.verbosity = String(
        p["verbosity"],
      ) as ConfigPreferences["verbosity"];
    }
  }

  result.preferences = prefs;

  // ── Org policy (pass-through, no deep validation) ──
  if (obj["org_policy"] !== undefined) {
    if (typeof obj["org_policy"] === "object" && obj["org_policy"] !== null) {
      result.org_policy = obj["org_policy"] as Record<
        string,
        Record<string, unknown>
      >;
    }
  }

  return result;
}
