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
 * @see Wave-6 F1b (CLI origin)
 * @see Story 50-4 — extraction into @assignee/core
 */

import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../../config/aws-credentials.js";
import { DEFAULT_AWS_REGION } from "../../config/config-schema.js";
import type { DestroyStrategy } from "../types.js";
import { warnDestroy } from "../warn.js";

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
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      let desc;
      try {
        desc = await ec2.send(
          new DescribeRouteTablesCommand({
            RouteTableIds: [resource.identifier],
          }),
        );
      } catch (descErr) {
        // DescribeRouteTables failed entirely (deleted out-of-band, or
        // missing ec2:DescribeRouteTables). Warn and continue — the
        // CCAPI delete will produce the authoritative error.
        warnDestroy("route_table_describe_failed", {
          identifier: resource.identifier,
          error: descErr instanceof Error ? descErr.message : String(descErr),
        });
        return;
      }
      const associations = desc.RouteTables?.[0]?.Associations ?? [];
      for (const assoc of associations) {
        if (
          assoc.RouteTableAssociationId &&
          assoc.Main !== true &&
          assoc.AssociationState?.State !== "disassociated"
        ) {
          try {
            await ec2.send(
              new DisassociateRouteTableCommand({
                AssociationId: assoc.RouteTableAssociationId,
              }),
            );
          } catch (perAssocErr) {
            // Per-association best-effort: a single failed disassociate
            // shouldn't abort the whole destroy. CCAPI will surface a
            // clean DependencyViolation later if the residual
            // association actually blocks the delete.
            warnDestroy("route_table_disassociate_failed", {
              identifier: resource.identifier,
              associationId: assoc.RouteTableAssociationId,
              error:
                perAssocErr instanceof Error
                  ? perAssocErr.message
                  : String(perAssocErr),
            });
          }
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
