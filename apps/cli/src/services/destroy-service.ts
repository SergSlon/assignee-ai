/**
 * destroy-service.ts — Reusable destroy logic extracted from the destroy command.
 *
 * Provides a `destroySingleResource()` function that handles:
 * - CloudControl API deletion with polling
 * - Pre-delete hooks (DynamoDB deletion protection)
 * - Redirect types (returns error)
 *
 * Returns a structured DestroyResult instead of throwing, making it
 * suitable for both single-resource and bulk-destroy workflows.
 *
 * @see Story 36.1
 * @see A6  (2026-04-08) — Lambda EventSourceMapping + SNS Topic delete
 *                         migrated from SDK fallback to CCAPI.
 * @see A10 (2026-04-09) — SNS Subscription promoted to first-class;
 *                         SDK Unsubscribe path removed from this file.
 */

import {
  CCAPI_REDIRECT_TYPES,
  COMPANION_RESOURCE_TYPES,
  RESOURCE_TYPES,
} from "@assignee/core";
import { createCloudControlClient } from "./cloudcontrol-client.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { CloudControlAdapter } from "./cloudcontrol-adapter.js";
import { ProvisioningErrorKind } from "./provisioning-port.js";
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

/**
 * ALB post-delete ENI drain parameters.
 * After CCAPI reports SUCCESS for ELBv2::LoadBalancer deletion, AWS takes
 * 30-120s to release the ALB's ENIs and public IPs. Subsequent tier 4
 * destroys (IGW detach, SecurityGroup delete, Subnet delete) fail with
 * DependencyViolation if the ENIs are still in-use. We poll
 * DescribeNetworkInterfaces until no ALB-related ENIs remain in the VPC.
 */
const ALB_ENI_DRAIN_MAX_ATTEMPTS = 24; // 24 * 5s = 120s
const ALB_ENI_DRAIN_POLL_INTERVAL_MS = 5000;

/**
 * Wave 11 P2-2: extracts the AWS account ID segment from an ARN, or
 * returns undefined when the ARN has no account segment (S3 buckets,
 * for example: `arn:aws:s3:::my-bucket`). Used by the cross-account
 * sanity check on CCAPI NotFound short-circuits.
 *
 * ARN structure: `arn:partition:service:region:account-id:resource`
 * — account-id is the 5th colon-separated segment (index 4).
 */
function extractAccountIdFromArn(arn: string): string | undefined {
  const parts = arn.split(":");
  if (parts.length < 5) return undefined;
  const account = parts[4];
  return account && /^\d{12}$/.test(account) ? account : undefined;
}

/**
 * Wave 11 P2-2: cross-account sanity check before treating a CCAPI
 * NotFound as success.
 *
 * Threat: a misconfigured operator credential set could legitimately
 * point at a different AWS account than the resource ARN's account.
 * In that case CCAPI returns NotFound for resources that genuinely
 * exist in the user's intended account but don't exist in the wrongly-
 * assumed one. The original short-circuit treated this as "destroy
 * success" — silently failing to delete the actual resources while
 * reporting OK.
 *
 * Returns:
 *   - `"safe-shortcircuit"` when the ARN's account matches the
 *     operator's account (the legitimate "already gone" case)
 *   - `"safe-shortcircuit"` when account info is unavailable on either
 *     side (S3 bucket ARN with no account segment, or STS lookup failed
 *     — preserve the original Wave 5 behavior in those edge cases since
 *     blocking the short-circuit there would regress the bulk-destroy
 *     tag-ghost cleanup that Wave 5 was designed to handle)
 *   - `"cross-account"` when the accounts differ — the caller should
 *     surface a real error explaining the mismatch instead of treating
 *     NotFound as success
 */
