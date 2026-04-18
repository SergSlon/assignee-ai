/**
 * Phase 1 of Bedrock invocation-logging setup (story 54-it1-09).
 *
 * Idempotent: GetRole → catch NO_SUCH_ENTITY → CreateRole → TagRole.
 * Trust policy allows bedrock.amazonaws.com to assume the role so
 * Bedrock can write invocation logs to CloudWatch on the caller's
 * behalf.
 *
 * Preserves the "verified" vs "created" log-step messaging from the
 * original god-function so UX is byte-for-byte identical.
 */

import * as clack from "@clack/prompts";
import {
  type IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import { AwsServicePrincipal, IamEffect, IamPolicy } from "@assignee/core";
import { AwsErrorName } from "../../../constants/aws-errors.js";
import { BEDROCK_LOGGING_ROLE_NAME, MANAGED_TAG } from "../constants.js";

/** Trust policy allowing bedrock.amazonaws.com to assume the role. */
function bedrockTrustPolicy(): string {
  return JSON.stringify({
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Effect: IamEffect.ALLOW,
        Principal: { Service: AwsServicePrincipal.BEDROCK },
        Action: IamPolicy.ACTION_ASSUME_ROLE,
      },
    ],
  });
}

/** Get-or-create the Bedrock logging IAM role, then apply managed tag. */
export async function ensureIamRole(iam: IAMClient): Promise<void> {
  try {
    await iam.send(new GetRoleCommand({ RoleName: BEDROCK_LOGGING_ROLE_NAME }));
    clack.log.step(
      `Role ${BEDROCK_LOGGING_ROLE_NAME} — verified (already exists)`,
    );
  } catch (err: unknown) {
    if (!(err instanceof Error) || err.name !== AwsErrorName.NO_SUCH_ENTITY) {
      throw err;
    }
    await iam.send(
      new CreateRoleCommand({
        RoleName: BEDROCK_LOGGING_ROLE_NAME,
        AssumeRolePolicyDocument: bedrockTrustPolicy(),
        Description: "Allows Bedrock to write invocation logs to CloudWatch",
      }),
    );
    clack.log.step(`Role ${BEDROCK_LOGGING_ROLE_NAME} — created`);
  }

  await iam.send(
    new TagRoleCommand({
      RoleName: BEDROCK_LOGGING_ROLE_NAME,
      Tags: [MANAGED_TAG],
    }),
  );
}
