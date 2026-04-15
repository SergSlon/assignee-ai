/**
 * Compound dependency-plan renderer.
 * Called by human_approval node when resourcePattern is set (compound intent).
 * Non-TTY fallback: plain text without ANSI/boxen (CI-safe).
 */
import boxen from "boxen";
import {
  CostEstimateLabel,
  type ArchitecturePattern,
  type ResourceSpec,
} from "@assignee/core";
import type { BPFinding } from "@assignee/best-practices";
import { BoxenAlign, BoxenBorderColor } from "../../config/constants.js";
import { formatFindings } from "../display-findings.js";
import { regionLabel } from "../display-plan.js";
import { stopSpinner } from "./spinner.js";

function buildQueueLines(
  resourceQueue: ResourceSpec[],
  perResourceCosts?: Record<string, string>,
): string[] {
  const lines: string[] = [];
  resourceQueue.forEach((resource, index) => {
    const cost = perResourceCosts?.[resource.resourceId];
    lines.push(`  [${index + 1}] ${resource.resourceType}`);
    lines.push(`       ${resource.displayName}${cost ? `  (~${cost})` : ""}`);
    if (index < resourceQueue.length - 1) {
      lines.push(`       ↓`);
    }
  });
  return lines;
}

function buildCostSummary(
  resourceQueue: ResourceSpec[],
  perResourceCosts: Record<string, string>,
): string[] {
  const knownCosts = resourceQueue
    .map((r) => perResourceCosts[r.resourceId])
    .filter(
      (c): c is string =>
        Boolean(c) &&
        c !== CostEstimateLabel.NA &&
        c !== CostEstimateLabel.FREE,
    );
  if (knownCosts.length === 0) return [];
  const lines = [``, `Estimated cost: ${knownCosts.join(" + ")} /month`];
  if (knownCosts.length < resourceQueue.length) {
    lines.push(`  (partial — not all resource costs estimated yet)`);
  }
  return lines;
}

export function renderDependencyPlan(
  pattern: ArchitecturePattern,
  resourceQueue: ResourceSpec[],
  perResourceCosts?: Record<string, string>,
  bpFindings?: BPFinding[],
): void {
  stopSpinner();
  const lines: string[] = [
    `Pattern:  ${pattern.displayName}`,
    ``,
    `Will provision ${resourceQueue.length} resource${resourceQueue.length === 1 ? "" : "s"} in order:`,
    ``,
    ...buildQueueLines(resourceQueue, perResourceCosts),
  ];

  if (perResourceCosts) {
    lines.push(...buildCostSummary(resourceQueue, perResourceCosts));
  }

  // Story 18.10: Unified findings summary for compound plans
  lines.push(``);
  lines.push(formatFindings(bpFindings));

  lines.push(``);
  lines.push(`Region:   ${regionLabel()}`);

  const content = lines.join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Compound Provisioning Plan",
        titleAlignment: BoxenAlign.LEFT,
        borderColor: BoxenBorderColor.CYAN,
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Compound Provisioning Plan ===\n${content}\n==================================\n`,
    );
  }
}
