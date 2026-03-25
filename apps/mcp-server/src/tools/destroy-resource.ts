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
  type ResourceTagMapping,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  CloudControlClient,
  DeleteResourceCommand,
  GetResourceRequestStatusCommand,
} from "@aws-sdk/client-cloudcontrol";
import { CCAPI_FALLBACK_TYPES, CCAPI_REDIRECT_TYPES } from "@assignee/core";

// ── Constants ────────────────────────────────────────────────────────────────

const TAG_KEY_MANAGED_BY = "managed-by";
const TAG_VALUE_MANAGED_BY = "assignee-ai";
const DEFAULT_REGION = process.env["AWS_REGION"] ?? "us-east-1";
const MAX_POLL_ATTEMPTS = 60;
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

// ── ARN helpers (self-contained — no CLI dependency) ─────────────────────────

function isArn(input: string): boolean {
  return input.startsWith("arn:aws:");
}

/**
 * Service+resource to CloudFormation type map.
 * WARNING: This map is duplicated from the CLI's resource resolver.
 * Any changes here MUST be mirrored in the CLI resolver (and vice-versa).
 * TODO: Extract into a shared @assignee/core utility to eliminate duplication.
 */
const SERVICE_TYPE_MAP: Record<string, Record<string, string>> = {
  // Tier 0
  s3: { "": "AWS::S3::Bucket" },
  ssm: { parameter: "AWS::SSM::Parameter" },
  iam: { role: "AWS::IAM::Role" },
  ec2: {
    instance: "AWS::EC2::Instance",
    vpc: "AWS::EC2::VPC",
    subnet: "AWS::EC2::Subnet",
    "security-group": "AWS::EC2::SecurityGroup",
    // Tier 1 networking
    "internet-gateway": "AWS::EC2::InternetGateway",
    "route-table": "AWS::EC2::RouteTable",
    natgateway: "AWS::EC2::NatGateway",
    // Route has no ARN (composite identifier) — not resolvable by ARN
  },
  rds: { db: "AWS::RDS::DBInstance" },
  lambda: {
    function: "AWS::Lambda::Function",
    "event-source-mapping": "AWS::Lambda::EventSourceMapping",
  },
  dynamodb: { table: "AWS::DynamoDB::Table" },
  sqs: { "": "AWS::SQS::Queue" },
  sns: { "": "AWS::SNS::Topic" },
  elasticloadbalancing: {
    loadbalancer: "AWS::ElasticLoadBalancingV2::LoadBalancer",
  },
  ecs: { cluster: "AWS::ECS::Cluster" },
  ecr: { repository: "AWS::ECR::Repository" },
  // Tier 1
  logs: { "log-group": "AWS::Logs::LogGroup" },
  // Tier 2
  cloudwatch: { alarm: "AWS::CloudWatch::Alarm" },
  secretsmanager: { secret: "AWS::SecretsManager::Secret" },
  apigateway: { apis: "AWS::ApiGatewayV2::Api" },
  "execute-api": { "": "AWS::ApiGatewayV2::Api" },
};

/** @internal Exported for testing only. */
export function arnToResourceType(arn: string): string | null {
  const parts = arn.split(":");
  if (parts.length < 6) return null;
  const service = parts[2];
  const resourcePart = parts[5] ?? "";
  // Extract resource type segment: first segment before "/" (handles most ARNs)
  // For API Gateway ARNs like arn:aws:apigateway:region::/apis/id, resourcePart starts with "/"
  const segments = resourcePart.split("/").filter(Boolean);
  const resourceType = segments[0] ?? "";
  if (!service) return null;
  const serviceTypes = SERVICE_TYPE_MAP[service];
  if (!serviceTypes) return null;
  return serviceTypes[resourceType] ?? serviceTypes[""] ?? null;
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

// ── Resolved resource shape ──────────────────────────────────────────────────

interface ResolvedResource {
  arn: string;
  resourceType: string;
  region: string;
  identifier: string;
}

// ── Tag helpers ──────────────────────────────────────────────────────────────

function tagsToRecord(mapping: ResourceTagMapping): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const tag of mapping.Tags ?? []) {
    if (tag.Key && tag.Value !== undefined) {
      tags[tag.Key] = tag.Value;
    }
  }
  return tags;
}

// ── Resource resolution ──────────────────────────────────────────────────────

async function resolveResource(
  input: string,
  taggingClient: ResourceGroupsTaggingAPIClient,
  region: string,
): Promise<ResolvedResource | null> {
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
        return {
          arn,
          resourceType: arnToResourceType(arn) ?? "Unknown",
          region: extractRegionFromArn(arn, region),
          identifier,
        };
      }
    }

    paginationToken = response.PaginationToken;
  } while (paginationToken);

  return null;
}

// ── Delete polling ───────────────────────────────────────────────────────────

async function pollDeleteStatus(
  ccClient: CloudControlClient,
  requestToken: string,
): Promise<{ success: boolean; message?: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
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
      return {
        success: false,
        message: `Poll error: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // IN_PROGRESS — wait and poll again
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
      const fallbackValues = Object.values(CCAPI_FALLBACK_TYPES) as string[];
      if (fallbackValues.includes(resolved.resourceType)) {
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
        const pollResult = await pollDeleteStatus(ccClient, requestToken);

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
