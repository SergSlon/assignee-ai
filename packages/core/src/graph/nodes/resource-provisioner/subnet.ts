/**
 * EC2 subnet pre-provision.
 *
 * When the SSH-bundle intent rule sets SubnetId = SUBNET_PLACEHOLDER,
 * the provisioner calls this module to resolve it to the first available
 * subnet in the account's default VPC.
 *
 * Flow:
 *   1. DescribeVpcs with isDefault=true — get the default VPC.
 *      If no default VPC exists, fail with a clear error pointing the user
 *      to create one first.
 *   2. DescribeSubnets filtered by the default VPC — pick the first subnet.
 *      If the VPC has no subnets, fail with a clear error.
 *   3. On success: replace desiredState[SubnetId] with the real subnet-id.
 *   4. On credential error: surface actionable message referencing
 *      ASSIGNEE_READER_* env vars and `assignee setup`.
 *
 * Per feedback_lazy_credential_resolution_in_mcp: credentials are resolved
 * lazily via tryAssigneeCredentials("reader") with try/catch — NOT
 * requireAssigneeCredentials (which throws a generic error).
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
 */
export async function ensureSubnet(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<EnsureSubnetResult> {
  if (
    state.resourceType !== RESOURCE_TYPES.EC2_INSTANCE ||
    desiredState[CfnKey.SUBNET_ID] !== ResourceDefault.SUBNET_PLACEHOLDER
  ) {
    return { ok: true };
  }

  const creds = tryAssigneeCredentials("reader");
  if (!creds) {
    // No reader creds — cannot resolve subnet. Clear the placeholder so the
    // instance launches in the default subnet without an explicit SubnetId
    // (AWS uses the default VPC's default subnet automatically).
    process.stderr.write(
      "[33m⚠️  Reader credentials not configured — SubnetId placeholder cleared. " +
        "The instance will launch in the default VPC subnet. " +
        "Set ASSIGNEE_READER_ACCESS_KEY_ID / ASSIGNEE_READER_SECRET_ACCESS_KEY or run `assignee setup` " +
        "to enable explicit subnet selection.[0m\n",
    );
    delete desiredState[CfnKey.SUBNET_ID];
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
    const vpcId = defaultVpc.VpcId;

    // Step 2: find the first subnet in the default VPC.
    const subnetsResult = await ec2.send(
      new DescribeSubnetsCommand({
        Filters: [{ Name: "vpc-id", Values: [vpcId] }],
      }),
    );
    const firstSubnet = subnetsResult?.Subnets?.[0];
    if (!firstSubnet?.SubnetId) {
      return {
        ok: false,
        errorMessage:
          `Default VPC (${vpcId}) has no subnets. ` +
          "Create a subnet first via `assignee apply 'Create a subnet'`, then re-run this command.",
      };
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
