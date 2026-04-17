/**
 * Checkpoint path loader — validates schema, TTL, preflight status, and
 * desiredState presence; strips redacted placeholders before handing the
 * record to the apply engine.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4 so apps/mcp-server and apps/cli load checkpoints through a
 * single validated path.
 *
 * MCP-specific HMAC integrity verification plugs in via the optional
 * `verifyIntegrity` callback — it runs AFTER schema/TTL/preflight/
 * desiredState checks but BEFORE redacted fields are stripped (so the
 * hash computed here matches the hash MCP registered at save time).
 *
 * @see Story 11.3, Story 50-5 B-2
 */

import * as fs from "node:fs/promises";
import {
  PlanCheckpointSchema,
  type PlanCheckpoint,
} from "../schema/checkpoint.js";
import { CheckpointError } from "../errors.js";
import { stripRedactedFields } from "./redaction.js";
import { isCheckpointExpired } from "./ttl.js";

/**
 * Optional integrity verification hook. Called with the fully-parsed
 * checkpoint after schema/TTL/preflight/desiredState checks pass and
 * before redacted placeholders are stripped. Throw to refuse the load;
 * return normally to accept. MCP's HMAC layer plugs in here.
 */
export type CheckpointVerifier = (
  filePath: string,
  cp: PlanCheckpoint,
) => void | Promise<void>;

/**
 * Loads and validates a checkpoint from an explicit file path.
 * Validates schema, TTL, preflight status, and desiredState presence.
 *
 * @param filePath Absolute path to the checkpoint JSON file.
 * @param options.verifyIntegrity Optional per-app integrity hook. MCP
 *   passes its HMAC verifier so an attacker cannot plant a file this
 *   process never wrote and have it accepted on resume. CLI can omit
 *   the option — it doesn't have per-process secrets.
 * @param options.missingFileMessage Optional override for the error
 *   message shown when the file is missing. Apps use this to steer the
 *   user to their own "run X to regenerate" command.
 * @param options.expiredMessage Optional override for the TTL-expired
 *   error message.
 * @param options.preflightFailedMessage Optional override for the
 *   preflight-failed error message.
 * @param options.emptyDesiredStateMessage Optional override for the
 *   empty-desiredState error message.
 * @throws CheckpointError on missing file, invalid schema, expired TTL,
 *   incomplete checkpoint, or integrity-check failure.
 */
export async function loadCheckpointFromPath(
  filePath: string,
  options: {
    verifyIntegrity?: CheckpointVerifier;
    missingFileMessage?: string;
    expiredMessage?: (createdDate: string, ttlHours: number) => string;
    preflightFailedMessage?: string;
    emptyDesiredStateMessage?: string;
  } = {},
): Promise<PlanCheckpoint> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf-8");
  } catch {
    throw new CheckpointError(
      options.missingFileMessage ??
        `Checkpoint file not found: ${filePath}. Run \`assignee plan\` to create a new plan.`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    // Backup corrupt file for debugging (best-effort).
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
      options.expiredMessage
        ? options.expiredMessage(createdDate, cp.ttl_hours)
        : `Checkpoint expired: created ${createdDate}, TTL ${cp.ttl_hours}h. Run \`assignee plan\` to create a new plan.`,
    );
  }

  // Validate checkpoint completeness for Phase 2
  if (!cp.preflightPassed) {
    throw new CheckpointError(
      options.preflightFailedMessage ??
        `Checkpoint did not pass preflight validation. Run \`assignee plan\` to create a new plan.`,
    );
  }

  if (!cp.desiredState || Object.keys(cp.desiredState).length === 0) {
    throw new CheckpointError(
      options.emptyDesiredStateMessage ??
        `Checkpoint has no desiredState. Run \`assignee plan\` to create a new plan.`,
    );
  }

  // Story 50-5 B-2: optional per-app integrity verification
  // (MCP plugs in its HMAC verifier). Runs BEFORE
  // stripRedactedFields mutates the state so the hash on load
  // matches the hash computed at save time.
  if (options.verifyIntegrity) {
    await options.verifyIntegrity(filePath, cp);
  }

  // Strip redacted fields so they are never sent to AWS on resume.
  // AWS will use defaults (e.g., auto-generated passwords) for omitted fields.
  cp.desiredState = stripRedactedFields(cp.desiredState);

  return cp;
}
