/**
 * Checkpoint serialization and loading service for MCP server.
 *
 * Story 50-4 consolidated the serialize/save/load/redact helpers into
 * `@assignee/core/checkpoint` so MCP and CLI share one implementation.
 * This module is now a thin MCP-only wrapper that plugs the per-process
 * HMAC integrity layer (see ./checkpoint-hmac.ts) into the shared core
 * via:
 *   - `saveCheckpoint`: delegates to core, then registers an HMAC over
 *     `(canonical-path, sha256(desiredState))` under an in-memory map.
 *   - `loadCheckpointFromPath`: passes a `verifyIntegrity` hook into
 *     core's loader; the hook fails closed if the file was not written
 *     by THIS process, or its desiredState has been mutated after save.
 *
 * Post-restart resume is refused by design — the HMAC secret is
 * regenerated per process. Operators re-plan after a server restart.
 *
 * @see Story 20.2, Story 20.3, Story 10.1, Story 50-5, Story 50-4
 */

import * as path from "node:path";
import * as os from "node:os";
import { CheckpointError, type PlanCheckpoint } from "@assignee/core";
import {
  saveCheckpoint as coreSaveCheckpoint,
  loadCheckpointFromPath as coreLoadCheckpointFromPath,
  serializeCheckpoint as coreSerializeCheckpoint,
  type SerializableGraphState,
} from "@assignee/core/checkpoint";
import {
  canonicalizeCheckpointPath,
  computeDesiredStateHash,
  signCheckpoint,
  verifyCheckpoint,
} from "./checkpoint-hmac.js";

/** MCP checkpoint directory — uses /tmp to avoid assuming a project directory. */
export const MCP_CHECKPOINT_DIR = path.join(
  os.tmpdir(),
  "assignee-mcp-checkpoints",
);

export type { SerializableGraphState };

/**
 * Extracts serializable fields from graph state into a PlanCheckpoint.
 * Delegates to `@assignee/core/checkpoint`.
 */
export function serializeCheckpoint(
  state: SerializableGraphState,
): PlanCheckpoint {
  return coreSerializeCheckpoint(state);
}

/**
 * Writes a checkpoint to disk and registers its HMAC integrity
 * signature in-process.
 *
 * Security bolts from Story 50-5 (B-1, B-2) preserved:
 *   - B-1: dir 0o700, file 0o600, atomic temp+rename — enforced by
 *     `@assignee/core/checkpoint#saveCheckpoint`.
 *   - B-2: `(canonical-path, sha256(desiredState))` signed with a
 *     per-process HMAC secret held in ./checkpoint-hmac.ts. Done AFTER
 *     the atomic rename so a failed write never pollutes the map.
 *
 * @returns The absolute file path written.
 */
export async function saveCheckpoint(
  checkpoint: PlanCheckpoint,
  dir: string = MCP_CHECKPOINT_DIR,
): Promise<string> {
  const filePath = await coreSaveCheckpoint(checkpoint, dir);
  // Story 50-5 B-2: register the HMAC AFTER the rename so a failed
  // write never pollutes the integrity map.
  const canonical = canonicalizeCheckpointPath(filePath);
  const desiredStateHash = computeDesiredStateHash(
    checkpoint.desiredState ?? {},
  );
  signCheckpoint(canonical, desiredStateHash);
  return filePath;
}

/**
 * Loads and validates a checkpoint from an explicit file path. Refuses
 * to load when the in-process HMAC signature does not match — i.e.
 * when the file was not written by this MCP server process or its
 * desiredState was modified after writing.
 *
 * @throws CheckpointError on missing file, invalid schema, expired
 *   TTL, incomplete checkpoint, or HMAC mismatch.
 * @see Story 50-5 B-2
 */
export async function loadCheckpointFromPath(
  filePath: string,
): Promise<PlanCheckpoint> {
  return coreLoadCheckpointFromPath(filePath, {
    missingFileMessage: `Checkpoint file not found: ${filePath}. Run plan_resource first to generate a plan.`,
    expiredMessage: (createdDate, ttlHours) =>
      `Checkpoint expired: created ${createdDate}, TTL ${ttlHours}h. Run plan_resource to generate a new plan.`,
    preflightFailedMessage:
      "Checkpoint did not pass preflight validation. Run plan_resource to generate a new plan.",
    emptyDesiredStateMessage:
      "Checkpoint has no desiredState. Run plan_resource to generate a new plan.",
    verifyIntegrity: (file, cp) => {
      // Story 50-5 B-2: HMAC integrity check over
      // (canonical-path, sha256(desiredState)). Runs BEFORE
      // stripRedactedFields (core's loader guarantees this ordering)
      // so the hash on load matches the hash computed at save time.
      const canonical = canonicalizeCheckpointPath(file);
      const desiredStateHash = computeDesiredStateHash(cp.desiredState);
      const integrity = verifyCheckpoint(canonical, desiredStateHash);
      if (!integrity.ok) {
        // W18-S2 (DEF-07 M-β-012/013): switch on reason so the message
        // steers the operator to the most likely remediation.
        const detail =
          integrity.reason === "not-registered"
            ? "The file was not produced by this MCP server process. If the server was restarted between plan and apply, in-memory integrity keys are regenerated per process — re-plan to continue."
            : "The file was produced by this process but its contents have been modified after writing. Investigate for tampering and re-plan.";
        throw new CheckpointError(
          `Checkpoint integrity check failed: ${file}. ${detail} Run plan_resource to generate a new plan.`,
        );
      }
    },
  });
}
