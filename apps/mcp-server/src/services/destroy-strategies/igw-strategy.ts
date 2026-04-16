/**
 * Destroy strategy for AWS::EC2::InternetGateway.
 *
 * InternetGateways must be detached from their VPC before CloudControl
 * can delete them. The preDestroy hook finds all VPC attachments and
 * detaches the IGW.
 *
 * Uses the centralized `requireAssigneeCredentials("operator")` helper
 * from @assignee/core — never falls through to the default AWS
 * credential chain.
 *
 * @see Story 49.1 — migrated to the shared richer DestroyContext
 *   interface consumed from @assignee/core.
 */

import {
  DescribeInternetGatewaysCommand,
  DetachInternetGatewayCommand,
} from "@aws-sdk/client-ec2";
import {
  RESOURCE_TYPES,
  createEC2Client,
  requireAssigneeCredentials,
  type DestroyStrategy,
} from "@assignee/core";

export const igwStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  isSlow: true, // detach + delete can exceed 2min

  async preDestroy(ctx): Promise<void> {
    const { resource, effectiveRegion } = ctx;
    const ec2 = createEC2Client({
      region: effectiveRegion,
      credentials: requireAssigneeCredentials("operator"),
    });
    try {
      const desc = await ec2.send(
        new DescribeInternetGatewaysCommand({
          InternetGatewayIds: [resource.identifier],
        }),
      );
      const attachments = desc.InternetGateways?.[0]?.Attachments ?? [];
      for (const att of attachments) {
        if (att.VpcId && att.State !== "detached") {
          await ec2.send(
            new DetachInternetGatewayCommand({
              InternetGatewayId: resource.identifier,
              VpcId: att.VpcId,
            }),
          );
        }
      }
    } finally {
      ec2.destroy();
    }
  },
};
