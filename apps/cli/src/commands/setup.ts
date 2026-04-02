/**
 * `assignee setup` command — creates IAM users, policies, and access keys
 * for the 3-user credential separation model.
 *
 * Requires admin/root AWS credentials. Idempotent: safe to re-run.
 *
 * @see Story 18.8 — IAM Security Overhaul
 */

import * as path from "node:path";
import { Command } from "commander";
import * as clack from "@clack/prompts";
import {
  IAMClient,
  CreateUserCommand,
  GetUserCommand,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
  DeleteAccessKeyCommand,
  TagUserCommand,
  TagRoleCommand,
  TagPolicyCommand,
} from "@aws-sdk/client-iam";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  operatorPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  type PolicyDocument,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ConfigurationError, AssigneeTag } from "@assignee/core";
import { mergeEnvFile } from "../utils/env-writer.js";
import { AWS_REGION } from "../config/constants.js";

/** Maps role keys to their policy generators, user names, and env var prefixes. */
const ROLES = [
  {
    key: "operator" as const,
    userName: IAM_USER_NAMES.operator,
    policyName: IAM_POLICY_NAMES.operator,
    policyFn: operatorPolicy,
    envKeyId: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    description: "CLI operator — Bedrock + CloudControl provisioning",
  },
  {
    key: "reader" as const,
    userName: IAM_USER_NAMES.reader,
    policyName: IAM_POLICY_NAMES.reader,
    policyFn: readerPolicy,
    envKeyId: "ASSIGNEE_READER_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_READER_SECRET_ACCESS_KEY",
    description: "MCP reader — schema, pricing, billing (read-only)",
  },
  {
    key: "auditor" as const,
    userName: IAM_USER_NAMES.auditor,
    policyName: IAM_POLICY_NAMES.auditor,
    policyFn: auditorPolicy,
    envKeyId: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    description: "MCP auditor — IAM simulate, SecurityHub (read-only)",
  },
] as const;

/** Standard tag applied to all IAM resources managed by assignee.ai. */
const MANAGED_TAG = { Key: AssigneeTag.KEY, Value: AssigneeTag.VALUE };

/** Bedrock invocation logging constants. */
const BEDROCK_LOGGING_ROLE_NAME = "AssigneeAiBedrockLoggingRole";
const BEDROCK_LOG_GROUP_NAME = "/assignee-ai/bedrock-invocations";

/**
 * Creates or updates an IAM managed policy.
 * Handles the 5-version limit by deleting the oldest non-default version.
 */
