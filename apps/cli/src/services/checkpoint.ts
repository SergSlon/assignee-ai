/**
 * Checkpoint serialization service — save/load/find domain-level plan checkpoints.
 *
 * @see Story 10.1
 * @see architecture.md#Checkpoint Serialization
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  PlanCheckpointSchema,
  CHECKPOINT_VERSION,
  CheckpointError,
  safeTry,
  type PlanCheckpoint,
} from "@assignee/core";
import type { AgentState } from "./graph-state.js";
import { CHECKPOINT_DEFAULT_TTL_HOURS } from "../config/constants.js";

/**
 * Extracts serializable fields from GraphState into a PlanCheckpoint.
 * Excludes: messages, resourceSchema, resourcePattern (non-serializable).
 */
export function serializeCheckpoint(state: AgentState): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: CHECKPOINT_DEFAULT_TTL_HOURS,
    runId: state.runId,
    userIntent: state.userIntent,
    resourceType: state.resourceType ?? "unknown",
    resourcePatternId: state.resourcePattern?.patternId ?? undefined,
    resourceQueue: state.resourceQueue
      ? state.resourceQueue.map((r) => ({
          resourceId: r.resourceId,
          resourceType: r.resourceType,
          displayName: r.displayName,
          desiredState: {},
        }))
      : undefined,
    desiredState: state.desiredState ?? {},
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? "N/A",
    preflightPassed: state.preflightPassed,
    elicitedOptions: state.elicitedOptions,
  };
}

/**
 * Writes a checkpoint to disk as JSON.
 * Creates the directory if it doesn't exist.
 *
 * @returns The absolute file path written.
 */
export async function saveCheckpoint(
  checkpoint: PlanCheckpoint,
  dir: string,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `checkpoint-${checkpoint.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  return filePath;
}

/**
 * Loads and validates a checkpoint by runId.
 * Throws CheckpointError on parse failure.
 */
export async function loadCheckpoint(
  runId: string,
  dir: string,
): Promise<PlanCheckpoint> {
  const filePath = path.join(dir, `checkpoint-${runId}.json`);
  const raw = await fs.readFile(filePath, "utf-8");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CheckpointError(
      `Corrupt checkpoint file (invalid JSON): ${filePath}`,
    );
  }
  const parsed = PlanCheckpointSchema.strict().safeParse(json);
  if (!parsed.success) {
    throw new CheckpointError(
      `Invalid checkpoint file: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

/**
 * Loads and validates a checkpoint from an explicit file path.
 * Validates schema, TTL, preflight status, and desiredState presence.
 *
 * @throws CheckpointError on missing file, invalid schema, expired TTL, or incomplete checkpoint.
 * @see Story 11.3
 */
export async function loadCheckpointFromPath(
  filePath: string,
): Promise<PlanCheckpoint> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new CheckpointError(
      `Checkpoint file not found: ${filePath}. Run \`assignee plan\` to create a new plan.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new CheckpointError(
      `Corrupt checkpoint file (invalid JSON): ${filePath}`,
    );
  }

  const parsed = PlanCheckpointSchema.strict().safeParse(json);
  if (!parsed.success) {
    throw new CheckpointError(
      `Invalid checkpoint file: ${parsed.error.message}`,
    );
  }

  const cp = parsed.data;

  // TTL validation
  const createdMs = new Date(cp.created_at).getTime();
  const expiresMs = createdMs + cp.ttl_hours * 60 * 60 * 1000;
  const now = Date.now();
  if (now > expiresMs) {
    const createdDate = new Date(cp.created_at).toLocaleString();
    throw new CheckpointError(
      `Checkpoint expired: created ${createdDate}, TTL ${cp.ttl_hours}h. Run \`assignee plan\` to create a new plan.`,
    );
  }

  // Validate checkpoint completeness for Phase 2
  if (!cp.preflightPassed) {
    throw new CheckpointError(
      `Checkpoint did not pass preflight validation. Run \`assignee plan\` to create a new plan.`,
    );
  }

  if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) {
    throw new CheckpointError(
      `Checkpoint has no desiredState. Run \`assignee plan\` to create a new plan.`,
    );
  }

  return cp;
}

/**
 * Scans a directory for checkpoint files, filters by TTL, returns the newest valid one.
 * Returns null if none are valid or the directory doesn't exist.
 */
export async function findNewestValidCheckpoint(
  dir: string,
): Promise<PlanCheckpoint | null> {
  const [readErr, entries] = await safeTry(fs.readdir(dir));
  if (readErr) return null;

  const checkpointFiles = entries.filter(
    (f) => f.startsWith("checkpoint-") && f.endsWith(".json"),
  );

  if (checkpointFiles.length === 0) return null;

  const now = Date.now();
  let newest: PlanCheckpoint | null = null;
  let newestTime = 0;

  for (const file of checkpointFiles) {
    const [err, raw] = await safeTry(
      fs.readFile(path.join(dir, file), "utf-8"),
    );
    if (err) continue;

    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      continue; // skip corrupt files
    }
    const parsed = PlanCheckpointSchema.safeParse(json);
    if (!parsed.success) continue;

    const cp = parsed.data;
    const createdMs = new Date(cp.created_at).getTime();
    const expiresMs = createdMs + cp.ttl_hours * 60 * 60 * 1000;

    if (now > expiresMs) continue; // expired

    if (createdMs > newestTime) {
      newest = cp;
      newestTime = createdMs;
    }
  }

  return newest;
}
