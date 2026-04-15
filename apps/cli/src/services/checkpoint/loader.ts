/**
 * Checkpoint path loader — validates schema, TTL, preflight status, and
 * desiredState presence; strips redacted placeholders before handing the
 * record to the apply engine.
 *
 * Extracted from checkpoint.ts during Wave-6c decomposition.
 *
 * @see Story 11.3
 */

import * as fs from "node:fs/promises";
import {
  PlanCheckpointSchema,
  CheckpointError,
  type PlanCheckpoint,
} from "@assignee/core";
import { stripRedactedFields } from "./redaction.js";
import { isCheckpointExpired } from "./ttl.js";

/**
 * Loads and validates a checkpoint from an explicit file path.
 * Validates schema, TTL, preflight status, and desiredState presence.
 *
 * @throws CheckpointError on missing file, invalid schema, expired TTL, or
 *   incomplete checkpoint.
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
    // Backup corrupt file for debugging
    try {
      await fs.copyFile(filePath, `${filePath}.corrupt.${Date.now()}`);
    } catch {
      /* best-effort */
    }
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
  if (isCheckpointExpired(cp)) {
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

  // Strip redacted fields so they are never sent to AWS on resume.
  // AWS will use defaults (e.g., auto-generated passwords) for omitted fields.
  cp.desiredState = stripRedactedFields(cp.desiredState);

  return cp;
}
