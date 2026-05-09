/**
 * W3-01 (Epic 100 Round 5) — Audit barrel.
 *
 * Re-exports from the audit surface so CLI and future consumers can import
 * from `@assignee/core/audit` without reaching into internal paths.
 */

export {
  computeChainLink,
  verifyChainLink,
  legacyComputeChainLink,
  legacyVerifyChainLink,
  getAuditKey,
  resolveAuditKey,
  DEFAULT_AUDIT_KEY_FILE,
  GENESIS_HMAC,
  AUDIT_KEY_MIN_LENGTH,
  _resetAuditKeyCache,
} from "./hmac-chain.js";

export {
  appendAuditRecord,
  readAuditLog,
  auditLogExists,
  DEFAULT_AUDIT_LOG_FILE,
  DEFAULT_AUDIT_LOG_DIR,
  type AuditEntry,
  type LegacyAuditEntry,
  type AuditLogLine,
} from "./audit-log.js";

export {
  verifyAuditLog,
  type VerifyResult,
  type VerifyReason,
  type ChainMode,
} from "./audit-verifier.js";

export {
  ensureAssigneeHomeDir,
  resolveAssigneeHomeDir,
} from "./ensure-assignee-home-dir.js";
