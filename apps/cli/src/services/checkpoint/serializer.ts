/**
 * Serialize AgentState into a PlanCheckpoint by extracting only persistable
 * fields and redacting sensitive values.
 *
 * Extracted from checkpoint.ts during Wave-6c decomposition.
 *
 * @see Story 10.1
 */

import {
  CHECKPOINT_VERSION,
  CostEstimateLabel,
  type PlanCheckpoint,
} from "@assignee/core";
import type { AgentState } from "../graph-state.js";
import {
  CHECKPOINT_DEFAULT_TTL_HOURS,
  UNKNOWN_FALLBACK,
} from "../../config/constants.js";
import { redactSensitiveFields } from "./redaction.js";

/**
 * Extracts serializable fields from GraphState into a PlanCheckpoint.
 * Excludes: messages, resourceSchema, resourcePattern (non-serializable).
 * Redacts sensitive fields (MasterUserPassword, SecretString) from desiredState.
 */
export function serializeCheckpoint(state: AgentState): PlanCheckpoint {
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
    preflightPassed: state.preflightPassed,
    elicitedOptions: state.elicitedOptions,
  };
}
