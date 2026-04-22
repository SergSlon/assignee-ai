/**
 * PENDING / plan-mode formatter — emits either JSON (--output json) or the
 * table/boxen plan preview. Also handles the compound plan-mode advance
 * (skipping non-provisionable companion resources) and the Story 35.4
 * interactive fix selection prompt.
 *
 * Epic 92 Wave 4 (e92.4.a):
 *  - sanitizeDesiredState drops empty-string / null / undefined rows so
 *    the plan box no longer shows "CPU Credits:  " empty rows (A-19).
 *  - normalizeMemoryHints strips duplicated trailing "/month" or "/mo"
 *    suffixes so cost-history lines no longer render "$0.0230/GB-month/month"
 *    or "$3.00/mo/mo" (A-19 / D-35). Storage format is unchanged; the
 *    normalizer is a read-side fix and accepts both old (double-unit
 *    legacy) and new (single-unit) input.
 */

import { ExecutionMode, ExecutionStatus } from "@/index.js";
import type { AgentState } from "@/graph/graph-state.js";
import type { Advisory } from "@/graph/nodes/intent-parser.js";
import {
  promptFixSelection,
  renderPlanBox,
  type FixSelectionResult,
} from "@/utils/display.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { EnvVar } from "@/constants/env-vars.js";

/**
 * Epic 92 Wave 4 (e92.4.a) / A-19: strip rows whose value is empty-string,
 * `undefined`, or `null` so the plan renderer does not produce
 * "CPU Credits:  " empty lines.
 *
 * Preserves `false`, `0`, empty arrays, empty objects — those are
 * deliberate values the user set (and render meaningfully downstream).
 * Only the three "no signal" markers are dropped.
 *
 * Pure function. Returns `undefined` when input is `undefined` so the
 * caller can skip the computation for non-state paths.
 */
export function sanitizeDesiredState(
  state: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (state === undefined) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(state)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value === "") continue;
    out[key] = value;
  }
  return out;
}

/**
 * Epic 92 Wave 4 (e92.4.a) / A-19 / D-35: collapse repeated trailing
 * unit suffixes on cost-history memory-hint strings.
 *
 * Examples:
 *   - `"Previous provision of this type: $0.0230/GB-month/month (...)"` →
 *     `"Previous provision of this type: $0.0230/GB-month (...)"`
 *   - `"Previous provision: $3.00/mo/mo"` → `"Previous provision: $3.00/mo"`
 *   - `"Previous provision: $5/month/mo"` → `"Previous provision: $5/month"`
 *   - Already-clean lines pass through unchanged.
 *
 * Invariant: cost-history storage format is unchanged. This normalizer
 * accepts BOTH already-clean and legacy-duplicated input, so older
 * provision-log entries keep rendering correctly after the upstream
 * llm-helpers.ts:63 fix lands in a sibling wave.
 */
export function normalizeMemoryHints(
  hints: string[] | undefined,
): string[] | undefined {
  if (hints === undefined) return undefined;
  return hints.map((hint) => collapseDuplicateMonthSuffix(hint));
}

function collapseDuplicateMonthSuffix(line: string): string {
  // Strip a spurious trailing "/month" or "/mo" from a cost token when
  // the preceding unit segment ALREADY ends in "month" or "mo".
  //
  // Handles both simple and compound units:
  //   "$3.00/mo/mo"           → "$3.00/mo"
  //   "$5/month/mo"           → "$5/month"
  //   "$0.0230/GB-month/month" → "$0.0230/GB-month"
  //   "$1.50/per-mo/mo"       → "$1.50/per-mo"
  //
  // Pattern anatomy:
  //   (month|mo)     — the tail of an existing unit segment
  //   \/(?:month|mo) — the spurious trailing `/month` or `/mo`
  //   (?=[\s.,)]|$)  — must be at a word boundary, so we don't touch
  //                    URL-like "/month/api" paths.
  //
  // Repeated passes handle triple-concat ("/mo/mo/mo") until stable.
  const pattern = /(month|mo)\/(?:month|mo)(?=[\s.,)]|$)/g;
  let prev = line;
  // Bounded at 8 passes defensively; in practice we see at most 2.
  for (let i = 0; i < 8; i++) {
    const next = prev.replace(pattern, "$1");
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

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
  /**
   * Non-blocking structured advisories — emitted by the intent-parser
   * when a token was silently altered (e.g. multi-word name remainder
   * was dropped). Distinct from `bpFindings` (best-practice violations)
   * and `adviceHints` (free-form tips). Epic 94 R8.
   */
  advisories: Advisory[];
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
  // Epic 92 Wave 4 (e92.4.a) / A-19: strip empty-valued rows so JSON
  // consumers don't see `"CPU Credits": ""` noise either.
  const cleanDesiredState = sanitizeDesiredState(state.desiredState);
  return {
    resourceType: state.resourceType,
    region,
    desiredState: cleanDesiredState ?? null,
    estimatedMonthlyCost: state.estimatedMonthlyCost ?? null,
    pricingBreakdown: state.pricingBreakdown ?? null,
    bpFindings: state.bpFindings ?? [],
    appliedFixes: state.appliedFixes ?? [],
    freeTierNote: state.freeTierNote ?? null,
    adviceHints: state.adviceHints ?? [],
    advisories: state.advisories ?? [],
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
 *
 * Epic 92 Wave 4 (e92.4.a): also normalizes the read-side state passed
 * to renderPlanBox. This is the single chokepoint where both JSON and
 * box rendering see the same sanitized input:
 *   - empty desiredState rows are dropped (A-19).
 *   - cost-history memory hints have duplicate "/month" / "/mo" suffix
 *     pairs collapsed (A-19 / D-35).
 */
function attachCompoundQueue(state: AgentState): AgentState {
  const cleanDesiredState = sanitizeDesiredState(state.desiredState);
  const cleanMemoryHints = normalizeMemoryHints(state.memoryHints);
  const base: AgentState = {
    ...state,
    // Only overwrite when the sanitizer returned a defined value; keep
    // `undefined` semantics intact for "no state yet" plan paths.
    ...(cleanDesiredState !== undefined
      ? { desiredState: cleanDesiredState }
      : {}),
    ...(cleanMemoryHints !== undefined
      ? { memoryHints: cleanMemoryHints }
      : {}),
  };
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.resourceQueue.length > 0
  ) {
    return {
      ...base,
      compoundQueue: {
        patternDisplayName: state.resourcePattern.displayName,
        resources: state.resourceQueue.map((r) => ({
          resourceType: r.resourceType,
          ...(r.displayName ? { displayName: r.displayName } : {}),
        })),
      },
    } as AgentState;
  }
  return base;
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
