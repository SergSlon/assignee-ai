/**
 * destroy_resource MCP tool — safely destroys a managed AWS resource.
 *
 * Resolves the resource by ARN or name via the Resource Groups Tagging API,
 * then deletes it via the CloudControl API and polls for completion.
 *
 * Safety mechanism: requires `confirmed: true` to proceed — same pattern as apply_plan.
 * The agent must present resource details to the user and get explicit approval first.
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  DEFAULT_AWS_REGION,
  AssigneeTag,
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
  isArn as coreIsArn,
  arnToResourceType as coreArnToResourceType,
  extractIdentifierFromArn as coreExtractIdentifierFromArn,
  extractRegionFromArn as coreExtractRegionFromArn,
} from "@assignee/core";
import { destroyRegistry } from "../services/destroy-strategies/index.js";

// ── Constants ────────────────────────────────────────────────────────────────

const TAG_KEY_MANAGED_BY = AssigneeTag.KEY;
const TAG_VALUE_MANAGED_BY = AssigneeTag.VALUE;
const DEFAULT_REGION = process.env["AWS_REGION"] ?? DEFAULT_AWS_REGION;
/** @see DESTROY_MAX_POLL_ATTEMPTS in apps/cli/src/config/constants.ts — keep in sync */
const MAX_POLL_ATTEMPTS = 60;
const EXTENDED_POLL_ATTEMPTS = 300; // 10 minutes for slow deletes (RDS, NatGW)
/** @see DESTROY_POLL_INTERVAL_MS in apps/cli/src/config/constants.ts — keep in sync */
const POLL_INTERVAL_MS = 2_000;

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

// ── ARN helpers ─────────────────────────────────────────────────────────────
//
// Wave 3 P2-2: ARN parsing helpers previously duplicated here and in
// `apps/cli/src/services/resource-resolver.ts` now live in
// `packages/core/src/config/arn-helpers.ts`. We re-export them from this
// module so existing consumers (`destroy-arn-resolution.test.ts`) keep
// importing from the same path. The implementation is identical across
// packages and partition-aware (accepts aws/aws-cn/aws-us-gov/aws-iso/
// aws-iso-b).

const isArn = coreIsArn;

/**
 * Resolves an ARN to a known CloudFormation resource type.
 * Returns null if the service/resource combination is not recognized
 * (unlike `arnToCloudFormationType` which produces a best-guess fallback).
 * @internal Exported for testing only.
 */
export const arnToResourceType = coreArnToResourceType;

/** @internal Exported for testing only. */
export const extractIdentifierFromArn = coreExtractIdentifierFromArn;

const extractRegionFromArn = coreExtractRegionFromArn;

/**
 * Returns the correct CloudControl Identifier for a resource given its ARN and type.
 * Delegates to the destroy strategy registry for type-specific identifier resolution.
 * Most types use the extracted name/id, but some need the full ARN or custom construction.
 */
function getCloudControlIdentifier(
  arn: string,
  resourceType: string,
  extractedId: string,
): string {
  const strategy = destroyRegistry.get(resourceType);
  if (strategy?.usesArnIdentifier) {
    return arn;
  }
  if (strategy?.extractIdentifier) {
    return strategy.extractIdentifier(
      arn,
      extractRegionFromArn(arn, DEFAULT_REGION),
    );
  }
  return extractedId;
}

// ── Resolved resource shape ──────────────────────────────────────────────────

interface ResolvedResource {
  arn: string;
  resourceType: string;
  region: string;
  identifier: string;
}

// ── Composite identifier detection ──────────────────────────────────────────

/**
 * Some resource types (e.g., Route) have no ARN — they use composite
 * primaryIdentifiers like "rtb-xxx|0.0.0.0/0". Detect and handle these
 * directly without Tagging API resolution.
 */
function tryResolveCompositeIdentifier(
  input: string,
  region: string,
): ResolvedResource | null {
  // Route: "rtb-xxx|cidr" composite identifier
  if (input.includes("|") && input.startsWith("rtb-")) {
    return {
      arn: input, // no real ARN — use composite ID as-is
      resourceType: "AWS::EC2::Route",
      region,
      identifier: input,
    };
  }
  return null;
}

