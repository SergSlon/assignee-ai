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
import {
  ArnPrefix,
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  DEFAULT_AWS_REGION,
  AssigneeTag,
  SERVICE_TYPE_MAP,
  SERVICE_SUBTYPE_MAP,
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

function isArn(input: string): boolean {
  return input.startsWith(ArnPrefix.AWS);
}

/**
 * Resolves an ARN to a known CloudFormation resource type.
 * Returns null if the service/resource combination is not recognized
 * (unlike arnToCloudFormationType which produces a best-guess fallback).
 *
 * Uses SERVICE_TYPE_MAP and SERVICE_SUBTYPE_MAP from @assignee/core.
 * @internal Exported for testing only.
 */
export function arnToResourceType(arn: string): string | null {
  const parts = arn.split(":");
  if (parts.length < 6) return null;
  const service = parts[2];
  const resourcePart = parts[5] ?? "";
  if (!service) return null;

  // Check subtype map first (ec2, iam, apigateway, etc.)
  const subtypes = SERVICE_SUBTYPE_MAP[service];
  if (subtypes) {
    const segments = resourcePart.split(/[:/]/).filter(Boolean);
    const resourceSeg = segments[0] ?? "";
    if (resourcePart.startsWith("/")) {
      const prefixed = "/" + resourceSeg;
      if (subtypes[prefixed]) return subtypes[prefixed]!;
    }
    if (subtypes[resourceSeg]) return subtypes[resourceSeg]!;
    if (subtypes[""]) return subtypes[""]!;
  }

  // Simple service→type map
  const mapped = SERVICE_TYPE_MAP[service];
  if (mapped) return mapped;

  // Unlike arnToCloudFormationType, return null for unknown services
  return null;
}

/** @internal Exported for testing only. */
export function extractIdentifierFromArn(arn: string): string {
  const parts = arn.split(":");
  if (parts.length < 6) return arn;

  // Rejoin everything after the 5th colon (resource section may contain colons)
  const resourceSection = parts.slice(5).join(":");

  // ARN resource formats:
  //  "type/id"              → ec2:instance/i-abc → "i-abc"
  //  "type:id"              → rds:db:my-db → "my-db", cloudwatch:alarm:my-alarm → "my-alarm"
  //  "id" (no separator)    → sqs:my-queue, sns:my-topic → "my-queue"
  //  "parameter/path/name"  → ssm:parameter/app/db → "app/db" (full path after "parameter/")
  //  "log-group:/path"      → logs:log-group:/aws/fn → "/aws/fn" (preserve leading /)
  //  "secret:name/suffix"   → secretsmanager:secret:app/db-AbC → "app/db-AbC"
  //  "/apis/id"             → apigateway:/apis/abc → "abc"

  // Detect colon-separated format: "type:identifier" (rds:db:name, cloudwatch:alarm:name, etc.)
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");

    // SSM parameter: "parameter/path/to/name" — but uses slash, not colon, for type separator
    if (resourceType === "parameter") {
      // Everything after "parameter/" is the identifier
      return resourceSection.slice("parameter/".length);
    }

    // Log group: "log-group:/path/name" or "log-group:simple-name"
    if (resourceType === "log-group") {
      return afterType;
    }

    // Secret: "secret:name-with-suffix" or "secret:path/name-suffix"
    if (resourceType === "secret") {
      return afterType;
    }

    // Generic colon-separated: "db:my-db", "alarm:my-alarm", etc.
    if (afterType && !resourceType.includes("/")) {
      return afterType;
    }
  }

  // Detect slash-separated: "type/identifier" or "/apis/id"
  const slashIdx = resourceSection.indexOf("/");
  if (slashIdx !== -1) {
    const afterSlash = resourceSection.slice(slashIdx + 1);
    // API Gateway: "/apis/abc123" — extract last segment
    if (resourceSection.startsWith("/")) {
      const segments = resourceSection.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? arn;
    }
    return afterSlash || arn;
  }

  // No separator — the resource section IS the identifier (SQS queue name, SNS topic name)
  return resourceSection || arn;
}

function extractRegionFromArn(arn: string, defaultRegion: string): string {
  const parts = arn.split(":");
  return parts[3] || defaultRegion;
}

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

async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
  // Check for composite identifiers first (no Tagging API needed)
  const composite = tryResolveCompositeIdentifier(input, region);
  if (composite) return composite;

  // Retry loop for Tagging API eventual consistency (especially IAM)
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

        const identifier = extractIdentifierFromArn(arn);
        const matchesArn = isArn(input) && arn === input;
        const matchesName = !isArn(input) && identifier === input;

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

// ── Delete polling ───────────────────────────────────────────────────────────

async function pollDeleteStatus(
  ccClient: CloudControlClient,
  requestToken: string,
  resourceType?: string,
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

      if (status === "SUCCESS") return { success: true };
      if (status === "FAILED") {
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
      // ── Resolve the resource ──────────────────────────────────────────
      const region = DEFAULT_REGION;
      let taggingClient: ResourceGroupsTaggingAPIClient;
      try {
        taggingClient = new ResourceGroupsTaggingAPIClient({ region });
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to initialize AWS client: ${err instanceof Error ? err.message : String(err)}`,
                hint: "Check that AWS credentials are configured (ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables).",
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
        // Fallback: if input is an ARN, attempt direct CloudControl delete
        // without Tagging API verification. This handles IAM and other resources
        // where Tagging API eventual consistency causes lookup failures.
        if (isArn(resource_identifier)) {
          const resourceType = arnToResourceType(resource_identifier);
          if (resourceType && resourceType !== "Unknown") {
            const extractedId = extractIdentifierFromArn(resource_identifier);
            resolved = {
              arn: resource_identifier,
              resourceType,
              region: extractRegionFromArn(resource_identifier, region),
              identifier: getCloudControlIdentifier(
                resource_identifier,
                resourceType,
                extractedId,
              ),
            };
            // SAFETY NOTE: This bypasses managed-by tag verification.
            // Only used when Tagging API hasn't indexed the resource yet.
            // CloudControl will reject if the resource doesn't exist.
            console.error(
              `[destroy_resource] ARN fallback (Tagging API miss): ${resource_identifier}`,
            );
          }
        }

        if (!resolved) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: true,
                  message: `No managed resource found matching "${resource_identifier}". Use list_managed_resources to see available resources.`,
                }),
              },
            ],
            isError: true,
          };
        }
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
        ccClient = new CloudControlClient({ region: resolved.region });
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
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: true,
                message: `Failed to destroy resource: ${err instanceof Error ? err.message : String(err)}`,
              }),
            },
          ],
          isError: true,
        };
      }
    },
  );
}