async function ensurePolicy(
  iam: IAMClient,
  accountId: string,
  policyName: string,
  policyDoc: PolicyDocument,
): Promise<string> {
  const policyArn = `arn:aws:iam::${accountId}:policy/${policyName}`;
  const policyJson = JSON.stringify(policyDoc);

  try {
    // Try to create the policy (first run)
    const result = await iam.send(
      new CreatePolicyCommand({
        PolicyName: policyName,
        PolicyDocument: policyJson,
        Description: `Managed by assignee.ai — do not edit manually.`,
      }),
    );
    return result.Policy!.Arn!;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "EntityAlreadyExistsException") {
      // Policy exists — create a new version (idempotent update)
      // First check version count (AWS limit: 5)
      const versions = await iam.send(
        new ListPolicyVersionsCommand({ PolicyArn: policyArn }),
      );
      const versionList = versions.Versions ?? [];
      if (versionList.length >= 5) {
        // Delete oldest non-default version
        const nonDefault = versionList
          .filter((v) => !v.IsDefaultVersion)
          .sort(
            (a, b) =>
              (a.CreateDate?.getTime() ?? 0) - (b.CreateDate?.getTime() ?? 0),
          );
        if (nonDefault.length > 0 && nonDefault[0]!.VersionId) {
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
async function ensureUser(iam: IAMClient, userName: string): Promise<boolean> {
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
    return false; // User already exists
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "NoSuchEntityException") {
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
 * Returns { accessKeyId, secretAccessKey }.
 */
async function ensureAccessKey(
  iam: IAMClient,
  userName: string,
  rotateExisting: boolean,
): Promise<{ accessKeyId: string; secretAccessKey: string }> {
  if (rotateExisting) {
    // Delete existing keys before creating new ones
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

export const setupCommand = new Command(CommandName.SETUP)
  .description(CommandDescription.SETUP)
  .option(
    "--profile <profile>",
    "AWS CLI profile with admin/root credentials (reads from ~/.aws/credentials)",
  )
  .option("-y, --yes", "Skip confirmation prompts")
  .action(async (options: { profile?: string; yes?: boolean }) => {
    clack.intro("Assignee.ai — IAM Setup");

    // ── Build credential provider ────────────────────────────────────
    // The setup command needs admin/root credentials which are typically in
    // ~/.aws/credentials, not in .env (which has the operator user).
    // Always use fromIni() to read from the AWS credentials file/config.
    // Use --profile to specify a non-default profile.
    const { fromIni } = await import("@aws-sdk/credential-providers");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const clientConfig: Record<string, any> = {
      credentials: fromIni({ profile: options.profile ?? "default" }),
    };

    // ── Verify admin credentials ─────────────────────────────────────
    const s = clack.spinner();
    s.start("Verifying AWS credentials...");

    let accountId: string;
    try {
      const sts = new STSClient(clientConfig);
      const identity = await sts.send(new GetCallerIdentityCommand({}));
      accountId = identity.Account!;
      s.stop(`Authenticated as ${identity.Arn} (account: ${accountId})`);
    } catch (err) {
      s.stop("Failed to verify AWS credentials.");
      throw new ConfigurationError(
        "Cannot reach AWS STS. Ensure you have admin/root credentials configured.\n" +
          "Tip: Use --profile <name> to specify an AWS CLI profile with admin access.\n" +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // ── Display plan and confirm ─────────────────────────────────────
    clack.log.info(
      "This command will create/update the following IAM resources:",
    );
    for (const role of ROLES) {
      clack.log.step(
        `  User: ${role.userName}\n  Policy: ${role.policyName}\n  Purpose: ${role.description}`,
      );
    }

    if (!options.yes) {
      const confirmed = await clack.confirm({
        message: "Proceed with IAM setup?",
        initialValue: true,
      });

      if (clack.isCancel(confirmed) || !confirmed) {
        clack.outro("Setup cancelled.");
        return;
      }
    }

    const iam = new IAMClient(clientConfig);
    const envUpdates: Record<string, string> = {};

    // ── Pre-check existing users for key rotation prompts (sequential) ─
    // Interactive prompts cannot run in parallel, so we gather rotation
    // decisions before the parallel IAM work begins.
    const rotationDecisions = new Map<string, boolean>();
    if (!options.yes) {
      for (const role of ROLES) {
        try {
          await iam.send(new GetUserCommand({ UserName: role.userName }));
          // User exists — check for access keys
          const existingKeys = await iam.send(
            new ListAccessKeysCommand({ UserName: role.userName }),
          );
          const hasKeys = (existingKeys.AccessKeyMetadata ?? []).length > 0;
          if (hasKeys) {
            const rotate = await clack.confirm({
              message: `User ${role.userName} already has access keys. Rotate them?`,
              initialValue: false,
            });
            if (clack.isCancel(rotate)) {
              clack.outro("Setup cancelled.");
              return;
            }
            rotationDecisions.set(role.userName, !!rotate);
          }
        } catch {
          // User doesn't exist yet — will be created; no prompt needed
        }
      }
    }

    // ── Create/update users, policies, and access keys (parallel) ────
    const sp = clack.spinner();
    const roleNames = ROLES.map((r) => r.userName).join(", ");
    sp.start(
      `Creating ${ROLES.length} IAM users in parallel (${roleNames})...`,
    );

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

        // 2. Create or update policy
        const policyDoc = role.policyFn();
        const policyArn = await ensurePolicy(
          iam,
          accountId,
          role.policyName,
          policyDoc,
        );

        // Tag policy idempotently
        await iam.send(
          new TagPolicyCommand({
            PolicyArn: policyArn,
            Tags: [MANAGED_TAG],
          }),
        );

        // 3. Attach policy to user
        await iam.send(
          new AttachUserPolicyCommand({
            UserName: role.userName,
            PolicyArn: policyArn,
          }),
        );

        // 4. Handle access keys
        let shouldCreateKey = isNew;
        if (!isNew) {
          const existingKeys = await iam.send(
            new ListAccessKeysCommand({ UserName: role.userName }),
          );
          const hasKeys = (existingKeys.AccessKeyMetadata ?? []).length > 0;

          if (hasKeys) {
            // Use pre-collected rotation decision; --yes skips rotation
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

    // Handle partial failures gracefully — save keys from successful roles
    const succeeded = settled.filter(
      (
        r,
      ): r is PromiseFulfilledResult<{
        role: (typeof ROLES)[number];
        isNew: boolean;
        roleEnv: Record<string, string>;
      }> => r.status === "fulfilled",
    );
    const failed = settled.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
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

    // Merge per-role env updates from successful roles
    for (const {
      value: { role, isNew, roleEnv },
    } of succeeded) {
      Object.assign(envUpdates, roleEnv);
      clack.log.step(
        isNew
          ? `Created user ${role.userName} with policy ${role.policyName}`
          : `User ${role.userName} verified, policy ${role.policyName} updated`,
      );
    }

    // ── Bedrock invocation logging (Tasks 1–3 from aws-bootstrap.md) ──
    const region = AWS_REGION;
    const logSp = clack.spinner();
    logSp.start("Setting up Bedrock invocation logging...");

    // Task 1: Create IAM role for Bedrock logging
    try {
      await iam.send(
        new GetRoleCommand({ RoleName: BEDROCK_LOGGING_ROLE_NAME }),
      );
      clack.log.step(
        `Role ${BEDROCK_LOGGING_ROLE_NAME} — verified (already exists)`,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "NoSuchEntityException") {
        await iam.send(
          new CreateRoleCommand({
            RoleName: BEDROCK_LOGGING_ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: "2012-10-17",
              Statement: [
                {
                  Effect: "Allow",
                  Principal: { Service: "bedrock.amazonaws.com" },
                  Action: "sts:AssumeRole",
                },
              ],
            }),
            Description:
              "Allows Bedrock to write invocation logs to CloudWatch",
          }),
        );
        clack.log.step(`Role ${BEDROCK_LOGGING_ROLE_NAME} — created`);
      } else {
        throw err;
      }
    }

    // Tag Bedrock logging role idempotently
    await iam.send(
      new TagRoleCommand({
        RoleName: BEDROCK_LOGGING_ROLE_NAME,
        Tags: [MANAGED_TAG],
      }),
    );

    // Task 2: Attach inline logging policy to the role (put-role-policy is idempotent)
    await iam.send(
      new PutRolePolicyCommand({
        RoleName: BEDROCK_LOGGING_ROLE_NAME,
        PolicyName: "BedrockLoggingPolicy",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Action: [
                "logs:CreateLogGroup",
                "logs:CreateLogStream",
                "logs:PutLogEvents",
                "logs:DescribeLogGroups",
              ],
              Resource: `arn:aws:logs:${region}:${accountId}:log-group:${BEDROCK_LOG_GROUP_NAME}:*`,
            },
          ],
        }),
      }),
    );
    clack.log.step("Inline policy BedrockLoggingPolicy — applied");

    // Task 3: Create CloudWatch log group
    {
      const { CloudWatchLogsClient, CreateLogGroupCommand } =
        await import("@aws-sdk/client-cloudwatch-logs");
      const cwl = new CloudWatchLogsClient({ ...clientConfig, region });
      try {
        await cwl.send(
          new CreateLogGroupCommand({ logGroupName: BEDROCK_LOG_GROUP_NAME }),
        );
        clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — created`);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === "ResourceAlreadyExistsException"
        ) {
          clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — verified`);
        } else {
          throw err;
        }
      }
    }

    // Task 4: Enable Bedrock invocation logging
    {
      const { BedrockClient, PutModelInvocationLoggingConfigurationCommand } =
        await import("@aws-sdk/client-bedrock");
      const bedrock = new BedrockClient({ ...clientConfig, region });
      await bedrock.send(
        new PutModelInvocationLoggingConfigurationCommand({
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: BEDROCK_LOG_GROUP_NAME,
              roleArn: `arn:aws:iam::${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}`,
            },
            textDataDeliveryEnabled: true,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        }),
      );
      clack.log.step("Bedrock invocation logging — enabled");
    }

    logSp.stop("Bedrock logging IAM role and policy ready");

    // ── Write .env file ──────────────────────────────────────────────
    if (Object.keys(envUpdates).length > 0) {
      const envPath = path.resolve(process.cwd(), ".env");
      const sp = clack.spinner();
      sp.start("Writing credentials to .env...");
      mergeEnvFile(envPath, envUpdates);
      sp.stop("Credentials written to .env");
    } else {
      clack.log.info("No new access keys created — .env file unchanged.");
    }

    // ── Summary ──────────────────────────────────────────────────────
    clack.log.success("IAM setup complete! Users and policies:");
    for (const role of ROLES) {
      clack.log.step(
        `  ${role.userName} → ${role.policyName} (env: ${role.envKeyId})`,
      );
    }

    clack.outro("Run `assignee plan` to verify the new credentials work.");
  });
