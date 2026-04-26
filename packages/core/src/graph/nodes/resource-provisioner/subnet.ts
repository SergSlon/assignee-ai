/**
 * EC2 subnet pre-provision.
 *
 * When the SSH-bundle intent rule sets SubnetId = SUBNET_PLACEHOLDER,
 * the provisioner calls this module to resolve it to the first AVAILABLE
 * subnet in the account's default VPC.
 *
 * Flow:
 *   1. DescribeVpcs with isDefault=true — get the default VPC.
 *      If no default VPC exists (or VPC state is not "available"), fail with
 *      a clear error pointing the user to create one first.
 *   2. DescribeSubnets filtered by the default VPC — pick the first subnet
 *      whose State === "available". If no available subnets, fail with a
 *      clear error.
 *   3. On success: replace desiredState[SubnetId] with the real subnet-id.
 *      Emit a WARNING (stderr) if the resolved subnet has
 *      MapPublicIpOnLaunch === false — the instance will not get a public
 *      IP automatically, which may cause SSH to fail.
 *   4. On credential error: surface actionable message referencing
 *      ASSIGNEE_READER_* env vars and `assignee setup`.
 *
 * Per feedback_lazy_credential_resolution_in_mcp: credentials are resolved
 * lazily via tryAssigneeCredentials("reader") with try/catch — NOT
 * requireAssigneeCredentials (which throws a generic error).
 *
 * Region note: this helper uses AWS_REGION for the EC2 client. The operator's
 * target region is assumed to match AWS_REGION. If they differ, the resolved
 * subnet will belong to the wrong region's default VPC.
 *
 * Retry contract: once desiredState[SubnetId] is set to a real subnet-id
 * (i.e. no longer the SUBNET_PLACEHOLDER), subsequent calls to ensureSubnet
 * are a no-op — the already-resolved ID is used as-is. Operators who need a
 * fresh resolution should clear the SubnetId field before retrying.
 *
 * SRP: this module changes when SSH-bundle subnet resolution rules change.
 */

import {
  CfnKey,
  RESOURCE_TYPES,
  ResourceDefault,
  createEC2Client,
} from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { tryAssigneeCredentials } from "@/config/aws-credentials.js";

export type EnsureSubnetResult =
  | { ok: true }
  | { ok: false; errorMessage: string };

/**
 * Resolve the SUBNET_PLACEHOLDER in `desiredState` in place.
 * No-ops unless resourceType is EC2::Instance AND SubnetId matches
 * the placeholder value.
 *
 * HIGH-3 (retry contract): when SubnetId is already a real subnet-id
 * (i.e. not the placeholder, not undefined), this function is a no-op and
 * emits a debug log so retry traces show which cached subnet-id is in use.
 * To force re-resolution (e.g. if the subnet was deleted), the caller must
 * clear desiredState[SubnetId] before retrying.
 */
