/**
 * Shared type-only definitions for fixes + findings that would
 * otherwise force utils/ to import from services/ (a dependency
 * inversion flagged by the Epic 49 code audit, H8).
 *
 * Types live here so both layers depend on a lower-level module
 * rather than cross layers. `services/graph-state.ts` re-exports
 * these under their original names for backward compatibility with
 * the agent state graph.
 *
 * @see Story 49.7 (Epic 49) — utils→services inversion fix
 * @see Story 50-4 Wave 5 Pass C-2 — lifted into @assignee/core
 */

import type { DataSource } from "../pricing/types.js";

/** Security finding surfaced by the Well-Architected Security MCP / local heuristics. */
export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";
  title: string;
  recommendation: string;
  service: string;
  /**
   * Story 46.2: provenance.
   *  - "mcp"      → live response from the Well-Architected Security MCP
   *  - "fallback" → produced by a local heuristic (not currently used,
   *                  reserved for future degradation path)
   */
  source: DataSource;
}

/** Record of a best-practice finding that was automatically fixed (Story 22.2). */
export interface AppliedFix {
  practiceId: string;
  title: string;
  fieldPath: string;
  oldValue: unknown;
  newValue: unknown;
}
