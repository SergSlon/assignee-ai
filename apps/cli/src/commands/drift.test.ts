import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { DriftStatus, type DriftResult } from "@assignee/core";

// Mock memory service
//
// vitest config has `mockReset: true`, so `vi.fn().mockImplementation(...)`
// constructor stubs get wiped between tests. Use a `class` declaration that
// delegates to module-level hoisted mocks (matches setup.test.ts pattern).
const { mockMemoryReadProvisions } = vi.hoisted(() => ({
  mockMemoryReadProvisions: vi.fn().mockResolvedValue([]),
}));

vi.mock("../services/memory.js", () => {
  class MemoryService {
    readProvisions = (...args: unknown[]) => mockMemoryReadProvisions(...args);
  }
  return { MemoryService };
});

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

import { driftCommand } from "./drift.js";

describe("drift command", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.exitCode = undefined;
    // Re-arm MemoryService method mock (vitest mockReset wipes it).
    mockMemoryReadProvisions.mockResolvedValue([]);
    // Reset commander state
    driftCommand.setOptionValue("resource", undefined);
    driftCommand.setOptionValue("region", undefined);
    driftCommand.setOptionValue("status", undefined);
    driftCommand.setOptionValue("json", undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    mockCreateDriftDetectorFromEnv.mockReset();
    process.exitCode = undefined;
  });

  it("displays empty state message when no provisions exist", async () => {
    mockMemoryReadProvisions.mockResolvedValue([]);

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No managed resources found");
    expect(output).toContain("assignee plan");
  });

  it("reports that credentials are needed when no drift port is set", async () => {
    mockMemoryReadProvisions.mockResolvedValue([
      {
        runId: "00000000-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::my-bucket",
        region: "us-east-1",
        desiredStateHash: "abc123",
        estimatedMonthlyCost: "$0.00",
        timestamp: "2026-03-20T14:30:00Z",
      },
    ]);

    mockCreateDriftDetectorFromEnv.mockReturnValue(undefined);

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("Drift detection requires AWS credentials");
  });

  it("uses drift port when available and checks resources", async () => {
    const provisions = [
      {
        runId: "00000000-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::bucket-1",
        region: "us-east-1",
        desiredStateHash: "abc",
        estimatedMonthlyCost: "$0",
        timestamp: "2026-03-20T14:30:00Z",
      },
    ];

    const mockPort = {
      getResource: vi.fn().mockResolvedValue([
        null,
        {
          ResourceDescription: {
            Properties: JSON.stringify({ BucketName: "bucket-1" }),
          },
        },
      ]),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const { DriftDetectorService } =
      await import("../services/drift-detector.js");
    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    mockCreateDriftDetectorFromEnv.mockReturnValue({
      detector,
      port: mockPort,
    });

    mockMemoryReadProvisions.mockResolvedValue(provisions);

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // The command should have rendered results and summary
    expect(output).toContain("resources checked");
  });

  it("renders region column from provision data in drift table", async () => {
    const provisions = [
      {
        runId: "00000000-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::bucket-1",
        region: "eu-west-1",
        desiredStateHash: "abc",
        estimatedMonthlyCost: "$0",
        timestamp: "2026-03-20T14:30:00Z",
      },
    ];

    const mockPort = {
      getResource: vi
        .fn()
        .mockResolvedValue([
          null,
          { ResourceDescription: { Properties: JSON.stringify({}) } },
        ]),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const { DriftDetectorService } =
      await import("../services/drift-detector.js");
    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    mockCreateDriftDetectorFromEnv.mockReturnValue({
      detector,
      port: mockPort,
    });

    mockMemoryReadProvisions.mockResolvedValue(provisions);

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("eu-west-1");
    expect(output).toContain("Region");
  });

  it("exit code remains undefined when all resources are in-sync", async () => {
    const provisions = [
      {
        runId: "00000000-0000-0000-0000-000000000001",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "arn:aws:s3:::bucket-1",
        region: "us-east-1",
        desiredStateHash: "abc",
        estimatedMonthlyCost: "$0",
        timestamp: "2026-03-20T14:30:00Z",
      },
    ];

    const mockPort = {
      getResource: vi
        .fn()
        .mockResolvedValue([
          null,
          { ResourceDescription: { Properties: JSON.stringify({}) } },
        ]),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const { DriftDetectorService } =
      await import("../services/drift-detector.js");
    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    mockCreateDriftDetectorFromEnv.mockReturnValue({
      detector,
      port: mockPort,
    });

    mockMemoryReadProvisions.mockResolvedValue(provisions);

    await driftCommand.parseAsync(["node", "drift"]);

    // exit code should remain undefined (0) - no drifted resources
    expect(process.exitCode).toBeUndefined();
  });
});
