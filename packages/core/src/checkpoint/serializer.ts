/**
 * Serialize graph state into a PlanCheckpoint by extracting only
 * persistable fields and redacting sensitive values.
 *
 * Extracted from apps/cli during Wave-6c; promoted to @assignee/core by
 * Story 50-4 so apps/mcp-server and apps/cli produce identical
 * checkpoint JSON. The function operates on a structural input shape
 * (`SerializableGraphState`) rather than a CLI-specific `AgentState`
 * type, so either app can pass its graph result without a cross-app
 * dependency.
 *
 * Story e92.1.d (Epic 89 regression C-05): each `resourceQueue[i]`
 * may now carry its own fully-elicited `desiredState`; the serializer
 * redacts and persists it instead of the pre-Epic-92 `{}` literal.
 * Additive fields `currentResourceIndex` + `completedResources` are
 * persisted too so resume can skip already-provisioned slices of the
 * queue. All new input fields are OPTIONAL — callers that have not yet
 * been updated keep producing the pre-Epic-92 `{}` shape and are
 * still schema-valid.
 *
 * @see Story 10.1, Story e92.1.d
 */

import { CHECKPOINT_VERSION } from "../schema/checkpoint.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";
import { UNKNOWN_FALLBACK } from "../config/cfn-keys/defaults.js";
import { redactSensitiveFields } from "./redaction.js";
import { CHECKPOINT_DEFAULT_TTL_HOURS } from "./constants.js";

/**
 * Structural shape consumed by `serializeCheckpoint`. Matches the
 * persistable subset of CLI's `AgentState` and MCP's graph invoke
 * result. Neither app depends on the other — they both conform to
 * this shape.
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
    /**
     * Story e92.1.d: callers that have accumulated per-resource
     * desiredState during compound planning pass it here. When
     * omitted the serializer writes `{}` (pre-Epic-92 behaviour).
     */
    desiredState?: Record<string, unknown>;
  }>;
  /**
   * Story e92.1.d: index into `resourceQueue` of the next resource
   * to plan/apply. Omitted → persisted as `0`.
   */
  currentResourceIndex?: number;
  /**
   * Story e92.1.d: already-provisioned resources accumulated by the
   * compound loop. Only `resourceArn` + `resourceType` are persisted
   * (other `ResourceResult` fields are graph-internal). Entries
   * without an ARN (e.g. mid-provision failures) are skipped —
   * resume cannot act on a half-provisioned resource.
   */
  completedResources?: Array<{
    resourceArn?: string;
    resourceType: string;
  }>;
}

/**
 * Extracts serializable fields from graph state into a PlanCheckpoint.
 * Excludes non-serializable fields (messages, resourceSchema, etc.).
 * Redacts sensitive values (MasterUserPassword, SecretString, AKIA-
 * pattern strings, etc.) from desiredState before writing to disk.
 *
 * Epic 94 Wave 3 N7 (C-02 HIGH REGRESSION): two persistence fixes.
 *   (1) `currentResourceIndex` is derived from `completedResources`
 *       length, NOT taken from `state.currentResourceIndex` directly.
 *       Why: the plan-mode formatter advances the live state past the
 *       end of the queue (`state.currentResourceIndex =
 *       state.resourceQueue.length`) so the END router triggers. That
 *       terminal overflow is graph-internal plumbing — on disk the
 *       semantic is "next resource to apply", which is always
 *       `completedResources.length`. Persisting the overflow causes
 *       apply-resume to skip the entire queue. Clamping below also
 *       guarantees we never write an out-of-range index for a
 *       resume-partial checkpoint.
 *   (2) Per-queue `desiredState` is populated from the top-level
 *       `state.desiredState` when the queue entry at
 *       `completedResources.length` has empty state and the top-level
 *       state resource-type matches. This closes the final-slot
 *       persistence gap: after plan completes, the top-level
 *       `state.desiredState` is whatever plan-generator last produced
 *       (the last-queue-entry's state), and the caller has no
 *       opportunity to push it back into the spec. We opportunistically
 *       backfill so the checkpoint isn't missing the final slot.
 */
