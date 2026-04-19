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
  fetchManagedResources as coreFetchManagedResources,
  requireAssigneeCredentials,
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
 * Enumerate tagged IAM roles — the RGTA API does NOT return IAM::Role
 * (per memory `feedback_iam_role_rgta_gap`). We paginate `iam:ListRoles`
 * + `iam:ListRoleTags` directly and filter client-side.
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
    const roles: ManagedIamRole[] = [];
    let marker: string | undefined;
    do {
      const resp = await client.send(
        new ListRolesCommand(marker ? { Marker: marker } : {}),
      );
      for (const role of resp.Roles ?? []) {
        if (!role.RoleName || !role.Arn) continue;
        const tagResp = await client.send(
          new ListRoleTagsCommand({ RoleName: role.RoleName }),
        );
        const tags = tagResp.Tags ?? [];
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
          arn: role.Arn,
          roleName: role.RoleName,
          createdDate: role.CreateDate?.toISOString() ?? "",
          tags: tagsRecord,
        });
      }
      marker = resp.IsTruncated ? resp.Marker : undefined;
    } while (marker);
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

    return await coreFetchManagedResources({
      region: resolvedRegion,
      fetchRgtaResources,
      enrichWithIamRoles: () => enumerateMcpIamRoles(resolvedRegion),
      ...(resourceType ? { resourceTypeFilter: resourceType } : {}),
      createdDateFallback: "run-id-tag",
      useFreeTierFallback: false,
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
