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
  auto_fix?: AutoFixModeType;
}

/** Budget / cost safety settings (FR-09 — panic limit). */
export interface ConfigBudget {
  /** Maximum allowed estimated monthly cost in USD. Apply is blocked if exceeded. */
  monthly_limit_usd?: number;
  /** When true, only warn — don't block. Default: false (block). */
  warn_only?: boolean;
}

/**
 * Top-level AssigneeConfig schema.
 * Used by user config, project config, and org policy files.
 * Extensible — future keys like `optimization.*` can be added without breaking.
 */
export interface AssigneeConfig {
  /** Global defaults (region, tags, naming) */
  defaults?: ConfigDefaults;
  /** User preferences (auto_fix) */
  preferences?: ConfigPreferences;
  /** Budget safety (monthly cost cap) */
  budget?: ConfigBudget;
  /** Org policy section (for local-only org files) */
  org_policy?: Record<string, Record<string, unknown>>;
}

/** Named constants for auto_fix preference values. */
export const AutoFixMode = {
  ASK: "ask",
  APPLY: "apply",
  SKIP: "skip",
} as const;
export type AutoFixModeType = (typeof AutoFixMode)[keyof typeof AutoFixMode];

// ── Default Values ───────────────────────────────────────────────────────

/**
 * Default AWS region — derived from the `AWS_REGION` env var when set,
 * otherwise falls back to `"us-east-1"` for US-first operators.
 *
 * W5-01 (P007-tech → L1-F05): using env-derived value stops EU operators
 * from silently hitting a US-East default when they have AWS_REGION
 * configured in their shell / process environment.
 *
 * MIGRATION-NOTE(M-009): process-lifetime config; multi-tenant SaaS will
 * need request-scoped lookup via `ConfigPort.get("AWS_REGION", "us-east-1")`.
 * Single-tenant CLI captures the value at module load — fine today.
 */
export const DEFAULT_AWS_REGION: string =
  process.env["AWS_REGION"] ?? "us-east-1";

/** Default values for all preference fields. */
export const CONFIG_DEFAULTS: Required<ConfigPreferences> = {
  auto_fix: AutoFixMode.ASK,
} as const;

// ── Enum Validation Sets ─────────────────────────────────────────────────

const VALID_AUTO_FIX: Set<string> = new Set([
  AutoFixMode.ASK,
  AutoFixMode.APPLY,
  AutoFixMode.SKIP,
]);

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