export function serializeCheckpoint(
  state: SerializableGraphState,
): PlanCheckpoint {
  // Filter the persistable completions first — we use the filtered
  // length as the canonical "next to apply" index (see (1) above).
  const persistableCompletions = (state.completedResources ?? [])
    // Skip entries without an ARN — a half-provisioned resource
    // has no handle we can skip on resume, so it must be re-
    // planned rather than silently assumed complete.
    .filter(
      (r): r is { resourceArn: string; resourceType: string } =>
        typeof r.resourceArn === "string" && r.resourceArn.length > 0,
    );

  // Canonical on-disk "next to apply" index. Falls back to the raw
  // `state.currentResourceIndex` only when no completions exist AND
  // the raw value is in bounds — used by mid-apply crash-recovery
  // tests that prime the in-memory index without populating
  // completions. The final `?? 0` is a defensive fallback for the
  // pre-Epic-92 call shape.
  const queueLen = state.resourceQueue?.length ?? 0;
  const rawIndex = state.currentResourceIndex;
  const clampedIndex =
    persistableCompletions.length > 0
      ? persistableCompletions.length
      : rawIndex !== undefined && rawIndex >= 0 && rawIndex < queueLen
        ? rawIndex
        : 0;

  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: CHECKPOINT_DEFAULT_TTL_HOURS,
    runId: state.runId,
    userIntent: state.userIntent,
    resourceType: state.resourceType ?? UNKNOWN_FALLBACK,
    resourcePatternId: state.resourcePattern?.patternId ?? undefined,
    resourceQueue: state.resourceQueue
      ? state.resourceQueue.map((r, i) => {
          // Story e92.1.d: persist the fully-elicited per-resource
          // desiredState when the caller supplied one.
          //
          // Epic 94 N7 (C-02) — backfill rule: if this queue slot is
          // the one whose top-level state the caller never stashed
          // back (the last-planned resource in plan-mode: its slot
          // sits at `state.currentResourceIndex` OR the final queue
          // index), and the top-level `state.desiredState` is non-
          // empty AND its resource type matches this slot's type,
          // adopt the top-level state as the slot's persisted
          // desiredState. Keeps existing per-slot state authoritative
          // when the caller DID stash one.
          const slotDesiredState =
            r.desiredState ?? backfillSlotDesiredState(state, r, i, queueLen);
          return {
            resourceId: r.resourceId,
            resourceType: r.resourceType,
            displayName: r.displayName,
            desiredState: slotDesiredState
              ? redactSensitiveFields(slotDesiredState)
              : {},
          };
        })
      : undefined,
    desiredState: redactSensitiveFields(state.desiredState ?? {}),
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
    preflightPassed: state.preflightPassed ?? false,
    elicitedOptions: state.elicitedOptions,
    currentResourceIndex: clampedIndex,
    completedResources: persistableCompletions.map((r) => ({
      resourceArn: r.resourceArn,
      resourceType: r.resourceType,
    })),
  };
}

/**
 * Epic 94 N7 (C-02) backfill helper for the last-planned queue slot.
 *
 * Plan-mode compound rendering leaves the final resource's
 * desiredState on `state.desiredState` and never pushes it back into
 * `resourceQueue[i].desiredState` — the formatter advances
 * `currentResourceIndex` past the end of the queue and returns,
 * which terminates the graph before any stash can happen. Without
 * this backfill the final queue slot round-trips as `{}` on disk,
 * and apply-resume cannot re-plan the last compound resource from
 * checkpoint alone.
 *
 * Rules for backfilling:
 *   - Only the slot at `state.currentResourceIndex` (when in
 *     bounds) OR the last queue slot when the index has overflowed
 *     past the end.
 *   - The slot's resourceType must match `state.resourceType` — the
 *     top-level state always belongs to the currently-planned
 *     resource, so a mismatch means the caller never cycled through
 *     this slot.
 *   - The top-level `state.desiredState` must be a non-empty object.
 *
 * Returns the adopted desiredState object or `undefined` when no
 * backfill applies (caller falls back to `{}`).
 */
function backfillSlotDesiredState(
  state: SerializableGraphState,
  slot: NonNullable<SerializableGraphState["resourceQueue"]>[number],
  slotIndex: number,
  queueLen: number,
): Record<string, unknown> | undefined {
  if (
    !state.desiredState ||
    Object.keys(state.desiredState).length === 0 ||
    queueLen === 0
  ) {
    return undefined;
  }
  const rawIndex = state.currentResourceIndex;
  const targetIndex =
    rawIndex !== undefined && rawIndex >= 0 && rawIndex < queueLen
      ? rawIndex
      : queueLen - 1; // overflowed past end → last slot
  if (slotIndex !== targetIndex) return undefined;
  if (
    state.resourceType !== undefined &&
    state.resourceType !== slot.resourceType
  ) {
    return undefined;
  }
  return state.desiredState;
}