export async function ensureSubnet(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureSubnetResult> {
  if (state.resourceType !== RESOURCE_TYPES.EC2_INSTANCE) {
    return { ok: true };
  }

  // HIGH-3: when SubnetId is already resolved (not placeholder, not absent),
  // emit a debug log noting the cached value and return early.
  if (
    desiredState[CfnKey.SUBNET_ID] !== ResourceDefault.SUBNET_PLACEHOLDER &&
    desiredState[CfnKey.SUBNET_ID] !== undefined
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        subnetAlreadyResolved: desiredState[CfnKey.SUBNET_ID],
        note: "Using cached subnet-id from previous resolution. Clear SubnetId to force re-resolution.",
      },
    });
    return { ok: true };
  }

  // If SubnetId is absent (undefined / not set at all), this is not an
  // SSH-bundle intent — no resolution needed.
  if (desiredState[CfnKey.SUBNET_ID] === undefined) {
    return { ok: true };
  }

  const creds = tryAssigneeCredentials("reader");
  if (!creds) {
    // No reader creds — cannot resolve subnet. Set SubnetId to undefined
    // (LOW-1: undefined rather than delete, so the key remains present in the
    // map and callers can distinguish "cleared" from "never set") so the
    // instance launches in the default subnet without an explicit SubnetId
    // (AWS uses the default VPC's default subnet automatically).
    process.stderr.write(
      "[33m⚠️  Reader credentials not configured — SubnetId placeholder cleared. " +
        "The instance will launch in the default VPC subnet. " +
        "Set ASSIGNEE_READER_ACCESS_KEY_ID / ASSIGNEE_READER_SECRET_ACCESS_KEY or run `assignee setup` " +
        "to enable explicit subnet selection.[0m\n",
    );
    // LOW-1: set to undefined rather than delete — the key remains present
    // in the map, clearly signalling "was set but cleared" to any caller
    // that checks for the key's existence. On next call, the undefined
    // check above will treat this as "not an SSH-bundle intent".
    desiredState[CfnKey.SUBNET_ID] = undefined;
    return { ok: true };
  }

  let ec2: ReturnType<typeof createEC2Client> | undefined;
  try {
    const { DescribeVpcsCommand, DescribeSubnetsCommand } =
      await import("@aws-sdk/client-ec2");
    ec2 = createEC2Client({ region: AWS_REGION, credentials: creds });

    // Step 1: find the default VPC.
    const vpcsResult = await ec2.send(
      new DescribeVpcsCommand({
        Filters: [{ Name: "isDefault", Values: ["true"] }],
      }),
    );
    const defaultVpc = vpcsResult?.Vpcs?.[0];
    if (!defaultVpc?.VpcId) {
      return {
        ok: false,
        errorMessage:
          "No default VPC found in your account. " +
          "Create a VPC first via `assignee apply 'Create a VPC'`, then re-run this command.",
      };
    }

    // MED-1: reject a default VPC that is being deleted or is otherwise
    // not in "available" state — AWS would reject subnet creates against it.
    if (defaultVpc.State !== "available") {
      return {
        ok: false,
        errorMessage:
          `Default VPC (${defaultVpc.VpcId}) is in state "${defaultVpc.State ?? "unknown"}" — ` +
          `only "available" VPCs can be used for subnet resolution. ` +
          "Wait for the VPC state to become available, or run `assignee apply 'Create a VPC'` to create a new one.",
      };
    }

    const vpcId = defaultVpc.VpcId;

    // Step 2: find the first AVAILABLE subnet in the default VPC.
    // HIGH-1: filter by State === "available" before picking [0] so
    // pending/deleting subnets are not resolved.
    const subnetsResult = await ec2.send(
      new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }),
    );
    const availableSubnets = (subnetsResult?.Subnets ?? []).filter(
      (s) => s.State === "available",
    );
    const firstSubnet = availableSubnets[0];
    if (!firstSubnet?.SubnetId) {
      return {
        ok: false,
        errorMessage:
          `Default VPC (${vpcId}) has no subnets in "available" state — ` +
          "wait for AWS provisioning to complete or run `assignee apply 'Create a VPC'`.",
      };
    }

    // HIGH-2: warn if the resolved subnet does not auto-assign public IPs.
    // SSH to a new EC2 instance requires a public IP unless a bastion / VPN is
    // in place. Emit a warning but do NOT fail — the user may be intentional
    // (e.g. connecting via SSM, bastion, or VPN).
    if (firstSubnet.MapPublicIpOnLaunch === false) {
      process.stderr.write(
        "[33m⚠️  Resolved subnet " +
          firstSubnet.SubnetId +
          " does not auto-assign public IPs (MapPublicIpOnLaunch=false). " +
          "SSH may fail unless you connect via SSM, a bastion host, or VPN. " +
          "To use a public subnet instead, run with --set SubnetId=<public-subnet-id>.[0m\n",
      );
    }

    desiredState[CfnKey.SUBNET_ID] = firstSubnet.SubnetId;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        subnetResolved: firstSubnet.SubnetId,
        defaultVpcId: vpcId,
      },
    });
    return { ok: true };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errorMessage:
        `Failed to resolve default subnet (${errMsg}). ` +
        "Ensure reader credentials have ec2:DescribeVpcs + ec2:DescribeSubnets permissions, " +
        "or set SubnetId manually with --set SubnetId=subnet-<id>.",
    };
  } finally {
    ec2?.destroy();
  }
}
