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
 * @see Story 10.1
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
          desiredState: {},
        }))
      : undefined,
    desiredState: redactSensitiveFields(state.desiredState ?? {}),
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
    preflightPassed: state.preflightPassed ?? false,
    elicitedOptions: state.elicitedOptions,
  };
}