// ── Resource resolution ──────────────────────────────────────────────────────

const MAX_RESOLVE_RETRIES = 4;
const RESOLVE_RETRY_DELAY_MS = 5_000;

/**
 * Returns true when the RGTA mapping has the required managed-by tag.
 * Never trust an ARN match alone — the tagging API could return a resource
 * that happens to have a different tag filter hit (none should, but defense
 * in depth) or a resource we don't own in a shared account.
 */
function hasManagedByTag(
  tags: Array<{ Key?: string; Value?: string }>,
): boolean {
  return tags.some(
    (t) => t.Key === TAG_KEY_MANAGED_BY && t.Value === TAG_VALUE_MANAGED_BY,
  );
}

/**
 * Targeted tag verification for a specific ARN. Uses the ResourceARNList
 * parameter so RGTA returns tags for that exact ARN (or an empty list if
 * it isn't indexed yet). Much faster than paginating the full managed
 * resource set when the caller already has an ARN.
 */
async function verifyArnIsManaged(
  arn: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
): Promise<boolean> {
  for (let attempt = 0; attempt < MAX_RESOLVE_RETRIES; attempt++) {
    const response = await taggingClient.send(
      new GetResourcesCommand({
        ResourceARNList: [arn],
      }),
    );
    for (const mapping of response.ResourceTagMappingList ?? []) {
      if (mapping.ResourceARN !== arn) continue;
      if (hasManagedByTag(mapping.Tags ?? [])) return true;
    }
    // RGTA may lag (especially IAM). Retry with backoff before giving up.
    if (attempt < MAX_RESOLVE_RETRIES - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RESOLVE_RETRY_DELAY_MS),
      );
    }
  }
  return false;
}

/**
 * Paginates the full managed resource set looking for a match by ARN or
 * by bare identifier. Used when the caller provided a non-ARN name.
 */
async function resolveByNameOrArn(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  const inputIsArn = isArn(input);
  for (let attempt = 0; attempt < MAX_RESOLVE_RETRIES; attempt++) {
    let paginationToken: string | undefined;

    do {
      const response = await taggingClient.send(
        new GetResourcesCommand({
          TagFilters: [
            { Key: TAG_KEY_MANAGED_BY, Values: [TAG_VALUE_MANAGED_BY] },
          ],
          PaginationToken: paginationToken,
        }),
      );

      for (const mapping of response.ResourceTagMappingList ?? []) {
        const arn = mapping.ResourceARN;
        if (!arn) continue;
        // Defense in depth: the TagFilters above should guarantee this,
        // but verify explicitly so we never destroy something whose
        // managed-by tag was modified mid-request.
        if (!hasManagedByTag(mapping.Tags ?? [])) continue;

        const identifier = extractIdentifierFromArn(arn);
        const matchesArn = inputIsArn && arn === input;
        const matchesName = !inputIsArn && identifier === input;

        if (matchesArn || matchesName) {
          const resourceType = arnToResourceType(arn) ?? "Unknown";
          return {
            arn,
            resourceType,
            region: extractRegionFromArn(arn, region),
            identifier: getCloudControlIdentifier(
              arn,
              resourceType,
              identifier,
            ),
          };
        }
      }

      paginationToken = response.PaginationToken;
    } while (paginationToken);

    // Not found — wait and retry (Tagging API eventual consistency)
    if (attempt < MAX_RESOLVE_RETRIES - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RESOLVE_RETRY_DELAY_MS),
      );
    }
  }

  return null;
}

