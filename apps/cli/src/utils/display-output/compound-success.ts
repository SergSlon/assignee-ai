/**
 * Compound provisioning success renderer.
 */
import chalk from "chalk";
import boxen from "boxen";
import type { ResourceResult, ArchitecturePattern } from "@assignee/core";
import { BoxenAlign } from "../../config/constants.js";
import { stopSpinner } from "./spinner.js";

/**
 * Renders a success summary after all compound provisioning resources complete.
 *
 * `displayArns` is an optional map keyed by `ResourceResult.resourceId`
 * holding the resolved full ARN for each entry. When supplied, the
 * renderer prefers the display ARN over the bare CCAPI identifier
 * stored on `result.resourceArn`. The bare identifier is preserved on
 * the entry itself so the LangGraph state continues to feed the
 * compound marker resolver in plan-generator.ts with the bare values
 * the EC2 APIs expect (VpcId, SubnetId, InternetGatewayId, etc.).
 */
export function renderCompoundSuccess(
  results: ResourceResult[],
  pattern: ArchitecturePattern,
  displayArns?: Record<string, string>,
): void {
  stopSpinner();

  const resultLines = results.map((r, i) => {
    const arnForDisplay =
      (r.resourceId && displayArns?.[r.resourceId]) || r.resourceArn;
    return `  ${i + 1}. ${r.resourceType}${arnForDisplay ? ` → ${arnForDisplay}` : ""}`;
  });

  if (process.stdout.isTTY) {
    const lines = [
      chalk.green.bold(`✓ ${pattern.displayName} provisioned successfully`),
      "",
      ...resultLines,
    ];
    process.stdout.write(
      boxen(lines.join("\n"), {
        padding: 1,
        borderColor: "green",
        title: "Compound Provisioning Complete",
        titleAlignment: BoxenAlign.LEFT,
      }) + "\n",
    );
  } else {
    const lines = [
      `✓ ${pattern.displayName} provisioned successfully`,
      "",
      ...resultLines,
    ];
    process.stdout.write(
      `=== Compound Provisioning Complete ===\n${lines.join("\n")}\n======================================\n`,
    );
  }
}
