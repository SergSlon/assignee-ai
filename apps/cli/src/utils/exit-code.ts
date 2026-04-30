/**
 * Maps a thrown error to the canonical CLI exit code.
 *
 * Story 50-8: the exit-code contract is now stable across `docs/commands.md`
 * and `docs/troubleshooting.md`. This function is the single source of
 * truth for "what code does this error class emit". The unhandled-error
 * catch in `apps/cli/src/index.ts` calls it; the integration test in
 * `apps/cli/src/__tests__/exit-codes.test.ts` asserts the table is honoured.
 *
 * Codes:
 *   0  — success (not produced here; reserved for normal exit)
 *   1  — generic error / unclassified
 *   2  — `assignee doctor` returned warnings only (set by doctor command)
 *   10 — policy / safety abort: typed-confirm mismatch, state guard,
 *        preflight rejection, IAM safety allowlist, BP block, drift
 *        threshold, env-gate refusal (`UserCancelledError`,
 *        `StateGuardError`, `MissingRequiredFieldsError`, and
 *        `AssigneeError` instances whose `.code` is in the
 *        POLICY_SAFETY_CODES set)
 *   11 — MCP server startup failure (`ErrorCode.MCP_STARTUP_FAILED`)
 *   12 — feature not yet implemented; emitted via direct
 *        `process.exit(ProcessExitCode.NOT_IMPLEMENTED)` in plan/apply/
 *        destroy when the user invokes a scaffold-only flag (e.g.
 *        --target-account). NOT returned by this function — use
 *        `ProcessExitCode.NOT_IMPLEMENTED` at the call site directly.
 */

import {
  StateGuardError,
  MissingRequiredFieldsError,
  UserCancelledError,
  AssigneeError,
} from "@assignee/core";
import { ErrorCode, ProcessExitCode } from "../constants/errors.js";

/**
 * AssigneeError codes that map to exit 10 (policy / safety abort).
 * Distinct from "the operation failed" — these are "the operator's
 * stated intent was refused for safety reasons", which scripts may
 * want to handle differently from a real failure.
 */
const POLICY_SAFETY_CODES: ReadonlySet<string> = new Set<string>([
  ErrorCode.USER_CANCELLED,
  ErrorCode.MISSING_REQUIRED_FIELDS,
  ErrorCode.NON_INTERACTIVE_NO_YES,
  ErrorCode.DESTROY_ERROR,
  ErrorCode.UNSUPPORTED_RESOURCE,
]);

export function errorToExitCode(err: unknown): number {
  // Specific subclasses checked BEFORE the generic AssigneeError branch —
  // subclasses pass `instanceof AssigneeError`, so the subclass-specific
  // mapping must run first to avoid being swallowed by the generic code
  // lookup below.
  if (
    err instanceof StateGuardError ||
    err instanceof MissingRequiredFieldsError ||
    err instanceof UserCancelledError
  ) {
    return ProcessExitCode.POLICY_SAFETY_ABORT;
  }
  if (err instanceof AssigneeError) {
    if (err.code === ErrorCode.MCP_STARTUP_FAILED) {
      return ProcessExitCode.MCP_STARTUP_FAILED;
    }
    if (POLICY_SAFETY_CODES.has(err.code)) {
      return ProcessExitCode.POLICY_SAFETY_ABORT;
    }
    return ProcessExitCode.GENERIC_ERROR;
  }
  return ProcessExitCode.GENERIC_ERROR;
}