async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  // Check for composite identifiers first (no Tagging API needed)
  const composite = tryResolveCompositeIdentifier(input, region);
  if (composite) return composite;

  // ARN input: targeted tag verification. This is both faster AND safer
  // than scanning the whole managed set — RGTA returns tags for the exact
  // ARN and we explicitly require managed-by=assignee-ai. If the tag is
  // missing we return null (the caller will surface a clear error) —
  // there is NO "ARN fallback that bypasses tag verification" path.
  if (isArn(input)) {
    const isManaged = await verifyArnIsManaged(input, taggingClient);
    if (!isManaged) return null;
    const resourceType = arnToResourceType(input) ?? "Unknown";
    const identifier = extractIdentifierFromArn(input);
    return {
      arn: input,
      resourceType,
      region: extractRegionFromArn(input, region),
      identifier: getCloudControlIdentifier(input, resourceType, identifier),
    };
  }

  // Name input: paginate the full managed set.
  return resolveByNameOrArn(input, taggingClient, region);
}

// ── NotFound short-circuit (cross-account sanity) ────────────────────────────

/** CloudControl HandlerErrorCode for "resource does not exist". */
const CCAPI_NOT_FOUND_ERROR_CODE = "NotFound";

/**
 * Extract the 12-digit AWS account segment from an ARN, or undefined
 * when the ARN has no account segment (e.g. `arn:aws:s3:::bucket`).
 */
function extractAccountIdFromArn(arn: string): string | undefined {
  const parts = arn.split(":");
  if (parts.length < 5) return undefined;
  const account = parts[4];
  return account && /^\d{12}$/.test(account) ? account : undefined;
}

/** Module-level cache: one STS lookup per MCP process. */
let cachedOperatorAccountId: string | undefined;
let cachedOperatorAccountLookup: Promise<string | undefined> | undefined;

/**
 * Returns the AWS account ID for the configured operator credentials.
 * Used by the cross-account sanity check on NotFound short-circuits.
 * Returns undefined on any failure (missing creds, STS error, timeout) —
 * the caller treats undefined as "cannot classify" and falls through to
 * the conservative safe-shortcircuit behavior.
 */
async function getOperatorAccountId(
  region: string,
): Promise<string | undefined> {
  if (cachedOperatorAccountId !== undefined) return cachedOperatorAccountId;
  if (cachedOperatorAccountLookup) return cachedOperatorAccountLookup;

  cachedOperatorAccountLookup = (async () => {
    try {
      const sts = new STSClient({
        region,
        credentials: requireAssigneeCredentials("operator"),
      });
      const result = await Promise.race([
        sts.send(new GetCallerIdentityCommand({})),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("STS timeout")), 5_000),
        ),
      ]);
      const account = result.Account;
      if (account) {
        cachedOperatorAccountId = account;
        return account;
      }
      return undefined;
    } catch {
      return undefined;
    }
  })();

  return cachedOperatorAccountLookup;
}

/**
 * Classifies a CCAPI NotFound response by comparing the resource ARN's
 * account to the operator's account. If they match (or account info is
 * unavailable), treat NotFound as success — the tag API commonly caches
 * deleted resources for ~1h. If they differ, the operator is almost
 * certainly pointing at the wrong account and we surface a real error.
 */
async function classifyNotFoundShortCircuit(
  resourceArn: string,
  region: string,
): Promise<"safe-shortcircuit" | "cross-account"> {
  const arnAccount = extractAccountIdFromArn(resourceArn);
  if (!arnAccount) return "safe-shortcircuit";
  const operatorAccount = await getOperatorAccountId(region);
  if (!operatorAccount) return "safe-shortcircuit";
  return arnAccount === operatorAccount ? "safe-shortcircuit" : "cross-account";
}

// ── Delete polling ───────────────────────────────────────────────────────────

