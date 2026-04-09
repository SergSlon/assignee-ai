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
  operatorServicesPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
  type PolicyDocument,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ConfigurationError, AssigneeTag } from "@assignee/core";
import { mergeEnvFile } from "../utils/env-writer.js";
import { AWS_REGION, PromiseStatus, UserMessage } from "../config/constants.js";
import { AwsErrorName } from "../constants/aws-errors.js";
import {
  ArnPrefix,
  IamAction,
  IamEffect,
  IamPolicy,
  AwsServicePrincipal,
} from "@assignee/core";

/**
 * Maps role keys to their policy generators, user names, and env var prefixes.
 *
 * Each role has a `policies` array because the operator surface is split
 * across two managed policies (A8 follow-up: AssigneeOperatorPolicy +
 * AssigneeOperatorServicesPolicy) to fit inside the AWS 6144-byte
 * managed-policy size limit. Both policies attach to the same operator
 * IAM user and AWS evaluates the union — strictly equivalent to the
 * pre-split single-policy version.
 */
const ROLES = [
  {
    key: "operator" as const,
    userName: IAM_USER_NAMES.operator,
    policies: [
      { name: IAM_POLICY_NAMES.operator, fn: operatorPolicy },
      {
        name: IAM_POLICY_NAMES.operatorServices,
        fn: operatorServicesPolicy,
      },
    ],
    envKeyId: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
    description: "CLI operator — Bedrock + CloudControl provisioning",
  },
  {
    key: "reader" as const,
    userName: IAM_USER_NAMES.reader,
    policies: [{ name: IAM_POLICY_NAMES.reader, fn: readerPolicy }],
    envKeyId: "ASSIGNEE_READER_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_READER_SECRET_ACCESS_KEY",
    description: "MCP reader — schema, pricing, billing (read-only)",
  },
  {
    key: "auditor" as const,
    userName: IAM_USER_NAMES.auditor,
    policies: [{ name: IAM_POLICY_NAMES.auditor, fn: auditorPolicy }],
    envKeyId: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
    envSecretKey: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
    description: "MCP auditor — IAM simulate, SecurityHub (read-only)",
  },
] as const;

/** Standard tag applied to all IAM resources managed by assignee.ai. */
const MANAGED_TAG = { Key: AssigneeTag.KEY, Value: AssigneeTag.VALUE };

