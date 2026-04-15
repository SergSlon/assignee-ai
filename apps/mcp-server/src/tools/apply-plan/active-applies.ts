/**
 * Concurrency guard for apply_plan — tracks the set of checkpoint
 * paths currently being applied so duplicate invocations are rejected
 * instead of provisioning the same plan twice.
 *
 * Module-level state is safe here because the MCP server is a single
 * long-lived process and the checkpoint path is the natural
 * primary key for a plan.
 */

const activeApplies = new Set<string>();

/** True if an apply for this checkpointPath is already in flight. */
export function isApplyActive(checkpointPath: string): boolean {
  return activeApplies.has(checkpointPath);
}

/** Register an apply as active. */
export function markApplyActive(checkpointPath: string): void {
  activeApplies.add(checkpointPath);
}

/** Release the active-apply lock for this checkpointPath. */
export function releaseApply(checkpointPath: string): void {
  activeApplies.delete(checkpointPath);
}

/** Exported for testing — clears the active-apply lock set. */
export function _resetActiveApplies(): void {
  activeApplies.clear();
}
