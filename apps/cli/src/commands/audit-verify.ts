/**
 * W3-01 (Epic 100 Round 5) — `assignee audit-verify` command.
 *
 * Walks the local audit-log HMAC chain and reports whether it is intact.
 * Exits 0 on a clean chain; exits non-zero with diagnostics on a broken
 * chain or when the log file does not exist.
 *
 * Usage:
 *   assignee audit-verify [--from <date>] [--to <date>] [--log-file <path>]
 *
 * Options:
 *   --from <date>     Skip entries whose timestamp is before this ISO date.
 *                     (Planned for Epic 101; today the full chain is verified.)
 *   --to <date>       Skip entries whose timestamp is after this ISO date.
 *                     (Planned for Epic 101; today the full chain is verified.)
 *   --log-file <path> Override the default audit log file path.
 *
 * Remote sink verification (KMS-signed S3 object-lock) defers to Epic 101.
 */

import { Command } from "commander";
import * as fs from "node:fs";
import { verifyAuditLog } from "@assignee/core/audit";
import { DEFAULT_AUDIT_LOG_FILE } from "@assignee/core/audit";

// ── Command ────────────────────────────────────────────────────────────

export interface AuditVerifyOptions {
  from?: string;
  to?: string;
  logFile?: string;
  json?: boolean;
}

export const auditVerifyCommand = new Command("audit-verify")
  .description(
    "Verify the HMAC chain integrity of the local audit log (W3-01). " +
      "Exits 0 on a clean chain; non-zero with diagnostics when the chain is broken.",
  )
  .option(
    "--from <date>",
    "Start date for verification range (ISO 8601). Scaffold: full chain always verified; range filtering is Epic 101.",
  )
  .option(
    "--to <date>",
    "End date for verification range (ISO 8601). Scaffold: full chain always verified; range filtering is Epic 101.",
  )
  .option(
    "--log-file <path>",
    `Audit log file path (default: ${DEFAULT_AUDIT_LOG_FILE})`,
  )
  .option(
    "--json",
    "Emit machine-readable JSON to stdout instead of human-readable text",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee audit-verify
        Verify the full audit log HMAC chain.
  $ assignee audit-verify --log-file /path/to/audit.log
        Verify a specific audit log file.

Note: --from / --to date filtering defers to Epic 101 (identity-squad hire).
The current implementation always walks the full chain.
`,
  )
  .action(async (opts: AuditVerifyOptions) => {
    const logFile = opts.logFile ?? DEFAULT_AUDIT_LOG_FILE;

    // Warn if --from or --to were supplied (scaffold: not yet filtering).
    // In --json mode the warning still goes to stderr (not suppressed) so
    // scripts know range filtering is a no-op.
    if (opts.from !== undefined || opts.to !== undefined) {
      process.stderr.write(
        "[audit-verify] Note: --from / --to date filtering is not yet implemented " +
          "(Epic 101 follow-on); the full chain will be verified.\n",
      );
    }

    // Fail fast when the log file does not exist: an absent audit log is an
    // error condition (not a valid empty chain), so report it before calling
    // verifyAuditLog (which silently returns ok:true on a missing file).
    if (!fs.existsSync(logFile)) {
      const message = `Audit log not found at "${logFile}". Run \`assignee audit-log\` to create it.`;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ valid: false, entries: 0, error: message }) + "\n",
        );
      } else {
        process.stderr.write(`[audit-verify] ${message}\n`);
      }
      process.exit(1);
      return;
    }

    let result: Awaited<ReturnType<typeof verifyAuditLog>>;
    try {
      result = await verifyAuditLog(logFile);
    } catch (err) {
      const message =
        `Failed to read audit log at "${logFile}": ` +
        `${err instanceof Error ? err.message : String(err)}`;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({ valid: false, entries: 0, error: message }) + "\n",
        );
      } else {
        process.stderr.write(`[audit-verify] ${message}\n`);
      }
      process.exit(1);
      return;
    }

    if (result.ok) {
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            valid: true,
            entries: result.total,
            chainMode: result.chainMode,
          }) + "\n",
        );
      } else {
        process.stdout.write(
          `[audit-verify] Chain OK — ${result.total} HMAC-bearing record(s) verified` +
            (result.legacyCount > 0
              ? `, ${result.legacyCount} pre-HMAC legacy record(s) skipped`
              : "") +
            ".\n",
        );
        process.stdout.write(`Chain mode: ${result.chainMode}\n`);
      }

      // Emit migration hint when chain has legacy or mixed HMAC entries.
      // Goes to stderr so JSON-mode stdout consumers are unaffected.
      if (result.chainMode !== "canonical") {
        process.stderr.write(
          `[audit-verify] Warning: ${result.legacyCount} of ${result.total} entries verified via ${result.chainMode} HMAC. ` +
            `Run \`scripts/audit-migrate-legacy-chain.ts --input <logfile>\` to re-sign with canonical HMAC.\n`,
        );
      }

      process.exit(0);
    } else {
      const reason =
        `Chain BROKEN at record index ${result.brokenAt}: ${result.reason}. ` +
        `${result.total} record(s) checked, ${result.legacyCount} legacy record(s) skipped.`;
      if (opts.json) {
        process.stdout.write(
          JSON.stringify({
            valid: false,
            entries: result.total,
            error: reason,
          }) + "\n",
        );
      } else {
        process.stderr.write(`[audit-verify] ${reason}\n`);
      }
      process.exit(1);
    }
  });
