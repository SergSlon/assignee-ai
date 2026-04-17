/**
 * Exit-code contract integration test.
 *
 * Story 50-8: the L8 review surfaced that `docs/commands.md` and
 * `docs/troubleshooting.md` disagreed on what exit code 10 meant. The
 * docs were unified (troubleshooting.md as canonical), the constants
 * extended (POLICY_SAFETY_ABORT=10, MCP_STARTUP_FAILED=11), and the
 * mapping was extracted to `utils/exit-code.ts`.
 *
 * This test pins the contract: every documented error class maps to the
 * documented exit code. If a future change accidentally re-uses 10
 * for "MCP startup failure" (the prior incorrect mapping) or drops the
 * doctor-warnings 2, this test fails before it ships.
 */

import { describe, it, expect } from "vitest";
import {
  StateGuardError,
  MissingRequiredFieldsError,
  UserCancelledError,
  AssigneeError,
} from "@assignee/core";
import { errorToExitCode } from "../utils/exit-code.js";
import { ErrorCode, ProcessExitCode } from "../constants/errors.js";

describe("ProcessExitCode constants", () => {
  it("declares all five documented codes", () => {
    expect(ProcessExitCode.SUCCESS).toBe(0);
    expect(ProcessExitCode.GENERIC_ERROR).toBe(1);
    expect(ProcessExitCode.DOCTOR_WARNINGS).toBe(2);
    expect(ProcessExitCode.POLICY_SAFETY_ABORT).toBe(10);
    expect(ProcessExitCode.MCP_STARTUP_FAILED).toBe(11);
  });

  it("does NOT re-use exit 10 for MCP startup (regression guard for L8 finding)", () => {
    expect(ProcessExitCode.MCP_STARTUP_FAILED).not.toBe(10);
  });
});

describe("errorToExitCode", () => {
  it("maps unknown errors to GENERIC_ERROR (1)", () => {
    expect(errorToExitCode(new Error("boom"))).toBe(1);
    expect(errorToExitCode("plain string")).toBe(1);
    expect(errorToExitCode(undefined)).toBe(1);
  });

  it("maps StateGuardError to POLICY_SAFETY_ABORT (10)", () => {
    expect(errorToExitCode(new StateGuardError("stale plan"))).toBe(10);
  });

  it("maps MissingRequiredFieldsError to POLICY_SAFETY_ABORT (10)", () => {
    expect(
      errorToExitCode(new MissingRequiredFieldsError(["BucketName"])),
    ).toBe(10);
  });

  it("maps UserCancelledError to POLICY_SAFETY_ABORT (10)", () => {
    expect(errorToExitCode(new UserCancelledError("user said n"))).toBe(10);
  });

  it("maps AssigneeError USER_CANCELLED to POLICY_SAFETY_ABORT (10)", () => {
    expect(
      errorToExitCode(new AssigneeError("aborted", ErrorCode.USER_CANCELLED)),
    ).toBe(10);
  });

  it("maps AssigneeError NON_INTERACTIVE_NO_YES to POLICY_SAFETY_ABORT (10)", () => {
    expect(
      errorToExitCode(
        new AssigneeError("--yes required", ErrorCode.NON_INTERACTIVE_NO_YES),
      ),
    ).toBe(10);
  });

  it("maps AssigneeError DESTROY_ERROR to POLICY_SAFETY_ABORT (10)", () => {
    expect(
      errorToExitCode(
        new AssigneeError("env gate refused", ErrorCode.DESTROY_ERROR),
      ),
    ).toBe(10);
  });

  it("maps AssigneeError MCP_STARTUP_FAILED to MCP_STARTUP_FAILED (11)", () => {
    expect(
      errorToExitCode(
        new AssigneeError("uvx not found", ErrorCode.MCP_STARTUP_FAILED),
      ),
    ).toBe(11);
  });

  it("maps unrelated AssigneeError codes to GENERIC_ERROR (1)", () => {
    expect(
      errorToExitCode(
        new AssigneeError("LLM rate limit", ErrorCode.LLM_RATE_LIMIT),
      ),
    ).toBe(1);
    expect(
      errorToExitCode(new AssigneeError("yaml parse", ErrorCode.INVALID_YAML)),
    ).toBe(1);
  });
});