async function pollDeleteStatus(
  ccClient: CloudControlClient,
  requestToken: string,
  resourceType?: string,
  resourceArn?: string,
  region?: string,
): Promise<{ success: boolean; message?: string }> {
  const MAX_TRANSIENT_ERRORS = 3;
  let transientErrors = 0;
  const strategy = resourceType ? destroyRegistry.get(resourceType) : undefined;
  const maxAttempts = strategy?.isSlow
    ? EXTENDED_POLL_ATTEMPTS
    : MAX_POLL_ATTEMPTS;
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await ccClient.send(
        new GetResourceRequestStatusCommand({ RequestToken: requestToken }),
      );
      const status = result.ProgressEvent?.OperationStatus;
      const errorCode = result.ProgressEvent?.ErrorCode;

      if (status === "SUCCESS") return { success: true };
      if (status === "FAILED") {
        // NotFound short-circuit: RGTA caches deleted resources for ~1h,
        // so bulk-destroy commonly re-submits an already-deleted resource.
        // Treat NotFound as success UNLESS the operator credentials point
        // at a different account than the resource ARN — in that case
        // NotFound is almost certainly a misconfiguration, not success.
        if (errorCode === CCAPI_NOT_FOUND_ERROR_CODE) {
          if (resourceArn && region) {
            const classification = await classifyNotFoundShortCircuit(
              resourceArn,
              region,
            );
            if (classification === "cross-account") {
              return {
                success: false,
                message: `CloudControl reported NotFound for ${resourceArn}, but the operator credentials are configured for a different AWS account. Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
              };
            }
          }
          return { success: true };
        }
        return {
          success: false,
          message:
            result.ProgressEvent?.StatusMessage ?? "Delete operation failed",
        };
      }
    } catch (err) {
      transientErrors++;
      if (transientErrors >= MAX_TRANSIENT_ERRORS) {
        return {
          success: false,
          message: `Poll error (after ${transientErrors} transient failures): ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      // Transient error — wait longer and retry
    }

    // IN_PROGRESS or transient error — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { success: false, message: "Delete operation timed out" };
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerDestroyResource(server: McpServer): void {
  server.tool(
    "destroy_resource",
    "Destroy a managed AWS resource by ARN or name. REQUIRES confirmed: true as a safety mechanism — the AI agent must present resource details and get explicit user approval before destroying.",
    destroyResourceParams,
    async ({ resource_identifier, confirmed }) => {
      // ── Lazy operator credential resolution ───────────────────────────
      // P0-1 fix: never fall through to the host's default credential
      // chain. Both AWS clients below are constructed with explicit
      // ASSIGNEE_OPERATOR_* credentials. If they're missing we fail
      // fast with an actionable hint instead of silently deleting
      // resources under the MCP host's profile.
      const region = DEFAULT_REGION;
      let operatorCreds;
      try {
        operatorCreds = requireAssigneeCredentials("operator");
      } catch (err) {
        const message =
          err instanceof MissingAssigneeCredentialsError
            ? err.message
            : err instanceof Error
              ? err.message
              : String(err);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Operator credentials are required to destroy resources: ${message}`,
                hint: "Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY in the MCP server environment, or run 'assignee setup' to create the IAM users.",
              }),
            },
          ],
          isError: true,
        };
      }

      let taggingClient: ResourceGroupsTaggingAPIClient;
      try {
        taggingClient = new ResourceGroupsTaggingAPIClient({
          region,
          credentials: operatorCreds,
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to initialize AWS client: ${err instanceof Error ? err.message : String(err)}`,
                hint: "Check that ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY are set.",
              }),
            },
          ],
          isError: true,
        };
      }

      let resolved: ResolvedResource | null;
      try {
        resolved = await resolveResource(
          resource_identifier,
          taggingClient,
          region,
        );
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to resolve resource: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }

      if (!resolved) {
        // P0-1 fix: NO ARN fallback that bypasses tag verification.
        // If the tagging API cannot prove the resource carries
        // managed-by=assignee-ai, we refuse to delete — the previous
        // "direct CloudControl delete" path would happily destroy any
        // resource the operator credentials could reach, including
        // unmanaged production resources.
        const isArnInput = isArn(resource_identifier);
        const message = isArnInput
          ? `Could not verify "${resource_identifier}" is managed by assignee.ai. The Resource Groups Tagging API did not return this ARN with a managed-by=assignee-ai tag after retries. Destroy was refused for safety.`
          : `No managed resource found matching "${resource_identifier}". Use list_managed_resources to see available resources.`;
        const hint = isArnInput
          ? "Only resources tagged managed-by=assignee-ai can be destroyed via this tool. If the resource was just created, the tagging API may not have indexed it yet — wait a minute and retry. If the resource is not managed by assignee.ai, delete it through the AWS Console or CLI."
          : undefined;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message,
                ...(hint ? { hint } : {}),
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Dry-run: return resource details without deleting ─────────────
      if (!confirmed) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
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
              }),
            },
          ],
        };
      }

      // ── Check for redirect types (cannot be deleted via CCAPI) ────────
      if (CCAPI_REDIRECT_TYPES[resolved.resourceType]) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `${resolved.resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Check for SDK fallback types (not supported in MCP server) ────
      const fallbackSet = new Set(
        Object.values(CCAPI_FALLBACK_TYPES) as string[],
      );
      if (fallbackSet.has(resolved.resourceType)) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `${resolved.resourceType} requires SDK fallback deletion which is not yet supported in the MCP server. Use the CLI: assignee destroy ${resource_identifier}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Delete via CloudControl API ───────────────────────────────────
      let ccClient: CloudControlClient;
      try {
        ccClient = new CloudControlClient({
          region: resolved.region,
          credentials: operatorCreds,
        });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to initialize CloudControl client: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }

      // ── Pre-delete hooks (delegated to strategy registry) ──────────
      {
        const preDestroyStrategy = destroyRegistry.get(resolved.resourceType);
        if (preDestroyStrategy?.preDestroy) {
          try {
            await preDestroyStrategy.preDestroy(
              resolved.identifier,
              resolved.region,
            );
          } catch (preErr: unknown) {
            // Non-fatal — log for debugging, CloudControl will give a clearer error
            const msg =
              preErr instanceof Error ? preErr.message : String(preErr);
            console.error(
              `[destroy_resource] pre-destroy warning for ${resolved.resourceType} ${resolved.identifier}: ${msg}`,
            );
          }
        }
      }

      try {
        const deleteResult = await ccClient.send(
          new DeleteResourceCommand({
            TypeName: resolved.resourceType,
            Identifier: resolved.identifier,
          }),
        );

        const requestToken = deleteResult.ProgressEvent?.RequestToken;
        if (!requestToken) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message:
                    "DeleteResource returned no request token — cannot track operation status.",
                }),
              },
            ],
            isError: true,
          };
        }

        // ── Poll for completion ───────────────────────────────────────────
        const pollResult = await pollDeleteStatus(
          ccClient,
          requestToken,
          resolved.resourceType,
          resolved.arn,
          resolved.region,
        );

        if (!pollResult.success) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `Destroy failed: ${pollResult.message}`,
                }),
              },
            ],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                status: "SUCCESS",
                message: `Resource ${resolved.arn} destroyed successfully.`,
                resource: {
                  arn: resolved.arn,
                  resourceType: resolved.resourceType,
                  region: resolved.region,
                  identifier: resolved.identifier,
                },
              }),
            },
          ],
        };
      } catch (err) {
        // NotFound short-circuit on the DeleteResource call itself —
        // mirrors the CLI's behavior for tag-ghost cleanup. CCAPI can
        // throw ResourceNotFoundException synchronously when the
        // resource is already gone. Apply the cross-account sanity
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
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    error: true,
                    message: `CloudControl reported NotFound for ${resolved.arn}, but the operator credentials are configured for a different AWS account. Verify ASSIGNEE_OPERATOR_ACCESS_KEY_ID points at the correct account before retrying.`,
                  }),
                },
              ],
              isError: true,
            };
          }
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  status: "SUCCESS",
                  message: `Resource ${resolved.arn} was already deleted (NotFound).`,
                  resource: {
                    arn: resolved.arn,
                    resourceType: resolved.resourceType,
                    region: resolved.region,
                    identifier: resolved.identifier,
                  },
                }),
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to destroy resource: ${errMsg}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
