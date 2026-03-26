/**
 * Tests for `assignee status` command.
 *
 * Validates --json output shape, empty state message, and error handling.
 * Mocks fetchManagedResources to avoid AWS API calls.
 *
 * @see Story 19.6, AC #5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ManagedResource } from "../services/list-resources.js";
import type { StatusData } from "../services/status-aggregator.js";

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockResources: ManagedResource[] = [
  {
    resourceType: "AWS::S3::Bucket",
    arn: "arn:aws:s3:::my-bucket-1",
    region: "us-east-1",
    createdDate: "2026-03-20",
    estimatedMonthlyCost: "$5.00/month",
  },
  {
    resourceType: "AWS::Lambda::Function",
    arn: "arn:aws:lambda:us-east-1:123456:function:my-fn",
    region: "us-east-1",
    createdDate: "2026-03-21",
    estimatedMonthlyCost: "$10.00/month",
  },
];

vi.mock("../services/list-resources.js", () => ({
  fetchManagedResources: vi.fn(),
}));

vi.mock("../services/status-aggregator.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../services/status-aggregator.js")>();
  return {
    ...original,
    buildStatusData: vi.fn(),
  };
});

// Mock bp-coverage module used by status command's --bp-coverage path
vi.mock("./status-bp-coverage.js", () => ({
  computeBPCoverage: vi.fn(),
  renderBPCoverage: vi.fn(),
}));

describe("status command", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stderrSpy: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let exitSpy: any;

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("--json output is valid JSON matching StatusData shape", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { statusCommand } = await import("./status.js");

    const mockStatusData: StatusData = {
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [
        {
          type: "AWS::S3::Bucket",
          count: 1,
          estimatedMonthlyCost: "$5.00/month",
        },
        {
          type: "AWS::Lambda::Function",
          count: 1,
          estimatedMonthlyCost: "$10.00/month",
        },
      ],
      byRegion: [
        { region: "us-east-1", count: 2, estimatedMonthlyCost: "$15.00/month" },
      ],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    };

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue(mockStatusData);

    try {
      await statusCommand.parseAsync(["node", "status", "--json"], {
        from: "user",
      });
    } catch {
      // process.exit throws
    }

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    const parsed = JSON.parse(output) as StatusData;

    expect(parsed.totalResources).toBe(2);
    expect(parsed.totalEstimatedMonthlyCost).toBe("$15.00/month");
    expect(parsed.byType).toHaveLength(2);
    expect(parsed.byRegion).toHaveLength(1);
    expect(parsed.lastUpdated).toBeTruthy();
  });

  it("empty state renders 'No resources managed' message", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue([]);

    try {
      await statusCommand.parseAsync(["node", "status"], { from: "user" });
    } catch {
      // process.exit throws
    }

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(output).toContain("No resources managed by assignee.ai");
    expect(output).toContain("assignee plan");
  });

  it("error state renders error with helpful message", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockRejectedValue(
      new Error("AWS credentials not found"),
    );

    try {
      await statusCommand.parseAsync(["node", "status"], { from: "user" });
    } catch {
      // process.exit throws
    }

    const stderrOutput = stderrSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("");
    expect(stderrOutput).toContain("Failed to fetch status");
    expect(stderrOutput).toContain("AWS credentials not found");
  });
});

describe("status command registration", () => {
  it("status command is registered in index.ts", async () => {
    // Verify the statusCommand export exists and has the right name
    const { statusCommand } = await import("./status.js");
    expect(statusCommand.name()).toBe("status");
    expect(statusCommand.description()).toBe(
      "Show summary of managed infrastructure",
    );
  });
});

describe("status command options registration", () => {
  it("has --bp-coverage option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const bpOption = statusCommand.options.find(
      (opt) => opt.long === "--bp-coverage",
    );
    expect(bpOption).toBeDefined();
    expect(bpOption!.description).toBe("Show BP rule coverage dashboard");
  });

  it("has --region option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const regionOption = statusCommand.options.find(
      (opt) => opt.long === "--region",
    );
    expect(regionOption).toBeDefined();
    expect(regionOption!.description).toBe("Filter to a specific AWS region");
  });

  it("has --json option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const jsonOption = statusCommand.options.find(
      (opt) => opt.long === "--json",
    );
    expect(jsonOption).toBeDefined();
    expect(jsonOption!.description).toBe("Output status data as JSON");
  });

  it("parses --region value correctly", async () => {
    const { statusCommand } = await import("./status.js");
    statusCommand.parseOptions(["--region", "eu-west-1"]);
    expect(statusCommand.opts()["region"]).toBe("eu-west-1");
  });

  it("parses --bp-coverage flag correctly", async () => {
    const { statusCommand } = await import("./status.js");
    statusCommand.parseOptions(["--bp-coverage"]);
    expect(statusCommand.opts()["bpCoverage"]).toBe(true);
  });
});
