/**
 * Checkpoint TTL arithmetic — single source of truth for the expiry check
 * shared by the loader, auto-detect, and pruner modules.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4 so apps/mcp-server and apps/cli share one expiry definition.
 */

import type { PlanCheckpoint } from "../schema/checkpoint.js";

/**
 * Checks whether a checkpoint has exceeded its TTL.
 */
export function isCheckpointExpired(checkpoint: PlanCheckpoint): boolean {
  const createdMs = new Date(checkpoint.created_at).getTime();
  const expiresMs = createdMs + checkpoint.ttl_hours * 60 * 60 * 1000;
  return Date.now() > expiresMs;
}
