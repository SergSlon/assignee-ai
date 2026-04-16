/**
 * destroy_resource MCP tool — safely destroys a managed AWS resource.
 *
 * Resolves the resource by ARN or name via the Resource Groups Tagging API,
 * then deletes it via the CloudControl API and polls for completion.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — same pattern as apply_plan.
 * The agent must present resource details to the user and get explicit approval first.
 *
 * SOLID refactor (Wave 6b F5a): this entrypoint is now a thin MCP tool handler
 * that composes sub-modules under `./destroy-resource/`:
 *   - resolve.ts         — RGTA lookup + ARN tag verification
 *   - sts-cache.ts       — operator account-id cache (poison-proof per Wave 4)
 *   - dispatcher.ts      — poll + NotFound classification + pre-destroy hook
 *   - error-envelope.ts  — MCP response shape
 *   - credentials.ts     — operator credential bootstrap + RGTA client init
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  CloudControlClient,
  DeleteResourceCommand,
} from "@aws-sdk/client-cloudcontrol";
import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  DEFAULT_AWS_REGION,
} from "@assignee/core";
import {
  buildErrorResponse,
  buildSuccessResponse,
  DESTROY_ERROR_CODES,
} from "./destroy-resource/error-envelope.js";
import { bootstrapOperatorCredentials } from "./destroy-resource/credentials.js";
import {
  isArn,
  resolveResource,
  arnToResourceType as resolveArnToResourceType,
  extractIdentifierFromArn as resolveExtractIdentifierFromArn,
} from "./destroy-resource/resolve.js";
import {
  getOperatorAccountId,
  resetOperatorAccountCache,
} from "./destroy-resource/sts-cache.js";
import {
  classifyNotFoundShortCircuit,
  pollDeleteStatus,
  runPreDestroyHook,
  verifyTagBeforeDelete,
} from "./destroy-resource/dispatcher.js";
import type { ResolvedResource } from "./destroy-resource/types.js";
import { mcpLogWarn } from "../utils/structured-log.js";

// ── Public re-exports (preserve the pre-refactor import surface) ────────────
// Existing tests import these from `../tools/destroy-resource.js`.
export { resolveArnToResourceType as arnToResourceType };
export { resolveExtractIdentifierFromArn as extractIdentifierFromArn };

/** @internal test-only: resets the STS account cache between tests. */
export function __resetOperatorAccountCacheForTests(): void {
  resetOperatorAccountCache();
}

/** @internal exported for unit tests — see P1-R2-1 cache-poison regression. */
export async function __getOperatorAccountIdForTests(
  region: string,
): Promise<string | undefined> {
  return getOperatorAccountId(region);
}

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_REGION = process.env["AWS_REGION"] ?? DEFAULT_AWS_REGION;

// ── Zod schema ───────────────────────────────────────────────────────────────

export const destroyResourceParams = {
  resource_identifier: z
    .string()
    .describe(
      "ARN or name of the resource to destroy. Must be a resource managed by assignee.ai (tagged managed-by=assignee-ai).",
    ),
  confirmed: z
    .boolean()
    .describe(
      "Safety gate — must be true to proceed with destruction. Set to false for a dry-run check that resolves the resource without deleting it.",
    ),
};

// ── Tool registration ────────────────────────────────────────────────────────

