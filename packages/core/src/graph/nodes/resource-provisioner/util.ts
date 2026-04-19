/**
 * Pure helpers shared across resource-provisioner submodules.
 *
 * SRP: formatting + sanitization + type-narrowing only. No I/O, no AWS SDK,
 * no LangGraph state. Safe to import from any submodule without cycles.
 */

import { SUPPORTED_TYPES_ARRAY, type ResourceType } from "@/index.js";

export function isResourceType(s: string): s is ResourceType {
  return (SUPPORTED_TYPES_ARRAY as readonly string[]).includes(s);
}

/**
 * Format an unknown caught error for logging. Prefer the full stack trace
 * (for diagnosing EIP/SSH leaks and other transient AWS failures), fall back
 * to the message, and only stringify non-Error throws as a last resort.
 */
export function formatErrorForLog(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? err.message;
  }
  return String(err);
}

/**
 * Whitelist-based filename sanitizer for SSH key file names. Only
 * `[A-Za-z0-9._-]` survives — every other character (path separators, null
 * bytes, newlines, control chars, shell metacharacters, Unicode) is replaced
 * with `_`. A leading dot is also rejected so the resulting file is never
 * a hidden dotfile and never resolves to `.` or `..`. Empty results fall
 * back to a deterministic placeholder so we never write to `/.pem`.
 */
export function sanitizeKeyName(name: string): string {
  let cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_");
  // Strip leading dots and underscores so the result is never a hidden
  // dotfile, never resolves to "." or "..", and never starts with the
  // sanitization placeholder. We strip dots first (to handle ".." and
  // ".hidden") and underscores second (to handle the residue from path
  // separators that the regex above replaced — e.g. "../etc/passwd" →
  // "_etc_passwd" → "etc_passwd").
  while (cleaned.length > 0 && (cleaned[0] === "." || cleaned[0] === "_")) {
    cleaned = cleaned.slice(1);
  }
  if (cleaned.length === 0) {
    cleaned = "assignee_key";
  }
  return cleaned;
}
