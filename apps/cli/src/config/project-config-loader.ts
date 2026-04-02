/**
 * Loads project-level config from `.assignee/config.yaml` by walking up
 * from the current directory to the project root.
 *
 * Security: the walk stops at `.git` or `package.json` boundaries —
 * never reaches the filesystem root. This prevents accidental reads
 * from shared parent directories outside the project.
 *
 * All I/O is wrapped in try/catch — this function never throws.
 *
 * @see Story 27.3 — Project-Level Config
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parse as parseYaml } from "yaml";
import { validateConfig } from "@assignee/core";
import type { AssigneeConfig } from "@assignee/core";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { CHECKPOINT_DIR, FileName } from "./constants.js";

/** Sentinel files that indicate a project root boundary. */
const PROJECT_ROOT_MARKERS = [".git", "package.json"] as const;

/**
 * Check whether a path exists on the filesystem.
 */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walk from `startDir` upward looking for `.assignee/config.yaml`.
 * Stops at the first directory containing a project root marker
 * (.git or package.json) — never walks above the project root.
 *
 * Returns the config file path if found, undefined otherwise.
 */
async function findProjectConfig(
  startDir: string,
): Promise<string | undefined> {
  let dir = startDir;

  while (true) {
    const candidate = path.join(dir, CHECKPOINT_DIR, FileName.CONFIG);
    if (await pathExists(candidate)) return candidate;

    // Check if we've reached a project root boundary
    const isProjectRoot = await Promise.all(
      PROJECT_ROOT_MARKERS.map((marker) => pathExists(path.join(dir, marker))),
    ).then((results) => results.some(Boolean));

    if (isProjectRoot) {
      // We found the project root but no .assignee/config.yaml — stop
      break;
    }

    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  return undefined;
}

/**
 * Load project-level config from `.assignee/config.yaml`.
 *
 * Walks from `startDir` (default `process.cwd()`) upward to find the
 * nearest `.assignee/config.yaml`. Parses, validates, and returns the
 * config. Returns `undefined` if no config is found or if parsing fails.
 *
 * @param startDir - Directory to start searching from (default: cwd)
 * @returns Validated AssigneeConfig or undefined (never throws)
 */
export async function loadProjectConfig(
  startDir?: string,
): Promise<AssigneeConfig | undefined> {
  const dir = startDir ?? process.cwd();

  try {
    const configPath = await findProjectConfig(dir);
    if (!configPath) return undefined;

    const content = await fs.readFile(configPath, "utf-8");
    const parsed: unknown = parseYaml(content);

    const validated = validateConfig(parsed);

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "info",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: { path: configPath, source: "project" },
    });

    return validated;
  } catch (err: unknown) {
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: {
        source: "project",
        reason: err instanceof Error ? err.message : "unknown error",
      },
    });
    return undefined;
  }
}
