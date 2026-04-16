/**
 * RouteTable destroy strategy — preDestroy disassociates every
 * non-main subnet association before CCAPI DeleteRouteTable.
 *
 * DeleteRouteTable fails with DependencyViolation while
 * associations exist. AWS::EC2::SubnetRouteTableAssociation is a
 * CloudFormation-only construct with no taggable AWS resource, so
 * it never appears in the bulk-destroy plan.
 *
 * INVARIANT: Skip `Main=true` associations — the VPC's main route
 * table cannot be disassociated and will be cleaned up automatically
 * when the VPC is deleted.
 *
 * @see Wave-6 F1b
 */

import { RESOURCE_TYPES } from "@assignee/core";
import type { DestroyStrategy } from "@assignee/core";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../../config/aws-credentials.js";
import { AWS_REGION } from "../../config/constants.js";
import { warnDestroy } from "./helpers.js";

export const ec2RouteTableStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
  async preDestroy(ctx) {
    const { resource, awsConfig } = ctx;
    let ec2: import("@aws-sdk/client-ec2").EC2Client | undefined;
    try {
      const {
        EC2Client,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
      } = await import("@aws-sdk/client-ec2");
      ec2 = new EC2Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const desc = await ec2.send(
        new DescribeRouteTablesCommand({
          RouteTableIds: [resource.identifier],
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
    } catch (err) {
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          success: false,
          error: `Cannot disassociate RouteTable before delete: ${err.message}`,
        };
      }
      warnDestroy("route_table_disassociate_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ec2?.destroy();
    }
  },
};
