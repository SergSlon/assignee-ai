/**
 * MCP-side wrapper around `@assignee/core`'s `fetchManagedResources`.
 *
 * The core module is SDK-decoupled (Story 52-2); this wrapper owns the
 * RGTA client lifecycle (long-running MCP must `destroy()` sockets
 * per invocation) and injects an IAM-role enumerator so MCP no longer
 * silently misses IAM roles per memory `feedback_iam_role_rgta_gap`.
 *
 * Credential resolution stays LAZY per memory
 * `feedback_lazy_credential_resolution_in_mcp` — `requireAssigneeCredentials`
 * throws per tool invocation rather than at module load.
 *
 * @see Story 20.4, Story 18.4, Story 49.2, Story 52-2
 */

import {
  ResourceGroupsTaggingAPIClient,
  GetResourcesCommand,
  type GetResourcesOutput,
} from "@aws-sdk/client-resource-groups-tagging-api";
import {
  IAMClient,
  ListRolesCommand,
  ListRoleTagsCommand,
} from "@aws-sdk/client-iam";
import {
  AssigneeTag,
  DEFAULT_AWS_REGION,
  defaultMemoryService,
  fetchManagedResources as coreFetchManagedResources,
  requireAssigneeCredentials,
  createListCreatedDateEnricher,
  createListPricingEnricher,
  createCloudWatchUsageEnricher,
  type ManagedIamRole,
  type ManagedResource,
  type RgtaMapping,
} from "@assignee/core";

export type { ManagedResource } from "@assignee/core";

/**
 * Default AWS region when none is specified.
 *
 * Story 56-it1-03 L4-003: resolve per-invocation, not at module load.
 * The MCP server is a long-running worker — capturing
 * `process.env["AWS_REGION"]` at import time serves a stale region
 * until restart. CLI-shaped consumers re-read env per call; mirror
 * that contract here.
 *
 * Story 56-it2-04 P2-03: coalesce on empty / whitespace-only values,
 * not just `undefined`. Unix shells that `export AWS_REGION=` (no
 * value) produce an empty string, and `??` only falls through on
 * undefined — so an empty region silently reached the SDK builder and
 * the AWS client threw an opaque `InvalidRegion` error. Trim first so
 * a single leading/trailing space from a sloppy pasted env doesn't
 * break the client either.
 */
export function resolveDefaultRegion(): string {
  const raw = process.env["AWS_REGION"];
  if (typeof raw !== "string") return DEFAULT_AWS_REGION;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_AWS_REGION;
  return trimmed;
}

/**
 * Maximum number of concurrent `iam:ListRoleTags` calls.
 *
 * Tag fetches are lightweight (single-role lookup, no pagination in the
 * common case) so 10 concurrent calls is safe without hitting IAM rate
 * limits. Comparable to the schema-warmer (5) and pricing decomposer
 * (PRICING_CONCURRENCY=5) concurrency caps used elsewhere in the project,
 * but higher because tag reads are cheaper per-call than schema/pricing.
 */
const IAM_TAG_FETCH_CONCURRENCY = 10;

/**
 * Enumerate tagged IAM roles — the RGTA API does NOT return IAM::Role
 * (per memory `feedback_iam_role_rgta_gap`). We paginate `iam:ListRoles`
 * to collect all role stubs, then fan-out `iam:ListRoleTags` in bounded
 * batches of {@link IAM_TAG_FETCH_CONCURRENCY} using `Promise.allSettled`
 * so a single role's tag fetch failing doesn't abort the entire
 * enumeration.
 *
 * Failures are NON-FATAL — swallowed at the core level, which falls
 * back to whatever RGTA returned.
 */
