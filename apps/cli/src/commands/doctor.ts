/**
 * `assignee doctor` command — non-destructive end-to-end health check.
 *
 * Verifies the critical preconditions for a successful `plan`/`apply`:
 *   1. AWS credentials for each of the 3 IAM roles (live STS GetCallerIdentity)
 *   2. Bedrock (or configured LLM provider) reachability with a tiny prompt
 *   3. MCP server launchability (pricing, docs, IAM, well-architected, billing)
 *   3b. MCP package version drift vs PyPI (informational)
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
 * @see Sally UX audit — "doctor / whoami diagnostics"
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { ProcessExitCode } from "../constants/errors.js";
import { renderReport, runDoctor } from "./doctor/index.js";

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
  checkMcpVersionDrift,
  type McpVersionCheckDeps,
  checkCache,
  type CacheCheckDeps,
  checkConfig,
  type ConfigCheckDeps,
  checkBestPractices,
  type BpCheckDeps,
  checkLlmRouting,
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

export const doctorCommand = new Command(CommandName.DOCTOR)
  .description(CommandDescription.DOCTOR)
  .option("--json", "Emit the report as JSON instead of formatted text")
  .option("--skip-bedrock", "Skip the Bedrock LLM invoke check")
  .option("--skip-mcp", "Skip the MCP server launch probe")
  .option(
    "--skip-mcp-version-check",
    "Skip the PyPI version drift check (offline / fast path)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee doctor
        Run every pre-flight check (credentials, region, Bedrock, MCP probes)
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
      skipBedrock?: boolean;
      skipMcp?: boolean;
      skipMcpVersionCheck?: boolean;
    }) => {
      const report = await runDoctor({
        version: readPackageVersion(),
        ...(opts.skipBedrock ? { skipBedrock: true } : {}),
        ...(opts.skipMcp ? { skipMcp: true } : {}),
        ...(opts.skipMcpVersionCheck ? { skipMcpVersionCheck: true } : {}),
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      } else {
        process.stdout.write(renderReport(report));
      }

      if (report.exitCode !== ProcessExitCode.SUCCESS) {
        process.exitCode = report.exitCode;
      }
    },
  );
