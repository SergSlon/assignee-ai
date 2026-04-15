/**
 * Apply-success renderer — single-resource provisioning completion.
 */
import chalk from "chalk";
import { CostEstimateLabel } from "@assignee/core";
import type { RenderableState } from "../display.js";
import { stopSpinner } from "./spinner.js";

/**
 * Renders the apply success line.
 *
 * `displayArn` is the resolved full ARN (e.g. arn:aws:s3:::my-bucket)
 * derived from the bare CCAPI primary identifier in `state.resourceArn`
 * (e.g. "my-bucket") via resolveResourceArn. The two are decoupled
 * because LangGraph state must keep the BARE identifier so the compound
 * marker resolver in plan-generator.ts can substitute it into child
 * resource fields like VpcId, SubnetId, InternetGatewayId, etc. — those
 * EC2 APIs reject full ARNs and require the bare ID. Display only needs
 * the user-facing ARN, so it stays out-of-band as a separate parameter.
 *
 * Falls back to state.resourceArn when displayArn is not provided —
 * preserves the legacy non-resolved behavior for any caller that
 * hasn't been updated to pass the resolved value.
 */
export function renderApplySuccess(
  state: RenderableState,
  displayArn?: string,
): void {
  stopSpinner();
  const arnForDisplay = displayArn ?? state.resourceArn;
  if (process.stdout.isTTY) {
    process.stdout.write(chalk.green("✅ Resource created successfully!\n"));
    if (arnForDisplay) {
      process.stdout.write(chalk.green(`   ARN: ${arnForDisplay}\n`));
    }
    process.stdout.write(chalk.dim(`   Run ID: ${state.runId}\n`));
  } else {
    process.stdout.write(
      `SUCCESS\nARN: ${arnForDisplay ?? CostEstimateLabel.NA}\nRun ID: ${state.runId}\n`,
    );
  }
}