async function enumerateMcpIamRoles(region: string): Promise<ManagedIamRole[]> {
  const creds = requireAssigneeCredentials("operator");
  const client = new IAMClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });
  try {
    // Phase 1: collect all role stubs via paginated ListRoles
    const roleStubs: Array<{
      roleName: string;
      arn: string;
      createdDate: string;
    }> = [];
    let marker: string | undefined;
    do {
      const resp = await client.send(
        new ListRolesCommand(marker ? { Marker: marker } : {}),
      );
      for (const role of resp.Roles ?? []) {
        if (!role.RoleName || !role.Arn) continue;
        roleStubs.push({
          roleName: role.RoleName,
          arn: role.Arn,
          createdDate: role.CreateDate?.toISOString() ?? "",
        });
      }
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);

    // Phase 2: fan-out ListRoleTags in bounded batches of
    // IAM_TAG_FETCH_CONCURRENCY using Promise.allSettled so a single
    // role's tag failure doesn't abort the entire enumeration.
    const roles: ManagedIamRole[] = [];
    for (let i = 0; i < roleStubs.length; i += IAM_TAG_FETCH_CONCURRENCY) {
      const batch = roleStubs.slice(i, i + IAM_TAG_FETCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map((stub) =>
          client.send(new ListRoleTagsCommand({ RoleName: stub.roleName })),
        ),
      );
      for (let j = 0; j < batch.length; j++) {
        const stub = batch[j]!;
        const result = results[j]!;
        if (result.status === "rejected") {
          // Per-role tag fetch failed; skip this role rather than aborting.
          continue;
        }
        const tags = result.value.Tags ?? [];
        const matches = tags.some(
          (t: { Key?: string; Value?: string }) =>
            t.Key === AssigneeTag.KEY && t.Value === AssigneeTag.VALUE,
        );
        if (!matches) continue;
        const tagsRecord: Record<string, string> = {};
        for (const t of tags as Array<{ Key?: string; Value?: string }>) {
          if (t.Key && t.Value !== undefined) tagsRecord[t.Key] = t.Value;
        }
        roles.push({
          arn: stub.arn,
          roleName: stub.roleName,
          createdDate: stub.createdDate,
          tags: tagsRecord,
        });
      }
    }
    return roles;
  } finally {
    client.destroy();
  }
}

/**
 * Fetches all resources tagged with `managed-by=assignee-ai`.
 * Paginates RGTA, merges IAM roles (new in Story 52-2), enriches with
 * provision-log cost data.
 */
export async function fetchManagedResources(
  region?: string,
  resourceType?: string,
): Promise<ManagedResource[]> {
  const resolvedRegion = region ?? resolveDefaultRegion();
  const rgtaClient = new ResourceGroupsTaggingAPIClient({
    region: resolvedRegion,
    credentials: requireAssigneeCredentials("operator"),
  });

  try {
    const fetchRgtaResources = async (): Promise<RgtaMapping[]> => {
      const all: RgtaMapping[] = [];
      let paginationToken: string | undefined;
      do {
        const command = new GetResourcesCommand({
          TagFilters: [{ Key: AssigneeTag.KEY, Values: [AssigneeTag.VALUE] }],
          ...(paginationToken ? { PaginationToken: paginationToken } : {}),
        });
        const response: GetResourcesOutput = await rgtaClient.send(command);
        for (const m of response.ResourceTagMappingList ?? []) all.push(m);
        paginationToken = response.PaginationToken;
      } while (paginationToken);
      return all;
    };

    // Build credentials for SDK-based enrichers (lazy — throws if unset,
    // but that's caught at the tool-handler layer).
    let sdkCredentials:
      | {
          accessKeyId: string;
          secretAccessKey: string;
          sessionToken?: string;
        }
      | undefined;
    try {
      const creds = requireAssigneeCredentials("operator");
      sdkCredentials = {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      };
    } catch {
      // Operator creds absent — skip SDK-based enrichers but still list.
    }

    return await coreFetchManagedResources({
      region: resolvedRegion,
      fetchRgtaResources,
      enrichWithIamRoles: () => enumerateMcpIamRoles(resolvedRegion),
      ...(resourceType ? { resourceTypeFilter: resourceType } : {}),
      // Pricing-MCP enrichment: resolves rate-card costs for N/A rows.
      // Parity with CLI enrichWithPricing (feature-pricing-mcp-list-enrichment AC#5).
      // F6 (2026-05-24): mirror the CLI's CloudWatch-backed storage
      // enricher so MCP `list_managed_resources` returns real $/mo
      // totals for S3 buckets, not just per-GB-month rate hints.
      // Parity with apps/cli/src/services/list-resources.ts.
      enrichWithPricing: createListPricingEnricher(
        sdkCredentials
          ? createCloudWatchUsageEnricher(sdkCredentials, resolvedRegion)
          : undefined,
      ),
      // Created-date enrichment: resolves creation timestamps for N/A rows.
      ...(sdkCredentials
        ? {
            enrichWithCreatedDate: createListCreatedDateEnricher(
              sdkCredentials,
              resolvedRegion,
            ),
          }
        : {}),
      createdDateFallback: "run-id-tag",
      useFreeTierFallback: false,
      getDestroyedArns: () => defaultMemoryService.readDestroyedArns(),
      onIamRoleEnumerationError: () => {
        // Long-running MCP: swallow silently (structured log at the
        // tool-handler layer captures the failure). This matches the
        // pre-52-2 behavior of "IAM roles absent means missing, not
        // error" for downstream MCP consumers.
      },
    });
  } finally {
    rgtaClient.destroy();
  }
}
