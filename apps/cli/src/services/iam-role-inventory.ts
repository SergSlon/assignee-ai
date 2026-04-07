/**
 * IAM Role inventory — parallel listing path for AWS::IAM::Role resources
 * that the Resource Groups Tagging API cannot return.
 *
 * AWS Resource Groups Tagging API supports IAM users, groups, managed
 * policies, server certificates, and SAML providers — but NOT IAM roles.
 * Freshly-tagged roles created by `assignee apply` are therefore invisible
 * to `assignee list` and `assignee destroy --all` if those commands rely
 * on RGTA alone.
 *
 * This module fills the gap by paginating `iam:ListRoles` + `iam:ListRoleTags`
 * directly and filtering for the `managed-by=assignee-ai` tag client-side.
 *
 * Required IAM permissions on the operator role:
 *   - iam:ListRoles
 *   - iam:ListRoleTags
 *   - iam:GetRole (for ARN-by-ARN lookup)
 *
 * @see Phase 2 smoke test BUG-1
 */

import {
  IAMClient,
  ListRolesCommand,
  ListRoleTagsCommand,
  GetRoleCommand,
} from "@aws-sdk/client-iam";
import { TAG_KEY_MANAGED_BY, TAG_VALUE_MANAGED_BY } from "../utils/tags.js";
import { operatorCredentials } from "../config/operator-credentials.js";
import { AWS_REGION } from "../config/constants.js";
import { RESOURCE_TYPES } from "@assignee/core";

/** Minimal shape returned to callers — matches the fields list-resources needs. */
export interface ManagedIamRole {
  arn: string;
  roleName: string;
  createdDate: string;
  tags: Record<string, string>;
}

/**
 * Builds a configured IAMClient using operator credentials. IAM is a
 * global service so the region is mostly cosmetic, but we honor the
 * configured AWS_REGION for consistency with other clients.
 */
function createIamClient(): IAMClient {
  const opCreds = operatorCredentials();
  return new IAMClient({
    region: opCreds.region ?? AWS_REGION,
    ...(opCreds.accessKeyId && opCreds.secretAccessKey
      ? {
          credentials: {
            accessKeyId: opCreds.accessKeyId,
            secretAccessKey: opCreds.secretAccessKey,
          },
        }
      : {}),
  });
}

/**
 * Returns true if a tag list contains the assignee.ai `managed-by` tag.
 */
function hasManagedByTag(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): boolean {
  return (tags ?? []).some(
    (t) => t.Key === TAG_KEY_MANAGED_BY && t.Value === TAG_VALUE_MANAGED_BY,
  );
}

/**
 * Converts an IAM SDK tag list to a flat key-value record.
 */
function tagsToRecord(
  tags: Array<{ Key?: string; Value?: string }> | undefined,
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const tag of tags ?? []) {
    if (tag.Key && tag.Value !== undefined) {
      record[tag.Key] = tag.Value;
    }
  }
  return record;
}

/**
 * Lists all IAM roles in the account and returns those tagged with
 * `managed-by=assignee-ai`.
 *
 * Pagination strategy: walk every role via ListRoles (paginated), then
 * call ListRoleTags for each role. ListRoles does NOT return tags, so
 * we cannot filter server-side. For accounts with thousands of roles
 * this is O(N) tag calls; in practice assignee-managed deployments
 * have a small number of roles so this is acceptable.
 *
 * Failures from individual ListRoleTags calls are non-fatal — that
 * single role is skipped rather than failing the whole listing. This
 * matches the resilience expectations of `assignee list`.
 *
 * @param client - Optional IAMClient (used in tests). Production callers
 *                 should omit and let the helper construct one.
 */
export async function fetchManagedIamRoles(
  client?: IAMClient,
): Promise<ManagedIamRole[]> {
  const iam = client ?? createIamClient();
  const managed: ManagedIamRole[] = [];

  let marker: string | undefined;
  do {
    const listResponse = await iam.send(
      new ListRolesCommand(marker ? { Marker: marker } : {}),
    );

    for (const role of listResponse.Roles ?? []) {
      if (!role.RoleName || !role.Arn) continue;

      let tags;
      try {
        const tagResponse = await iam.send(
          new ListRoleTagsCommand({ RoleName: role.RoleName }),
        );
        tags = tagResponse.Tags;
      } catch {
        // Non-fatal: skip this role rather than failing the whole list.
        // Common cause: a role created out-of-band that the operator
        // role doesn't have iam:ListRoleTags permission on.
        continue;
      }

      if (!hasManagedByTag(tags)) continue;

      managed.push({
        arn: role.Arn,
        roleName: role.RoleName,
        createdDate: role.CreateDate
          ? new Date(role.CreateDate).toISOString()
          : "N/A",
        tags: tagsToRecord(tags),
      });
    }

    marker = listResponse.IsTruncated ? listResponse.Marker : undefined;
  } while (marker);

  return managed;
}

/**
 * Looks up a single managed IAM role by ARN. Returns null if the role
 * does not exist or is not tagged with `managed-by=assignee-ai`.
 *
 * Used by the destroy-by-arn path so that targeted destroys work
 * even when the freshly-created role hasn't propagated through any
 * caches yet — iam:GetRole + iam:ListRoleTags are point-lookups, not
 * scans.
 */
export async function getManagedIamRoleByArn(
  arn: string,
  client?: IAMClient,
): Promise<ManagedIamRole | null> {
  // ARN format: arn:aws:iam::<account>:role/<roleName>
  const match = arn.match(/^arn:aws:iam::\d+:role\/(.+)$/);
  if (!match) return null;
  const roleName = match[1]!;

  const iam = client ?? createIamClient();

  try {
    const [getResponse, tagResponse] = await Promise.all([
      iam.send(new GetRoleCommand({ RoleName: roleName })),
      iam.send(new ListRoleTagsCommand({ RoleName: roleName })),
    ]);

    const role = getResponse.Role;
    if (!role || !role.Arn) return null;
    if (!hasManagedByTag(tagResponse.Tags)) return null;

    return {
      arn: role.Arn,
      roleName: role.RoleName ?? roleName,
      createdDate: role.CreateDate
        ? new Date(role.CreateDate).toISOString()
        : "N/A",
      tags: tagsToRecord(tagResponse.Tags),
    };
  } catch {
    // NoSuchEntity / AccessDenied / network failure all collapse to
    // "not found" — the caller falls through to the next resolver.
    return null;
  }
}

/**
 * The CloudFormation resource type for IAM roles, re-exported for
 * call sites that need to construct ManagedResource entries from
 * the helper output.
 */
export const IAM_ROLE_RESOURCE_TYPE = RESOURCE_TYPES.IAM_ROLE;
