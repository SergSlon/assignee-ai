/**
 * Low-level IAM helpers for setup: policy upsert, user upsert, and
 * access-key issuance/rotation. Each helper is idempotent and raises
 * on non-recoverable AWS errors — the orchestrator decides how to
 * triage partial failures.
 */

import {
  type IAMClient,
  CreateUserCommand,
  GetUserCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
  DeleteAccessKeyCommand,
} from "@aws-sdk/client-iam";
import { AssigneeTag, getPartitionFromRegion } from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import { AwsErrorName } from "../../constants/aws-errors.js";
import { buildIamPolicyArn } from "../../utils/setup-arn-builder.js";
import type { PolicyDocument } from "./constants.js";

/**
 * Creates or updates an IAM managed policy.
 * Handles the 5-version limit by deleting the oldest non-default version.
 */
export async function ensurePolicy(
  iam: IAMClient,
  accountId: string,
  policyName: string,
  policyDoc: PolicyDocument,
): Promise<string> {
  // Partition-aware: setup runs in the caller's region so GovCloud/China
  // operators get `arn:aws-us-gov:` / `arn:aws-cn:` policy ARNs.
  const partition = getPartitionFromRegion(AWS_REGION);
  const policyArn = buildIamPolicyArn({ partition, accountId, policyName });
  const policyJson = JSON.stringify(policyDoc);

  try {
    const result = await iam.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: policyJson,
        Description: `Managed by assignee.ai — do not edit manually.`,
      }),
    );
    return result.Policy!.Arn!;
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      err.name === AwsErrorName.ENTITY_ALREADY_EXISTS
    ) {
      const versions = await iam.send(
        new ListPolicyVersionsCommand({ PolicyArn: policyArn }),
      );
      const versionList = versions.Versions ?? [];
      if (versionList.length >= 5) {
        const nonDefault = versionList
          .filter((v) => !v.IsDefaultVersion)
          .sort(
            (a, b) =>
              (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0),
          );
        // Defensive: AWS guarantees at most one default version, so there
        // should always be a non-default candidate when we hit the limit.
        // @see SECURITY-AUDIT.md — M-S12
        if (nonDefault.length === 0) {
          process.stderr.write(
            `[assignee dev setup] WARNING: policy ${policyName} has 5 versions ` +
              `but none are non-default. Skipping policy update to avoid a ` +
              `LimitExceeded error. Inspect the policy in the AWS console.\n`,
          );
          return policyArn;
        }
        if (nonDefault[0]!.VersionId) {
          await iam.send(
            new DeletePolicyVersionCommand({
              PolicyArn: policyArn,
              VersionId: nonDefault[0]!.VersionId,
            }),
          );
        }
      }

      await iam.send(
        new CreatePolicyVersionCommand({
          PolicyArn: policyArn,
          PolicyDocument: policyJson,
          SetAsDefault: true,
        }),
      );
      return policyArn;
    }
    throw err;
  }
}

/**
 * Creates an IAM user if it doesn't already exist.
 * Returns true if the user was newly created, false if it already existed.
 */
export async function ensureUser(
  iam: IAMClient,
  userName: string,
): Promise<boolean> {
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
    return false;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === AwsErrorName.NO_SUCH_ENTITY) {
      await iam.send(
        new CreateUserCommand({
          UserName: userName,
          Tags: [{ Key: AssigneeTag.KEY, Value: AssigneeTag.VALUE }],
        }),
      );
      return true;
    }
    throw err;
  }
}

/**
 * Creates access keys for a user, optionally rotating existing ones.
 */
export async function ensureAccessKey(
  iam: IAMClient,
  userName: string,
  rotateExisting: boolean,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  if (rotateExisting) {
    const existing = await iam.send(
      new ListAccessKeysCommand({ UserName: userName }),
    );
    for (const key of existing.AccessKeyMetadata ?? []) {
      if (key.AccessKeyId) {
        await iam.send(
          new DeleteAccessKeyCommand({
            UserName: userName,
            AccessKeyId: key.AccessKeyId,
          }),
        );
      }
    }
  }

  const result = await iam.send(
    new CreateAccessKeyCommand({ UserName: userName }),
  );
  return {
    accessKeyId: result.AccessKey!.AccessKeyId!,
    secretAccessKey: result.AccessKey!.SecretAccessKey!,
  };
}
