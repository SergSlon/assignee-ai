/**
 * PENDING / plan-mode formatter — emits either JSON (--output json) or the
 * table/boxen plan preview. Also handles the compound plan-mode advance
 * (skipping non-provisionable companion resources) and the Story 35.4
 * interactive fix selection prompt.
 */

import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import {
  promptFixSelection,
  renderPlanBox,
  type FixSelectionResult,
} from "@/utils/display.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { EnvVar } from "@/constants/env-vars.js";

interface PlanJsonPayload {
  resourceType: string | undefined;
  region: string;
  desiredState: unknown;
  estimatedMonthlyCost: unknown;
  pricingBreakdown: unknown;
  bpFindings: unknown[];
  appliedFixes: unknown[];
  freeTierNote: unknown;
  adviceHints: unknown[];
  resourcePattern?: {
    patternId: string;
    displayName: string;
    resourceCount: number;
  };
  resourceQueue?: Array<{
    resourceId: string;
    resourceType: string;
    displayName: string | undefined;
    provisionable: boolean;
  }> | null;
}

function buildPlanJsonPayload(state: AgentState): PlanJsonPayload {
  const region =
    process.env[EnvVar.AWS_REGION] ??
    process.env[EnvVar.AWS_DEFAULT_REGION] ??
    AWS_REGION;
  return {
    resourceType: state.resourceType,
    region,
    desiredState: state.desiredState ?? null,
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? null,
    pricingBreakdown: state.pricingBreakdown ?? null,
    bpFindings: state.bpFindings ?? [],
    appliedFixes: state.appliedFixes ?? [],
    freeTierNote: state.freeTierNote ?? null,
    adviceHints: state.adviceHints ?? [],
    ...(state.resourcePattern
      ? {
          resourcePattern: {
            patternId: state.resourcePattern.patternId,
            displayName: state.resourcePattern.displayName,
            resourceCount: state.resourceQueue?.length ?? 1,
          },
          resourceQueue:
            state.resourceQueue?.map((r) => ({
              resourceId: r.resourceId,
              resourceType: r.resourceType,
              displayName: r.displayName,
              provisionable: r.provisionable !== false,
            })) ?? null,
        }
      : {}),
  };
}

/**
 * Attach the compound queue to the state so renderPlanBox prints the full
 * "Compound: N resources" listing inside the boxen frame (Tier S #3).
 */
function attachCompoundQueue(state: AgentState): AgentState {
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.resourceQueue.length > 0
  ) {
    return {
      ...state,
      compoundQueue: {
        patternDisplayName: state.resourcePattern.displayName,
        resources: state.resourceQueue.map((r) => ({
          resourceType: r.resourceType,
          ...(r.displayName ? { displayName: r.displayName } : {}),
        })),
      },
    } as AgentState;
  }
  return state;
}

export async function formatPlanResult(
  state: AgentState,
): Promise<Partial<AgentState>> {
  let fixResult: FixSelectionResult | null = null;

  const isPlanRender =
    state.executionMode === ExecutionMode.PLAN ||
    (state.executionMode === ExecutionMode.APPLY && !state.preflightPassed);

  if (isPlanRender) {
    if (state.outputFormat === "json") {
      process.stdout.write(
        JSON.stringify(buildPlanJsonPayload(state), null, 2) + "\n",
      );
    } else {
      const stateWithQueue = attachCompoundQueue(state);
      renderPlanBox(stateWithQueue);

      fixResult = await promptFixSelection(state);
      if (fixResult) {
        const updatedState = {
          ...stateWithQueue,
          desiredState: fixResult.desiredState,
          bpFindings: fixResult.bpFindings,
          appliedFixes: fixResult.appliedFixes,
        };
        renderPlanBox(updatedState);
      }
    }
  }

  // Compound plan-mode queue advance.
  if (
    state.executionMode === ExecutionMode.PLAN &&
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined
  ) {
    let nextIndex = state.currentResourceIndex + 1;
    while (
      nextIndex < state.resourceQueue.length &&
      state.resourceQueue[nextIndex]?.provisionable === false
    ) {
      nextIndex++;
    }

    const advance: Partial<AgentState> =
      nextIndex < state.resourceQueue.length
        ? {
            currentResourceIndex: nextIndex,
            resourceType: state.resourceQueue[nextIndex]!.resourceType,
            desiredState: undefined,
            executionStatus: ExecutionStatus.PENDING,
          }
        : // All resources planned — advance past end so the router sends to END.
          { currentResourceIndex: state.resourceQueue.length };

    if (fixResult) {
      // Spread advance FIRST so fixResult fields win (advance.desiredState
      // is undefined which would overwrite the user's applied fix).
      return {
        ...advance,
        desiredState: fixResult.desiredState,
        bpFindings: fixResult.bpFindings,
        appliedFixes: fixResult.appliedFixes,
      };
    }
    return advance;
  }

  if (fixResult) {
    return {
      desiredState: fixResult.desiredState,
      bpFindings: fixResult.bpFindings,
      appliedFixes: fixResult.appliedFixes,
    };
  }
  return {};
}
