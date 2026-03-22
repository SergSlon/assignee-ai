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
  CreatePolicyCommand,
  CreatePolicyVersionCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  ListPolicyVersionsCommand,
  DeletePolicyVersionCommand,
  DeleteAccessKeyCommand,
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
import { ProcessExitCode } from "../constants/errors.js";
import { mergeEnvFile } from "../utils/env-writer.js";

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
          Tags: [{ Key: "managed-by", Value: "assignee-ai" }],
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
      clack.log.error(
        "Cannot reach AWS STS. Ensure you have admin/root credentials configured.\n" +
          "Tip: Use --profile <name> to specify an AWS CLI profile with admin access.\n" +
          `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(ProcessExitCode.GENERIC_ERROR);
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

    // ── Create/update users, policies, and access keys ───────────────
    for (const role of ROLES) {
      const sp = clack.spinner();

      // 1. Create or verify user
      sp.start(`Creating user ${role.userName}...`);
      const isNew = await ensureUser(iam, role.userName);
      sp.stop(
        isNew
          ? `Created user ${role.userName}`
          : `User ${role.userName} already exists`,
      );

      // 2. Create or update policy
      sp.start(`Creating policy ${role.policyName}...`);
      const policyDoc = role.policyFn();
      const policyArn = await ensurePolicy(
        iam,
        accountId,
        role.policyName,
        policyDoc,
      );
      sp.stop(`Policy ${role.policyName} ready (${policyArn})`);

      // 3. Attach policy to user
      sp.start(`Attaching policy to ${role.userName}...`);
      await iam.send(
        new AttachUserPolicyCommand({
          UserName: role.userName,
          PolicyArn: policyArn,
        }),
      );
      sp.stop(`Policy attached to ${role.userName}`);

      // 4. Handle access keys
      let shouldCreateKey = isNew;
      if (!isNew) {
        // Check for existing keys
        const existingKeys = await iam.send(
          new ListAccessKeysCommand({ UserName: role.userName }),
        );
        const hasKeys = (existingKeys.AccessKeyMetadata ?? []).length > 0;

        if (hasKeys) {
          let rotate: boolean | symbol = false;
          if (options.yes) {
            // With --yes, skip rotation (keep existing keys)
            rotate = false;
          } else {
            rotate = await clack.confirm({
              message: `User ${role.userName} already has access keys. Rotate them?`,
              initialValue: false,
            });

            if (clack.isCancel(rotate)) {
              clack.outro("Setup cancelled.");
              return;
            }
          }

          shouldCreateKey = !!rotate;
          if (rotate) {
            sp.start(`Rotating access keys for ${role.userName}...`);
            const keys = await ensureAccessKey(iam, role.userName, true);
            envUpdates[role.envKeyId] = keys.accessKeyId;
            envUpdates[role.envSecretKey] = keys.secretAccessKey;
            sp.stop(`Access keys rotated for ${role.userName}`);
          }
        } else {
          shouldCreateKey = true;
        }
      }

      if (shouldCreateKey && !envUpdates[role.envKeyId]) {
        sp.start(`Creating access keys for ${role.userName}...`);
        const keys = await ensureAccessKey(iam, role.userName, false);
        envUpdates[role.envKeyId] = keys.accessKeyId;
        envUpdates[role.envSecretKey] = keys.secretAccessKey;
        sp.stop(`Access keys created for ${role.userName}`);
      }
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
      clack.log.step(
        `  ${role.userName} → ${role.policyName} (env: ${role.envKeyId})`,
      );
    }

    clack.outro("Run `assignee plan` to verify the new credentials work.");
  });
