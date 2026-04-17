/**
 * Persistent audit-log writer for the MCP server.
 *
 * Story 50-5 H-3: previously the MCP server emitted only stderr
 * `mcpLog` records — ephemeral, not tamper-resistant, and never
 * correlatable with CloudTrail for a post-incident review. This
 * module adds an append-only JSON-lines file under
 * `${ASSIGNEE_MCP_AUDIT_DIR ?? ~/.assignee/logs}/mcp-audit-YYYY-MM-DD.jsonl`,
 * rotated daily on first write of a new UTC date.
 *
 * The file is created with mode 0o600 (owner rw) and the parent
 * directory with mode 0o700 (owner rwx) — matching the checkpoint-file
 * hardening in Story 50-5 B-1.
 *
 * Integrity caveat (M-2 accepted, not blocked):
 *   This log is local-only and vulnerable to an operator with disk
 *   access tampering retroactively. For tamperproof infrastructure
 *   audit trail, CloudTrail remains authoritative — each record
 *   includes `runId` / `resourceType` / `identifier` so an analyst
 *   can pivot from the JSONL timeline to the corresponding CloudTrail
 *   events. Per the story spec, adding tamperproof storage is
 *   deferred to the SaaS phase (M-3 / out-of-scope).
 *
 * Redaction policy (per feedback_redaction_allowlist_not_denylist):
 *   We do NOT run a denylist regex over the record fields. Instead,
 *   the surface is a strict allowlist — only the enumerated fields
 *   on `AuditRecord` are written, and `errorClass` is deliberately
 *   a short classification string (e.g. "CheckpointError",
 *   "AccessDenied") never the raw error message, since error
 *   messages are the main leakage vector.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/**
 * Record shape written to the audit log. Stable across tool types so
 * the JSONL file parses uniformly. All fields required; undefined
 * callers should pass an explicit sentinel (e.g. empty string) so the
 * record doesn't contain undefined JSON.
 */
export interface AuditRecord {
  /** Tool name: "apply_plan" | "destroy_resource" (extend as new mutating tools land). */
  tool: string;
  /** Run identifier from the checkpoint / caller (UUID). Empty string when no run id is available (e.g. ad-hoc destroy). */
  runId: string;
  /** AWS CloudFormation resource type (e.g. "AWS::S3::Bucket"). */
  resourceType: string;
  /** The ARN (preferred) or bare identifier of the resource acted on. */
  identifier: string;
  /** Whether the tool invocation succeeded. */
  success: boolean;
  /** Classification of the error (short kebab-case or error class name). Empty string on success. */
  errorClass: string;
}

/** Resolves the audit directory, honouring the ASSIGNEE_MCP_AUDIT_DIR override. */
export function auditLogDir(): string {
  const override = process.env["ASSIGNEE_MCP_AUDIT_DIR"];
  if (override && override.length > 0) return override;
  return path.join(os.homedir(), ".assignee", "logs");
}

/**
 * Returns the full path of today's audit log file. Rotation happens
 * implicitly via the filename — a new UTC date yields a new file.
 */
export function auditLogPath(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return path.join(auditLogDir(), `mcp-audit-${yyyy}-${mm}-${dd}.jsonl`);
}

/**
 * Appends a single JSON-lines record to today's audit log. All
 * errors are swallowed — audit logging MUST NEVER propagate a
 * failure back into the tool handler, or an attacker could DoS the
 * handler by filling the audit directory's filesystem. The trade-off
 * is documented in the module-level comment: CloudTrail remains the
 * authoritative audit surface.
 */
export async function auditLog(record: AuditRecord): Promise<void> {
  try {
    const dir = auditLogDir();
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const filePath = auditLogPath();
    const entry =
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...record,
      }) + "\n";
    // appendFile with explicit mode ensures newly-created log files
    // start at 0o600. Existing files' modes are respected (appendFile
    // doesn't chmod an existing file), so if an operator has manually
    // tightened the mode further we don't widen it.
    await fs.appendFile(filePath, entry, { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Best-effort only. See module comment for rationale.
  }
}

/**
 * @internal Test-only. Resets process env side-effects so unit tests
 * can exercise both the default and override branches deterministically.
 */
export function _resetAuditEnvForTests(): void {
  delete process.env["ASSIGNEE_MCP_AUDIT_DIR"];
}
