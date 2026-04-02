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
import type {
  UserResourceConfig,
  BPEnforcementLevelType,
} from "@assignee/core";
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

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: { path: configPath },
    });

    return parsed as UserConfig;
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
