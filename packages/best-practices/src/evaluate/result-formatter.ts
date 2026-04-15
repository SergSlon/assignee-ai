/**
 * Result formatter — builds the BPFinding surface from a triggered rule.
 * Split from evaluate.ts (W6d F3). Display/copy decisions live here so the
 * rule-runner can stay focused on pass/fail logic.
 */

import type { BestPractice, BPFinding } from "../types.js";

/**
 * Build a BPFinding from a triggered BestPractice.
 *
 * @param bp - The best practice that fired
 * @returns A finding object for display in the plan box
 */
export function buildFinding(bp: BestPractice): BPFinding {
  const finding: BPFinding = {
    practiceId: bp.id,
    title: bp.title,
    severity: bp.severity,
    category: bp.category,
    message:
      bp.description ??
      `${bp.title} — expected ${bp.property_path} ${bp.check_type} ${typeof bp.expected_value === "object" ? JSON.stringify(bp.expected_value) : bp.expected_value}`,
    remediation: bp.remediation,
    blocking: bp.blocking ?? false,
  };

  if (bp.autoFixable) {
    finding.autoFixable = true;
    finding.desiredStatePatch = bp.desiredStatePatch;
  }

  // Story 35.5: Always propagate property_path so FixCommandResolver can categorize
  finding.propertyPath = bp.property_path;

  // Story 35.7: Propagate human-readable fix hint
  if (bp.fix_hint) {
    finding.fixHint = bp.fix_hint;
  }

  if (bp.fixType) {
    finding.fixType = bp.fixType;
    finding.interactiveOptions = bp.interactiveOptions;
  }

  // Story 43.1: Propagate consequence text for risk display
  if (bp.consequence) {
    finding.consequence = bp.consequence;
  }

  return finding;
}
