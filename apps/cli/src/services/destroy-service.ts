/**
 * destroy-service.ts — Reusable destroy logic extracted from the destroy command.
 *
 * Provides a `destroySingleResource()` function that handles:
 * - CloudControl API deletion with polling
 * - SDK fallback for EventSourceMapping, SNS Subscription, SNS Topic
 * - Pre-delete hooks (DynamoDB deletion protection)
 * - Redirect types (returns error)
 *
 * Returns a structured DestroyResult instead of throwing, making it
 * suitable for both single-resource and bulk-destroy workflows.
 *
 * @see Story 36.1
 */

import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  RESOURCE_TYPES,
} from "@assignee/core";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { ProvisioningErrorKind } from "./provisioning-port.js";
import { SDKFallbackDispatcher } from "./sdk-fallback-dispatcher.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import {
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "../config/aws-credentials.js";
import {
  AWS_REGION,
  DESTROY_MAX_POLL_ATTEMPTS,
  DESTROY_POLL_INTERVAL_MS,
} from "../config/constants.js";

/**
 * Structured warn-level log line for non-fatal failures inside the destroy
 * pipeline. destroy-service has no LangGraph runId plumbed in, so we emit a
 * plain JSON object on stderr (matching the shape of the main logger) rather
 * than depending on ../utils/logger.ts which requires an action enum value.
 */
function warnDestroy(action: string, extras: Record<string, unknown>): void {
  try {
    process.stderr.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "warn",
        source: "destroy-service",
        action,
        extras,
      }) + "\n",
    );
  } catch {
    // stderr write failures are swallowed — never let logging break destroy.
  }
}

/**
 * CloudFront distribution disable polling parameters.
 * CloudFront "in-progress" transitions routinely take 15+ minutes; we allow
 * up to 30 minutes before giving up. Each poll sleeps POLL_INTERVAL_MS.
 */
const CLOUDFRONT_DISABLE_MAX_ATTEMPTS = 360; // 360 * 5s = 30 min
const CLOUDFRONT_POLL_INTERVAL_MS = 5000;
/** Max consecutive transient errors from cf.send(GetDistribution) before aborting. */
const CLOUDFRONT_MAX_TRANSIENT_ERRORS = 5;

/**
 * DynamoDB UpdateTable(DeletionProtectionEnabled=false) returns immediately,
 * but the disable propagates asynchronously. Polling DescribeTable until
 * the change is visible avoids racing the subsequent CloudControl
 * DeleteResource call (which would fail with ResourceInUseException).
 */
const DDB_DISABLE_PROTECTION_MAX_POLLS = 6;
const DDB_DISABLE_PROTECTION_POLL_INTERVAL_MS = 5000;

/**
 * S3 DeleteObjects accepts at most 1000 keys per request. ListObjectVersions
 * can return up to 1000 Versions plus 1000 DeleteMarkers in a single page —
 * 2000 combined — so the merged array must be chunked before deletion.
 */
const S3_DELETE_OBJECTS_CHUNK_SIZE = 1000;

const MAX_POLL_ATTEMPTS = DESTROY_MAX_POLL_ATTEMPTS;
const POLL_INTERVAL_MS = DESTROY_POLL_INTERVAL_MS;

/** AWS CloudControl API operation status values. */
const CCAPIStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
} as const;

/** CloudControl HandlerErrorCode for "resource does not exist". */
const CCAPI_NOT_FOUND_ERROR_CODE = "NotFound";

export interface DestroyResult {
  success: boolean;
  resourceType: string;
  identifier: string;
  arn: string;
  error?: string;
}

export interface DestroyOptions {
  region?: string;
  silent?: boolean; // suppress spinner/output for bulk mode
  onProgress?: (message: string) => void;
}

/**
 * Polls for delete completion using the CloudControlAdapter's getRequestStatus method.
 *
 * Returns `success: true` for both genuine SUCCESS and the FAILED+NotFound
 * combination. The latter happens when the bulk-destroy plan picks up a
 * resource from the Resource Groups Tagging API that has already been
 * deleted in AWS (the API continues to return tags for ~1 hour after
 * NAT Gateway/EIP deletion). The user's destroy intent is satisfied
 * either way — the resource is gone.
 */
