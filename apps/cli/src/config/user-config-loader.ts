/**
 * Loads user-level resource option preferences from XDG-compliant config.
 * Reads `$ASSIGNEE_CONFIG_DIR/config.yaml` (env override) or `~/.config/assignee/config.yaml`.
 *
 * All I/O is wrapped in try/catch — this function never throws.
 *
 * @see Story 7.2 — AC: 1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type {
  UserResourceConfig,
  BPEnforcementLevelType,
} from "@assignee/core";
import { BPEnforcementLevel } from "@assignee/core";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { EnvVar } from "../constants/env-vars.js";
import { FileName } from "./constants.js";

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

/** Resolve the config file path from env override or XDG default. */
export function resolveConfigPath(): string {
  const configDir =
    process.env[EnvVar.ASSIGNEE_CONFIG_DIR] ??
    path.join(os.homedir(), ".config", "assignee");
  return path.join(configDir, FileName.CONFIG);
}

/**
 * Load user config from YAML file. Returns undefined if the file is missing or malformed.
 *
 * @returns Parsed user config or undefined (never throws)
 */
export async function loadUserConfig(): Promise<UserConfig | undefined> {
  const configPath = resolveConfigPath();
  try {
    const content = await fs.readFile(configPath, "utf-8");
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
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // File not found is expected — user may not have created config yet
      return undefined;
    }

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
