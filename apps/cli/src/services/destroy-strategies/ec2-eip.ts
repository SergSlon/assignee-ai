/**
 * EIP destroy strategy — full CCAPI bypass via ec2:ReleaseAddress.
 *
 * Wave 19 Bug #6: EIP is not destroyable via CloudControl DeleteResource
 * (the type schema exists but the delete handler is unreliable for EIPs
 * attached to NAT Gateways that have been deleted but not yet propagated).
 * Always go through ec2:ReleaseAddress directly. The bulk-destroy tier
 * table now lists EIP at tier 4, after NAT Gateway at tier 3, so by the
 * time we reach this branch the NAT Gateway is already gone and the EIP
 * is in `disassociated` state.
 *
 * InvalidAllocationID.NotFound / "does not exist" are treated as success
 * (the desired end state is already reached).
 *
 * @see Wave-6 F1b
 */

import { COMPANION_RESOURCE_TYPES } from "@assignee/core";
import type { DestroyStrategy } from "@assignee/core";

export const ec2EipStrategy: DestroyStrategy = {
  resourceType: COMPANION_RESOURCE_TYPES.EC2_EIP,
  async destroy(ctx) {
    const { EC2Client, ReleaseAddressCommand } =
      await import("@aws-sdk/client-ec2");
    const { resource, awsConfig } = ctx;
    const ec2 = new EC2Client({
      region: resource.region,
      ...(awsConfig.accessKeyId && awsConfig.secretAccessKey
        ? {
            credentials: {
              accessKeyId: awsConfig.accessKeyId,
              secretAccessKey: awsConfig.secretAccessKey,
            },
          }
        : {}),
    });
    try {
      // ARN format: arn:aws:ec2:us-east-1:112233445566:elastic-ip/eipalloc-xxx
      // Identifier comes from extractIdentifier and is just `eipalloc-xxx`.
      await ec2.send(
        new ReleaseAddressCommand({ AllocationId: resource.identifier }),
      );
      return { success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (
        errMsg.includes("InvalidAllocationID.NotFound") ||
        errMsg.includes("does not exist")
      ) {
        return { success: true };
      }
      return {
        success: false,
        error: `Failed to release EIP ${resource.identifier}: ${errMsg}`,
      };
    } finally {
      ec2.destroy();
    }
  },
};
