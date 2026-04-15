/**
 * Admin credential provider + STS verification for `assignee setup`.
 *
 * The setup command needs admin/root credentials — typically in
 * ~/.aws/credentials, NOT in .env (which holds the operator user).
 * Always use fromIni() to read from the AWS credentials file/config.
 *
 * Honors process.env.AWS_PROFILE so users who export AWS_PROFILE in
 * their shell don't silently get the "default" profile when they run
 * `assignee setup` without --profile. Mirrors AWS CLI behavior.
 */

import * as clack from "@clack/prompts";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import type { fromIni } from "@aws-sdk/credential-providers";
import { ConfigurationError } from "@assignee/core";

export interface AdminClientConfig {
  credentials: ReturnType<typeof fromIni>;
  region?: string;
}

export async function buildAdminClientConfig(
  profileOpt: string | undefined,
): Promise<{
  clientConfig: AdminClientConfig;
  resolvedProfile: string;
}> {
  const { fromIni } = await import("@aws-sdk/credential-providers");
  const resolvedProfile = profileOpt ?? process.env["AWS_PROFILE"] ?? "default";
  const clientConfig: AdminClientConfig = {
    credentials: fromIni({ profile: resolvedProfile }),
  };
  return { clientConfig, resolvedProfile };
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
    const hint =
      opts.contextHint === "full-setup"
        ? "Cannot reach AWS STS. Ensure you have admin/root credentials configured.\n" +
          "Tip: Use --profile <name> to specify an AWS CLI profile with admin access.\n"
        : "Cannot reach AWS STS. Ensure you have admin credentials configured.\n";
    throw new ConfigurationError(
      hint + `Error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
