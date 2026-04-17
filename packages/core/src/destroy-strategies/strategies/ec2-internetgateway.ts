/**
 * InternetGateway destroy strategy — preDestroy detaches the gateway
 * from every attached VPC before CCAPI DeleteInternetGateway.
 *
 * Wave 11 P2-3 half-state invariant: per-attachment try/catch so a
 * failure on attachment N+1 doesn't leave attachment N..0 rolled
 * back. We maximize forward progress; residual attachments are
 * logged via `igw_partial_detach_state` so reconcile/debugging can
 * see exactly what was done.
 *
 * AWS::EC2::VPCGatewayAttachment is CloudFormation-only with no
 * taggable AWS resource, so it never appears in the bulk-destroy
 * plan — this pre-delete hook is the ONLY cleanup path.
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

export const ec2InternetGatewayStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  async preDestroy(ctx) {
    const { resource, awsConfig } = ctx;
    let ec2: import("@aws-sdk/client-ec2").EC2Client | undefined;
    try {
      const {
        EC2Client,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
      } = await import("@aws-sdk/client-ec2");
      ec2 = new EC2Client({
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const desc = await ec2.send(
        new DescribeInternetGatewaysCommand({
          InternetGatewayIds: [resource.identifier],
        }),
      );
      const attachments = desc.InternetGateways?.[0]?.Attachments ?? [];
      let detachOk = 0;
      let detachFail = 0;
      const detachErrors: string[] = [];
      for (const att of attachments) {
        if (att.VpcId && att.State !== "detached") {
          try {
            await ec2.send(
              new DetachInternetGatewayCommand({
                InternetGatewayId: resource.identifier,
                VpcId: att.VpcId,
              }),
            );
            detachOk++;
          } catch (perAttErr) {
            detachFail++;
            const message =
              perAttErr instanceof Error
                ? perAttErr.message
                : String(perAttErr);
            detachErrors.push(`${att.VpcId}: ${message}`);
            // Continue the loop — maximize forward progress so the next
            // destroy attempt (or the upcoming CCAPI delete) has less
            // residual work.
          }
        }
      }
      if (detachFail > 0) {
        warnDestroy("igw_partial_detach_state", {
          identifier: resource.identifier,
          detachedCount: detachOk,
          remainingCount: detachFail,
          errors: detachErrors,
          note: "CloudControl delete will produce DependencyViolation if any residual attachment matters. Re-run 'assignee destroy' to retry remaining attachments.",
        });
      }
    } catch (err) {
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          success: false,
          error: `Cannot detach InternetGateway before delete: ${err.message}`,
        };
      }
      // Non-fatal: gateway may already be detached, or the lookup may have
      // raced a concurrent destroy. Log and continue — the downstream
      // CloudControl delete will surface a clean error if it really is
      // still attached.
      warnDestroy("igw_detach_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ec2?.destroy();
    }
  },
};
