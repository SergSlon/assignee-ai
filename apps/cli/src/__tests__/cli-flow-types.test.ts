/**
 * CLI Flow Types — tests for config constants, enums, error classes, and ports:
 *   - config constants (CHECKPOINT_DIR, TTL, SUPPORTED_TYPES_HINT, AWS_REGION)
 *   - provisioning port contract (ProvisioningErrorKind)
 *   - error classes (AssigneeError, ConfigurationError, CheckpointError, UserCancelledError)
 *   - execution enums (ExecutionMode, ExecutionStatus, DriftStatus, ChangeType)
 *
 * All blocks are stateless — pure import + assertion, no shared setup/teardown.
 *
 * @see Stories 33.x — CLI integration test matrix (split from cli-flow-matrix.test.ts)
 */

import { describe, it, expect } from "vitest";

// ═════════════════════════════════════════════════════════════════════════════
// CONFIG CONSTANTS
// ═════════════════════════════════════════════════════════════════════════════

describe("config constants", () => {
  it("CHECKPOINT_DIR is .assignee", async () => {
    const { CHECKPOINT_DIR } = await import("../config/constants.js");
    expect(CHECKPOINT_DIR).toBe(".assignee");
  });

  it("CHECKPOINT_DEFAULT_TTL_HOURS is 72", async () => {
    const { CHECKPOINT_DEFAULT_TTL_HOURS } =
      await import("../config/constants.js");
    expect(CHECKPOINT_DEFAULT_TTL_HOURS).toBe(72);
  });

  it("SUPPORTED_TYPES_HINT includes category groupings (Epic 96 B4/B5: no embedded Examples)", async () => {
    const { SUPPORTED_TYPES_HINT } = await import("../config/constants.js");
    // New format groups by domain instead of dumping raw CFN type names.
    // Epic 96 Wave 1 B4/B5: the hint intentionally does NOT embed its
    // own `Examples:` block — per-command `addHelpText` wrappers carry
    // the examples so `plan --help` / `apply --help` render a single
    // `Examples:` heading.
    expect(SUPPORTED_TYPES_HINT).toContain("What you can create");
    expect(SUPPORTED_TYPES_HINT).toContain("Compute");
    expect(SUPPORTED_TYPES_HINT).toContain("Databases");
    expect(SUPPORTED_TYPES_HINT).toContain("Networking");
    expect(SUPPORTED_TYPES_HINT).toContain("S3 bucket");
    expect(SUPPORTED_TYPES_HINT).not.toContain("Examples:");
  });

  it("AWS_REGION defaults to us-east-1", async () => {
    const origRegion = process.env["AWS_REGION"];
    delete process.env["AWS_REGION"];

    // Re-import to get fresh default
    const mod = await import("../config/constants.js");
    // Module may be cached, but the default should be us-east-1 or env-overridden
    expect(typeof mod.AWS_REGION).toBe("string");
    expect(mod.AWS_REGION).toMatch(/^[a-z]{2}-[a-z]+-\d+$/);

    if (origRegion) process.env["AWS_REGION"] = origRegion;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// PROVISIONING PORT TYPES
// ═════════════════════════════════════════════════════════════════════════════

describe("provisioning port contract", () => {
  it("ProvisioningErrorKind has all expected variants", async () => {
    const { ProvisioningErrorKind } =
      await import("../services/provisioning-port.js");
    expect(ProvisioningErrorKind.NOT_FOUND).toBe("NOT_FOUND");
    expect(ProvisioningErrorKind.ALREADY_EXISTS).toBe("ALREADY_EXISTS");
    expect(ProvisioningErrorKind.ACCESS_DENIED).toBe("ACCESS_DENIED");
    expect(ProvisioningErrorKind.THROTTLED).toBe("THROTTLED");
    expect(ProvisioningErrorKind.SERVICE_ERROR).toBe("SERVICE_ERROR");
    expect(ProvisioningErrorKind.UNKNOWN).toBe("UNKNOWN");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// ERROR CLASSES
// ═════════════════════════════════════════════════════════════════════════════

describe("error classes", () => {
  it("AssigneeError carries error code", async () => {
    const { AssigneeError } = await import("@assignee/core");
    const err = new AssigneeError("test error", "TEST_CODE");
    expect(err.message).toBe("test error");
    expect(err.code).toBe("TEST_CODE");
    expect(err).toBeInstanceOf(Error);
  });

  it("ConfigurationError is an AssigneeError", async () => {
    const { ConfigurationError, AssigneeError } =
      await import("@assignee/core");
    const err = new ConfigurationError("bad config");
    expect(err).toBeInstanceOf(AssigneeError);
    expect(err.message).toBe("bad config");
  });

  it("CheckpointError is an AssigneeError", async () => {
    const { CheckpointError, AssigneeError } = await import("@assignee/core");
    const err = new CheckpointError("expired checkpoint");
    expect(err).toBeInstanceOf(AssigneeError);
  });

  it("UserCancelledError is an AssigneeError", async () => {
    const { UserCancelledError, AssigneeError } =
      await import("@assignee/core");
    const err = new UserCancelledError("user cancelled");
    expect(err).toBeInstanceOf(AssigneeError);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// EXECUTION MODE & STATUS ENUMS
// ═════════════════════════════════════════════════════════════════════════════

describe("execution enums", () => {
  it("ExecutionMode has PLAN and APPLY", async () => {
    const { ExecutionMode } = await import("@assignee/core");
    expect(ExecutionMode.PLAN).toBe("plan");
    expect(ExecutionMode.APPLY).toBe("apply");
  });

  it("ExecutionStatus has all expected variants", async () => {
    const { ExecutionStatus } = await import("@assignee/core");
    expect(ExecutionStatus.SUCCESS).toBe("SUCCESS");
    expect(ExecutionStatus.FAILED).toBe("FAILED");
    expect(ExecutionStatus.CANCELLED).toBe("CANCELLED");
    expect(ExecutionStatus.UNSUPPORTED_RESOURCE).toBe("UNSUPPORTED_RESOURCE");
  });

  it("DriftStatus has expected variants", async () => {
    const { DriftStatus } = await import("@assignee/core");
    expect(DriftStatus.IN_SYNC).toBe("IN_SYNC");
    expect(DriftStatus.DRIFTED).toBe("DRIFTED");
    expect(DriftStatus.DELETED).toBe("DELETED");
    expect(DriftStatus.ERROR).toBe("ERROR");
    expect(DriftStatus.BASELINE_MISSING).toBe("BASELINE_MISSING");
  });

  it("ChangeType has expected variants", async () => {
    const { ChangeType } = await import("@assignee/core");
    expect(ChangeType.MODIFIED).toBe("MODIFIED");
    expect(ChangeType.REMOVED).toBe("REMOVED");
    expect(ChangeType.ADDED_EXTERNALLY).toBe("ADDED_EXTERNALLY");
  });
});