async function classifyNotFoundShortCircuit(
  resourceArn: string,
): Promise<"safe-shortcircuit" | "cross-account"> {
  const arnAccount = extractAccountIdFromArn(resourceArn);
  if (!arnAccount) return "safe-shortcircuit";

  // Lazy import to avoid pulling resolve-arn (and STS client) into
  // every code path that imports destroy-service. The cached
  // getOperatorAccountId helper amortizes the STS call across the
  // whole CLI process.
  const { getOperatorAccountId } = await import("../utils/resolve-arn.js");
  const operatorAccount = await getOperatorAccountId();
  if (!operatorAccount) return "safe-shortcircuit";

  return arnAccount === operatorAccount ? "safe-shortcircuit" : "cross-account";
}

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
  resourceArn?: string,
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
      //
      // Wave 11 P2-2: cross-account sanity check. If the operator's
      // account differs from the resource ARN's account, this NotFound
      // is almost certainly the user pointing at the wrong account by
      // accident — surface it as a real error so they don't think the
      // destroy succeeded.
      if (status.errorCode === CCAPI_NOT_FOUND_ERROR_CODE) {
        if (resourceArn) {
          const classification =
            await classifyNotFoundShortCircuit(resourceArn);
          if (classification === "cross-account") {
            return {
              success: false,
              message: `CloudControl reported NotFound for ${resourceArn}, but the operator credentials are configured for a different AWS account. The resource may exist in your intended account — verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
            };
          }
        }
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
  // Wave 19 Bug #9: IAM is a global service. The bulk-destroy plan tags
  // IAM resources with `region: "global"` (matching how list-resources.ts
  // reports them), and the CLI's destroy command passes that through to
  // destroySingleResource as `options.region`. Without remapping, the
  // CloudControl SDK builds an endpoint of `cloudcontrolapi.global.amazonaws.com`,
  // which doesn't exist — the destroy fails with `getaddrinfo ENOTFOUND
  // cloudcontrolapi.global.amazonaws.com` and leaves the IAM resource
  // orphaned. Always promote "global" to a real Bedrock-eligible region
  // (us-east-1 is the canonical IAM control-plane region).
  const requestedRegion = options?.region;
  const effectiveRegion =
    requestedRegion === "global" || !requestedRegion
      ? AWS_REGION
      : requestedRegion;
  const awsConfig: AwsConfig = {
    ...operatorCredentials(),
    region: effectiveRegion,
  };

  // ── EIP destroy via native ec2:ReleaseAddress ────────────────────────
  // Wave 19 Bug #6: EIP is not destroyable via CloudControl DeleteResource
  // (the type schema exists but the delete handler is unreliable for EIPs
  // attached to NAT Gateways that have been deleted but not yet propagated).
  // Always go through ec2:ReleaseAddress directly. The bulk-destroy tier
  // table now lists EIP at tier 4, after NAT Gateway at tier 3, so by the
  // time we reach this branch the NAT Gateway is already gone and the EIP
  // is in `disassociated` state.
  if (resourceType === COMPANION_RESOURCE_TYPES.EC2_EIP) {
    try {
      const { EC2Client, ReleaseAddressCommand } =
        await import("@aws-sdk/client-ec2");
      const ec2 = new EC2Client({
        region: resource.region,
        ...(awsConfig.accessKeyId && awsConfig.secretAccessKey
          ? {
              credentials: {
                accessKeyId: awsConfig.accessKeyId,
                secretAccessKey: awsConfig.secretAccessKey,
              },
            }
          : {}),
      });
      // ARN format: arn:aws:ec2:us-east-1:054125018476:elastic-ip/eipalloc-xxx
      // Identifier comes from extractIdentifier and is just `eipalloc-xxx`.
      await ec2.send(
        new ReleaseAddressCommand({ AllocationId: resource.identifier }),
      );
      return { ...baseResult, success: true };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      // InvalidAllocationID.NotFound = already released, treat as success
      if (
        errMsg.includes("InvalidAllocationID.NotFound") ||
        errMsg.includes("does not exist")
      ) {
        return { ...baseResult, success: true };
      }
      return {
        ...baseResult,
        success: false,
        error: `Failed to release EIP ${resource.identifier}: ${errMsg}`,
      };
    }
  }

  // A10 (2026-04-09): SNS Subscription is no longer routed through
  // the SDK dispatcher — it's now a first-class CCAPI type with its
  // own plugin and flows through the standard DeleteResource path
  // below. The dispatcher.unsubscribe() branch was removed.

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
      // Wave 19 Bug #3: AccessDenied on ListBucketVersions / DeleteObjectVersion
      // used to be swallowed as a warn and the destroy continued — which only
      // appeared to work on empty buckets. On any bucket that had ever received
      // writes, CloudControl DeleteBucket would then fail with BucketNotEmpty
      // and the user got an opaque error. Promoted to hard failure so the
      // user learns the real cause (missing IAM perm) instead of a
      // second-order CCAPI error. s3:ListBucketVersions + s3:DeleteObjectVersion
      // are already in iam-actions.ts for S3_BUCKET; if the deployed
      // AssigneeOperatorPolicy lacks them, re-run `assignee setup`.
      const errMsg = err instanceof Error ? err.message : String(err);
      const isAccessDenied =
        errMsg.includes("AccessDenied") ||
        errMsg.includes("not authorized") ||
        errMsg.includes("UnauthorizedOperation");
      if (isAccessDenied) {
        return {
          ...baseResult,
          success: false,
          error:
            `Cannot empty S3 bucket "${resource.identifier}" before delete — the operator role lacks ` +
            `s3:ListBucketVersions / s3:DeleteObjectVersion. These are already in iam-actions.ts for ` +
            `S3_BUCKET; run \`assignee setup\` to refresh AssigneeOperatorPolicy in AWS. ` +
            `Original AWS error: ${errMsg}`,
        };
      }
      // Other failures (network, throttling, empty bucket) — log and continue
      // so destroy still attempts DeleteBucket.
      warnDestroy("s3_empty_bucket_failed", {
        identifier: resource.identifier,
        error: errMsg,
      });
    }
  }

  // InternetGateway: detach from VPCs before deleting (CloudControl
  // delegates to DeleteInternetGateway which fails with DependencyViolation
  // when the gateway is still attached). AWS::EC2::VPCGatewayAttachment is
  // a CloudFormation-only construct with no taggable AWS resource, so it
  // never appears in the bulk-destroy plan and cannot be torn down through
  // the normal tier path. Mirrors the MCP server's igw-strategy.
  //
  // Wave 11 P2-3: half-state recovery. The previous loop ran detaches
  // sequentially with no per-attachment error handling — if attachment
  // N+1 failed after N had already been detached, the IGW was left in
  // a half-detached state with no recovery. The fix:
  //   1. Each per-attachment detach is wrapped in its own try/catch.
  //   2. Per-attachment failures are logged but don't abort the loop —
  //      we maximize forward progress so any subsequent attempt has
  //      less work to do.
  //   3. The structured warn log records `partial_detach_state` with
  //      success/failure counts so `assignee reconcile` (and debugging)
  //      can see exactly what happened.
  //   4. We DO NOT roll back successful detaches. Re-attaching is
  //      technically possible via AttachInternetGateway, but the user's
  //      intent was to destroy — re-attaching only delays the inevitable.
  //   5. CloudControl's subsequent DeleteResource will produce an
  //      authoritative DependencyViolation if any residual attachment
  //      blocks the delete. The user can re-run destroy and it will pick
  //      up where this one left off.
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
      // Surface partial state explicitly so reconcile/debugging can see
      // exactly which attachments were detached and which weren't. Only
      // emit when there's actual partial state to report.
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

  // EFS FileSystem: delete all mount targets before deleting the file
  // system. Mount targets are in NO_TAG_TYPES (no managed-by tag) so
  // they're invisible to the tag-based bulk-destroy discovery. Without
  // this pre-delete hook, DeleteFileSystem fails with "has mount targets"
  // (409 FileSystemInUse). Mirrors the IGW detach / RouteTable disassociate
  // pattern for non-taggable dependent resources.
  if (resourceType === RESOURCE_TYPES.EFS_FILE_SYSTEM) {
    try {
      const {
        EFSClient,
        DescribeMountTargetsCommand,
        DeleteMountTargetCommand,
      } = await import("@aws-sdk/client-efs");
      const efs = new EFSClient({
        region: awsConfig.region ?? AWS_REGION,
        credentials: requireAssigneeCredentials("operator"),
      });
      const desc = await efs.send(
        new DescribeMountTargetsCommand({
          FileSystemId: resource.identifier,
        }),
      );
      const mountTargets = desc.MountTargets ?? [];
      for (const mt of mountTargets) {
        if (mt.MountTargetId) {
          try {
            await efs.send(
              new DeleteMountTargetCommand({
                MountTargetId: mt.MountTargetId,
              }),
            );
          } catch (mtErr) {
            warnDestroy("efs_mount_target_delete_failed", {
              fileSystemId: resource.identifier,
              mountTargetId: mt.MountTargetId,
              error: mtErr instanceof Error ? mtErr.message : String(mtErr),
            });
          }
        }
      }
      // Mount target deletion is async — poll until all are gone (max 60s)
      if (mountTargets.length > 0) {
        for (let attempt = 0; attempt < 30; attempt++) {
          const check = await efs.send(
            new DescribeMountTargetsCommand({
              FileSystemId: resource.identifier,
            }),
          );
          if (!check.MountTargets || check.MountTargets.length === 0) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
    } catch (err) {
      warnDestroy("efs_mount_target_cleanup_failed", {
        identifier: resource.identifier,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Default: CloudControl API ────────────────────────────────────────
  try {
    const ccClient = createCloudControlClient(awsConfig);
    const adapter = new CloudControlAdapter(ccClient);

    // Some resource types use the full ARN as their CCAPI primary identifier
    // (not an extracted sub-path). If extractIdentifier stripped the ARN prefix,
    // CCAPI returns NOT_FOUND and the resource silently survives. Use the full
    // ARN for these types.
    const ARN_IDENTIFIED_TYPES: ReadonlySet<string> = new Set([
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    ]);
    const ccIdentifier = ARN_IDENTIFIED_TYPES.has(resourceType)
      ? resource.arn
      : resource.identifier;

    const [deleteErr, deleteResult] = await adapter.deleteResource(
      resourceType,
      ccIdentifier,
    );

    if (deleteErr) {
      // NOT_FOUND means the resource is already gone — that is the user's
      // intended end-state for a destroy operation, so report success rather
      // than a noisy failure. Common cause: the Resource Groups Tagging API
      // continues to return tags for ~1 hour after a NAT Gateway/EIP is
      // actually deleted, which causes destroy --all to repeatedly emit
      // confusing "not found" errors for resources that the bulk-destroy
      // plan included from a stale tag listing.
      //
      // Wave 11 P2-2: cross-account sanity check. Same threat as in
      // pollDeleteStatus — a misconfigured operator credential could
      // legitimately point at the wrong account, where the resource
      // doesn't exist. Surface that as a real error instead of silently
      // succeeding.
      if (deleteErr.kind === ProvisioningErrorKind.NOT_FOUND) {
        const classification = await classifyNotFoundShortCircuit(resource.arn);
        if (classification === "cross-account") {
          return {
            ...baseResult,
            success: false,
            error: `CloudControl reported NotFound for ${resource.arn}, but the operator credentials are configured for a different AWS account. The resource may exist in your intended account — verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
          };
        }
        return { ...baseResult, success: true };
      }
      return {
        ...baseResult,
        success: false,
        error: `Failed to destroy resource: ${deleteErr.message}`,
      };
    }

    // Poll for delete completion (pass resource.arn so the cross-account
    // sanity check can fire on FAILED+NotFound poll results too).
    const pollResult = await pollDeleteStatus(
      adapter,
      deleteResult.requestToken,
      resource.arn,
    );

    if (!pollResult.success) {
      return {
        ...baseResult,
        success: false,
        error: `Destroy failed: ${pollResult.message}`,
      };
    }

    // ── Post-delete: ALB ENI drain wait ────────────────────────────────
    // After CCAPI reports SUCCESS for ELBv2::LoadBalancer deletion, AWS
    // takes 30-120s to fully release the ALB's ENIs and public IPs.
    // Subsequent tier 4 destroys (IGW detach, SecurityGroup delete,
    // Subnet delete) fail with DependencyViolation because the ENIs are
    // still in-use. Poll DescribeNetworkInterfaces until no ALB-related
    // ENIs remain, or timeout after 120s.
    if (resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER) {
      try {
        const { EC2Client, DescribeNetworkInterfacesCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({
          region: awsConfig.region ?? AWS_REGION,
          credentials: requireAssigneeCredentials("operator"),
        });

        // ALB ENIs have a description matching "ELB app/<lb-name>/<hex>".
        // Extract the LB name from the ARN (full) or identifier (extracted).
        // Full ARN: arn:...:loadbalancer/app/<name>/<id>
        // Extracted identifier from bulk-destroy: app/<name>/<id>
        const lbNameMatch =
          resource.arn.match(/loadbalancer\/app\/([^/]+)\//) ??
          resource.identifier.match(/^app\/([^/]+)\//);
        const lbName = lbNameMatch?.[1];

        if (lbName) {
          for (
            let attempt = 0;
            attempt < ALB_ENI_DRAIN_MAX_ATTEMPTS;
            attempt++
          ) {
            const enis = await ec2.send(
              new DescribeNetworkInterfacesCommand({
                Filters: [
                  {
                    Name: "description",
                    Values: [`ELB app/${lbName}/*`],
                  },
                ],
              }),
            );

            const remaining = enis.NetworkInterfaces?.length ?? 0;
            if (remaining === 0) {
              if (attempt > 0) {
                options?.onProgress?.(
                  `ALB ENI drain complete after ${(attempt * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s`,
                );
              }
              break;
            }

            options?.onProgress?.(
              `Waiting for ${remaining} ALB ENI(s) to release (${((attempt + 1) * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s / ${(ALB_ENI_DRAIN_MAX_ATTEMPTS * ALB_ENI_DRAIN_POLL_INTERVAL_MS) / 1000}s max)...`,
            );
            await new Promise((r) =>
              setTimeout(r, ALB_ENI_DRAIN_POLL_INTERVAL_MS),
            );
          }
        } else {
          // Cannot extract LB name — fall back to a conservative 60s wait
          options?.onProgress?.(
            "Waiting 60s for ALB ENI release (cannot determine LB name)...",
          );
          await new Promise((r) => setTimeout(r, 60_000));
        }
      } catch (err) {
        // Non-fatal: if ENI polling fails, log and continue. The downstream
        // tier 4 deletes may still succeed if AWS has released the ENIs, or
        // they'll surface their own DependencyViolation error.
        warnDestroy("alb_eni_drain_failed", {
          identifier: resource.identifier,
          error: err instanceof Error ? err.message : String(err),
        });
      }
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
