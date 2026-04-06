/**
 * Destroy strategy for AWS::EC2::InternetGateway.
 *
 * InternetGateways must be detached from their VPC before CloudControl
 * can delete them. The preDestroy hook finds all VPC attachments and
 * detaches the IGW.
 *
 * Uses the centralized `requireAssigneeCredentials("operator")` helper from
 * @assignee/core — never falls through to the default AWS credential chain.
 */

import {
  EC2Client,
  DescribeInternetGatewaysCommand,
  DetachInternetGatewayCommand,
} from "@aws-sdk/client-ec2";
import { requireAssigneeCredentials } from "@assignee/core";
import type { DestroyStrategy } from "./types.js";

export const igwStrategy: DestroyStrategy = {
  resourceType: "AWS::EC2::InternetGateway",
  isSlow: true, // detach + delete can exceed 2min

  async preDestroy(identifier: string, region: string): Promise<void> {
    const ec2 = new EC2Client({
      region,
      credentials: requireAssigneeCredentials("operator"),
    });
    const desc = await ec2.send(
      new DescribeInternetGatewaysCommand({
        InternetGatewayIds: [identifier],
      }),
    );
    const attachments = desc.InternetGateways?.[0]?.Attachments ?? [];
    for (const att of attachments) {
      if (att.VpcId && att.State !== "detached") {
        await ec2.send(
          new DetachInternetGatewayCommand({
            InternetGatewayId: identifier,
            VpcId: att.VpcId,
          }),
        );
      }
    }
  },
};
