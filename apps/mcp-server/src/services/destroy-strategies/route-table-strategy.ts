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
 *
 * Wave 11 P2-4: error-contract consistency with the CLI hook —
 * per-association disassociate failures warn-and-continue; only
 * `MissingAssigneeCredentialsError` aborts. CCAPI produces the
 * authoritative DependencyViolation if residual attachments matter.
 *
 * @see Story 49.1 — migrated to the shared DestroyContext interface.
 */

import {
  EC2Client,
  DescribeRouteTablesCommand,
  DisassociateRouteTableCommand,
} from "@aws-sdk/client-ec2";
import {
  RESOURCE_TYPES,
  MissingAssigneeCredentialsError,
  requireAssigneeCredentials,
  type DestroyStrategy,
} from "@assignee/core";

export const routeTableStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
  isSlow: true, // disassociate + delete can exceed 1min for compound VPCs

  async preDestroy(ctx): Promise<void> {
    const { resource, effectiveRegion, warn } = ctx;
    let ec2: EC2Client;
    try {
      ec2 = new EC2Client({
        region: effectiveRegion,
        credentials: requireAssigneeCredentials("operator"),
      });
    } catch (err) {
      // Credential errors are fatal — surface them so the caller can
      // tell the user to set ASSIGNEE_OPERATOR_*. Mirrors the CLI
      // hook's behavior where MissingAssigneeCredentialsError aborts
      // the destroy with a friendly message.
      if (err instanceof MissingAssigneeCredentialsError) throw err;
      throw err;
    }

    try {
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
            warn("route_table_disassociate_partial", {
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
    } catch (descErr) {
      // DescribeRouteTables failed entirely (deleted out-of-band, or
      // missing ec2:DescribeRouteTables). Warn and continue — the
      // CCAPI delete will produce the authoritative error.
      warn("route_table_describe_failed", {
        identifier: resource.identifier,
        error: descErr instanceof Error ? descErr.message : String(descErr),
      });
    }
  },
};
