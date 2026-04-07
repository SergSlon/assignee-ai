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
 * Wave 11 P2-4: error-contract consistency with the CLI hook in
 * `apps/cli/src/services/destroy-service.ts`. Previously this strategy
 * threw hard on any DescribeRouteTables / DisassociateRouteTable error
 * while the CLI hook warned-and-continued on the same errors (only
 * `MissingAssigneeCredentialsError` was treated as fatal). Match the
 * CLI behavior so MCP `destroy_resource` and CLI `destroy` produce the
 * same outcome for the same conditions. The "let CCAPI surface
 * authoritative errors" philosophy: if a per-association disassociate
 * fails for a benign reason (already disassociated by parallel cleanup,
 * race with another operator), the CCAPI delete attempt that follows
 * will produce a clean DependencyViolation if the residual attachment
 * actually still matters. If it doesn't, we shouldn't have aborted.
 */

import {
  EC2Client,
  DescribeRouteTablesCommand,
  DisassociateRouteTableCommand,
} from "@aws-sdk/client-ec2";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "@assignee/core";
import type { DestroyStrategy } from "./types.js";

export const routeTableStrategy: DestroyStrategy = {
  resourceType: "AWS::EC2::RouteTable",
  isSlow: true, // disassociate + delete can exceed 1min for compound VPCs

  async preDestroy(identifier: string, region: string): Promise<void> {
    let ec2: EC2Client;
    try {
      ec2 = new EC2Client({
        region,
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
          try {
            await ec2.send(
              new DisassociateRouteTableCommand({
                AssociationId: assoc.RouteTableAssociationId,
              }),
            );
          } catch (perAssocErr) {
            // Per-association best-effort: a single failed disassociate
            // shouldn't abort the whole destroy. Log to stderr (the MCP
            // server's diagnostic channel) and continue with the rest.
            // CCAPI will surface a clean DependencyViolation later if
            // the residual association actually blocks the delete.
            process.stderr.write(
              `[route-table-strategy] warning: failed to disassociate ${assoc.RouteTableAssociationId} from ${identifier}: ${perAssocErr instanceof Error ? perAssocErr.message : String(perAssocErr)}. Continuing — CCAPI will report DependencyViolation if the residual attachment matters.\n`,
            );
          }
        }
      }
    } catch (descErr) {
      // DescribeRouteTables failed entirely (the route table was
      // deleted out-of-band, or the operator policy is missing
      // ec2:DescribeRouteTables). Warn and continue — the CCAPI delete
      // will produce the authoritative error.
      process.stderr.write(
        `[route-table-strategy] warning: DescribeRouteTables failed for ${identifier}: ${descErr instanceof Error ? descErr.message : String(descErr)}. Continuing without pre-disassociate.\n`,
      );
    }
  },
};
