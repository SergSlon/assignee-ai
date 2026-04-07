/**
 * Destroy strategy for AWS::EC2::RouteTable.
 *
 * Non-default route tables must have all subnet associations removed
 * before CloudControl can delete them — DeleteRouteTable fails with
 * DependencyViolation while associations exist. AWS::EC2::SubnetRouteTable
 * Association is a CloudFormation-only construct with no taggable AWS
 * resource, so it never appears in the bulk-destroy plan and cannot be
 * torn down through the normal tier path.
 *
 * Skips Main=true associations — the VPC's main route table cannot be
 * disassociated and is cleaned up automatically when the VPC is deleted.
 *
 * Uses the centralized `requireAssigneeCredentials("operator")` helper
 * from @assignee/core — never falls through to the default AWS chain.
 */

import {
  EC2Client,
  DescribeRouteTablesCommand,
  DisassociateRouteTableCommand,
} from "@aws-sdk/client-ec2";
import { requireAssigneeCredentials } from "@assignee/core";
import type { DestroyStrategy } from "./types.js";

export const routeTableStrategy: DestroyStrategy = {
  resourceType: "AWS::EC2::RouteTable",
  isSlow: true, // disassociate + delete can exceed 1min for compound VPCs

  async preDestroy(identifier: string, region: string): Promise<void> {
    const ec2 = new EC2Client({
      region,
      credentials: requireAssigneeCredentials("operator"),
    });
    const desc = await ec2.send(
      new DescribeRouteTablesCommand({
        RouteTableIds: [identifier],
      }),
    );
    const associations = desc.RouteTables?.[0]?.Associations ?? [];
    for (const assoc of associations) {
      if (
        assoc.RouteTableAssociationId &&
        assoc.Main !== true &&
        assoc.AssociationState?.State !== "disassociated"
      ) {
        await ec2.send(
          new DisassociateRouteTableCommand({
            AssociationId: assoc.RouteTableAssociationId,
          }),
        );
      }
    }
  },
};
