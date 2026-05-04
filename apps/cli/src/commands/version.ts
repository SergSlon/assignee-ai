/**
 * `assignee version` command — richer version + environment info.
 *
 * Distinct from the built-in `--version` flag: this subcommand also prints
 * Node.js version, platform/arch, and the pinned MCP server versions.
 * Those MCP pins matter for bug reports because each server carries its
 * own feature set — an issue against the pricing or documentation server
 * is much easier to triage with the exact version stamp.
 *
 * Registered via `program.addCommand(versionCommand)` so it participates
 * in the shared Commander tree walked by `scripts/generate-completions.ts`
 * and by `completions.ts`. Previously the command was inlined in
 * `src/index.ts` and the completion-generator had to re-declare a stub
 * copy; exposing it as a standalone module closes that drift gap
 * (Epic 58-it1-03, closes `it57-1-L3-L1`).
 */

import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { detectAwsConfigDefaultRegion } from "@assignee/core";
import { DEFAULT_AUDIT_KEY_FILE } from "@assignee/core/audit";

/**
 * Resolve the CLI version from `apps/cli/package.json`.
 *
 * Matches the lookup used by the root `program.version(pkg.version)` call
 * in `src/index.ts`, so `assignee --version` and `assignee version` can
 * never drift apart.
 *
 * Epic 61-it1-01 (L3-001): when the package.json read/parse fails (damaged
 * install, partial extract, permission issue) we now emit a stderr warning
 * before returning the "0.0.0" fallback. Silent fallback used to leave
 * operators with "version 0.0.0" in bug reports and no hint that the npm
 * package itself was damaged; the warning makes the degraded state visible
 * and points them at the remediation (reinstall / verify the package).
 */
export function readPackageVersion(): string {
  try {
    const pkgPath = resolve(import.meta.dirname, "..", "..", "package.json");
    const raw = readFileSync(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "0.0.0";
  } catch {
    console.warn(
      "assignee: package.json version unreadable; reporting 0.0.0. Reinstall or verify the npm package is intact.",
    );
    return "0.0.0";
  }
}

/**
 * Shape of the `MCP_PINS` record we depend on for the pinned-servers block.
 * Keeping it local to this module avoids a top-level static import so the
 * version command can still run when the MCP-server config module fails to
 * load (corrupt install, partial extract, permission issue).
 *
 * Epic 65-it1-01 (L3-001 MED): the dynamic `import("../config/mcp-servers.js")`
 * call in the action handler is now wrapped in try/catch. On failure we warn
 * the operator and substitute an empty pins record so `assignee version`
 * still prints CLI version + Node + platform — the exact triage info a bug
 * report needs when the MCP server wiring itself is broken.
 */
type McpPinsRecord = {
  AWS_PRICING: string;
  AWS_DOCUMENTATION: string;
  AWS_IAM: string;
  AWS_WA_SECURITY: string;
  AWS_COST_MANAGEMENT: string;
};

/**
 * All-empty fallback used when `import("../config/mcp-servers.js")` throws.
 * Every pin renders as an empty string so the "Pinned MCP servers:" block
 * still appears (five labelled rows) but the version column is blank —
 * the adjacent `console.warn` gives the operator the "why".
 */
const EMPTY_MCP_PINS: McpPinsRecord = {
  AWS_PRICING: "",
  AWS_DOCUMENTATION: "",
  AWS_IAM: "",
  AWS_WA_SECURITY: "",
  AWS_COST_MANAGEMENT: "",
};

/**
 * Dynamically load `MCP_PINS`. On any failure emit an operator-visible
 * warning and return {@link EMPTY_MCP_PINS} so the rest of the version
 * output still completes. Exported so the Epic 65-it1-01 unit test can
 * exercise the catch branch directly without spawning a subprocess.
 */
export async function loadMcpPinsOrFallback(): Promise<McpPinsRecord> {
  try {
    const mod = await import("../config/mcp-servers.js");
    return mod.MCP_PINS as McpPinsRecord;
  } catch {
    console.warn(
      "assignee: MCP_PINS unavailable; reporting empty list. Reinstall or verify the package is intact.",
    );
    return EMPTY_MCP_PINS;
  }
}

/**
 * Detect whether the audit key is sourced from the `ASSIGNEE_AUDIT_KEY`
 * env var ("env") or falls back to the on-disk key file ("file").
 *
 * PR-030 (W24c-S3): included in `assignee version --json` so bug reports
 * carry the audit-key provenance without exposing the key material itself.
 */
function resolveAuditKeySource(): "env" | "file" {
  const envKey = process.env["ASSIGNEE_AUDIT_KEY"];
  return envKey && envKey.length > 0 ? "env" : "file";
}

/**
 * Return the stat mode of the audit-key file as an octal number (e.g. 0o600),
 * or `undefined` if the file does not exist or cannot be stat'd.
 *
 * F037 (full-audit-2026-05-02): ops triage needs the file mode to confirm the
 * key file has the expected 0o600 permissions — included in `--json` output
 * only when the file is accessible; omitted entirely (not null) on failure so
 * the field is absent rather than misleading in degraded installs.
 */
function resolveAuditKeyFileMode(): number | undefined {
  try {
    const s = statSync(DEFAULT_AUDIT_KEY_FILE);
    return s.mode & 0o777;
  } catch {
    return undefined;
  }
}

export const versionCommand = new Command("version")
  .description("Show version and environment info")
  .option(
    "--json",
    "Emit machine-readable JSON to stdout instead of human-readable text",
  )
  .action(async (opts: { json?: boolean }) => {
    const MCP_PINS = await loadMcpPinsOrFallback();
    const version = readPackageVersion();

    if (opts.json) {
      // PR-030 (W24c-S3): emit a compact self-describe blob for bug reports.
      // Fields: cli (semver), node (engine version), platform, arch,
      // region (AWS_REGION or ~/.aws/config [default] region or "unset"),
      // auditKeySource ("env"|"file").
      //
      // RES-1 (W24d): fall through to detectAwsConfigDefaultRegion() so
      // SSO operators whose region is set via ~/.aws/config [default] profile
      // (not AWS_REGION env) see the actual region instead of "unset".
      const auditKeyFileMode = resolveAuditKeyFileMode();
      const blob: Record<string, unknown> = {
        cli: version,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        region:
          process.env["AWS_REGION"] ??
          detectAwsConfigDefaultRegion() ??
          "unset",
        auditKeySource: resolveAuditKeySource(),
      };
      // F037: include file mode only when the key file exists and is readable.
      if (auditKeyFileMode !== undefined) {
        blob["auditKeyFileMode"] = auditKeyFileMode;
      }
      process.stdout.write(JSON.stringify(blob) + "\n");
      return;
    }

    const lines = [
      `assignee ${version}`,
      `node     ${process.version}`,
      `platform ${process.platform} ${process.arch}`,
      "",
      "Pinned MCP servers:",
      `  pricing        ${MCP_PINS.AWS_PRICING}`,
      `  documentation  ${MCP_PINS.AWS_DOCUMENTATION}`,
      `  iam            ${MCP_PINS.AWS_IAM}`,
      `  wa-security    ${MCP_PINS.AWS_WA_SECURITY}`,
      `  cost-mgmt      ${MCP_PINS.AWS_COST_MANAGEMENT}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  });
