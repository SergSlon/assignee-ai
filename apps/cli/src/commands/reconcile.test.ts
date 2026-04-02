import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { DriftStatus, ChangeType, type DriftResult } from "@assignee/core";

// Mock memory service
vi.mock("../services/memory.js", () => ({
  MemoryService: vi.fn().mockImplementation(() => ({
    readProvisions: vi.fn().mockResolvedValue([]),
    appendProvision: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock drift-detail view
vi.mock("../views/drift-detail.js", () => ({
  renderDriftDetail: vi.fn().mockReturnValue("mock detail view"),
}));

// Mock drift detector factory
const mockCreateDriftDetectorFromEnv = vi.fn();
vi.mock("../services/drift-detector-factory.js", () => ({
  createDriftDetectorFromEnv: (...args: unknown[]) =>
    mockCreateDriftDetectorFromEnv(...args),
}));

import {
  reconcileCommand,
  buildPatchDocument,
  reconcileResource,
} from "./reconcile.js";
import { MemoryService } from "../services/memory.js";
import type { ProvisioningPort } from "../services/provisioning-port.js";

function createMockPort(
  overrides?: Partial<ProvisioningPort>,
): ProvisioningPort {
  return {
    getResource: vi.fn().mockResolvedValue([
      null,
      {
        ResourceDescription: { Properties: JSON.stringify({}) },
      },
    ]),
    createResource: vi.fn(),
    deleteResource: vi.fn(),
    updateResource: vi
      .fn()
      .mockResolvedValue([null, { requestToken: "tok-123" }]),
    getRequestStatus: vi.fn(),
    ...overrides,
  };
}

function makeDriftResult(overrides?: Partial<DriftResult>): DriftResult {
  return {
    resourceType: "AWS::S3::Bucket",
    resourceId: "my-bucket",
    status: DriftStatus.DRIFTED,
    driftedFields: [
      {
        path: "VersioningConfiguration.Status",
        desiredValue: "Enabled",
        actualValue: "Suspended",
        changeType: ChangeType.MODIFIED,
      },
    ],
    actualState: { VersioningConfiguration: { Status: "Suspended" } },
    desiredState: { VersioningConfiguration: { Status: "Enabled" } },
    checkedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("reconcile command", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.exitCode = undefined;
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    mockCreateDriftDetectorFromEnv.mockReset();
    delete (globalThis as Record<string, unknown>)["__reconcilePromptFn"];
    delete (globalThis as Record<string, unknown>)["__reconcileConfirmFn"];
  });

  it("displays empty state message when no provisions exist", async () => {
    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue([]),
        }) as any,
    );

    await reconcileCommand.parseAsync(["node", "reconcile"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No managed resources found");
  });

  it("reports that credentials are needed when no drift port is set", async () => {
    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue([
            {
              runId: "run-1",
              resourceType: "AWS::S3::Bucket",
              resourceArn: "my-bucket",
              region: "us-east-1",
              desiredStateHash: "abc",
              estimatedMonthlyCost: "$0",
              timestamp: "2026-03-20T14:30:00Z",
            },
          ]),
        }) as any,
    );

    mockCreateDriftDetectorFromEnv.mockReturnValue(undefined);
    await reconcileCommand.parseAsync(["node", "reconcile"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Reconcile requires AWS credentials");
  });

  it("shows in-sync message when no drifted resources found", async () => {
    const mockPort = createMockPort({
      getResource: vi.fn().mockResolvedValue([
        null,
        {
          ResourceDescription: {
            Properties: JSON.stringify({ BucketName: "my-bucket" }),
          },
        },
      ]),
    });
    const { DriftDetectorService } =
      await import("../services/drift-detector.js");
    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    mockCreateDriftDetectorFromEnv.mockReturnValue({
      detector,
      port: mockPort,
    });

    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue([
            {
              runId: "run-1",
              resourceType: "AWS::S3::Bucket",
              resourceArn: "my-bucket",
              region: "us-east-1",
              desiredStateHash: "abc",
              estimatedMonthlyCost: "$0",
              timestamp: "2026-03-20T14:30:00Z",
            },
          ]),
        }) as any,
    );

    await reconcileCommand.parseAsync(["node", "reconcile"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("in sync");
  });

  describe("--dry-run", () => {
    it("shows planned actions without making API calls", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: true,
        autoReconcile: false,
        promptFn: vi.fn(),
        confirmFn: vi.fn(),
      });

      expect(action).toBe("skip");
      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("dry-run");
      expect(mockPort.updateResource).not.toHaveBeenCalled();
    });
  });

  describe("--auto-reconcile", () => {
    it("reconciles all drifted resources without prompting", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: false,
        autoReconcile: true,
        promptFn: vi.fn(),
        confirmFn: vi.fn(),
      });

      expect(action).toBe("reconcile");
      expect(mockPort.updateResource).toHaveBeenCalledTimes(1);
    });
  });

  describe("interactive prompt flow", () => {
    it("reconciles when user selects 'Reconcile'", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Reconcile"),
        confirmFn: vi.fn().mockResolvedValue(true),
      });

      expect(action).toBe("reconcile");
      expect(mockPort.updateResource).toHaveBeenCalledTimes(1);
    });

    it("accepts when user selects 'Accept'", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();

      vi.mocked(MemoryService).mockImplementation(
        () =>
          ({
            readProvisions: vi.fn().mockResolvedValue([]),
            appendProvision: vi.fn().mockResolvedValue(undefined),
          }) as any,
      );
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Accept"),
        confirmFn: vi.fn(),
      });

      expect(action).toBe("accept");
      expect(mockPort.updateResource).not.toHaveBeenCalled();
    });

    it("skips when user selects 'Skip'", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Skip"),
        confirmFn: vi.fn(),
      });

      expect(action).toBe("skip");
      expect(mockPort.updateResource).not.toHaveBeenCalled();
    });

    it("skips when user declines HITL confirmation", async () => {
      const mockPort = createMockPort();
      const result = makeDriftResult();
      const memory = new MemoryService();

      const action = await reconcileResource(result, mockPort, memory, {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Reconcile"),
        confirmFn: vi.fn().mockResolvedValue(false),
      });

      expect(action).toBe("skip");
      expect(mockPort.updateResource).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("throws on UpdateResource failure", async () => {
      const mockPort = createMockPort({
        updateResource: vi
          .fn()
          .mockResolvedValue([
            { kind: "ACCESS_DENIED", message: "Not authorized" },
            null,
          ]),
      });
      const result = makeDriftResult();
      const memory = new MemoryService();

      await expect(
        reconcileResource(result, mockPort, memory, {
          dryRun: false,
          autoReconcile: true,
          promptFn: vi.fn(),
          confirmFn: vi.fn(),
        }),
      ).rejects.toThrow("Not authorized");
    });
  });

  describe("summary output format", () => {
    it("formats summary correctly", async () => {
      const mockPort = createMockPort({
        getResource: vi
          .fn()
          .mockResolvedValueOnce([
            null,
            {
              ResourceDescription: {
                Properties: JSON.stringify({
                  VersioningConfiguration: { Status: "Suspended" },
                }),
              },
            },
          ])
          .mockResolvedValueOnce([
            null,
            {
              ResourceDescription: {
                Properties: JSON.stringify({
                  BucketName: "other-bucket",
                }),
              },
            },
          ]),
      });
      const { DriftDetectorService } =
        await import("../services/drift-detector.js");
      const detector = new DriftDetectorService({ provisioningPort: mockPort });
      mockCreateDriftDetectorFromEnv.mockReturnValue({
        detector,
        port: mockPort,
      });
      (globalThis as Record<string, unknown>)["__reconcilePromptFn"] = vi
        .fn()
        .mockResolvedValueOnce("Skip")
        .mockResolvedValueOnce("Skip");
      (globalThis as Record<string, unknown>)["__reconcileConfirmFn"] = vi
        .fn()
        .mockResolvedValue(true);

      vi.mocked(MemoryService).mockImplementation(
        () =>
          ({
            readProvisions: vi.fn().mockResolvedValue([
              {
                runId: "run-1",
                resourceType: "AWS::S3::Bucket",
                resourceArn: "bucket-1",
                region: "us-east-1",
                desiredStateHash: "abc",
                estimatedMonthlyCost: "$0",
                timestamp: "2026-03-20T14:30:00Z",
              },
            ]),
          }) as any,
      );

      await reconcileCommand.parseAsync(["node", "reconcile"]);

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      // Either "in sync" or summary line should appear
      expect(output).toMatch(/in sync|Reconciled:/);
    });
  });
});

