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
  type ResolvedGlobalConfig,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { EnvVar } from "../constants/env-vars.js";
import { ProcessExitCode } from "../constants/errors.js";
import { loadGlobalConfig } from "../config/load-global-config.js";
import { loadUserConfig } from "../config/user-config-loader.js";
import { STS_TIMEOUT_MS } from "../config/constants/timeouts.js";

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
  /**
   * A2 follow-up (2026-04-08): inject the global config loader so unit
   * tests don't need to touch the real filesystem or env vars. Defaults
   * to the production `loadGlobalConfig(loadUserConfig())` composition.
   */
  loadResolvedConfig?: () => Promise<ResolvedGlobalConfig | undefined>;
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
  // EX-7 regression fix: capture the timer handle so we can clear it on
  // success. Without the clearTimeout the Node event loop stays alive for
  // the full STS_TIMEOUT_MS window after the call resolves, making whoami
  // feel like the slowest command in the CLI instead of the fastest.
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`STS call timed out after ${STS_TIMEOUT_MS}ms`)),
        STS_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([
      client.send(new GetCallerIdentityCommand({})),
      timeoutPromise,
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
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }

  if (!account || !arn) {
    stderr(
      "STS GetCallerIdentity returned an empty response. Cannot determine identity.\n",
    );
    return ProcessExitCode.GENERIC_ERROR;
  }

  const configPath = findProjectConfig(cwd());
  const configLine = configPath ? `${configPath} (loaded)` : "(none in cwd)";

  // A2 follow-up (2026-04-08): surface the resolved global preferences
  // so operators can verify ASSIGNEE_* env vars / project YAML / user
  // YAML are actually taking effect. Silent fallback — if the loader
  // throws for any reason, we just skip the block and still show the
  // identity info (never let preference resolution break whoami).
  const loadResolved =
    deps.loadResolvedConfig ??
    (async () => {
      try {
        const userConfig = await loadUserConfig();
        return await loadGlobalConfig(userConfig);
      } catch {
        return undefined;
      }
    });
  const resolvedConfig = await loadResolved();

  const lines = [
    `Account:  ${account}`,
    `User ARN: ${arn}`,
    `Region:   ${region}`,
    `Role:     operator (${EnvVar.OPERATOR_ACCESS_KEY})`,
    `Config:   ${configLine}`,
  ];

  if (resolvedConfig) {
    const prefs = resolvedConfig.preferences;
    const defaultRegion = resolvedConfig.defaults?.region;
    lines.push(
      "",
      "Resolved global preferences (flag > env > project > user > defaults):",
      `  auto_fix:      ${prefs.auto_fix}`,
      `  output_format: ${prefs.output_format}`,
      `  verbosity:     ${prefs.verbosity}`,
    );
    if (defaultRegion) {
      lines.push(`  defaults.region: ${defaultRegion}`);
    }
  }

  lines.push("", "For full diagnostics, run `assignee doctor`.", "");
  stdout(lines.join("\n"));
  return ProcessExitCode.SUCCESS;
}

export const whoamiCommand = new Command(CommandName.WHOAMI)
  .description(CommandDescription.WHOAMI)
  .addHelpText(
    "after",
    `
Examples:
  $ assignee whoami
        Show resolved AWS identity (account, region, profile) and
        which credential path assignee is using

whoami is read-only — it only calls STS GetCallerIdentity. No --yes
flag is required.
`,
  )
  .action(async () => {
    const code = await runWhoami();
    if (code !== ProcessExitCode.SUCCESS) {
      process.exitCode = code;
    }
  });
