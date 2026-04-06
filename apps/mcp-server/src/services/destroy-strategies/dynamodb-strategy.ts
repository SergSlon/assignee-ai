/**
 * Destroy strategy for AWS::DynamoDB::Table.
 *
 * DynamoDB tables may have deletion protection enabled. The preDestroy hook
 * disables it before the CloudControl delete call. Failure is non-fatal
 * since the table may not have protection enabled.
 *
 * Uses the centralized `requireAssigneeCredentials("operator")` helper from
 * @assignee/core — never falls through to the default AWS credential chain.
 */

import { requireAssigneeCredentials } from "@assignee/core";
import type { DestroyStrategy } from "./types.js";

export const dynamodbStrategy: DestroyStrategy = {
  resourceType: "AWS::DynamoDB::Table",

  async preDestroy(identifier: string, region: string): Promise<void> {
    const { DynamoDBClient, UpdateTableCommand } =
      await import("@aws-sdk/client-dynamodb");
    const ddb = new DynamoDBClient({
      region,
      credentials: requireAssigneeCredentials("operator"),
    });
    await ddb.send(
      new UpdateTableCommand({
        TableName: identifier,
        DeletionProtectionEnabled: false,
      }),
    );
  },
};