/** Bedrock invocation logging constants. */
const BEDROCK_LOGGING_ROLE_NAME = "AssigneeAiBedrockLoggingRole";
const BEDROCK_LOGGING_POLICY_NAME = "BedrockLoggingPolicy";
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
    if (
      err instanceof Error &&
      err.name === AwsErrorName.ENTITY_ALREADY_EXISTS
    ) {
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
        // Defensive: AWS guarantees at most one default version, so there
        // should always be a non-default candidate when we hit the limit.
        // If not (e.g. an unexpected API state), warn loudly and skip the
        // update so the caller sees a clear message instead of a cryptic
        // LimitExceeded from CreatePolicyVersion below.
        // @see SECURITY-AUDIT.md — M-S12
        if (nonDefault.length === 0) {
          process.stderr.write(
            `[assignee setup] WARNING: policy ${policyName} has 5 versions ` +
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
async function ensureUser(iam: IAMClient, userName: string): Promise<boolean> {
  try {
    await iam.send(new GetUserCommand({ UserName: userName }));
    return false; // User already exists
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
  .description(
    CommandDescription.SETUP +
      " The operator role is REQUIRED — setup aborts if it fails.",
  )
  .option(
    "--profile <profile>",
    "AWS CLI profile with admin/root credentials (reads from ~/.aws/credentials)",
  )
  .option("-y, --yes", "Skip confirmation prompts")
  .option(
    "--enable-llm-logging",
    "PRIVACY: Enable Bedrock invocation text logging to CloudWatch (logs every prompt and response). Default: OFF.",
    false,
  )
  .option(
    "--disable-llm-logging",
    "PRIVACY: Explicitly DISABLE Bedrock invocation text logging (idempotent). Runs only the PutModelInvocationLoggingConfiguration call with textDataDeliveryEnabled=false; does NOT re-run the full IAM wizard. Mutually exclusive with --enable-llm-logging.",
    false,
  )
  .option(
    "--dry-run",
    "Print the plan of resources that WOULD be created without invoking any AWS APIs",
    false,
  )
  .action(
    async (options: {
      profile?: string;
      yes?: boolean;
      enableLlmLogging?: boolean;
      disableLlmLogging?: boolean;
      dryRun?: boolean;
    }) => {
      // UX (Sally): --enable and --disable are mutually exclusive. Pass both
      // by mistake and we fail fast with a clear message rather than silently
      // picking one of the two.
      if (options.enableLlmLogging && options.disableLlmLogging) {
        throw new ConfigurationError(
          "Flags --enable-llm-logging and --disable-llm-logging are mutually exclusive. " +
            "Pass one or the other, not both.",
        );
      }

      clack.intro("Assignee.ai — IAM Setup");

      // ── Disable-only fast path ───────────────────────────────────────
      // Sally UX fix: the CLI previously exposed --enable-llm-logging but no
      // symmetric --disable flag, forcing users to run raw AWS CLI commands
      // to turn logging back off. This path only touches Bedrock's
      // PutModelInvocationLoggingConfiguration — no IAM, no .env, no users.
      if (options.disableLlmLogging) {
        if (options.dryRun) {
          clack.log.info(
            "DRY RUN — no AWS APIs will be called. The following Bedrock configuration WOULD be applied:",
          );
          clack.log.step(
            "Bedrock invocation logging — DISABLE:\n" +
              `  - Target log group: ${BEDROCK_LOG_GROUP_NAME}\n` +
              `  - Target role: ${BEDROCK_LOGGING_ROLE_NAME}\n` +
              `  - textDataDeliveryEnabled: false\n` +
              `  - imageDataDeliveryEnabled: false\n` +
              `  - embeddingDataDeliveryEnabled: false`,
          );
          clack.outro(
            "Dry run complete — no changes made. Re-run without --dry-run to apply.",
          );
          return;
        }

        // Build the same credential provider as the main path so the user
        // can pass --profile / AWS_PROFILE to target a specific account.
        const { fromIni } = await import("@aws-sdk/credential-providers");
        const resolvedProfile =
          options.profile ?? process.env["AWS_PROFILE"] ?? "default";
        const clientConfig: {
          credentials: ReturnType<typeof fromIni>;
          region?: string;
        } = {
          credentials: fromIni({ profile: resolvedProfile }),
        };

        // Resolve the account id so the role ARN we pass to Bedrock points
        // at the caller's account — NOT hard-coded.
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
            "Cannot reach AWS STS. Ensure you have admin credentials configured.\n" +
              `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }

        const region = AWS_REGION;
        const { BedrockClient, PutModelInvocationLoggingConfigurationCommand } =
          await import("@aws-sdk/client-bedrock");
        const bedrock = new BedrockClient({ ...clientConfig, region });
        const disableSp = clack.spinner();
        disableSp.start("Disabling Bedrock invocation text logging...");
        try {
          await bedrock.send(
            new PutModelInvocationLoggingConfigurationCommand({
              loggingConfig: {
                cloudWatchConfig: {
                  logGroupName: BEDROCK_LOG_GROUP_NAME,
                  roleArn: `${ArnPrefix.IAM}:${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}`,
                },
                textDataDeliveryEnabled: false,
                imageDataDeliveryEnabled: false,
                embeddingDataDeliveryEnabled: false,
              },
            }),
          );
          disableSp.stop(
            "Bedrock invocation text logging — DISABLED (metadata still flows; bodies no longer captured)",
          );
        } catch (err) {
          disableSp.stop("Failed to disable Bedrock invocation logging.");
          throw err;
        }

        clack.outro(
          "LLM prompt/response text logging is OFF. Re-run with --enable-llm-logging to opt back in.",
        );
        return;
      }

      // ── Dry-run path: print plan and exit without any AWS calls ─────
      // UX (M-T1): Each section is rendered as ONE multi-line clack.log.step
      // call so clack inserts only one `│` connector per section instead of
      // one between every line. A 14-line plan collapses from ~28 visible
      // rows to ~12.
      if (options.dryRun) {
        clack.log.info(
          "DRY RUN — no AWS APIs will be called. The following resources WOULD be created/updated:",
        );
        clack.log.step(
          "IAM Users:\n" +
            ROLES.map(
              (r) =>
                `  - ${r.userName} (managed policies: ${r.policies.map((p) => p.name).join(", ")}) — ${r.description}`,
            ).join("\n"),
        );
        clack.log.step(
          "IAM Managed Policies:\n" +
            ROLES.flatMap((r) =>
              r.policies.map(
                (p) => `  - ${p.name} (attached to user ${r.userName})`,
              ),
            ).join("\n"),
        );
        clack.log.step(
          "IAM Access Keys:\n" +
            ROLES.map(
              (r) =>
                `  - 1 access key per user, written to .env as ${r.envKeyId} / ${r.envSecretKey}`,
            ).join("\n"),
        );
        const textLogging = options.enableLlmLogging ? "true" : "false";
        clack.log.step(
          "Bedrock invocation logging infrastructure:\n" +
            `  - IAM role: ${BEDROCK_LOGGING_ROLE_NAME}\n` +
            `  - Inline policy: ${BEDROCK_LOGGING_POLICY_NAME} (logs:CreateLogGroup, CreateLogStream, PutLogEvents, DescribeLogGroups)\n` +
            `  - CloudWatch log group: ${BEDROCK_LOG_GROUP_NAME}\n` +
            `  - Bedrock model invocation logging configuration: textDataDeliveryEnabled=${textLogging}, imageDataDeliveryEnabled=false, embeddingDataDeliveryEnabled=false`,
        );
        if (options.enableLlmLogging) {
          clack.log.warn(
            "WARNING: --enable-llm-logging is set. If applied, ALL Bedrock prompts and responses will be written to CloudWatch Logs in plaintext.",
          );
        } else {
          clack.log.info(
            "LLM prompt/response text logging is OFF (safe default). Re-run with --enable-llm-logging to opt in.",
          );
        }
        clack.log.step(`Files written: .env (in ${process.cwd()})`);
        clack.outro("Dry run complete — no changes made.");
        return;
      }

      // ── Build credential provider ────────────────────────────────────
      // The setup command needs admin/root credentials which are typically in
      // ~/.aws/credentials, not in .env (which has the operator user).
      // Always use fromIni() to read from the AWS credentials file/config.
      // Use --profile to specify a non-default profile.
      const { fromIni } = await import("@aws-sdk/credential-providers");
      // L1 V1 audit (2026-04-06): honor process.env.AWS_PROFILE so users who
      // export AWS_PROFILE in their shell don't silently get the "default"
      // profile when they run `assignee setup` without --profile. Mirrors
      // standard AWS CLI behavior.
      const resolvedProfile =
        options.profile ?? process.env["AWS_PROFILE"] ?? "default";
      const clientConfig: {
        credentials: ReturnType<typeof fromIni>;
        region?: string;
      } = {
        credentials: fromIni({ profile: resolvedProfile }),
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
        const policyList = role.policies.map((p) => p.name).join(", ");
        clack.log.step(
          `  User: ${role.userName}\n  Policy: ${policyList}\n  Purpose: ${role.description}`,
        );
      }

      if (!options.yes) {
        const confirmed = await clack.confirm({
          message: "Proceed with IAM setup?",
          initialValue: true,
        });

        if (clack.isCancel(confirmed) || !confirmed) {
          clack.outro(UserMessage.SETUP_CANCELLED);
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
                clack.outro(UserMessage.SETUP_CANCELLED);
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

          // 2. Create + attach every policy in the role's `policies`
          // array. The operator role has 2 (core + services) due to
          // the A8 split; reader/auditor have 1 each. AWS allows up
          // to 10 managed policies per user so this is well within
          // bounds.
          for (const { name: policyName, fn: policyFn } of role.policies) {
            const policyDoc = policyFn();
            const policyArn = await ensurePolicy(
              iam,
              accountId,
              policyName,
              policyDoc,
            );

            // Tag policy idempotently
            await iam.send(
              new TagPolicyCommand({
                PolicyArn: policyArn,
                Tags: [MANAGED_TAG],
              }),
            );

            // Attach policy to user (idempotent — IAM tolerates
            // re-attaching an already-attached policy)
            await iam.send(
              new AttachUserPolicyCommand({
                UserName: role.userName,
                PolicyArn: policyArn,
              }),
            );
          }

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
        }> => r.status === PromiseStatus.FULFILLED,
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

      // Merge per-role env updates from successful roles
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

      // ── Operator role is REQUIRED — abort on failure ────────────────
      // All CLI commands need operator credentials. If the operator role
      // failed but reader/auditor succeeded, the .env file would be missing
      // the operator keys and every subsequent command would fail with an
      // opaque error. Fail loudly here instead.
      // @see SECURITY-AUDIT.md — M-S11
      const operatorSucceeded = succeeded.some(
        (s) => s.value.role.key === "operator",
      );
      if (!operatorSucceeded) {
        clack.log.error(
          "Operator role failed to provision. The operator user is REQUIRED " +
            "for every assignee command. Aborting setup without writing .env. " +
            "Inspect the IAM error above and re-run `assignee setup`.",
        );
        clack.outro("Setup aborted: operator role is required.");
        process.exit(1);
        return; // defensive: in tests, process.exit is mocked
      }

      // ── Bedrock invocation logging (Tasks 1–3 from aws-bootstrap.md) ──
      // Wrapped in try/finally so any throw during the setup block stops the
      // spinner cleanly instead of leaving the terminal stuck.
      // @see SECURITY-AUDIT.md — M-S10
      const region = AWS_REGION;
      const logSp = clack.spinner();
      logSp.start("Setting up Bedrock invocation logging...");
      let bedrockLoggingOk = false;
      try {
        // Task 1: Create IAM role for Bedrock logging
        try {
          await iam.send(
            new GetRoleCommand({ RoleName: BEDROCK_LOGGING_ROLE_NAME }),
          );
          clack.log.step(
            `Role ${BEDROCK_LOGGING_ROLE_NAME} — verified (already exists)`,
          );
        } catch (err: unknown) {
          if (
            err instanceof Error &&
            err.name === AwsErrorName.NO_SUCH_ENTITY
          ) {
            await iam.send(
              new CreateRoleCommand({
                RoleName: BEDROCK_LOGGING_ROLE_NAME,
                AssumeRolePolicyDocument: JSON.stringify({
                  Version: IamPolicy.VERSION,
                  Statement: [
                    {
                      Effect: IamEffect.ALLOW,
                      Principal: { Service: AwsServicePrincipal.BEDROCK },
                      Action: IamPolicy.ACTION_ASSUME_ROLE,
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
            PolicyName: BEDROCK_LOGGING_POLICY_NAME,
            PolicyDocument: JSON.stringify({
              Version: IamPolicy.VERSION,
              Statement: [
                {
                  Effect: IamEffect.ALLOW,
                  Action: [
                    IamAction.LOGS_CREATE_LOG_GROUP,
                    IamAction.LOGS_CREATE_LOG_STREAM,
                    IamAction.LOGS_PUT_LOG_EVENTS,
                    IamAction.LOGS_DESCRIBE_LOG_GROUPS,
                  ],
                  Resource: `${ArnPrefix.LOGS}${region}:${accountId}:log-group:${BEDROCK_LOG_GROUP_NAME}:*`,
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
              new CreateLogGroupCommand({
                logGroupName: BEDROCK_LOG_GROUP_NAME,
              }),
            );
            clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — created`);
          } catch (err: unknown) {
            if (
              err instanceof Error &&
              err.name === AwsErrorName.RESOURCE_ALREADY_EXISTS
            ) {
              clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — verified`);
            } else {
              throw err;
            }
          }
        }

        // Task 4: Enable Bedrock invocation logging
        // PRIVACY: textDataDeliveryEnabled defaults to FALSE. Only when the user
        // explicitly passes --enable-llm-logging do we send prompt/response text
        // to CloudWatch Logs. Metadata logging still flows so callers retain
        // invocation telemetry without bodies.
        {
          const {
            BedrockClient,
            PutModelInvocationLoggingConfigurationCommand,
          } = await import("@aws-sdk/client-bedrock");
          const bedrock = new BedrockClient({ ...clientConfig, region });
          const textLogging = options.enableLlmLogging === true;
          if (textLogging) {
            clack.log.warn(
              "⚠ All LLM prompts/responses will be logged to CloudWatch — " +
                `disable later via: aws bedrock put-model-invocation-logging-configuration ` +
                `--logging-config '{"cloudWatchConfig":{"logGroupName":"${BEDROCK_LOG_GROUP_NAME}","roleArn":"${ArnPrefix.IAM}:${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}"},"textDataDeliveryEnabled":false}'`,
            );
          }
          await bedrock.send(
            new PutModelInvocationLoggingConfigurationCommand({
              loggingConfig: {
                cloudWatchConfig: {
                  logGroupName: BEDROCK_LOG_GROUP_NAME,
                  roleArn: `${ArnPrefix.IAM}:${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}`,
                },
                textDataDeliveryEnabled: textLogging,
                imageDataDeliveryEnabled: false,
                embeddingDataDeliveryEnabled: false,
              },
            }),
          );
          clack.log.step(
            textLogging
              ? "Bedrock invocation logging — enabled (text bodies INCLUDED)"
              : "Bedrock invocation logging — enabled (metadata only, text bodies excluded)",
          );
        }

        bedrockLoggingOk = true;
      } finally {
        logSp.stop(
          bedrockLoggingOk
            ? "Bedrock logging IAM role and policy ready"
            : "Bedrock logging setup failed — see error above",
        );
      }

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
        const policyList = role.policies.map((p) => p.name).join(", ");
        clack.log.step(
          `  ${role.userName} → ${policyList} (env: ${role.envKeyId})`,
        );
      }

      clack.outro("Run `assignee plan` to verify the new credentials work.");
    },
  );
