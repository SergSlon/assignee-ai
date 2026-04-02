/**
 * Checkpoint serialization and loading service for MCP server.
 * Ported from apps/cli/src/services/checkpoint.ts — provides serializeCheckpoint,
 * saveCheckpoint (Story 20.2) and loadCheckpointFromPath (Story 20.3).
 *
 * @see Story 20.2, Story 20.3, Story 10.1
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  PlanCheckpointSchema,
  CHECKPOINT_VERSION,
  CheckpointError,
  CostEstimateLabel,
  type PlanCheckpoint,
} from "@assignee/core";

/** Default TTL for checkpoint expiry validation (72 hours). */
const CHECKPOINT_DEFAULT_TTL_HOURS = 72;

/** MCP checkpoint directory — uses /tmp to avoid assuming a project directory. */
export const MCP_CHECKPOINT_DIR = path.join(
  os.tmpdir(),
  "assignee-mcp-checkpoints",
);

/**
 * Serializable state fields extracted from the graph final state.
 * Matches the shape of AgentState from the CLI's graph-state.ts.
 */
export interface SerializableGraphState {
  runId: string;
  userIntent: string;
  resourceType?: string;
  desiredState?: Record<string, unknown>;
  estimatedMonthlyCost?: string;
  preflightPassed?: boolean;
  elicitedOptions?: Record<string, unknown>;
  resourcePattern?: { patternId?: string };
  resourceQueue?: Array<{
    resourceId: string;
    resourceType: string;
    displayName: string;
  }>;
}

/**
 * Extracts serializable fields from graph state into a PlanCheckpoint.
 * Mirrors the CLI's serializeCheckpoint but operates on a plain object
 * (the graph invoke result) rather than the typed AgentState.
 */
export function serializeCheckpoint(
  state: SerializableGraphState,
): PlanCheckpoint {
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
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
    preflightPassed: state.preflightPassed ?? false,
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
  dir: string = MCP_CHECKPOINT_DIR,
): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `checkpoint-${checkpoint.runId}.json`);
  await fs.writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf-8");
  return filePath;
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
      `Checkpoint file not found: ${filePath}. Run plan_resource first to generate a plan.`,
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
  const ttlHours = cp.ttl_hours ?? CHECKPOINT_DEFAULT_TTL_HOURS;
  const createdMs = new Date(cp.created_at).getTime();
  const expiresMs = createdMs + ttlHours * 60 * 60 * 1000;
  const now = Date.now();
  if (now > expiresMs) {
    const createdDate = new Date(cp.created_at).toLocaleString();
    throw new CheckpointError(
      `Checkpoint expired: created ${createdDate}, TTL ${ttlHours}h. Run plan_resource to generate a new plan.`,
    );
  }

  // Validate checkpoint completeness for provisioning
  if (!cp.preflightPassed) {
    throw new CheckpointError(
      `Checkpoint did not pass preflight validation. Run plan_resource to generate a new plan.`,
    );
  }

  if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) {
    throw new CheckpointError(
      `Checkpoint has no desiredState. Run plan_resource to generate a new plan.`,
    );
  }

  return cp;
}
