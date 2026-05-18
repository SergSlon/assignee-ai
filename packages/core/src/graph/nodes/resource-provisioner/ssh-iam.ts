/**
 * EC2 SSH-bundle IAM instance-profile pre-provision.
 *
 * When the user types `assignee infra apply "Create a EC2 with SSH"`, the
 * SSH-intent path needs the instance to be SSM-capable so the user can
 * `aws ssm start-session` even when SSH is firewalled. This pre-hook
 * auto-creates an IAM role + instance profile carrying the AWS-managed
 * `AmazonSSMManagedInstanceCore` policy and attaches the profile name
 * to the EC2's `IamInstanceProfile` desired-state property.
 *
 * Naming
 *   `assignee-ssh-<runId-suffix>` — unique per run (mirrors the keypair
 *   resource lifecycle). The runId-suffix is the first 8 chars of
 *   `state.runId` matching the convention used by `injectCompoundResourceName`
 *   in `compound-helpers.ts`.
 *
 * Flow:
 *   1. Skip early if the user supplied an `IamInstanceProfile` themselves
 *      (any non-empty value) OR the resourceType is not EC2::Instance OR
 *      the userIntent does not contain "ssh".
 *   2. CreateRole with Service: ec2.amazonaws.com assume-role-policy.
 *   3. AttachRolePolicy with the partition-aware managed-policy ARN
 *      `arn:<partition>:iam::aws:policy/AmazonSSMManagedInstanceCore`.
 *   4. CreateInstanceProfile.
 *   5. AddRoleToInstanceProfile.
 *   6. Mutate `desiredState[IamInstanceProfile] = profileName`.
 *
 * Each AWS call is idempotent: `EntityAlreadyExists` on Create*, NoSuchEntity
 * on retry-once paths, and `LimitExceeded` are caught and the operation
 * proceeds. AccessDenied is surfaced (we cannot proceed without IAM).
 *
 * Cleanup tracker mirror — caller passes the result to
 * `cleanupAllocatedResources` so a partial create-failure (e.g. AddRole
 * succeeds but the EC2 CCAPI call later fails) tears down the orphan
 * role + profile.
 *
 * SRP: this module changes when SSH-bundle IAM rules change.
 */

import {
  CfnKey,
  ExecutionStatus,
  RESOURCE_TYPES,
  getPartitionFromRegion,
} from "@/index.js";
import type { AgentState } from "../../graph-state.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { requireAssigneeCredentials } from "@/config/aws-credentials.js";
import { isSshIntent } from "@/utils/ssh-intent.js";

/** Tracker passed to cleanup so partial creates can be torn down. */
export interface SshIamCreated {
  /** IAM role name we created (or attempted). Undefined when nothing created. */
  roleName: string | undefined;
  /** IAM instance-profile name we created (or attempted). Undefined when nothing created. */
  profileName: string | undefined;
  /** Managed policy ARN we attached. Undefined when no attach call ran. */
  attachedPolicyArn: string | undefined;
  /** True once we successfully called AddRoleToInstanceProfile. */
  roleAddedToProfile: boolean;
}

export type SshIamResult =
  | {
      ok: true;
      created: SshIamCreated;
    }
  | {
      ok: false;
      partial: Partial<AgentState>;
      created: SshIamCreated;
    };

const ASSUME_ROLE_POLICY_DOCUMENT = JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    {
      Effect: "Allow",
      Principal: { Service: "ec2.amazonaws.com" },
      Action: "sts:AssumeRole",
    },
  ],
});

/** Type guard: was a string actually supplied (non-empty after trim)? */
function isUserSuppliedProfile(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  if (value && typeof value === "object") {
    // CCAPI accepts `{Arn: ...}` or `{Name: ...}` shapes.
    const v = value as Record<string, unknown>;
    if (typeof v["Arn"] === "string" && v["Arn"].trim().length > 0) return true;
    if (typeof v["Name"] === "string" && v["Name"].trim().length > 0)
      return true;
  }
  return false;
}

