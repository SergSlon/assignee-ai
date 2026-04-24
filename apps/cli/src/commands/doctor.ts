/**
 * `assignee doctor` command — non-destructive end-to-end health check.
 *
 * Verifies the critical preconditions for a successful `plan`/`apply`:
 *   1. AWS credentials for each of the 3 IAM roles (live STS GetCallerIdentity)
 *   2. Bedrock (or configured LLM provider) reachability with a tiny prompt
 *   3. MCP server launchability (pricing, docs, IAM, well-architected, billing)
 *   4. Local cache health (~/.assignee size, oldest checkpoint, log file count)
 *   5. Project configuration file presence + validity
 *   6. Best-practices manifest integrity (SHA-256 hash match)
 *   7. (Optional) Per-node LLM routing table when configured
 *
 * Exit codes (see docs/troubleshooting.md):
 *   0 — all green
 *   1 — at least one hard failure (✗)
 *   2 — only warnings (!)
 *
 * Doctor MUST NOT mutate any state — every check is read-only. Each
 * check has a 5-second timeout so the whole command stays under the
 * 10s budget even on slow connections (constraint #6 in the spec).
 *
 * Implementation lives under `./doctor/` (Wave-6b F1 SOLID refactor):
 *   - `doctor/types.ts`           — DoctorCheck / DoctorReport interfaces
 *   - `doctor/util.ts`            — withTimeout, rollup, formatting helpers
 *   - `doctor/runner.ts`          — orchestrator; runs checks + composes report
 *   - `doctor/formatter.ts`       — text rendering + exit code mapping
 *   - `doctor/checks/<name>.ts`   — one file per diagnostic
 *
 * This entrypoint is intentionally thin: parse CLI options, call
 * `runDoctor`, emit JSON or text, set the exit code. Adding a new
 * check requires editing only `runner.ts` + a new `checks/<name>.ts` —
 * no edits to existing checks (OCP).
 *
 * Story 50-3: added `--short` for fast whoami-style identity summary
 * (replaces the removed `whoami` command). Removed `--skip-mcp-version-check`
 * (PyPI drift check removed along with the service).
 *
 * @see Sally UX audit — "doctor / whoami diagnostics"
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { Command } from "commander";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import {
  tryAssigneeCredentials,
  DEFAULT_AWS_REGION,
  type ExplicitAwsCredentials,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import { EnvVar } from "../constants/env-vars.js";
import { STS_TIMEOUT_MS } from "../config/constants/timeouts.js";
import { renderReport, runDoctor } from "./doctor/index.js";
import { installJsonStderrFilter } from "./json-stderr-filter.js";
import { resolveJsonMode } from "./output-format.js";

// Re-export the public surface so existing imports
// (`from "./doctor.js"`) keep working — primarily used by
// `doctor.test.ts` which exercises every check directly.
export {
  DEFAULT_CHECK_TIMEOUT_MS,
  type CheckStatus,
  type DoctorSubCheck,
  type DoctorSection,
  type DoctorReport,
  type CheckContext,
  type DoctorCheck,
  checkCredentials,
  type CredentialsCheckDeps,
  checkBedrock,
  type BedrockCheckDeps,
  checkMcpServers,
  type McpCheckDeps,
  checkCache,
  type CacheCheckDeps,
  checkConfig,
  type ConfigCheckDeps,
  checkBestPractices,
  type BpCheckDeps,
  runDoctor,
  type RunDoctorDeps,
  renderReport,
  renderSection,
  buildSummary,
  statusToExit,
} from "./doctor/index.js";

/** Read the CLI version from `apps/cli/package.json` (best-effort). */
function readPackageVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
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

/** Options threaded into the short doctor (identity-only) flow. */
export interface ShortDoctorDeps {
  stsClientFactory?: (
    creds: ExplicitAwsCredentials,
    region: string,
  ) => {
    send: (cmd: GetCallerIdentityCommand) => Promise<{
      Account?: string;
      Arn?: string;
    }>;
  };
  cwd?: () => string;
  stdout?: (msg: string) => void;
  stderr?: (msg: string) => void;
}

/**
 * `doctor --short` — single-STS-call identity summary. Exported for
 * direct unit testing. Returns the exit code the caller should set.
 *
 * This subsumes the functionality of the removed `assignee whoami`
 * command (Story 50-3).
 */
export async function runShortDoctor(
  deps: ShortDoctorDeps = {},
): Promise<number> {
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
  // Capture the timer handle so we can clear it on success — otherwise
  // the Node event loop stays alive for the full STS_TIMEOUT_MS window.
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

export const doctorCommand = new Command(CommandName.DOCTOR)
  .description(CommandDescription.DOCTOR)
  // Epic 98 e98.W5.N3 (B-07 / D-16): uniform `--json` + `-o, --output
  // <format>` across every command.
  .option("-o, --output <format>", "Output format (json|text)", "text")
  .option("--json", "Shorthand for --output json")
  .option("--skip-bedrock", "Skip the Bedrock LLM invoke check")
  .option("--skip-mcp", "Skip the MCP server launch probe")
  .option(
    "--short",
    "Fast identity-only summary: STS account + ARN + region + active config (replaces the removed `whoami` command)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee doctor
        Run every pre-flight check (credentials, region, Bedrock, MCP probes)
  $ assignee doctor --short
        Fast whoami-style identity summary (one STS call, no MCP probes)
  $ assignee doctor --json > report.json
        Emit a structured report (useful for CI and bug reports)
  $ assignee doctor --skip-bedrock --skip-mcp
        Fast offline check: credentials + config only

doctor is read-only — it never mutates AWS state, so no --yes is needed.
`,
  )
  .action(
    async (opts: {
      json?: boolean;
      output?: string;
      skipBedrock?: boolean;
      skipMcp?: boolean;
      short?: boolean;
    }) => {
      // Epic 98 e98.W5.N3: normalise `--json` + `--output json` and
      // install the stderr filter for the duration of the command.
      const jsonMode = resolveJsonMode(opts);
      opts.json = jsonMode || opts.json;
      const stderrFilter = installJsonStderrFilter(jsonMode);
      try {
        if (opts.short) {
          const code = await runShortDoctor();
          if (code !== ProcessExitCode.SUCCESS) {
            process.exitCode = code;
          }
          return;
        }

        const report = await runDoctor({
          version: readPackageVersion(),
          ...(opts.skipBedrock ? { skipBedrock: true } : {}),
          ...(opts.skipMcp ? { skipMcp: true } : {}),
        });

        if (opts.json) {
          process.stdout.write(
            JSON.stringify({ ok: true, ...report }, null, 2) + "\n",
          );
        } else {
          process.stdout.write(renderReport(report));
        }

        if (report.exitCode !== ProcessExitCode.SUCCESS) {
          process.exitCode = report.exitCode;
        }
      } finally {
        stderrFilter.restore();
      }
    },
  );
