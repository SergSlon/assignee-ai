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
import { AWS_REGION } from "../config/constants.js";
import {
  RESOURCE_TYPES,
  requireAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "@assignee/core";

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
 *
 * Wave 10 P0-2: this used to spread `operatorCredentials()` only when
 * non-empty, which let the IAMClient silently fall through to the
 * default AWS credential chain (`~/.aws/credentials`, EC2 instance
 * role, SSO) when ASSIGNEE_OPERATOR_* env vars were unset. On a dev
 * laptop with personal credentials configured, `assignee list` would
 * silently enumerate IAM in THE WRONG ACCOUNT. Now uses the canonical
 * `requireAssigneeCredentials("operator")` helper from @assignee/core
 * which throws `MissingAssigneeCredentialsError` rather than fall
 * through. The throw is caught at the call sites
 * (`fetchManagedIamRoles` and `getManagedIamRoleByArn`) and converted
 * into the same friendly warning path used by `list-resources.ts`.
 *
 * @throws MissingAssigneeCredentialsError when operator env vars unset
 */
function createIamClient(): IAMClient {
  const creds = requireAssigneeCredentials("operator");
  return new IAMClient({
    region: AWS_REGION,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
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
  // Wave 10 P0-2: when no client is injected (production path) the
  // helper constructs one via createIamClient(), which now throws
  // MissingAssigneeCredentialsError instead of silently falling
  // through to the default AWS credential chain. Callers
  // (`list-resources.ts`, `resource-resolver.ts`) already handle a
  // thrown error from this function with a friendly warning — letting
  // it propagate keeps the existing surface contract intact.
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
  // ARN format: arn:aws[-partition]:iam::<account>:role/[<path>/]<roleName>
  // The partition segment must match `aws`, `aws-us-gov`, or `aws-cn`
  // so GovCloud / China role lookups don't silently fail with "not
  // found" — same convention as `isArn()` in arn-builder.ts.
  //
  // IAM roles can live under a path like /service-role/MyRole or
  // /aws-service-role/foo.amazonaws.com/MyRole. The IAM API requires
  // the BARE role name (no path) for GetRole and ListRoleTags — passing
  // a path-prefixed value fails with ValidationError "must satisfy
  // regular expression pattern: [\w+=,.@-]+" (no slash allowed).
  // Strip every leading path segment by taking the last non-empty
  // "/"-delimited chunk. A trailing "/" (e.g. ".../service-role/")
  // would otherwise produce an empty string from `split('/').pop()`
  // and trip the same ValidationError. assignee.ai itself never creates
  // path-prefixed roles, but users running `assignee destroy` against
  // pre-existing tagged roles may pass a path-prefixed ARN.
  const match = arn.match(/^arn:aws[\w-]*:iam::\d+:role\/(.+)$/);
  if (!match) return null;
  const captured = match[1]!;
  const segments = captured.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return null;
  const roleName = segments[segments.length - 1]!;

  // Wave 10 P0-2: same credential guard as fetchManagedIamRoles. When
  // no client is injected, we construct one via the now-strict
  // createIamClient(). MissingAssigneeCredentialsError collapses to
  // null here (the byArn path treats "can't enumerate" the same as
  // "not found") rather than throwing — this matches the existing
  // try/catch swallow on AccessDenied / NoSuchEntity / network below.
  let iam: IAMClient;
  try {
    iam = client ?? createIamClient();
  } catch (err) {
    if (err instanceof MissingAssigneeCredentialsError) return null;
    throw err;
  }

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
  } catch (err) {
    // Wave 11 P2-1: surface AccessDenied as a real error instead of
    // collapsing it to null. The previous bare `catch {}` made
    // "iam:GetRole denied on the operator policy" look identical to
    // "the role doesn't exist" — users with a hand-edited operator
    // policy missing iam:GetRole would see "role not found" and waste
    // time hunting a non-existent inventory bug. NoSuchEntity (the
    // expected "not found" path) and other errors still collapse to
    // null so the byArn fallback chain keeps working.
    const errName =
      err && typeof err === "object" && "name" in err
        ? String((err as { name: unknown }).name)
        : "";
    if (
      errName === "AccessDeniedException" ||
      errName === "AccessDenied" ||
      errName === "UnauthorizedOperation"
    ) {
      throw new Error(
        `Cannot look up IAM role ${roleName}: the operator policy is missing iam:GetRole or iam:ListRoleTags. Run 'assignee setup' to refresh operator permissions.`,
        { cause: err },
      );
    }
    return null;
  }
}

/**
 * The CloudFormation resource type for IAM roles, re-exported for
 * call sites that need to construct ManagedResource entries from
 * the helper output.
 */
export const IAM_ROLE_RESOURCE_TYPE = RESOURCE_TYPES.IAM_ROLE;