/**
 * Best-effort idempotent IAM call. Swallows `EntityAlreadyExists` so a
 * retry / parallel run doesn't re-throw on a resource we already own.
 * Other errors propagate so the caller can fail-fast and clean up.
 */
async function callIdempotent<T>(
  fn: () => Promise<T>,
  acceptableErrorNames: readonly string[],
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (err) {
    const errName =
      err instanceof Error ? (err as { name?: string }).name : undefined;
    if (errName && acceptableErrorNames.includes(errName)) {
      return undefined;
    }
    throw err;
  }
}

const emptyCreated: SshIamCreated = {
  roleName: undefined,
  profileName: undefined,
  attachedPolicyArn: undefined,
  roleAddedToProfile: false,
};

/**
 * Create (or reuse) the SSH-bundle IAM role + instance profile and
 * write the profile name into `desiredState[IamInstanceProfile]`. No-op
 * unless this is an EC2::Instance, the userIntent passes the shared
 * `isSshIntent` gate (positive `\bssh\b` and no negation phrasing),
 * AND the user did not supply their own profile.
 */
export async function ensureSshIamProfile(
  state: AgentState,
  desiredState: Record<string, unknown>,
): Promise<SshIamResult> {
  // Gate 1: only EC2::Instance.
  if (state.resourceType !== RESOURCE_TYPES.EC2_INSTANCE) {
    return { ok: true, created: emptyCreated };
  }
  // Gate 2: only when userIntent affirmatively asks for SSH (the
  // shared `isSshIntent` helper rejects negation phrasings like
  // "without ssh", "no ssh", "disable ssh" — see audit H2 / 2026-05-05).
  if (!isSshIntent(state.userIntent)) {
    return { ok: true, created: emptyCreated };
  }
  // Gate 3: skip if the user already supplied a profile.
  if (isUserSuppliedProfile(desiredState[CfnKey.IAM_INSTANCE_PROFILE])) {
    return { ok: true, created: emptyCreated };
  }

  const created: SshIamCreated = { ...emptyCreated };
  // Use the same shortId convention as compound-helpers.ts:175.
  const shortId = (state.runId ?? "").slice(0, 8) || "default";
  const profileName = `assignee-ssh-${shortId}`;
  const roleName = profileName;
  const partition = getPartitionFromRegion(AWS_REGION);
  const managedPolicyArn = `arn:${partition}:iam::aws:policy/AmazonSSMManagedInstanceCore`;

  process.stderr.write(
    `\u001B[33m🔐 auto-attaching SSM-capable role for SSH instance: ${roleName}\u001B[0m\n`,
  );

  let iam:
    | { send: (cmd: unknown) => Promise<unknown>; destroy: () => void }
    | undefined;
  try {
    const {
      IAMClient,
      CreateRoleCommand,
      AttachRolePolicyCommand,
      CreateInstanceProfileCommand,
      AddRoleToInstanceProfileCommand,
      TagInstanceProfileCommand,
    } = await import("@aws-sdk/client-iam");
    const creds = requireAssigneeCredentials("operator");
    iam = new IAMClient({
      region: AWS_REGION,
      credentials: {
        accessKeyId: creds.accessKeyId,
        secretAccessKey: creds.secretAccessKey,
        ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
      },
    }) as unknown as {
      send: (cmd: unknown) => Promise<unknown>;
      destroy: () => void;
    };

    // BLOCKER #2 fix (Story i SSH-IAM compound review): tag the
    // auto-created role with managed-by=assignee-ai + the runId so it
    // is visible to:
    //   - any future IAM-aware destroy sweep (per
    //     feedback_iam_role_rgta_gap: AWS Resource Groups Tagging API
    //     does NOT return IAM::Role, so an IAM cleanup must enumerate
    //     via iam:ListRoles + iam:ListRoleTags filtered by managed-by).
    //     Story 50-3 removed the bulk-destroy CLI surface; the tags
    //     keep the role discoverable for the per-resource destroy path
    //     and for any future opt-in IAM sweep.
    //   - the safety allowlist (per
    //     feedback_assignee_infra_safety_allowlist: bulk-destroy still
    //     skips the AssigneeOperator/Reader/Auditor/Bedrock* roles —
    //     `assignee-ssh-*` does not collide with that allowlist).
    const assigneeTags = [
      { Key: "managed-by", Value: "assignee-ai" },
      { Key: "assignee-run-id", Value: state.runId ?? "" },
    ];
    // Step 1: CreateRole (idempotent — EntityAlreadyExists tolerated).
    // Tags are passed inline; CreateRole accepts them in a single call.
    await callIdempotent(
      () =>
        iam!.send(
          new CreateRoleCommand({
            RoleName: roleName,
            AssumeRolePolicyDocument: ASSUME_ROLE_POLICY_DOCUMENT,
            Description:
              "Assignee.ai SSH-bundle role: SSM-capable EC2 instance profile",
            Tags: assigneeTags,
          }),
        ),
      ["EntityAlreadyExistsException"],
    );
    created.roleName = roleName;

    // Step 2: AttachRolePolicy (idempotent — re-attach is a no-op in IAM).
    await callIdempotent(
      () =>
        iam!.send(
          new AttachRolePolicyCommand({
            RoleName: roleName,
            PolicyArn: managedPolicyArn,
          }),
        ),
      [],
    );
    created.attachedPolicyArn = managedPolicyArn;

    // Step 3: CreateInstanceProfile (idempotent).
    // BLOCKER #2 fix: CreateInstanceProfile does NOT accept Tags
    // inline (unlike CreateRole), so we follow with TagInstanceProfile
    // to apply the managed-by + assignee-run-id tags. The tag call is
    // also wrapped in callIdempotent so a re-run on an already-tagged
    // profile (or a NoSuchEntity race) doesn't blow up the flow.
    await callIdempotent(
      () =>
        iam!.send(
          new CreateInstanceProfileCommand({
            InstanceProfileName: profileName,
          }),
        ),
      ["EntityAlreadyExistsException"],
    );
    created.profileName = profileName;
    await callIdempotent(
      () =>
        iam!.send(
          new TagInstanceProfileCommand({
            InstanceProfileName: profileName,
            Tags: assigneeTags,
          }),
        ),
      ["NoSuchEntityException"],
    );

    // Step 4: AddRoleToInstanceProfile — IAM rejects with
    // LimitExceeded.LimitExceededException when the profile already has
    // a role attached. Treat both that AND EntityAlreadyExists as
    // success-in-our-favour (the role is already in place).
    await callIdempotent(
      () =>
        iam!.send(
          new AddRoleToInstanceProfileCommand({
            InstanceProfileName: profileName,
            RoleName: roleName,
          }),
        ),
      ["LimitExceededException", "EntityAlreadyExistsException"],
    );
    created.roleAddedToProfile = true;

    // Step 5: mutate desiredState to point the EC2 at the profile.
    desiredState[CfnKey.IAM_INSTANCE_PROFILE] = profileName;

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: {
        sshIamCreated: { roleName, profileName, managedPolicyArn },
      },
    });

    return { ok: true, created };
  } catch (iamErr: unknown) {
    const errMsg = iamErr instanceof Error ? iamErr.message : String(iamErr);
    process.stderr.write(
      `\u001B[31m⚠️  SSH-bundle IAM provisioning failed: ${errMsg}\u001B[0m\n`,
    );
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "error",
      action: LOG_ACTIONS.RESOURCE_PROVISION_STARTED,
      extras: { sshIamError: errMsg, sshIamPartial: created },
    });
    return {
      ok: false,
      created,
      partial: {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `SSH-bundle IAM instance-profile provisioning failed (cannot proceed without SSM-capable role): ${errMsg}`,
        desiredState,
      },
    };
  } finally {
    iam?.destroy();
  }
}
