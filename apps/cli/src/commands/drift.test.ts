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
vi.mock("../services/memory.js", () => ({
  MemoryService: vi.fn().mockImplementation(() => ({
    readProvisions: vi.fn().mockResolvedValue([]),
  })),
}));

// Mock drift-detail view
vi.mock("../views/drift-detail.js", () => ({
  renderDriftDetail: vi.fn().mockReturnValue("mock detail view"),
}));

import { driftCommand } from "./drift.js";
import { MemoryService } from "../services/memory.js";

describe("drift command", () => {
  let stdoutSpy: MockInstance;

  beforeEach(() => {
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    process.exitCode = undefined;
    // Reset commander state
    driftCommand.setOptionValue("resource", undefined);
    driftCommand.setOptionValue("region", undefined);
    driftCommand.setOptionValue("status", undefined);
    driftCommand.setOptionValue("json", undefined);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
    process.exitCode = undefined;
    delete (globalThis as Record<string, unknown>)["__assigneeDriftPort"];
  });

  it("displays empty state message when no provisions exist", async () => {
    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue([]),
        }) as any,
    );

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("No managed resources found");
    expect(output).toContain("assignee plan");
  });

  it("reports that credentials are needed when no drift port is set", async () => {
    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue([
            {
              runId: "00000000-0000-0000-0000-000000000001",
              resourceType: "AWS::S3::Bucket",
              resourceArn: "arn:aws:s3:::my-bucket",
              region: "us-east-1",
              desiredStateHash: "abc123",
              estimatedMonthlyCost: "$0.00",
              timestamp: "2026-03-20T14:30:00Z",
            },
          ]),
        }) as any,
    );

    delete (globalThis as Record<string, unknown>)["__assigneeDriftPort"];

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
      getResource: vi
        .fn()
        .mockResolvedValue([
          null,
          {
            ResourceDescription: {
              Properties: JSON.stringify({ BucketName: "bucket-1" }),
            },
          },
        ]),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    (globalThis as Record<string, unknown>)["__assigneeDriftPort"] = mockPort;

    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue(provisions),
        }) as any,
    );

    await driftCommand.parseAsync(["node", "drift"]);

    const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // The command should have rendered results and summary
    expect(output).toContain("resources checked");
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
      getRequestStatus: vi.fn(),
    };

    (globalThis as Record<string, unknown>)["__assigneeDriftPort"] = mockPort;

    vi.mocked(MemoryService).mockImplementation(
      () =>
        ({
          readProvisions: vi.fn().mockResolvedValue(provisions),
        }) as any,
    );

    await driftCommand.parseAsync(["node", "drift"]);

    // exit code should remain undefined (0) - no drifted resources
    expect(process.exitCode).toBeUndefined();
  });
});