async function pollDeleteStatus(
  adapter: CloudControlAdapter,
  requestToken: string,
): Promise<{ success: boolean; message?: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const [err, status] = await adapter.getRequestStatus(requestToken);
    if (err) {
      return { success: false, message: err.message };
    }

    if (status.operationStatus === CCAPIStatus.SUCCESS) {
      return { success: true };
    }
    if (status.operationStatus === CCAPIStatus.FAILED) {
      // Treat NotFound as success — the resource is already in the desired
      // (deleted) end state. CloudControl reports this via the structured
      // ErrorCode field rather than a fragile string match on statusMessage.
      if (status.errorCode === CCAPI_NOT_FOUND_ERROR_CODE) {
        return { success: true };
      }
      return {
        success: false,
        message: status.statusMessage ?? "Delete operation failed",
      };
    }

    // IN_PROGRESS — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { success: false, message: "Delete operation timed out" };
}

/**
 * Destroys a single AWS resource via CloudControl API or SDK fallback.
 *
 * Returns a structured result instead of throwing, making it composable
 * for both interactive single-destroy and bulk-destroy flows.
 */
export async function destroySingleResource(
  resource: {
    arn: string;
    resourceType: string;
    identifier: string;
    region: string;
  },
  options?: DestroyOptions,
): Promise<DestroyResult> {
  const baseResult: Pick<DestroyResult, "resourceType" | "identifier" | "arn"> =
    {
      resourceType: resource.resourceType,
      identifier: resource.identifier,
      arn: resource.arn,
    };

  const resourceType = resource.resourceType;

  // ── Redirect types cannot be deleted ─────────────────────────────────
  if (CCAPI_REDIRECT_TYPES[resourceType]) {
    return {
      ...baseResult,
      success: false,
      error: `${resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
    };
  }

  // ── Resolve AWS credentials ──────────────────────────────────────────
  const awsConfig: AwsConfig = {
    ...operatorCredentials(),
    ...(options?.region ? { region: options.region } : {}),
  };

  // ── SDK fallback for CCAPI gap types ─────────────────────────────────
  if (
    resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING ||
    resourceType === CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION ||
    resourceType === RESOURCE_TYPES.SNS_TOPIC
  ) {
    try {
      const dispatcher = new SDKFallbackDispatcher(awsConfig);

      let deleteResult;
      if (resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING) {
        deleteResult = await dispatcher.deleteEventSourceMapping(
          resource.identifier,
        );
      } else if (resourceType === RESOURCE_TYPES.SNS_TOPIC) {
        // SNS Topic delete via CloudControl fails with invalid TopicArn format.
        // Use native SDK DeleteTopicCommand instead.
        deleteResult = await dispatcher.deleteTopic(resource.arn);
      } else {
        deleteResult = await dispatcher.unsubscribe(resource.arn);
      }

      const [deleteErr] = deleteResult;
      if (deleteErr) {
        return {
          ...baseResult,
          success: false,
          error: `Failed to destroy resource: ${deleteErr.message}`,
        };
      }

      return { ...baseResult, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        success: false,
        error: `Failed to destroy resource: ${message}`,
      };
    }
  }

  // ── CloudFront distribution: disable then delete (SDK only) ──────────
  if (resourceType === "AWS::CloudFront::Distribution") {
    try {
      const {
        CloudFrontClient,
        GetDistributionCommand,
        UpdateDistributionCommand,
        DeleteDistributionCommand,
      } = await import("@aws-sdk/client-cloudfront");
      // L-A12: Migrate from the legacy `awsConfig.accessKeyId` check (which
      // would only fire for the CloudFront branch) to the same
      // `requireAssigneeCredentials("operator")` helper used by the rest of
      // destroy-service. This guarantees a consistent friendly error if
      // operatorCredentials() ever returns an object missing keys.
      let cfCreds;
      try {
        cfCreds = requireAssigneeCredentials("operator");
      } catch (credErr) {
        if (credErr instanceof MissingAssigneeCredentialsError) {
          return {
            ...baseResult,
            success: false,
            error: `Missing AWS credentials for resource cleanup: ${credErr.message}`,
          };
        }
        throw credErr;
      }
      const cf = new CloudFrontClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: cfCreds,
      });

      // Step 1: Get current config + ETag
      const getResp = await cf.send(
        new GetDistributionCommand({ Id: resource.identifier }),
      );
      const config = getResp.Distribution?.DistributionConfig;
      const etag = getResp.ETag;
      if (!config || !etag) {
        return {
          ...baseResult,
          success: false,
          error: "Could not retrieve distribution config",
        };
      }

      // Step 2: Disable if enabled
      if (config.Enabled) {
        config.Enabled = false;
        await cf.send(
          new UpdateDistributionCommand({
            Id: resource.identifier,
            DistributionConfig: config,
            IfMatch: etag,
          }),
        );
        // Wait for deployment. CloudFront Deployed transitions routinely
        // take 15+ minutes; we allow up to 30 minutes. Transient errors
        // from GetDistribution (throttling, 5xx) are retried up to
        // CLOUDFRONT_MAX_TRANSIENT_ERRORS consecutive times before aborting.
        const maxSec =
          (CLOUDFRONT_DISABLE_MAX_ATTEMPTS * CLOUDFRONT_POLL_INTERVAL_MS) /
          1000;
        let consecutiveTransientErrors = 0;
        for (let i = 0; i < CLOUDFRONT_DISABLE_MAX_ATTEMPTS; i++) {
          await new Promise((r) => setTimeout(r, CLOUDFRONT_POLL_INTERVAL_MS));
          options?.onProgress?.(
            `Disabling CloudFront distribution (${
              ((i + 1) * CLOUDFRONT_POLL_INTERVAL_MS) / 1000
            }s / ~${maxSec}s max)...`,
          );
          let status;
          try {
            status = await cf.send(
              new GetDistributionCommand({ Id: resource.identifier }),
            );
            consecutiveTransientErrors = 0;
          } catch (pollErr) {
            consecutiveTransientErrors++;
            warnDestroy("cloudfront_poll_transient_error", {
              identifier: resource.identifier,
              attempt: i + 1,
              consecutive: consecutiveTransientErrors,
              error:
                pollErr instanceof Error ? pollErr.message : String(pollErr),
            });
            if (consecutiveTransientErrors >= CLOUDFRONT_MAX_TRANSIENT_ERRORS) {
              return {
                ...baseResult,
                success: false,
                error: `CloudFront poll failed after ${consecutiveTransientErrors} consecutive transient errors: ${
                  pollErr instanceof Error ? pollErr.message : String(pollErr)
                }`,
              };
            }
            // Retry on next iteration
            continue;
          }
          const distStatus = status.Distribution?.Status;
          if (distStatus === "Deployed") {
            // Step 3: Delete with latest ETag
            await cf.send(
              new DeleteDistributionCommand({
                Id: resource.identifier,
                IfMatch: status.ETag!,
              }),
            );
            return { ...baseResult, success: true };
          }
          if (distStatus && distStatus !== "InProgress") {
            return {
              ...baseResult,
              success: false,
              error: `CloudFront disable failed with status: ${distStatus}`,
            };
          }
        }
        return {
          ...baseResult,
          success: false,
          error: `CloudFront disable timed out after ${maxSec / 60} minutes`,
        };
      }

      // Already disabled — delete directly
      await cf.send(
        new DeleteDistributionCommand({
          Id: resource.identifier,
          IfMatch: etag,
        }),
      );
      return { ...baseResult, success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        ...baseResult,
        success: false,
        error: `CloudFront destroy failed: ${message}`,
      };
    }
  }

  // ── Pre-delete hooks ─────────────────────────────────────────────────
  // DynamoDB: disable deletion protection before deleting
  if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    try {
      const { DynamoDBClient, UpdateTableCommand, DescribeTableCommand } =
        await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      await ddb.send(
        new UpdateTableCommand({
          TableName: resource.identifier,
          DeletionProtectionEnabled: false,
        }),
      );

      // Poll DescribeTable until DeletionProtectionEnabled propagates to false.
      // UpdateTable returns immediately while the change is still in flight,
      // and a racing CloudControl DeleteResource will fail with
      // ResourceInUseException. We poll up to ~30s before giving up — at
      // which point the downstream delete will surface its own error.
      for (let i = 0; i < DDB_DISABLE_PROTECTION_MAX_POLLS; i++) {
        let described;
        try {
          described = await ddb.send(
            new DescribeTableCommand({ TableName: resource.identifier }),
          );
        } catch (descErr) {
          // V1 N2: Distinguish "permission denied" from "transient" failures.
          // Previously we always `break` on any DescribeTable error and let
          // the downstream CloudControl delete race the unfinished
          // UpdateTable, which produced a confusing ResourceInUseException.
          // If the operator role lacks dynamodb:DescribeTable we can NEVER
          // verify propagation — that is an operational misconfiguration,
          // not a transient state, so surface it loudly.
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
              ...baseResult,
              success: false,
              error:
                `Cannot verify DynamoDB deletion-protection propagation for ` +
                `${resource.identifier}: missing dynamodb:DescribeTable ` +
                `permission. Grant the operator role dynamodb:DescribeTable on ` +
                `this table and retry. Underlying error: ${errMessage}`,
            };
          }
          // Non-permission failure (e.g. transient throttle) — log and bail
          // out of the poll loop, letting the downstream delete surface its
          // own error.
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
    } catch (err) {
      // Surface missing-credentials errors clearly — never let them be
      // silently swallowed, or the subsequent CloudControl DeleteResource
      // fails with a confusing ResourceInUseException.
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          ...baseResult,
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
  }

  // S3: empty bucket before deleting (buckets with objects cannot be destroyed)
  if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    try {
      const { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } =
        await import("@aws-sdk/client-s3");
      const s3 = new S3Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });

      // Delete all object versions and delete markers (paginated)
      let isTruncated = true;
      let batch = 0;
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      while (isTruncated) {
        batch++;
        options?.onProgress?.(`Emptying S3 bucket (batch ${batch})...`);
        const versions = await s3.send(
          new ListObjectVersionsCommand({
            Bucket: resource.identifier,
            KeyMarker: keyMarker,
            VersionIdMarker: versionIdMarker,
          }),
        );
        const objects = [
          ...(versions.Versions ?? []).map((v) => ({
            Key: v.Key!,
            VersionId: v.VersionId,
          })),
          ...(versions.DeleteMarkers ?? []).map((m) => ({
            Key: m.Key!,
            VersionId: m.VersionId,
          })),
        ].filter((o) => o.Key);

        // ListObjectVersions can return up to 1000 Versions PLUS up to 1000
        // DeleteMarkers in a single page (2000 combined). DeleteObjects
        // accepts at most 1000 keys per request, so we must chunk.
        for (
          let off = 0;
          off < objects.length;
          off += S3_DELETE_OBJECTS_CHUNK_SIZE
        ) {
          const chunk = objects.slice(off, off + S3_DELETE_OBJECTS_CHUNK_SIZE);
          await s3.send(
            new DeleteObjectsCommand({
              Bucket: resource.identifier,
              Delete: { Objects: chunk },
            }),
          );
        }
        isTruncated = versions.IsTruncated ?? false;
        keyMarker = versions.NextKeyMarker;
        versionIdMarker = versions.NextVersionIdMarker;
        // V1 N5 audit (2026-04-06): paranoid guard against an infinite loop
        // if the AWS response sets IsTruncated=true but omits BOTH next
        // markers. The AWS spec says this can't happen, but a malformed/
        // mocked response previously caused destroy to spin forever. Break
        // out so the destroy attempt fails fast and the caller can retry.
        if (isTruncated && !keyMarker && !versionIdMarker) {
          warnDestroy("s3_list_versions_truncated_without_marker", {
            identifier: resource.identifier,
            batch,
          });
          break;
        }
      }
    } catch (err) {
      // Surface missing-credentials errors clearly — swallowing them here
      // causes the downstream CloudControl DeleteResource to fail with an
      // opaque BucketNotEmpty-style error.
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          ...baseResult,
          success: false,
          error: `Cannot empty S3 bucket before delete: ${err.message}`,
        };
      }
      // Non-fatal: bucket may already be empty, or the role may lack
      // s3:ListBucketVersions / s3:DeleteObject on it. Log and continue.
      warnDestroy("s3_empty_bucket_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // InternetGateway: detach from VPCs before deleting (CloudControl
  // delegates to DeleteInternetGateway which fails with DependencyViolation
  // when the gateway is still attached). AWS::EC2::VPCGatewayAttachment is
  // a CloudFormation-only construct with no taggable AWS resource, so it
  // never appears in the bulk-destroy plan and cannot be torn down through
  // the normal tier path. Mirrors the MCP server's igw-strategy.
  if (resourceType === RESOURCE_TYPES.EC2_INTERNET_GATEWAY) {
    try {
      const {
        EC2Client,
        DescribeInternetGatewaysCommand,
        DetachInternetGatewayCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const desc = await ec2.send(
        new DescribeInternetGatewaysCommand({
          InternetGatewayIds: [resource.identifier],
        }),
      );
      const attachments = desc.InternetGateways?.[0]?.Attachments ?? [];
      for (const att of attachments) {
        if (att.VpcId && att.State !== "detached") {
          await ec2.send(
            new DetachInternetGatewayCommand({
              InternetGatewayId: resource.identifier,
              VpcId: att.VpcId,
            }),
          );
        }
      }
    } catch (err) {
      if (err instanceof MissingAssigneeCredentialsError) {
        return {
          ...baseResult,
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
    }
  }

  // RouteTable: disassociate any non-main subnet associations before
  // deleting (DeleteRouteTable fails with DependencyViolation while
  // associations exist). AWS::EC2::SubnetRouteTableAssociation is a
  // CloudFormation-only construct with no taggable AWS resource, so it
  // never appears in the bulk-destroy plan. Skip Main=true associations
  // — the VPC's main route table cannot be disassociated and will be
  // cleaned up automatically when the VPC is deleted.
  if (resourceType === RESOURCE_TYPES.EC2_ROUTE_TABLE) {
    try {
      const {
        EC2Client,
        DescribeRouteTablesCommand,
        DisassociateRouteTableCommand,
      } = await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
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
          ...baseResult,
          success: false,
          error: `Cannot disassociate RouteTable before delete: ${err.message}`,
        };
      }
      warnDestroy("route_table_disassociate_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Default: CloudControl API ────────────────────────────────────────
  try {
    const ccClient = createCloudControlClient(awsConfig);
    const adapter = new CloudControlAdapter(ccClient);

    const [deleteErr, deleteResult] = await adapter.deleteResource(
      resourceType,
      resource.identifier,
    );

    if (deleteErr) {
      // NOT_FOUND means the resource is already gone — that is the user's
      // intended end-state for a destroy operation, so report success rather
      // than a noisy failure. Common cause: the Resource Groups Tagging API
      // continues to return tags for ~1 hour after a NAT Gateway/EIP is
      // actually deleted, which causes destroy --all to repeatedly emit
      // confusing "not found" errors for resources that the bulk-destroy
      // plan included from a stale tag listing.
      if (deleteErr.kind === ProvisioningErrorKind.NOT_FOUND) {
        return { ...baseResult, success: true };
      }
      return {
        ...baseResult,
        success: false,
        error: `Failed to destroy resource: ${deleteErr.message}`,
      };
    }

    // Poll for delete completion
    const pollResult = await pollDeleteStatus(
      adapter,
      deleteResult.requestToken,
    );

    if (!pollResult.success) {
      return {
        ...baseResult,
        success: false,
        error: `Destroy failed: ${pollResult.message}`,
      };
    }

    return { ...baseResult, success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...baseResult,
      success: false,
      error: `Failed to destroy resource: ${message}`,
    };
  }
}
