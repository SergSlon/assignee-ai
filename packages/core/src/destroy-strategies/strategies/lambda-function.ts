/**
 * Lambda Function destroy strategy — cascades to the companion IAM exec
 * role created by the `lambda-with-exec-role` compound pattern.
 *
 * When `assignee infra apply "Create a Lambda"` runs, it auto-creates an IAM
 * role named `assignee-iam-execution-role-<runId8>` and a Lambda with
 * the same runId suffix. The provision log records both resources under
 * the same runId. Without this cascade, destroying the Lambda orphans
 * the IAM role on the account (cost leak + security hygiene).
 *
 * Safety guardrails — the cascade only fires when ALL of:
 *   1. A companion IAM role record shares the Lambda's runId in the
 *      provision log.
 *   2. The role ARN ends with `/assignee-iam-execution-role-<shortId>`
 *      (the exact name compound-helpers.ts writes). User-provided roles
 *      (e.g. "my-lambda-role") are never touched.
 *   3. The cascade delete is non-fatal — a failed role deletion logs a
 *      warn but never fails the Lambda destroy. The user can clean up
 *      manually if needed.
 *
 * CCAPI identifier for AWS::IAM::Role is the bare role name (not ARN).
 * The provision log stores the full ARN; we extract the name via
 * `arn.split("/").pop()`.
 */

import {
  CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import { RESOURCE_TYPES } from "../../config/resource-types/named.js";
import { listProvisionRecords } from "../../managed-resources/store.js";
import type { DestroyStrategy } from "../types.js";

/** Name prefix for auto-created compound-pattern exec roles. */
const ASSIGNEE_EXEC_ROLE_PREFIX = "assignee-iam-execution-role-";

/** Poll cap: 30 × 2s = 60s max wait for role delete. */
const ROLE_DELETE_MAX_POLL = 30;
const ROLE_DELETE_POLL_MS = 2000;

export const lambdaFunctionStrategy: DestroyStrategy = {
  resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,

  async postDestroy(ctx) {
    const { resource, awsConfig } = ctx;

    // Find the Lambda's provision record to get its runId.
    let lambdaRunId: string | undefined;
    try {
      const records = await listProvisionRecords();
      const lambdaRecord = records.find((r) => r.key === resource.arn);
      if (!lambdaRecord?.runId) return;
      lambdaRunId = lambdaRecord.runId;
    } catch (err) {
      ctx.warn("lambda_cascade_provision_lookup_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Find a companion IAM role with the same runId whose name is the
    // auto-generated assignee exec role (never a user-provided role).
    let companionRoleArn: string | undefined;
    try {
      const records = await listProvisionRecords();
      const companion = records.find(
        (r) =>
          r.runId === lambdaRunId &&
          r.resourceType === RESOURCE_TYPES.IAM_ROLE &&
          (() => {
            const roleName = r.key.split("/").pop() ?? "";
            return roleName.startsWith(ASSIGNEE_EXEC_ROLE_PREFIX);
          })(),
      );
      if (!companion) return;
      companionRoleArn = companion.key;
    } catch (err) {
      ctx.warn("lambda_cascade_role_lookup_failed", {
        identifier: resource.identifier,
        runId: lambdaRunId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    const roleName = companionRoleArn.split("/").pop();
    if (!roleName) return;

    ctx.onProgress?.(`Cascading destroy to companion IAM role: ${roleName}`);

    let ccClient: CloudControlClient | undefined;
    try {
      ccClient = new CloudControlClient({
        region: awsConfig.region,
        credentials: {
          accessKeyId: awsConfig.accessKeyId,
          secretAccessKey: awsConfig.secretAccessKey,
          // W2-01: pass session token for STS/SSO short-term credentials.
          ...(awsConfig.sessionToken
            ? { sessionToken: awsConfig.sessionToken }
            : {}),
        },
      });

      const deleteResult = await ccClient.send(
        new DeleteResourceCommand({
          TypeName: RESOURCE_TYPES.IAM_ROLE,
          Identifier: roleName,
        }),
      );

      const requestToken = deleteResult.ProgressEvent?.RequestToken;
      if (!requestToken) return;

      // Poll until SUCCESS, FAILED, or cap.
      for (let i = 0; i < ROLE_DELETE_MAX_POLL; i++) {
        const statusResult = await ccClient.send(
          new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
        );
        const status = statusResult.ProgressEvent?.OperationStatus;
        if (status === "SUCCESS") {
          ctx.onProgress?.(`Companion IAM role ${roleName} deleted.`);
          return;
        }
        if (status === "FAILED") {
          const errCode = statusResult.ProgressEvent?.ErrorCode ?? "unknown";
          // NotFound means already gone — treat as success.
          if (errCode === "NotFound") return;
          ctx.warn("lambda_cascade_role_delete_failed", {
            roleName,
            errorCode: errCode,
            statusMessage: statusResult.ProgressEvent?.StatusMessage ?? "",
          });
          return;
        }
        await new Promise((r) => setTimeout(r, ROLE_DELETE_POLL_MS));
      }

      ctx.warn("lambda_cascade_role_delete_timeout", {
        roleName,
        hint: `Run \`assignee infra destroy arn:aws:iam::...:role/${roleName}\` to clean up manually.`,
      });
    } catch (err) {
      // Non-fatal: log so the user knows, but the Lambda destroy succeeded.
      ctx.warn("lambda_cascade_role_delete_error", {
        roleName,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      ccClient?.destroy();
    }
  },
};
