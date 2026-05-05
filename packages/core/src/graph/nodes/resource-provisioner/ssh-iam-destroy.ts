/**
 * SSH-bundle IAM teardown — post-destroy companion to `ensureSshIamProfile`.
 *
 * Pre-demo audit (2026-05-05) H3: when the user runs `assignee destroy
 * <ec2-arn>`, the existing flow tears down the EC2 instance + KeyPair +
 * SecurityGroup but leaves the auto-created `assignee-ssh-<runId-suffix>`
 * IAM Role and InstanceProfile orphaned. They sit in the account
 * forever — free-tier, but every demo iteration adds another pair to
 * the IAM console.
 *
 * Cleanup is deterministic: the role + profile names are derived from
 * the runId-suffix using the same convention as `ensureSshIamProfile`
 * (`packages/core/src/graph/nodes/resource-provisioner/ssh-iam.ts:152-154`),
 * so we don't need an IAM listing call. The runId comes from the
 * provision-log lookup (we already wrote it at apply time per
 * `memory-recorder.ts`).
 *
 * Best-effort:
 *   - NoSuchEntity / ResourceNotFound at any step is tolerated (idempotent
 *     retry-after-cleanup). Mirrors `cleanup.ts:99-205` swallow pattern.
 *   - DeleteRole DeleteConflict (user manually attached additional managed
 *     policies that we don't know about) is logged with a hint, the role
 *     is left for the user to clean up manually. We deliberately do NOT
 *     ListAttachedRolePolicies + iterate-detach because that path can
 *     race with concurrent IAM API calls and would significantly expand
 *     the blast radius for V1.
 *   - Any other error is logged at warn level and swallowed — destroy of
 *     the EC2 itself has already succeeded; surfacing IAM cleanup
 *     failures to stderr would confuse the operator about whether the
 *     primary destroy worked.
 *
 * SRP: this module changes only when SSH-bundle IAM teardown rules
 * change.
 */

import { getPartitionFromRegion, RESOURCE_TYPES } from "@/index.js";
import { defaultMemoryService } from "@/services/memory.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { requireAssigneeCredentials } from "@/config/aws-credentials.js";
import { formatErrorForLog } from "./util.js";

/**
 * Compute the deterministic SSH-bundle IAM role + instance-profile names
 * for a given runId. MUST stay aligned with `ensureSshIamProfile` in
 * `ssh-iam.ts` — the convention is `assignee-ssh-<first-8-of-runId>`,
 * with a `default` suffix when the runId is empty (defensive).
 *
 * Exported for tests + the bulk-destroy / future audit-cleanup paths.
 */
export function computeSshBundleIamNames(runId: string | undefined): {
  roleName: string;
  profileName: string;
} {
  const shortId = (runId ?? "").slice(0, 8) || "default";
  const profileName = `assignee-ssh-${shortId}`;
  return { roleName: profileName, profileName };
}

/** Tracker returned to the caller for telemetry / test assertions. */
export interface SshIamDestroyResult {
  /** Role name we attempted to delete (deterministic from runId). */
  roleName: string;
  /** Profile name we attempted to delete (= roleName by convention). */
  profileName: string;
  /** True iff the role was deleted (or already absent) by the end. */
  roleRemoved: boolean;
  /** True iff the profile was deleted (or already absent) by the end. */
  profileRemoved: boolean;
  /** Any non-NoSuchEntity errors encountered, in order. */
  warnings: string[];
}

const NOT_FOUND_NAMES = new Set([
  "NoSuchEntityException",
  "NoSuchEntity",
  "ResourceNotFoundException",
  "ResourceNotFound",
]);

function isNotFoundError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = (err as { name?: string }).name ?? "";
  return NOT_FOUND_NAMES.has(name);
}

/**
 * Tear down the SSH-bundle IAM role + instance profile for the given
 * runId. Best-effort: never throws; non-NoSuchEntity errors are recorded
 * in the returned `warnings` array and logged at warn level.
 *
 * Steps (matches the order required by IAM):
 *   1. RemoveRoleFromInstanceProfile (so the profile can be deleted)
 *   2. DeleteInstanceProfile
 *   3. DetachRolePolicy (the AmazonSSMManagedInstanceCore ARN we attached)
 *   4. DeleteRole
 *
 * Each step swallows NoSuchEntity / ResourceNotFound; "the resource was
 * already gone" is a successful idempotent re-run from our perspective.
 */
