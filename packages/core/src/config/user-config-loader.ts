/**
 * Loads user-level resource option preferences from XDG-compliant config.
 * Reads `$ASSIGNEE_CONFIG_DIR/config.yaml` (env override) or `~/.config/assignee/config.yaml`.
 *
 * All I/O is wrapped in try/catch — this function never throws.
 *
 * Lifted from apps/cli/src/config/user-config-loader.ts in Story 50-4
 * Wave 5 Pass G so the in-core graph (createGraph + nodes) can read
 * user config without reaching back into the CLI app.
 *
 * RW4d-migration-C (M-016): now accepts an optional `StoragePort` so
 * SaaS callers can swap the YAML file read for a tenant-scoped blob
 * lookup. When omitted, builds a `LocalFsStorageAdapter` rooted at the
 * resolved config directory and reads the `config.yaml` key. The port
 * returns the raw UTF-8 string via `readText`; YAML parsing happens in
 * this module (the port stays format-agnostic).
 *
 * @see Story 7.2 — AC: 1
 */

import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { UserResourceConfig } from "./resource-policy.js";
import {
  BPEnforcementLevel,
  type BPEnforcementLevelType,
} from "../schema/graph-state.js";
import { log, LOG_ACTIONS } from "../utils/logger/index.js";
import { EnvVar } from "../constants/env-vars.js";
import { FileName } from "./constants/paths.js";
import { ProcessEnvConfigAdapter, type ConfigPort } from "./config-port.js";
import { LocalFsStorageAdapter } from "../adapters/storage/local-fs-adapter.js";
import type { StoragePort } from "../ports/storage-port.js";

/** Extended user config with top-level preferences (beyond per-resource overrides). */
export type UserConfig = UserResourceConfig & {
  bestPractices?: {
    enforcement?: BPEnforcementLevelType;
    autoFix?: boolean;
  };
};

/**
 * Zod schema for the user config file. Top-level keys can be either:
 *  - The reserved `bestPractices` key (typed object)
 *  - Any AWS resource type identifier mapping to a free-form record
 *
 * Validation here catches structural drift early instead of crashing
 * deeper in the pipeline.
 *
 * @see SECURITY-AUDIT.md — M-S4
 */
const BEST_PRACTICES_KEY = "bestPractices";
const BPEnforcementLevelSchema = z.nativeEnum(BPEnforcementLevel);

const BestPracticesSchema = z
  .object({
    enforcement: BPEnforcementLevelSchema.optional(),
    autoFix: z.boolean().optional(),
  })
  .strict();

// Per-resource overrides are free-form records (`Record<string, unknown>`).
const ResourceOverrideSchema = z.record(z.string(), z.unknown());

const UserConfigSchema = z
  .record(z.string(), z.unknown())
  .superRefine((obj, ctx) => {
    for (const [key, value] of Object.entries(obj)) {
      if (key === BEST_PRACTICES_KEY) {
        const result = BestPracticesSchema.safeParse(value);
        if (!result.success) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `Invalid '${key}' section: ${result.error.issues
              .map((i) => i.message)
              .join(", ")}`,
          });
        }
        continue;
      }
      // Resource override: must be an object map.
      if (value === null || typeof value !== "object" || Array.isArray(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Resource override '${key}' must be an object map of property → value`,
        });
        continue;
      }
      const result = ResourceOverrideSchema.safeParse(value);
      if (!result.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Invalid resource override for '${key}'`,
        });
      }
    }
  });

/**
 * Validate parsed YAML against the user config schema.
 * Throws an Error with a clear, key-naming message on failure.
 * Exported only for testing.
 */
export function validateUserConfig(parsed: unknown): UserConfig {
  const result = UserConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const offendingKey = issue?.path.join(".") || "<root>";
    throw new Error(
      `Invalid user config: '${offendingKey}' — ${issue?.message ?? "schema validation failed"}`,
    );
  }
  return result.data as UserConfig;
}

/**
 * Resolve the config directory from env override or XDG default.
 *
 * Internal helper — used by `resolveConfigPath` (back-compat string path)
 * and as the `rootDir` for the fallback `LocalFsStorageAdapter` so the
 * port-backed and legacy code paths agree on where `config.yaml` lives.
 */
function resolveConfigDir(config?: ConfigPort): string {
  const effectiveConfig = config ?? new ProcessEnvConfigAdapter();
  return (
    effectiveConfig.get(EnvVar.ASSIGNEE_CONFIG_DIR) ??
    path.join(os.homedir(), ".config", "assignee")
  );
}

/**
 * Resolve the config file path from env override or XDG default.
 *
 * MASTER-009: accepts an optional `ConfigPort` so SaaS callers can
 * supply a tenant-scoped lookup. When omitted, falls back to a fresh
 * `ProcessEnvConfigAdapter` (legacy single-tenant CLI behaviour).
 */
export function resolveConfigPath(config?: ConfigPort): string {
  return path.join(resolveConfigDir(config), FileName.CONFIG);
}

/**
 * Load user config from YAML file. Returns undefined if the file is missing or malformed.
 *
 * MASTER-009: accepts an optional `ConfigPort` and forwards it to
 * `resolveConfigPath`.
 *
 * RW4d-migration-C (M-016): accepts an optional `StoragePort`. When
 * supplied, the loader reads the `config.yaml` key from that port (the
 * caller owns the port's rootDir, which it should set to the config
 * directory). When omitted, the loader builds a
 * `LocalFsStorageAdapter` rooted at the directory resolved from
 * `config` (or env / XDG default) and reads the `config.yaml` key —
 * preserving the legacy single-tenant CLI semantics.
 *
 * KEY mapping: `<configDir>/config.yaml` → key `config.yaml`
 * (rootDir = `<configDir>`).
 *
 * YAML note: `StoragePort.readJson` is JSON-only, so this loader uses
 * `port.readText(key)` and parses the YAML in-process via the existing
 * `yaml` dependency. The port stays format-agnostic on purpose.
 *
 * @returns Parsed user config or undefined (never throws)
 */
export async function loadUserConfig(
  config?: ConfigPort,
  // TODO(SaaS): require StoragePort once all callers thread it through.
  storage?: StoragePort,
): Promise<UserConfig | undefined> {
  const configDir = resolveConfigDir(config);
  const configPath = path.join(configDir, FileName.CONFIG);
  const key = FileName.CONFIG;
  const port = storage ?? new LocalFsStorageAdapter({ rootDir: configDir });

  try {
    const content = await port.readText(key);

    if (content === undefined) {
      // Missing key — equivalent to ENOENT in the legacy fs path.
      // User may not have created the config yet; return silently.
      return undefined;
    }

    const parsed: unknown = parseYaml(content);

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: { path: configPath, reason: "empty or non-object YAML" },
      });
      return undefined;
    }

    let validated: UserConfig;
    try {
      validated = validateUserConfig(parsed);
    } catch (validationErr) {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: {
          path: configPath,
          reason:
            validationErr instanceof Error
              ? validationErr.message
              : "schema validation failed",
        },
      });
      return undefined;
    }

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: { path: configPath },
    });

    return validated;
  } catch (err: unknown) {
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: {
        path: configPath,
        reason: err instanceof Error ? err.message : "unknown error",
      },
    });
    return undefined;
  }
}
