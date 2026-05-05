/**
 * Apply-success renderer — single-resource provisioning completion.
 *
 * Composition contract: the success line is rendered as a sequence of
 * inline section helpers (header → ARN → network → run id) so future
 * stories can slot a new section in additively without re-architecting
 * the file. Story iii will add `renderConnect` next to `renderNetwork`
 * to print the SSH connect command between the network address and
 * the Run ID. Keep helpers single-section, pure (no I/O beyond
 * `process.stdout.write`), and TTY-aware via the `isTty` flag.
 */
import chalk from "chalk";
import { CostEstimateLabel } from "../../pricing/filter-constants.js";
import type { RenderableState } from "../display-helpers/renderable-state.js";
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
  const isTty = !!process.stdout.isTTY;
  if (isTty) {
    process.stdout.write(chalk.green("✅ Resource created successfully!\n"));
    if (arnForDisplay) {
      process.stdout.write(chalk.green(`   ARN: ${arnForDisplay}\n`));
    }
    renderNetwork(state, isTty);
    renderConnect(state, isTty);
    process.stdout.write(chalk.dim(`   Run ID: ${state.runId}\n`));
  } else {
    process.stdout.write(
      `SUCCESS\nARN: ${arnForDisplay ?? CostEstimateLabel.NA}\n`,
    );
    renderNetwork(state, isTty);
    renderConnect(state, isTty);
    process.stdout.write(`Run ID: ${state.runId}\n`);
  }
}

/**
 * Print the public network address(es) for the freshly-created resource.
 * No-op when neither `publicIpAddress` nor `publicDnsName` is set —
 * RDS / Lambda / S3 / private EC2 emit nothing here.
 *
 * The DNS line is suppressed when it is identical to the IP address
 * (some AWS configurations return the IP for both fields when no
 * public DNS is configured, e.g. instances launched into a VPC with
 * `enableDnsHostnames=false`); printing the same value twice would
 * be noise.
 */
function renderNetwork(state: RenderableState, isTty: boolean): void {
  const ip = state.publicIpAddress?.trim();
  const dns = state.publicDnsName?.trim();
  const hasIp = !!ip;
  const showDns = !!dns && dns !== ip;
  if (!hasIp && !showDns) return;
  if (isTty) {
    if (hasIp) {
      process.stdout.write(chalk.green(`   Public IP:  ${ip}\n`));
    }
    if (showDns) {
      process.stdout.write(chalk.green(`   Public DNS: ${dns}\n`));
    }
  } else {
    if (hasIp) {
      process.stdout.write(`Public IP: ${ip}\n`);
    }
    if (showDns) {
      process.stdout.write(`Public DNS: ${dns}\n`);
    }
  }
}

/**
 * SSH-bundle Story iii — copy-pasteable connect command.
 *
 * Suppressed silently unless ALL of `publicIpAddress`, `keyName`, and
 * `sshUsername` are present and non-empty on the RenderableState. This
 * matches the apply-single.ts contract: the caller only populates
 * those three fields when the resource was provisioned via the SSH
 * bundle and a post-apply describe successfully resolved a public IP
 * + an AMI default user. RDS / Lambda / S3 / private EC2 / EC2 without
 * the SSH bundle all silently skip this line.
 *
 * The keypair path (`~/.assignee/keys/<name>.pem`) mirrors the
 * convention in `resource-provisioner/ssh-keypair.ts:118-127`. Renderer
 * stays type-agnostic — if a future caller wires SSH-shaped fields on
 * a non-EC2 resource, the line still renders. Per Story ii's
 * "renderer is type-agnostic" contract, suppression is the caller's
 * responsibility, not the renderer's.
 */
function renderConnect(state: RenderableState, isTty: boolean): void {
  const ip = state.publicIpAddress?.trim();
  const keyName = state.keyName?.trim();
  const user = state.sshUsername?.trim();
  if (!ip || !keyName || !user) return;
  const cmd = `ssh -i ~/.assignee/keys/${keyName}.pem ${user}@${ip}`;
  if (isTty) {
    process.stdout.write(chalk.green(`   Connect:    ${cmd}\n`));
  } else {
    process.stdout.write(`Connect: ${cmd}\n`);
  }
}