export function registerDestroyResource(server: McpServer): void {
  server.tool(
    "destroy_resource",
    "Destroy a managed AWS resource by ARN or name. REQUIRES confirmed: true as a safety mechanism — the AI agent must present resource details and get explicit user approval before destroying.",
    destroyResourceParams,
    async ({ resource_identifier, confirmed }) => {
      // ── Lazy operator credential resolution (P0-1) ───────────────────
      const region = DEFAULT_REGION;
      const bootstrap = bootstrapOperatorCredentials(region);
      if (!bootstrap.ok) return bootstrap.error;
      const { operatorCreds, taggingClient } = bootstrap.result;
      // Story 49.3: SDK client lifecycle. Tracked clients destroyed in
      // the outer `finally` regardless of which early-return branch
      // we take — long-running MCP server must never leak sockets.
      let ccClientRef: CloudControlClient | undefined;
      try {
        // Capture start time before resolve so the TOCTOU SECURITY log line
        // reflects the full resolve→delete window observed by the operator.
        const resolveStartMs = Date.now();
        let resolved: ResolvedResource | null;
        try {
          resolved = await resolveResource(
            resource_identifier,
            taggingClient,
            region,
          );
        } catch (err) {
          return buildErrorResponse(
            `Failed to resolve resource: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        if (!resolved) {
          // NO ARN fallback that bypasses tag verification. If RGTA cannot
          // prove managed-by=assignee-ai, refuse to delete.
          const isArnInput = isArn(resource_identifier);
          const message = isArnInput
            ? `Could not verify "${resource_identifier}" is managed by assignee.ai. The Resource Groups Tagging API did not return this ARN with a managed-by=assignee-ai tag after retries. Destroy was refused for safety.`
            : `No managed resource found matching "${resource_identifier}". Use list_managed_resources to see available resources.`;
          const hint = isArnInput
            ? "Only resources tagged managed-by=assignee-ai can be destroyed via this tool. If the resource was just created, the tagging API may not have indexed it yet — wait a minute and retry. If the resource is not managed by assignee.ai, delete it through the AWS Console or CLI."
            : undefined;
          return buildErrorResponse(message, hint);
        }

        // ── Dry-run: return resource details without deleting ─────────────
        if (!confirmed) {
          return buildSuccessResponse({
            status: "PENDING_CONFIRMATION",
            message:
              "Resource resolved. Set confirmed: true to proceed with destruction.",
            resource: {
              arn: resolved.arn,
              resourceType: resolved.resourceType,
              region: resolved.region,
              identifier: resolved.identifier,
            },
            hint: "Present these details to the user and get explicit approval before setting confirmed: true.",
          });
        }

        // ── Check for redirect types (cannot be deleted via CCAPI) ────────
        if (CCAPI_REDIRECT_TYPES[resolved.resourceType]) {
          return buildErrorResponse(
            `${resolved.resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
          );
        }

        // ── Check for SDK fallback types (not supported in MCP server) ────
        const fallbackSet = new Set(
          Object.values(CCAPI_FALLBACK_TYPES) as string[],
        );
        if (fallbackSet.has(resolved.resourceType)) {
          return buildErrorResponse(
            `${resolved.resourceType} requires SDK fallback deletion which is not yet supported in the MCP server. Use the CLI: assignee destroy ${resource_identifier}`,
          );
        }

        // ── Initialize CloudControl client in the resource's region ───────
        let ccClient: CloudControlClient;
        try {
          ccClient = new CloudControlClient({
            region: resolved.region,
            credentials: operatorCreds,
          });
          ccClientRef = ccClient;
        } catch (err) {
          return buildErrorResponse(
            `Failed to initialize CloudControl client: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        // ── Pre-delete hooks (delegated to strategy registry) ─────────────
        await runPreDestroyHook(
          resolved.resourceType,
          resolved.identifier,
          resolved.region,
        );

        // ── TOCTOU mitigation: re-verify managed-by tag immediately before
        //    DeleteResource dispatch. Closes the resolve→delete race where
        //    an attacker with tag:UntagResources could strip the tag after
        //    we resolved. See story 48.4 and invariants.md "Destroy TOCTOU
        //    window". Composite-identifier resources (no ARN) bypass.
        try {
          const recheck = await verifyTagBeforeDelete(
            resolved,
            taggingClient,
            resolveStartMs,
            resolved.region,
          );
          if (!recheck.ok) {
            // Intentionally unredacted: operator owns the ARN by virtue of
            // the first verify passing, and the SOC needs it for forensic
            // CloudTrail correlation. See feedback_redaction_allowlist_not_denylist.
            mcpLogWarn(
              "destroy-resource",
              "toctou_tag_missing",
              { warnLine: recheck.warnLine },
              recheck.warnLine,
            );
            return buildErrorResponse(
              `Destroy refused: the managed-by=assignee-ai tag on ${resolved.arn} was stripped between resolve and delete. The resource was NOT deleted.`,
              "Investigate immediately — an external principal removed the managed-by tag mid-flight. Check CloudTrail for UntagResources events on this ARN and review IAM policies granting tag:UntagResources.",
              DESTROY_ERROR_CODES.TOCTOU_TAG_MISSING,
            );
          }
        } catch (err) {
          // Fail-closed: if the second verify throws (RGTA error), we cannot
          // prove the tag is still present, so refuse the delete rather than
          // racing on a best-effort guess.
          return buildErrorResponse(
            `Pre-delete tag re-verification failed: ${err instanceof Error ? err.message : String(err)}. The resource was NOT deleted.`,
            "RGTA was unreachable at the pre-delete check. Retry once the Resource Groups Tagging API is healthy.",
          );
        }

        // ── Delete via CloudControl API ───────────────────────────────────
        try {
          const deleteResult = await ccClient.send(
            new DeleteResourceCommand({
              TypeName: resolved.resourceType,
              Identifier: resolved.identifier,
            }),
          );

          const requestToken = deleteResult.ProgressEvent?.RequestToken;
          if (!requestToken) {
            return buildErrorResponse(
              "DeleteResource returned no request token — cannot track operation status.",
            );
          }

          const pollResult = await pollDeleteStatus(
            ccClient,
            requestToken,
            resolved.resourceType,
            resolved.arn,
            resolved.region,
          );

          if (!pollResult.success) {
            return buildErrorResponse(`Destroy failed: ${pollResult.message}`);
          }

          return buildSuccessResponse({
            status: "SUCCESS",
            message: `Resource ${resolved.arn} destroyed successfully.`,
            resource: {
              arn: resolved.arn,
              resourceType: resolved.resourceType,
              region: resolved.region,
              identifier: resolved.identifier,
            },
          });
        } catch (err) {
          // NotFound short-circuit on the DeleteResource call itself —
          // CCAPI can throw ResourceNotFoundException synchronously when
          // the resource is already gone. Apply the cross-account sanity
          // check so we don't silently succeed under the wrong account.
          const errName = err instanceof Error ? err.name : "";
          const errMsg = err instanceof Error ? err.message : String(err);
          const isNotFound =
            errName === "ResourceNotFoundException" ||
            /ResourceNotFoundException|NotFound/.test(errMsg);
          if (isNotFound) {
            const classification = await classifyNotFoundShortCircuit(
              resolved.arn,
              resolved.region,
            );
            if (classification === "cross-account") {
              return buildErrorResponse(
                `CloudControl reported NotFound for ${resolved.arn}, but the operator credentials are configured for a different AWS account. Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
              );
            }
            return buildSuccessResponse({
              status: "SUCCESS",
              message: `Resource ${resolved.arn} was already deleted (NotFound).`,
              resource: {
                arn: resolved.arn,
                resourceType: resolved.resourceType,
                region: resolved.region,
                identifier: resolved.identifier,
              },
            });
          }
          return buildErrorResponse(`Failed to destroy resource: ${errMsg}`);
        }
      } finally {
        // Story 49.3: dispose the CCAPI + tagging clients even when
        // an early branch returned. `.destroy()` is idempotent in
        // AWS SDK v3 so calling it on already-disposed refs is safe.
        ccClientRef?.destroy();
        taggingClient.destroy();
      }
    },
  );
}
