/**
 * `assignee whoami` command — fast, single-purpose identity check.
 *
 * Resolves the operator role STS identity (account, ARN), the active region,
 * and whether a project config file is loaded. Designed to answer the most
 * common debugging question: "Which AWS identity am I about to use?"
 *
 * Exits non-zero when the operator credentials are missing so it can be
 * chained safely in shell pipelines (`assignee whoami && assignee plan ...`).
 *
 * @see Sally UX audit — "doctor / whoami diagnostics"
 */

import { Command } from "commander";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  tryAssigneeCredentials,
  DEFAULT_AWS_REGION,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { EnvVar } from "../constants/env-vars.js";
import { ProcessExitCode } from "../constants/errors.js";

/** Per-call STS deadline. Doctor's <10s budget => 5s per check. */
const STS_TIMEOUT_MS = 5000;

/** Internal injection seam — tests override these to mock the STS client. */
export interface WhoamiDeps {
  stsClientFactory?: (
    creds: ExplicitAwsCredentials,
    region: string,
  ) => {
    send: (cmd: GetCallerIdentityCommand) => Promise<{
      Account?: string;
      Arn?: string;
      UserId?: string;
    }>;
  };
  cwd?: () => string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
  exit?: (code: number) => void;
}

/** Resolve the active AWS region from env (matches the rest of the CLI). */
function resolveRegion(): string {
  return (
    process.env[EnvVar.AWS_REGION] ??
    process.env[EnvVar.AWS_DEFAULT_REGION] ??
    DEFAULT_AWS_REGION
  );
}

/**
 * Locate `assignee.yaml` (or `.assignee/config.yaml`) in the cwd.
 * Returns the relative path or undefined.
 */
function findProjectConfig(cwd: string): string | undefined {
  const candidates = [
    "assignee.yaml",
    "assignee.yml",
    join(".assignee", "config.yaml"),
  ];
  for (const candidate of candidates) {
    const abs = join(cwd, candidate);
    if (existsSync(abs)) return `./${candidate}`;
  }
  return undefined;
}

/**
 * Run the whoami flow with injected dependencies. Exported for direct
 * unit testing without going through commander parseAsync.
 */
export async function runWhoami(deps: WhoamiDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? ((m: string) => process.stdout.write(m));
  const stderr = deps.stderr ?? ((m: string) => process.stderr.write(m));
  const cwd = deps.cwd ?? (() => process.cwd());

  const creds = tryAssigneeCredentials("operator");
  if (!creds) {
    stderr(
      "No AWS credentials configured.\n" +
        "Run `assignee setup` to create least-privilege IAM users, or set\n" +
        `${EnvVar.OPERATOR_ACCESS_KEY} + ${EnvVar.OPERATOR_SECRET_KEY}.\n`,
    );
    return ProcessExitCode.GENERIC_ERROR;
  }

  const region = resolveRegion();
  const factory =
    deps.stsClientFactory ??
    ((c: ExplicitAwsCredentials, r: string) =>
      new STSClient({
        region: r,
        credentials: {
          accessKeyId: c.accessKeyId,
          secretAccessKey: c.secretAccessKey,
          ...(c.sessionToken ? { sessionToken: c.sessionToken } : {}),
        },
      }));

  const client = factory(creds, region);

  let account: string | undefined;
  let arn: string | undefined;
  try {
    const result = await Promise.race([
      client.send(new GetCallerIdentityCommand({})),
      new Promise<never>((_, reject) =>
        setTimeout(
          () =>
            reject(new Error(`STS call timed out after ${STS_TIMEOUT_MS}ms`)),
          STS_TIMEOUT_MS,
        ),
      ),
    ]);
    account = result.Account;
    arn = result.Arn;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const name =
      err instanceof Error && err.name && err.name !== "Error"
        ? `${err.name}: `
        : "";
    stderr(
      `Failed to verify AWS identity via STS: ${name}${message}\n` +
        "Check your credentials, network connection, and IAM permissions (sts:GetCallerIdentity).\n",
    );
    return ProcessExitCode.GENERIC_ERROR;
  }

  if (!account || !arn) {
    stderr(
      "STS GetCallerIdentity returned an empty response. Cannot determine identity.\n",
    );
    return ProcessExitCode.GENERIC_ERROR;
  }

  const configPath = findProjectConfig(cwd());
  const configLine = configPath ? `${configPath} (loaded)` : "(none in cwd)";

  const lines = [
    `Account:  ${account}`,
    `User ARN: ${arn}`,
    `Region:   ${region}`,
    `Role:     operator (${EnvVar.OPERATOR_ACCESS_KEY})`,
    `Config:   ${configLine}`,
    "",
    "For full diagnostics, run `assignee doctor`.",
    "",
  ];
  stdout(lines.join("\n"));
  return ProcessExitCode.SUCCESS;
}

export const whoamiCommand = new Command(CommandName.WHOAMI)
  .description(CommandDescription.WHOAMI)
  .action(async () => {
    const code = await runWhoami();
    if (code !== ProcessExitCode.SUCCESS) {
      process.exitCode = code;
    }
  });