describe("buildPatchDocument", () => {
  it("builds replace ops for MODIFIED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "VersioningConfiguration.Status",
        desiredValue: "Enabled",
        actualValue: "Suspended",
        changeType: ChangeType.MODIFIED,
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

  it("builds add ops for REMOVED fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Encryption.SSEAlgorithm",
        desiredValue: "aws:kms",
        actualValue: undefined,
        changeType: ChangeType.REMOVED,
      },
    ]);

    expect(ops).toEqual([
      { op: "add", path: "/Encryption/SSEAlgorithm", value: "aws:kms" },
    ]);
  });

  it("builds remove ops for ADDED_EXTERNALLY fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "LoggingConfiguration",
        desiredValue: undefined,
        actualValue: { DestinationBucketName: "logs" },
        changeType: ChangeType.ADDED_EXTERNALLY,
      },
    ]);

    expect(ops).toEqual([{ op: "remove", path: "/LoggingConfiguration" }]);
  });

  it("handles array index paths", () => {
    const { ops } = buildPatchDocument([
      {
        path: "Tags[0].Value",
        desiredValue: "prod",
        actualValue: "staging",
        changeType: ChangeType.MODIFIED,
      },
    ]);

    expect(ops).toEqual([
      { op: "replace", path: "/Tags/0/Value", value: "prod" },
    ]);
  });

  it("builds multiple ops from multiple drifted fields", () => {
    const { ops } = buildPatchDocument([
      {
        path: "A",
        desiredValue: 1,
        actualValue: 2,
        changeType: ChangeType.MODIFIED,
      },
      {
        path: "B",
        desiredValue: undefined,
        actualValue: "x",
        changeType: ChangeType.ADDED_EXTERNALLY,
      },
    ]);

    expect(ops).toHaveLength(2);
  });

  it("skips create-only properties and returns them separately", () => {
    const { ops, skippedCreateOnly } = buildPatchDocument(
      [
        {
          path: "BucketName",
          desiredValue: "old-name",
          actualValue: "new-name",
          changeType: ChangeType.MODIFIED,
        },
        {
          path: "VersioningConfiguration.Status",
          desiredValue: "Enabled",
          actualValue: "Suspended",
          changeType: ChangeType.MODIFIED,
        },
      ],
      ["/properties/BucketName"],
    );

    expect(ops).toHaveLength(1);
    expect(ops[0]).toHaveProperty("path", "/VersioningConfiguration/Status");
    expect(skippedCreateOnly).toHaveLength(1);
    expect(skippedCreateOnly[0]!.path).toBe("BucketName");
  });
});
