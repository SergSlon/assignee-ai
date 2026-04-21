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
    resourceType: state.resourceType ?? UNKNOWN_FALLBACK,
    resourcePatternId: state.resourcePattern?.patternId ?? undefined,
    resourceQueue: state.resourceQueue
      ? state.resourceQueue.map((r) => ({
          resourceId: r.resourceId,
          resourceType: r.resourceType,
          displayName: r.displayName,
          // Story e92.1.d: persist the fully-elicited per-resource
          // desiredState when the caller supplied one. Redact through
          // the same allowlist the top-level desiredState uses so
          // MasterUserPassword/SecretString/etc never land on disk.
          // Fall back to `{}` when the caller (pre-Epic-92 path) did
          // not accumulate per-resource state.
          desiredState: r.desiredState
            ? redactSensitiveFields(r.desiredState)
            : {},
        }))
      : undefined,
    desiredState: redactSensitiveFields(state.desiredState ?? {}),
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
    preflightPassed: state.preflightPassed ?? false,
    elicitedOptions: state.elicitedOptions,
    // Story e92.1.d: partial-apply resume. Default to 0/[] so
    // single-resource checkpoints keep a uniform on-disk shape even
    // though they never advance the index.
    currentResourceIndex: state.currentResourceIndex ?? 0,
    completedResources: (state.completedResources ?? [])
      // Skip entries without an ARN — a half-provisioned resource
      // has no handle we can skip on resume, so it must be re-
      // planned rather than silently assumed complete.
      .filter(
        (r): r is { resourceArn: string; resourceType: string } =>
          typeof r.resourceArn === "string" && r.resourceArn.length > 0,
      )
      .map((r) => ({
        resourceArn: r.resourceArn,
        resourceType: r.resourceType,
      })),
  };
}
