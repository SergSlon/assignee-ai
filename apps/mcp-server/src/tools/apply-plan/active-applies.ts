/**
 * Concurrency guard for apply_plan — tracks the set of checkpoint
 * paths currently being applied so duplicate invocations are rejected
 * instead of provisioning the same plan twice.
 *
 * Module-level state is safe here because the MCP server is a single
 * long-lived process and the checkpoint path is the natural
 * primary key for a plan.
 */

/**
 * Defense-in-depth ceiling on the active-applies set. Callers are
 * expected to release in `finally`, but a panic or missed error path
 * would leak an entry forever on a long-lived MCP process. Past this
 * cap, `markApplyActive` throws instead of silently growing.
 *
 * Operators with atypical scaling requirements (e.g. high-concurrency
 * CI fleets) can override via `ASSIGNEE_MCP_MAX_ACTIVE_APPLIES` — must
 * be a positive integer; any non-numeric / non-positive value falls
 * through to the built-in default so a typo doesn't silently disable
 * the guard (Story 56-it2-04 L3-L1).
 */
export const DEFAULT_MAX_ACTIVE_APPLIES = 100;

function resolveMaxActiveApplies(): number {
  const raw = process.env["ASSIGNEE_MCP_MAX_ACTIVE_APPLIES"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_MAX_ACTIVE_APPLIES;
  const parsed = Number(raw.trim());
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_MAX_ACTIVE_APPLIES;
  }
  return parsed;
}

export const MAX_ACTIVE_APPLIES = resolveMaxActiveApplies();

const activeApplies = new Set<string>();

/** True if an apply for this checkpointPath is already in flight. */
export function isApplyActive(checkpointPath: string): boolean {
  return activeApplies.has(checkpointPath);
}

/** Register an apply as active. */
export function markApplyActive(checkpointPath: string): void {
  if (
    activeApplies.size >= MAX_ACTIVE_APPLIES &&
    !activeApplies.has(checkpointPath)
  ) {
    // Story 56-it2-04 L5-L1: include the rejected checkpointPath so the
    // operator can correlate the throw with the specific apply that
    // overflowed (previous message showed only the cap, which meant
    // a post-mortem required guessing which checkpoint triggered it).
    throw new Error(
      `Active-applies cap reached (${MAX_ACTIVE_APPLIES}); rejected checkpoint "${checkpointPath}". This likely indicates a release leak; check apply-plan handler for missing finally/release paths.`,
    );
  }
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
