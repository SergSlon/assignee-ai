/**
 * DynamoDB Table destroy strategy — preDestroy disables deletion
 * protection and polls DescribeTable until the change has propagated.
 *
 * UpdateTable(DeletionProtectionEnabled=false) returns immediately,
 * but the disable propagates asynchronously. Polling DescribeTable
 * until the change is visible avoids racing the subsequent
 * CloudControl DeleteResource call (which would fail with
 * ResourceInUseException).
 *
 * V1 N2 invariant: if the operator role lacks dynamodb:DescribeTable
 * we can NEVER verify propagation — surface as a hard failure so the
 * user gets a clear IAM error instead of a confusing CCAPI race.
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

const DDB_DISABLE_PROTECTION_MAX_POLLS = 6;
const DDB_DISABLE_PROTECTION_POLL_INTERVAL_MS = 5000;

export const dynamodbTableStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
  async preDestroy(ctx) {
    const { resource, awsConfig } = ctx;
    try {
      const { DynamoDBClient, UpdateTableCommand, DescribeTableCommand } =
        await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({
        region: awsConfig.region ?? DEFAULT_AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      try {
        await ddb.send(
          new UpdateTableCommand({
            TableName: resource.identifier,
            DeletionProtectionEnabled: false,
          }),
        );

        // Poll DescribeTable until DeletionProtectionEnabled propagates to false.
        for (let i = 0; i < DDB_DISABLE_PROTECTION_MAX_POLLS; i++) {
          let described;
          try {
            described = await ddb.send(
              new DescribeTableCommand({ TableName: resource.identifier }),
            );
          } catch (descErr) {
            const errName =
              (descErr as { name?: string; Code?: string })?.name ??
              (descErr as { Code?: string })?.Code ??
              "";
            const errMessage =
              descErr instanceof Error ? descErr.message : String(descErr);
            const isPermissionError =
              errName === "AccessDeniedException" ||
              errName === "AccessDenied" ||
              errName === "UnauthorizedOperation" ||
              errName === "NotAuthorizedException" ||
              /\b(?:AccessDenied|not authorized|UnauthorizedOperation)\b/i.test(
                errMessage,
              );
            if (isPermissionError) {
              return {
                success: false,
                error:
                  `Cannot verify DynamoDB deletion-protection propagation for ` +
                  `${resource.identifier}: missing dynamodb:DescribeTable ` +
                  `permission. Grant the operator role dynamodb:DescribeTable on ` +
                  `this table and retry. Underlying error: ${errMessage}`,
              };
            }
            warnDestroy("dynamodb_describe_after_disable_failed", {
              identifier: resource.identifier,
              attempt: i + 1,
              error: errMessage,
            });
            break;
          }
          const stillProtected =
            described.Table?.DeletionProtectionEnabled === true;
          if (!stillProtected) break;
          if (i === DDB_DISABLE_PROTECTION_MAX_POLLS - 1) {
            warnDestroy("dynamodb_disable_protection_propagation_timeout", {
              identifier: resource.identifier,
              polls: DDB_DISABLE_PROTECTION_MAX_POLLS,
            });
            break;
          }
          await new Promise((r) =>
            setTimeout(r, DDB_DISABLE_PROTECTION_POLL_INTERVAL_MS),
          );
        }
      } finally {
        ddb.destroy();
      }
    } catch (err) {
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          success: false,
          error: `Cannot disable DynamoDB deletion protection: ${err.message}`,
        };
      }
      // Non-fatal: table may not have deletion protection enabled, or the
      // role may lack dynamodb:UpdateTable. Log and continue — the main
      // CloudControl delete path below will surface a clean error if the
      // table actually *is* protected.
      warnDestroy("dynamodb_disable_protection_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
