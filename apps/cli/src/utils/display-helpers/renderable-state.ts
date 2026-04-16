/**
 * Public types for display-layer inputs.
 *
 * Minimal shapes needed for rendering — avoid circular imports with graph.ts.
 */
import type { FreeTierNote } from "../free-tier.js";
import type { BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../../types/fix-finding.js";
import type { PricingBreakdown, DataSource } from "@assignee/core";

/**
 * Minimal compound-pattern shape for plan-box rendering. Mirrors the
 * relevant fields of `ArchitecturePattern` and `resourceQueue` without
 * pulling those types into display.ts (which would create a circular
 * import with graph-state.ts).
 */
export interface RenderableCompoundQueue {
  patternDisplayName: string;
  resources: ReadonlyArray<{
    resourceType: string;
    displayName?: string;
  }>;
}

/** Minimal state shape needed for rendering — avoids circular imports with graph.ts */
export interface RenderableState {
  resourceType: string;
  desiredState?: Record<string, unknown>;
  estimatedMonthlyCost?: string;
  /**
   * Story 46.2: provenance tag for `estimatedMonthlyCost`. When present,
   * `formatCostLine` appends a "(live)" / "(cached)" / "(estimated)" /
   * "(from log)" suffix so the user can tell where the dollar amount came
   * from. Free-tier resources tag `"free"` and get no suffix.
   */
  estimatedMonthlyCostSource?: DataSource;
  runId: string;
  resourceArn?: string;
  executionMode?: string;
  freeTierNote?: FreeTierNote;
  bpFindings?: BPFinding[];
  memoryHints?: string[];
  appliedFixes?: AppliedFix[];
  pricingBreakdown?: PricingBreakdown;
  verbose?: boolean;
  autoFixEnabled?: boolean;
  autoApprove?: boolean;
  adviceHints?: string[];
  sourceDir?: string;
  sourceFileCount?: number;
  // Tier S #3: when populated, the plan box renders a "Compound: N
  // resources" prelude listing every resource in the queue. Without
  // this, compound plans only displayed the first resource which
  // misled users about what was about to happen.
  compoundQueue?: RenderableCompoundQueue;
}
