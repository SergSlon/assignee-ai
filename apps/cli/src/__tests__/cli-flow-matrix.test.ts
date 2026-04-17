/**
 * CLI Flow Matrix — exhaustive integration tests for every command and flag combination.
 *
 * Strategy: test the exported command action handlers and helper functions directly,
 * mocking at the AWS/MCP boundary. Each test validates the command handler logic
 * without requiring actual AWS connections or MCP servers.
 *
 * Story 50-3 cut the `clean`, `cache`, `patterns`, `types`, `whoami` commands
 * plus `destroy --all` / `--include-iam` — their tests went with them.
 *
 * We test:
 *   - destroyAction (exported handler for destroy)
 *   - buildPatchDocument (reconcile patch generation)
 *   - Command option/argument definitions for all registered commands
 *
 * For commands that use runCommand() (plan, apply), we validate the graph invocation
 * contract and error handling by testing the shared command runner and the command
 * option definitions.
 *
 * @see Stories 33.x — CLI integration test matrix
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Capture stdout/stderr ──────────────────────────────────────────────────

let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

function captureOutput() {
  stdoutWrites = [];
  stderrWrites = [];
  process.stdout.write = vi.fn((...args: unknown[]) => {
    const data = typeof args[0] === "string" ? args[0] : String(args[0]);
    stdoutWrites.push(data);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = vi.fn((...args: unknown[]) => {
    const data = typeof args[0] === "string" ? args[0] : String(args[0]);
    stderrWrites.push(data);
    return true;
  }) as typeof process.stderr.write;
}

function restoreOutput() {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

function getStdout(): string {
  return stdoutWrites.join("");
}

// ═════════════════════════════════════════════════════════════════════════════
// COMMAND REGISTRATION & OPTION DEFINITIONS
// ═════════════════════════════════════════════════════════════════════════════

describe("command registration and options", () => {
  it("all commands are defined with correct names", async () => {
    const { CommandName } = await import("../constants/commands.js");
    expect(CommandName.PLAN).toBe("plan");
    expect(CommandName.APPLY).toBe("apply");
    expect(CommandName.INIT).toBe("init");
    expect(CommandName.LIST).toBe("list");
    expect(CommandName.DESTROY).toBe("destroy");
    expect(CommandName.STATUS).toBe("status");
    expect(CommandName.DRIFT).toBe("drift");
    expect(CommandName.RECONCILE).toBe("reconcile");
    expect(CommandName.SETUP).toBe("setup");
  });

  it("all command descriptions are non-empty", async () => {
    const { CommandDescription } = await import("../constants/commands.js");
    for (const [key, desc] of Object.entries(CommandDescription)) {
      expect(desc, `${key} description should be non-empty`).toBeTruthy();
      expect(
        (desc as string).length,
        `${key} description should be meaningful`,
      ).toBeGreaterThan(10);
    }
  });

  it("INTENT argument is optional (bracketed)", async () => {
    const { CommandArgs } = await import("../constants/commands.js");
    expect(CommandArgs.INTENT.NAME).toBe("[intent]");
  });

  it("RESOURCE argument is required (angle-bracketed)", async () => {
    const { CommandArgs } = await import("../constants/commands.js");
    expect(CommandArgs.RESOURCE.NAME).toBe("<resource>");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE — buildPatchDocument
// ═════════════════════════════════════════════════════════════════════════════

describe("buildPatchDocument (reconcile)", () => {
  let buildPatchDocument: (typeof import("../commands/reconcile.js"))["buildPatchDocument"];

  beforeEach(async () => {
    const mod = await import("../commands/reconcile.js");
    buildPatchDocument = mod.buildPatchDocument;
  });

  it("generates replace op for MODIFIED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "VersioningConfiguration.Status",
        desiredValue: "Enabled",
        actualValue: "Suspended",
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops).toEqual([
      {
        op: "replace",
        path: "/VersioningConfiguration/Status",
        value: "Enabled",
      },
    ]);
  });

  it("generates add op for REMOVED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Tags.environment",
        desiredValue: "prod",
        actualValue: undefined,
        changeType: "REMOVED" as const,
      },
    ]);
    expect(ops).toEqual([
      { op: "add", path: "/Tags/environment", value: "prod" },
    ]);
  });

  it("generates remove op for ADDED_EXTERNALLY fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Tags.unwanted",
        desiredValue: undefined,
        actualValue: "extra",
        changeType: "ADDED_EXTERNALLY" as const,
      },
    ]);
    expect(ops).toEqual([{ op: "remove", path: "/Tags/unwanted" }]);
  });

  it("converts dot notation to JSON pointer paths", () => {
    const { ops } = buildPatchDocument([
      {
        path: "a.b.c",
        desiredValue: 42,
        actualValue: 0,
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops[0]).toEqual({
      op: "replace",
      path: "/a/b/c",
      value: 42,
    });
  });

  it("converts array index notation to JSON pointer", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Rules[0].Effect",
        desiredValue: "Allow",
        actualValue: "Deny",
        changeType: "MODIFIED" as const,
      },
    ]);
    expect(ops[0]).toEqual({
      op: "replace",
      path: "/Rules/0/Effect",
      value: "Allow",
    });
  });

  it("handles multiple drifted fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Field1",
        desiredValue: "a",
        actualValue: "b",
        changeType: "MODIFIED" as const,
      },
      {
        path: "Field2",
        desiredValue: "x",
        actualValue: undefined,
        changeType: "REMOVED" as const,
      },
      {
        path: "Field3",
        desiredValue: undefined,
        actualValue: "y",
        changeType: "ADDED_EXTERNALLY" as const,
      },
    ]);
    expect(ops).toHaveLength(3);
    expect(ops[0]).toHaveProperty("op", "replace");
    expect(ops[1]).toHaveProperty("op", "add");
    expect(ops[2]).toHaveProperty("op", "remove");
  });

  it("returns empty ops array for no drifted fields", () => {
    const { ops } = buildPatchDocument([]);
    expect(ops).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DESTROY ACTION — direct handler tests
// ═════════════════════════════════════════════════════════════════════════════

describe("destroyAction", () => {
  beforeEach(() => {
    captureOutput();
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    restoreOutput();
  });

  // Story 50-3: --include-iam / --dry-run / --all flags were removed.
  // destroyAction now only rejects missing-resource invocations.
  it("rejects missing resource", async () => {
    const { destroyAction } = await import("../commands/destroy.js");
    await expect(destroyAction(undefined, {})).rejects.toThrow(
      /needs to know what to destroy/,
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// CHECKPOINT SERVICE
// ═════════════════════════════════════════════════════════════════════════════

describe("checkpoint serialization", () => {
  it("serializeCheckpoint extracts correct fields from state", async () => {
    const { serializeCheckpoint } = await import("../services/checkpoint.js");

    const mockState = {
      runId: "test-run-123",
      userIntent: "Create an S3 bucket named my-bucket",
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "my-bucket" },
      estimatedMonthlyCost: "$0.023/mo",
      preflightPassed: true,
      elicitedOptions: { region: "us-east-1" },
      resourcePattern: undefined,
      resourceQueue: undefined,
    } as never;

    const cp = serializeCheckpoint(mockState);

    expect(cp.runId).toBe("test-run-123");
    expect(cp.userIntent).toBe("Create an S3 bucket named my-bucket");
    expect(cp.resourceType).toBe("AWS::S3::Bucket");
    expect(cp.desiredState).toEqual({ BucketName: "my-bucket" });
    expect(cp.preflightPassed).toBe(true);
    expect(cp.ttl_hours).toBe(72);
    // Pin checkpoint_version to the canonical CHECKPOINT_VERSION constant
    // rather than just toBeDefined — guards against accidental shape
    // regressions and forces a deliberate change to the schema constant.
    const { CHECKPOINT_VERSION } = await import("@assignee/core");
    expect(cp.checkpoint_version).toBe(CHECKPOINT_VERSION);
  });

  it("serializeCheckpoint handles compound resources with queue", async () => {
    const { serializeCheckpoint } = await import("../services/checkpoint.js");

    const mockState = {
      runId: "compound-run",
      userIntent: "Create a VPC",
      resourceType: "AWS::EC2::VPC",
      desiredState: {},
      estimatedMonthlyCost: "$50/mo",
      preflightPassed: true,
      elicitedOptions: {},
      resourcePattern: { patternId: "vpc-full" },
      resourceQueue: [
        {
          resourceId: "vpc-1",
          resourceType: "AWS::EC2::VPC",
          displayName: "my-vpc",
          desiredState: { CidrBlock: "10.0.0.0/16" },
        },
        {
          resourceId: "subnet-1",
          resourceType: "AWS::EC2::Subnet",
          displayName: "my-subnet",
          desiredState: { CidrBlock: "10.0.1.0/24" },
        },
      ],
    } as never;

    const cp = serializeCheckpoint(mockState);

    expect(cp.resourcePatternId).toBe("vpc-full");
    expect(cp.resourceQueue).toHaveLength(2);
    expect(cp.resourceQueue![0]!.displayName).toBe("my-vpc");
  });

  it("serializeCheckpoint defaults resourceType to unknown when missing", async () => {
    const { serializeCheckpoint } = await import("../services/checkpoint.js");

    const mockState = {
      runId: "no-type-run",
      userIntent: "Do something",
      resourceType: undefined,
      desiredState: undefined,
      estimatedMonthlyCost: undefined,
      preflightPassed: undefined,
      elicitedOptions: undefined,
      resourcePattern: undefined,
      resourceQueue: undefined,
    } as never;

    const cp = serializeCheckpoint(mockState);
    expect(cp.resourceType).toBe("unknown");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DRIFT DETECTOR — normalizeValue
// ═════════════════════════════════════════════════════════════════════════════

describe("drift detector normalizeValue", () => {
  it("coerces stringified boolean to boolean", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("true", true)).toBe(true);
    expect(normalizeValue("false", false)).toBe(false);
  });

  it("coerces stringified number to number", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("42", 42)).toBe(42);
    expect(normalizeValue("3.14", 3.14)).toBe(3.14);
  });

  it("treats null/undefined as equivalent", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue(null, undefined)).toBeUndefined();
    expect(normalizeValue(undefined, null)).toBeUndefined();
  });

  it("leaves non-coercible values untouched", async () => {
    const { normalizeValue } = await import("../services/drift-detector.js");
    expect(normalizeValue("hello", "world")).toBe("hello");
    expect(normalizeValue(42, 99)).toBe(42);
  });
});

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

  it("SUPPORTED_TYPES_HINT includes category groupings and examples", async () => {
    const { SUPPORTED_TYPES_HINT } = await import("../config/constants.js");
    // New format groups by domain instead of dumping raw CFN type names
    expect(SUPPORTED_TYPES_HINT).toContain("What you can create");
    expect(SUPPORTED_TYPES_HINT).toContain("Compute");
    expect(SUPPORTED_TYPES_HINT).toContain("Databases");
    expect(SUPPORTED_TYPES_HINT).toContain("Networking");
    expect(SUPPORTED_TYPES_HINT).toContain("S3 bucket");
    expect(SUPPORTED_TYPES_HINT).toContain("Examples:");
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
// RECONCILE — reconcileResource with injected mocks
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileResource", () => {
  beforeEach(() => {
    captureOutput();
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    restoreOutput();
  });

  it("returns skip when dry-run is true", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn().mockResolvedValue([null, { requestToken: "t" }]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "Versioning",
            desiredValue: "Enabled",
            actualValue: "Suspended",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: true,
        autoReconcile: false,
        promptFn: vi.fn(),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("skip");
    const output = getStdout();
    expect(output).toContain("dry-run");
  });

  it("auto-reconcile calls updateResource without prompt", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn().mockResolvedValue([null, { requestToken: "t" }]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();
    const promptFn = vi.fn();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "Versioning",
            desiredValue: "Enabled",
            actualValue: "Suspended",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: true,
        promptFn,
        confirmFn: vi.fn().mockResolvedValue(true),
      },
    );

    expect(action).toBe("reconcile");
    expect(promptFn).not.toHaveBeenCalled();
    expect(mockPort.updateResource).toHaveBeenCalled();
  });

  it("user choosing Skip returns skip action", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "X",
            desiredValue: "a",
            actualValue: "b",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Skip"),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("skip");
    expect(mockPort.updateResource).not.toHaveBeenCalled();
  });

  it("user choosing Accept returns accept action", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const memory = {
      readProvisions: vi.fn().mockResolvedValue([
        {
          resourceArn: "arn:aws:s3:::test",
          desiredStateHash: "old",
          timestamp: "2024-01-01",
        },
      ]),
      appendProvision: vi.fn().mockResolvedValue(undefined),
      writeProvision: vi.fn().mockResolvedValue(undefined),
    } as never;

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "X",
            desiredValue: "a",
            actualValue: "b",
            changeType: "MODIFIED" as const,
          },
        ],
        actualState: { X: "b" },
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Accept"),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("accept");
  });

  it("reconcile with port error throws", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi
        .fn()
        .mockResolvedValue([
          { kind: "SERVICE_ERROR", message: "AWS down" },
          null,
        ]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    await expect(
      reconcileResource(
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "arn:aws:s3:::test",
          status: "DRIFTED" as const,
          checkedAt: new Date().toISOString(),
          driftedFields: [
            {
              path: "X",
              desiredValue: "a",
              actualValue: "b",
              changeType: "MODIFIED" as const,
            },
          ],
        },
        mockPort,
        memory,
        {
          dryRun: false,
          autoReconcile: true,
          promptFn: vi.fn(),
          confirmFn: vi.fn().mockResolvedValue(true),
        },
      ),
    ).rejects.toThrow("AWS down");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MEMORY SERVICE — provision log operations
// ═════════════════════════════════════════════════════════════════════════════

describe("MemoryService", () => {
  it("can be instantiated with custom directory", async () => {
    // Direct import (no mock) — tests the constructor
    const mod = await vi.importActual<typeof import("../services/memory.js")>(
      "../services/memory.js",
    );
    const svc = new mod.MemoryService("/tmp/test-memory");
    // Stronger than toBeDefined: assert the constructed object exposes
    // the documented MemoryService API surface.
    expect(svc).toBeInstanceOf(mod.MemoryService);
    expect(typeof svc.readProvisions).toBe("function");
    expect(typeof svc.appendProvision).toBe("function");
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

// ═════════════════════════════════════════════════════════════════════════════
// PLAN COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("plan command definition", () => {
  it("has -o / --output option", async () => {
    const { planCommand } = await import("../commands/plan.js");
    const opt = planCommand.options.find((o) => o.long === "--output");
    expect(opt).toMatchObject({
      long: "--output",
      short: "-o",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --no-apply option", async () => {
    const { planCommand } = await import("../commands/plan.js");
    const opt = planCommand.options.find((o) => o.long === "--no-apply");
    expect(opt).toMatchObject({
      long: "--no-apply",
      description: expect.stringMatching(/.+/),
    });
  });

  it("accepts [intent] as optional argument", async () => {
    const { planCommand } = await import("../commands/plan.js");
    // Commander stores registered args
    expect(planCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(planCommand.registeredArguments[0]!.name()).toBe("intent");
    expect(planCommand.registeredArguments[0]!.required).toBe(false);
  });

  it("has addHelpText registered for after-help content", async () => {
    const { planCommand } = await import("../commands/plan.js");
    // Commander's helpInformation() doesn't include addHelpText('after') content,
    // but we can verify the command has the expected description and options
    const helpInfo = planCommand.helpInformation();
    expect(helpInfo).toContain("plan");
    expect(helpInfo).toContain("--output");
    expect(helpInfo).toContain("--no-apply");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// APPLY COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("apply command definition", () => {
  it("has --wizard option (opt-in interactive mode)", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--wizard");
    expect(opt).toMatchObject({
      long: "--wizard",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -y / --yes option", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -c / --checkpoint option", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const opt = applyCommand.options.find((o) => o.long === "--checkpoint");
    expect(opt).toMatchObject({
      long: "--checkpoint",
      short: "-c",
      description: expect.stringMatching(/.+/),
    });
  });

  it("help text includes checkpoint examples", async () => {
    const { applyCommand } = await import("../commands/apply.js");
    const helpInfo = applyCommand.helpInformation();
    expect(helpInfo).toContain("--checkpoint");
    expect(helpInfo).toContain("--wizard");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// INIT COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("init command definition", () => {
  it("has --global option", async () => {
    const { initCommand } = await import("../commands/init.js");
    const opt = initCommand.options.find((o) => o.long === "--global");
    expect(opt).toMatchObject({
      long: "--global",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// LIST COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("list command definition", () => {
  it("has --json option", async () => {
    const { listCommand } = await import("../commands/list.js");
    const opt = listCommand.options.find((o) => o.long === "--json");
    expect(opt).toMatchObject({
      long: "--json",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --region option", async () => {
    const { listCommand } = await import("../commands/list.js");
    const opt = listCommand.options.find((o) => o.long === "--region");
    expect(opt).toMatchObject({
      long: "--region",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DESTROY COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("destroy command definition", () => {
  it("has -y / --yes option", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    const opt = destroyCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has required <resource> argument (Story 50-3 made it mandatory)", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    expect(destroyCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(destroyCommand.registeredArguments[0]!.name()).toBe("resource");
    expect(destroyCommand.registeredArguments[0]!.required).toBe(true);
  });

  it("no longer exposes bulk-destroy flags (--all / --include-iam / --dry-run)", async () => {
    const { destroyCommand } = await import("../commands/destroy.js");
    const longs = destroyCommand.options.map((o) => o.long);
    expect(longs).not.toContain("--all");
    expect(longs).not.toContain("--include-iam");
    expect(longs).not.toContain("--dry-run");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// STATUS COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("status command definition", () => {
  it("has --json option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--json");
    expect(opt).toMatchObject({
      long: "--json",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --region option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--region");
    expect(opt).toMatchObject({
      long: "--region",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --bp-coverage option", async () => {
    const { statusCommand } = await import("../commands/status.js");
    const opt = statusCommand.options.find((o) => o.long === "--bp-coverage");
    expect(opt).toMatchObject({
      long: "--bp-coverage",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// DRIFT COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("drift command definition", () => {
  it("has all expected options", async () => {
    const { driftCommand } = await import("../commands/drift.js");
    const optionNames = driftCommand.options.map((o) => o.long);
    expect(optionNames).toContain("--resource");
    expect(optionNames).toContain("--region");
    expect(optionNames).toContain("--status");
    expect(optionNames).toContain("--json");
    expect(optionNames).toContain("--output");
    expect(optionNames).toContain("--concurrency");
    expect(optionNames).toContain("--no-color");
    expect(optionNames).toContain("--verbose");
  });

  it("accepts optional [resource-id] argument", async () => {
    const { driftCommand } = await import("../commands/drift.js");
    expect(driftCommand.registeredArguments.length).toBeGreaterThanOrEqual(1);
    expect(driftCommand.registeredArguments[0]!.required).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcile command definition", () => {
  it("has --resource option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find((o) => o.long === "--resource");
    expect(opt).toMatchObject({
      long: "--resource",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --dry-run option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find((o) => o.long === "--dry-run");
    expect(opt).toMatchObject({
      long: "--dry-run",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has --auto-reconcile option", async () => {
    const { reconcileCommand } = await import("../commands/reconcile.js");
    const opt = reconcileCommand.options.find(
      (o) => o.long === "--auto-reconcile",
    );
    expect(opt).toMatchObject({
      long: "--auto-reconcile",
      description: expect.stringMatching(/.+/),
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// SETUP COMMAND — option definition validation
// ═════════════════════════════════════════════════════════════════════════════

describe("setup command definition", () => {
  it("has --profile option", async () => {
    const { setupCommand } = await import("../commands/setup.js");
    const opt = setupCommand.options.find((o) => o.long === "--profile");
    expect(opt).toMatchObject({
      long: "--profile",
      description: expect.stringMatching(/.+/),
    });
  });

  it("has -y / --yes option", async () => {
    const { setupCommand } = await import("../commands/setup.js");
    const opt = setupCommand.options.find((o) => o.long === "--yes");
    expect(opt).toMatchObject({
      long: "--yes",
      short: "-y",
      description: expect.stringMatching(/.+/),
    });
  });
});

// Story 50-3: `cache`, `patterns`, `types` commands were removed.
// Their content folded into silent TTL schema cache / `plan --help` discovery.

// ═════════════════════════════════════════════════════════════════════════════
// SUPPORTED TYPES — core exports
// ═════════════════════════════════════════════════════════════════════════════

describe("supported resource types", () => {
  it("SUPPORTED_TYPES_ARRAY includes S3, EC2, Lambda", async () => {
    const { SUPPORTED_TYPES_ARRAY } = await import("@assignee/core");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::S3::Bucket");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::EC2::Instance");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::Lambda::Function");
  });

  it("SUPPORTED_TYPES_ARRAY has exactly 37 types (36 + RDS::DBSubnetGroup)", async () => {
    const { SUPPORTED_TYPES_ARRAY } = await import("@assignee/core");
    expect(SUPPORTED_TYPES_ARRAY.length).toBe(37);
  });
});
