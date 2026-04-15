/**
 * Creates/updates Operator, Reader, and Auditor IAM users in parallel:
 * user → tag → per-policy (create/update + tag + attach) → access keys.
 *
 * Handles partial failures gracefully: returns per-role results so the
 * caller can decide whether to abort (operator is REQUIRED per M-S11).
 */

import * as clack from "@clack/prompts";
import {
  type IAMClient,
  AttachUserPolicyCommand,
  ListAccessKeysCommand,
  TagUserCommand,
  TagPolicyCommand,
} from "@aws-sdk/client-iam";
import { PromiseStatus } from "../../config/constants.js";
import { MANAGED_TAG, ROLES, type Role } from "./constants.js";
import { ensureAccessKey, ensurePolicy, ensureUser } from "./iam-helpers.js";

export interface RoleProvisionResult {
  role: Role;
  isNew: boolean;
  roleEnv: Record<string, string>;
}

export interface ProvisionOutcome {
  succeeded: RoleProvisionResult[];
  failed: PromiseRejectedResult[];
  envUpdates: Record<string, string>;
}

export async function provisionUsers(
  iam: IAMClient,
  accountId: string,
  rotationDecisions: Map<string, boolean>,
): Promise<ProvisionOutcome> {
  const sp = clack.spinner();
  const roleNames = ROLES.map((r) => r.userName).join(", ");
  sp.start(`Creating ${ROLES.length} IAM users in parallel (${roleNames})...`);

  const settled = await Promise.allSettled(
    ROLES.map(async (role) => {
      const roleEnv: Record<string, string> = {};

      // 1. Create or verify user
      const isNew = await ensureUser(iam, role.userName);

      // Tag user idempotently (covers pre-existing users missing the tag)
      await iam.send(
        new TagUserCommand({
          UserName: role.userName,
          Tags: [MANAGED_TAG],
        }),
      );

      // 2. Create + attach every policy. Operator has 3 (core +
      // servicesA + servicesB) after the A/B split; reader/auditor
      // have 1 each. AWS allows up to 10 managed policies per user.
      for (const { name: policyName, fn: policyFn } of role.policies) {
        const policyDoc = policyFn();
        const policyArn = await ensurePolicy(
          iam,
          accountId,
          policyName,
          policyDoc,
        );

        await iam.send(
          new TagPolicyCommand({
            PolicyArn: policyArn,
            Tags: [MANAGED_TAG],
          }),
        );

        await iam.send(
          new AttachUserPolicyCommand({
            UserName: role.userName,
            PolicyArn: policyArn,
          }),
        );
      }

      // 3. Handle access keys
      let shouldCreateKey = isNew;
      if (!isNew) {
        const existingKeys = await iam.send(
          new ListAccessKeysCommand({ UserName: role.userName }),
        );
        const hasKeys = (existingKeys.AccessKeyMetadata ?? []).length > 0;

        if (hasKeys) {
          const rotate = rotationDecisions.get(role.userName) ?? false;
          shouldCreateKey = rotate;
          if (rotate) {
            const keys = await ensureAccessKey(iam, role.userName, true);
            roleEnv[role.envKeyId] = keys.accessKeyId;
            roleEnv[role.envSecretKey] = keys.secretAccessKey;
          }
        } else {
          shouldCreateKey = true;
        }
      }

      if (shouldCreateKey && !roleEnv[role.envKeyId]) {
        const keys = await ensureAccessKey(iam, role.userName, false);
        roleEnv[role.envKeyId] = keys.accessKeyId;
        roleEnv[role.envSecretKey] = keys.secretAccessKey;
      }

      return { role, isNew, roleEnv };
    }),
  );

  const succeeded = settled.filter(
    (r): r is PromiseFulfilledResult<RoleProvisionResult> =>
      r.status === PromiseStatus.FULFILLED,
  );
  const failed = settled.filter(
    (r): r is PromiseRejectedResult => r.status === PromiseStatus.REJECTED,
  );

  sp.stop(
    failed.length === 0
      ? `All ${ROLES.length} IAM users ready (${roleNames})`
      : `${succeeded.length}/${ROLES.length} IAM users ready (${failed.length} failed)`,
  );

  if (failed.length > 0) {
    for (const f of failed) {
      clack.log.error(
        `IAM setup failed for one role: ${f.reason instanceof Error ? f.reason.message : String(f.reason)}`,
      );
    }
  }

  const envUpdates: Record<string, string> = {};
  for (const {
    value: { role, isNew, roleEnv },
  } of succeeded) {
    Object.assign(envUpdates, roleEnv);
    const policyList = role.policies.map((p) => p.name).join(", ");
    clack.log.step(
      isNew
        ? `Created user ${role.userName} with policy ${policyList}`
        : `User ${role.userName} verified, policy ${policyList} updated`,
    );
  }

  return {
    succeeded: succeeded.map((s) => s.value),
    failed,
    envUpdates,
  };
}