export async function destroySshBundleIam(
  runId: string,
  region: string = AWS_REGION,
): Promise<SshIamDestroyResult> {
  const { roleName, profileName } = computeSshBundleIamNames(runId);
  const result: SshIamDestroyResult = {
    roleName,
    profileName,
    roleRemoved: false,
    profileRemoved: false,
    warnings: [],
  };

  let iam:
    | { send: (cmd: unknown) => Promise<unknown>; destroy: () => void }
    | undefined;

  try {
    const {
      IAMClient,
      RemoveRoleFromInstanceProfileCommand,
      DeleteInstanceProfileCommand,
      DetachRolePolicyCommand,
      DeleteRoleCommand,
    } = await import("@aws-sdk/client-iam");
    const creds = requireAssigneeCredentials("operator");
    iam = new IAMClient({
      region,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      },
    }) as unknown as {
      send: (cmd: unknown) => Promise<unknown>;
      destroy: () => void;
    };

    const partition = getPartitionFromRegion(region);
    const managedPolicyArn = `arn:${partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`;

    // Step 1: detach role from profile. NoSuchEntity → already detached
    // or never created.
    try {
      await iam.send(
        new RemoveRoleFromInstanceProfileCommand({
          InstanceProfileName: profileName,
          RoleName: roleName,
        }),
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        const msg = `RemoveRoleFromInstanceProfile failed for ${profileName}/${roleName}: ${formatErrorForLog(err)}`;
        result.warnings.push(msg);
        log({
          ts: new Date().toISOString(),
          runId,
          level: "warn",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: {
            phase: "ssh_iam_destroy_remove_role_from_profile",
            message: msg,
          },
        });
      }
    }

    // Step 2: delete the instance profile.
    try {
      await iam.send(
        new DeleteInstanceProfileCommand({ InstanceProfileName: profileName }),
      );
      result.profileRemoved = true;
    } catch (err) {
      if (isNotFoundError(err)) {
        result.profileRemoved = true;
      } else {
        const msg = `DeleteInstanceProfile failed for ${profileName}: ${formatErrorForLog(err)}`;
        result.warnings.push(msg);
        log({
          ts: new Date().toISOString(),
          runId,
          level: "warn",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: {
            phase: "ssh_iam_destroy_delete_instance_profile",
            message: msg,
          },
        });
      }
    }

    // Step 3: detach the AmazonSSMManagedInstanceCore policy from the role.
    try {
      await iam.send(
        new DetachRolePolicyCommand({
          RoleName: roleName,
          PolicyArn: managedPolicyArn,
        }),
      );
    } catch (err) {
      if (!isNotFoundError(err)) {
        const msg = `DetachRolePolicy failed for ${roleName}: ${formatErrorForLog(err)}`;
        result.warnings.push(msg);
        log({
          ts: new Date().toISOString(),
          runId,
          level: "warn",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: { phase: "ssh_iam_destroy_detach_role_policy", message: msg },
        });
      }
    }

    // Step 4: delete the role. DeleteConflict means user manually attached
    // additional policies — log a hint and leave the role in place for
    // manual cleanup (do NOT iterate-detach: races with concurrent IAM
    // calls + expands the blast radius beyond what we provisioned).
    try {
      await iam.send(new DeleteRoleCommand({ RoleName: roleName }));
      result.roleRemoved = true;
    } catch (err) {
      if (isNotFoundError(err)) {
        result.roleRemoved = true;
      } else {
        const errName =
          err instanceof Error ? (err as { name?: string }).name : "";
        const isConflict =
          errName === "DeleteConflictException" || errName === "DeleteConflict";
        const msg = isConflict
          ? `DeleteRole conflict on ${roleName} — additional policies are attached that Assignee did not provision. Detach them manually and run \`aws iam delete-role --role-name ${roleName}\` to finish cleanup.`
          : `DeleteRole failed for ${roleName}: ${formatErrorForLog(err)}`;
        result.warnings.push(msg);
        log({
          ts: new Date().toISOString(),
          runId,
          level: "warn",
          action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
          extras: { phase: "ssh_iam_destroy_delete_role", message: msg },
        });
      }
    }
  } catch (err) {
    const msg = `SSH-bundle IAM cleanup failed before any step ran: ${formatErrorForLog(err)}`;
    result.warnings.push(msg);
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: { phase: "ssh_iam_destroy_client_init_failed", message: msg },
    });
  } finally {
    iam?.destroy();
  }

  return result;
}

/**
 * Look up the runId for a destroyed EC2 ARN, then run
 * `destroySshBundleIam`. No-ops when:
 *   - The provision record can't be found (e.g. the EC2 was applied
 *     before this code existed, or the user deleted `~/.assignee/memory/
 *     provisions.json`).
 *   - The resource was applied with a non-SSH intent (the IAM names
 *     won't exist in IAM and every step swallows NoSuchEntity → no-op).
 *
 * Best-effort: never throws. Caller doesn't need to wrap in try/catch.
 *
 * Returns the destroy result for tests / callers that want to surface
 * the cleanup status. Production destroy flow ignores the return value
 * (silent best-effort matches the "destroy already succeeded; don't
 * confuse the operator" contract).
 */
export async function maybeDestroySshBundleIamForArn(
  arn: string,
  resourceType: string,
  region: string = AWS_REGION,
): Promise<SshIamDestroyResult | undefined> {
  // Only EC2 instances ever carry SSH-bundle IAM artifacts.
  if (resourceType !== RESOURCE_TYPES.EC2_INSTANCE) return undefined;
  if (!arn) return undefined;

  const record = await defaultMemoryService.readProvisionRecord(arn);
  if (!record) {
    // Pre-Story-iv records or rotated-out records — we can't compute the
    // role name without the runId. Silent no-op; user can clean up
    // manually via `aws iam list-roles --query "Roles[?starts_with(...)`.
    return undefined;
  }

  return destroySshBundleIam(record.runId, region);
}
