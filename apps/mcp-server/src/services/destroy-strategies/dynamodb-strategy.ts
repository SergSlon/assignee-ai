/**
 * Destroy strategy for AWS::DynamoDB::Table.
 *
 * DynamoDB tables may have deletion protection enabled. The preDestroy
 * hook disables it before the CloudControl delete call. Failure is
 * non-fatal since the table may not have protection enabled.
 *
 * Uses the centralized `requireAssigneeCredentials("operator")` helper
 * from @assignee/core — never falls through to the default AWS
 * credential chain.
 *
 * @see Story 49.1 — migrated to the shared DestroyContext interface.
 */

import {
  RESOURCE_TYPES,
  requireAssigneeCredentials,
  type DestroyStrategy,
} from "@assignee/core";

export const dynamodbStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,

  async preDestroy(ctx): Promise<void> {
    const { resource, effectiveRegion } = ctx;
    const { DynamoDBClient, UpdateTableCommand } =
      await import("@aws-sdk/client-dynamodb");
    const ddb = new DynamoDBClient({
      region: effectiveRegion,
      credentials: requireAssigneeCredentials("operator"),
    });
    await ddb.send(
      new UpdateTableCommand({
        TableName: resource.identifier,
        DeletionProtectionEnabled: false,
      }),
    );
  },
};
