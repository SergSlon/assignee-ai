/**
 * Admin credential provider + STS verification for `assignee dev setup`.
 *
 * The setup command needs admin/root credentials — typically in
 * ~/.aws/credentials or via `aws sso login` / `aws login` (AWS Identity
 * Center same-device). NOT in .env (which holds the operator user).
 *
 * Honors process.env.AWS_PROFILE so users who export AWS_PROFILE in their
 * shell don't silently get the "default" profile when they run
 * `assignee dev setup` without --profile. Mirrors AWS CLI behavior.
 *
 * Resolution order: SDK provider chain (env vars, SSO, ini, IMDS) → if
 * empty/incomplete or STS rejects, fall back to shelling out to
 * `aws configure export-credentials` (the AWS CLI understands modern auth
 * formats like `login_session` that the Node SDK does not).
 */

import * as clack from "@clack/prompts";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { execFileSync } from "node:child_process";
import { ConfigurationError } from "@assignee/core";

export interface AdminClientConfig {
  credentials: ReturnType<typeof fromNodeProviderChain>;
  region?: string;
}

interface AwsCliExportedCredentials {
  AccessKeyId: string;
  SecretAccessKey: string;
  SessionToken?: string;
  Expiration?: string;
  Version: number;
}

/**
 * Shells out to `aws configure export-credentials --profile <p> --format process-credential-provider`
 * and returns the resolved credentials. Used as a fallback when the SDK
 * provider chain returns empty creds for AWS CLI–only auth formats
 * (login_session, sso_session with new shape, etc.).
 */
function exportCredentialsViaCli(profile: string): {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
} | null {
  // Try modern JSON format first; fall back to env-no-export (key=value lines)
  // for older AWS CLIs that don't have the process-credential-provider format.
  for (const format of [
    "process-credential-provider",
    "env-no-export",
  ] as const) {
    try {
      const out = execFileSync(
        "aws",
        [
          "configure",
          "export-credentials",
          "--profile",
          profile,
          "--format",
          format,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      if (format === "process-credential-provider") {
        const parsed: AwsCliExportedCredentials = JSON.parse(out);
        return {
          accessKeyId: parsed.AccessKeyId,
          secretAccessKey: parsed.SecretAccessKey,
          ...(parsed.SessionToken ? { sessionToken: parsed.SessionToken } : {}),
        };
      }
      // env-no-export: parse `KEY=value\n` lines.
      const env: Record<string, string> = {};
      for (const line of out.split("\n")) {
        const eq = line.indexOf("=");
        if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
      }
      const ak = env["AWS_ACCESS_KEY_ID"];
      const sk = env["AWS_SECRET_ACCESS_KEY"];
      if (ak && sk) {
        return {
          accessKeyId: ak,
          secretAccessKey: sk,
          ...(env["AWS_SESSION_TOKEN"]
            ? { sessionToken: env["AWS_SESSION_TOKEN"] }
            : {}),
        };
      }
    } catch {
      // try next format
    }
  }
  return null;
}

export async function buildAdminClientConfig(
  profileOpt: string | undefined,
): Promise<{
  clientConfig: AdminClientConfig;
  resolvedProfile: string;
}> {
  const { fromNodeProviderChain } =
    await import("@aws-sdk/credential-providers");
  const resolvedProfile = profileOpt ?? process.env["AWS_PROFILE"] ?? "default";
  const sdkProvider = fromNodeProviderChain({ profile: resolvedProfile });
  // Prefer the AWS CLI's resolved creds over the Node SDK chain. The CLI
  // understands modern auth formats (login_session, AWS Identity Center
  // same-device login) that the Node SDK does not. Falling back to the SDK
  // chain only when the CLI is missing or fails — covers CI runners that
  // don't ship an `aws` binary.
  const credentials = async () => {
    const fromCli = exportCredentialsViaCli(resolvedProfile);
    if (fromCli) return fromCli;
    try {
      const c = await sdkProvider();
      if (c?.accessKeyId && c?.secretAccessKey) return c;
    } catch {
      // fall through to error
    }
    throw new ConfigurationError(
      `No AWS credentials found for profile "${resolvedProfile}".\n` +
        "Tried: `aws configure export-credentials` and SDK provider chain (env vars, SSO, ini).\n" +
        "Hint: run `aws login` / `aws sso login` first, or set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY in your shell.",
    );
  };
  return {
    clientConfig: { credentials },
    resolvedProfile,
  };
}

/**
 * Verifies admin credentials with STS GetCallerIdentity and returns the
 * account id. Throws ConfigurationError with an actionable hint on
 * failure.
 */
export async function verifyAdminCredentials(
  clientConfig: AdminClientConfig,
  opts: { contextHint: "full-setup" | "disable-only" } = {
    contextHint: "full-setup",
  },
): Promise<string> {
  const s = clack.spinner();
  s.start("Verifying AWS credentials...");
  try {
    const sts = new STSClient(clientConfig);
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    const accountId = identity.Account!;
    s.stop(`Authenticated as ${identity.Arn} (account: ${accountId})`);
    return accountId;
  } catch (err) {
    s.stop("Failed to verify AWS credentials.");
    const errMsg = err instanceof Error ? err.message : String(err);
    // Recognise the SDK XML-parser death that fires when the credential
    // chain returned empty/garbage creds and AWS responded with HTML.
    const isParserDeath =
      errMsg.includes("EntityReplacer") || errMsg.includes("#xD");
    const hint =
      opts.contextHint === "full-setup"
        ? "Cannot reach AWS STS. Ensure you have admin/root credentials configured.\n" +
          "Tip: Use --profile <name> to specify an AWS CLI profile with admin access.\n" +
          (isParserDeath
            ? "This usually means your default AWS profile uses an auth format the\n" +
              "Node SDK can't read (e.g. AWS Identity Center same-device login).\n" +
              "Try: `aws configure export-credentials --format env-no-export` and paste\n" +
              "the AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN values\n" +
              "into your shell before re-running.\n"
            : "")
        : "Cannot reach AWS STS. Ensure you have admin credentials configured.\n";
    throw new ConfigurationError(hint + `Error: ${errMsg}`);
  }
}
