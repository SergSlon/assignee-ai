/**
 * Local org policy loader — reads org policy from local YAML files.
 * Supports project-level (.assignee/org-policy.yaml) and user-level
 * (~/.config/assignee/org-policy.yaml) policy files with deep-merge.
 *
 * Project-level takes precedence over user-level.
 * All I/O is wrapped in try/catch — this function never throws.
 *
 * @see Story 27.6 — Org Policy Enforcement (Local-Only)
 */

import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parse as parseYaml } from "yaml";
import type {
  OrgResourceConfig,
  OrgFieldConfig,
  OrgFieldPolicy,
} from "@assignee/core";
import { log, LOG_ACTIONS } from "../utils/logger.js";

/**
 * Walk up from `startDir` looking for `.assignee/org-policy.yaml`.
 * Returns the resolved path if found, undefined otherwise.
 */
export function findProjectPolicyPath(startDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const root = path.parse(dir).root;

  while (dir !== root) {
    const candidate = path.join(dir, ".assignee", "org-policy.yaml");
    try {
      fs.accessSync(candidate, fs.constants.R_OK);
      return candidate;
    } catch {
      // Not found at this level — check for project root boundary
      const markers = [".git", "package.json"];
      if (
        markers.some((m) => {
          try {
            fs.accessSync(path.join(dir, m));
            return true;
          } catch {
            return false;
          }
        })
      ) {
        break; // Stop at project root
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Fallback: return cwd-based path (read will handle ENOENT gracefully)
  return path.join(startDir, ".assignee", "org-policy.yaml");
}

/**
 * Resolve the user-level org policy path.
 */
export function resolveUserPolicyPath(): string {
  return path.join(os.homedir(), ".config", "assignee", "org-policy.yaml");
}

/**
 * Attempt to read and parse a YAML file as OrgResourceConfig.
 * Returns undefined on any error (ENOENT, parse error, malformed structure).
 */
async function readPolicyFile(
  filePath: string,
): Promise<OrgResourceConfig | undefined> {
  try {
    const content = await fsPromises.readFile(filePath, "utf-8");
    const parsed: unknown = parseYaml(content);

    if (parsed === null || parsed === undefined || typeof parsed !== "object") {
      log({
        ts: new Date().toISOString(),
        runId: "system",
        level: "warn",
        action: LOG_ACTIONS.CONFIG_LOADED,
        extras: {
          path: filePath,
          reason: "empty or non-object org policy YAML",
        },
      });
      return undefined;
    }

    // Validate structure: Record<string, Record<string, { policy, value? }>>
    const obj = parsed as Record<string, unknown>;
    const result: OrgResourceConfig = {};

    for (const [resourceType, fields] of Object.entries(obj)) {
      if (typeof fields !== "object" || fields === null) {
        log({
          ts: new Date().toISOString(),
          runId: "system",
          level: "warn",
          action: LOG_ACTIONS.CONFIG_LOADED,
          extras: {
            path: filePath,
            reason: `malformed resource type entry: ${resourceType}`,
          },
        });
        return undefined;
      }

      const fieldMap: Record<string, OrgFieldConfig> = {};
      for (const [fieldName, fieldConfig] of Object.entries(
        fields as Record<string, unknown>,
      )) {
        if (typeof fieldConfig !== "object" || fieldConfig === null) {
          log({
            ts: new Date().toISOString(),
            runId: "system",
            level: "warn",
            action: LOG_ACTIONS.CONFIG_LOADED,
            extras: {
              path: filePath,
              reason: `malformed field config: ${resourceType}.${fieldName}`,
            },
          });
          return undefined;
        }

        const fc = fieldConfig as Record<string, unknown>;
        const policy = fc["policy"];
        if (
          policy !== "locked" &&
          policy !== "default" &&
          policy !== "always_ask"
        ) {
          log({
            ts: new Date().toISOString(),
            runId: "system",
            level: "warn",
            action: LOG_ACTIONS.CONFIG_LOADED,
            extras: {
              path: filePath,
              reason: `invalid policy '${policy}' for ${resourceType}.${fieldName}`,
            },
          });
          return undefined;
        }

        fieldMap[fieldName] = {
          policy: policy as OrgFieldPolicy,
          ...(fc["value"] !== undefined ? { value: fc["value"] } : {}),
        };
      }

      result[resourceType] = fieldMap;
    }

    return result;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // File not found — expected, not an error
      return undefined;
    }

    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.CONFIG_LOADED,
      extras: {
        reason:
          err instanceof Error
            ? err.message
            : "unknown error reading org policy",
      },
    });
    return undefined;
  }
}

/**
 * Deep-merge two org policies. `high` takes precedence over `low`
 * on field-level collisions (same resource type + field name).
 */
export function mergeOrgPolicies(
  low: OrgResourceConfig,
  high: OrgResourceConfig,
): OrgResourceConfig {
  const result: OrgResourceConfig = {};

  // Start with all resource types from low
  for (const [rt, fields] of Object.entries(low)) {
    result[rt] = { ...fields };
  }

  // Overlay high — wins on field-level collision
  for (const [rt, fields] of Object.entries(high)) {
    if (!result[rt]) {
      result[rt] = { ...fields };
    } else {
      result[rt] = { ...result[rt], ...fields };
    }
  }

  return result;
}

/**
 * Load the local org policy by reading project-level and user-level files.
 * Project-level has higher precedence. Returns undefined if no policy files exist.
 *
 * Never throws — all errors are logged as warnings and return undefined.
 */
export async function loadLocalOrgPolicy(
  cwd: string = process.cwd(),
): Promise<OrgResourceConfig | undefined> {
  const projectPath = path.join(cwd, ".assignee", "org-policy.yaml");
  const userPath = resolveUserPolicyPath();

  const [projectPolicy, userPolicy] = await Promise.all([
    readPolicyFile(projectPath),
    readPolicyFile(userPath),
  ]);

  if (!projectPolicy && !userPolicy) {
    return undefined;
  }

  if (projectPolicy && userPolicy) {
    // Deep-merge: project wins on field-level collision
    return mergeOrgPolicies(userPolicy, projectPolicy);
  }

  return projectPolicy ?? userPolicy;
}
