/**
 * Tests for `assignee status` command.
 *
 * Validates --json output shape, empty state message, error handling,
 * and Epic 92 e92.u.a observability additions (runId positional warning
 * + STATUS_STARTED / STATUS_COMPLETE structured log events).
 *
 * Mocks fetchManagedResources to avoid AWS API calls and the logger
 * module so we can assert the emitted action envelope without touching
 * the real daily log file.
 *
 * @see Story 19.6, AC #5; Epic 92 e92.u.a
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
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
  renderBPCoverageGaps: vi.fn(),
  filterActionableGaps: vi.fn((gaps: unknown[]) => gaps),
}));

// Mock status-factory so the --bp-coverage branch never touches the real filesystem
vi.mock("./status-factory.js", () => ({
  getBpDir: vi.fn(() => "/tmp/fixture-bp-dir"),
}));

// Epic 92 e92.u.a: mock the logger module so the new STATUS_STARTED /
// STATUS_COMPLETE emissions don't hit the real daily log file during
// tests, and so we can assert the action envelope. The action enum and
// LogLevel constants are re-exported from core; use the real values
// (copied verbatim) to keep the tests honest about the wire format.
vi.mock("../utils/logger.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    STATUS_STARTED: "status_started",
    STATUS_COMPLETE: "status_complete",
  },
  LogLevel: {
    INFO: "info",
    WARN: "warn",
    ERROR: "error",
  },
}));

describe("status command", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  let stderrSpy: MockInstance<typeof process.stderr.write>;

  let exitSpy: MockInstance<typeof process.exit>;

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
    // Commander caches `_optionValues` on the singleton `statusCommand`.
    // A prior `--json` run sticks `output: "json"` into the cache, so
    // the text-mode assertion here needs a fresh module import to
    // reset the Commander instance. Same pattern as
    // apply-destroy-reconcile-json.test.ts "text-mode success" test.
    vi.resetModules();
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
    // Same Commander-instance-reset rationale as the empty-state test
    // above — guards against `output: "json"` leaking in from a prior
    // parseAsync on the same singleton.
    vi.resetModules();
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
  // Wave 18: strengthened the three command-option-registration tests
  // below to assert the option's long-flag name explicitly. The
  // previous `toBeDefined()` would have passed for any non-undefined
  // Option object the find() returned, even one with a different long
  // flag — masking refactors that rename a flag.
  it("has --bp-coverage option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const bpOption = statusCommand.options.find(
      (opt) => opt.long === "--bp-coverage",
    );
    expect(bpOption?.long).toBe("--bp-coverage");
    expect(bpOption!.description).toBe("Show BP rule coverage dashboard");
  });

  it("has --region option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const regionOption = statusCommand.options.find(
      (opt) => opt.long === "--region",
    );
    expect(regionOption?.long).toBe("--region");
    expect(regionOption!.description).toBe("Filter to a specific AWS region");
  });

  it("has --json option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const jsonOption = statusCommand.options.find(
      (opt) => opt.long === "--json",
    );
    expect(jsonOption?.long).toBe("--json");
    // Epic 98 e98.W5.N3 (B-07 / D-16): `--json` is now the shorthand
    // for `--output json` on every command (same help text as
    // plan/apply/destroy/reconcile). The previous narrow description
    // "Output status data as JSON" predates the unified flag contract.
    expect(jsonOption!.description).toBe("Shorthand for --output json");
  });

  it("has -o, --output <format> option registered (B-07 / D-16 closure)", async () => {
    const { statusCommand } = await import("./status.js");
    const outputOption = statusCommand.options.find(
      (opt) => opt.long === "--output",
    );
    expect(outputOption?.long).toBe("--output");
    expect(outputOption?.short).toBe("-o");
    expect(outputOption!.description).toBe("Output format (json|text)");
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

  // Story 56-it1-01: --resource-type parity with MCP
  // list_managed_resources. Option is registered and long flag is
  // canonical so renames get caught by this assertion.
  it("has --resource-type option registered", async () => {
    const { statusCommand } = await import("./status.js");
    const opt = statusCommand.options.find((o) => o.long === "--resource-type");
    expect(opt?.long).toBe("--resource-type");
    expect(opt!.description).toMatch(/CFN resource type/i);
  });

  it("parses --resource-type value correctly", async () => {
    const { statusCommand } = await import("./status.js");
    statusCommand.parseOptions(["--resource-type", "AWS::S3::Bucket"]);
    expect(statusCommand.opts()["resourceType"]).toBe("AWS::S3::Bucket");
  });

  // Epic 92 e92.u.a (D-08): help text documents the [runId] positional
  // and recommends `list --json` for per-run queries.
  it("documents [runId] positional + list --json per-run guidance in help", async () => {
    const { statusCommand } = await import("./status.js");
    const helpText = statusCommand.helpInformation();
    // Commander renders optional positional args as `[runId]` in Usage.
    expect(helpText).toContain("[runId]");
    // The runId description nudges users at `list --json`. Commander
    // word-wraps long descriptions across lines, so normalise
    // whitespace before asserting the phrase is present.
    const collapsed = helpText.replace(/\s+/g, " ");
    expect(collapsed).toContain("assignee list --json");
  });
});

// Story 56-it1-01: runtime behaviour of `status --resource-type`.
// Mirrors the list-command tests: shorthand normalises to the CFN
// form, full CFN passes through, invalid types surface the SSO hint
// WITHOUT touching AWS.
/**
 * Reset commander option state on the shared statusCommand singleton
 * (see analogous helper in list.test.ts for the rationale). Prior
 * describe blocks call `parseOptions([...])` which leaves parsed
 * values on the module-level command; without this teardown the
 * Story 56-it1-01 tests below run with stale `resourceType` /
 * `bpCoverage` / `region` flags set.
 */
async function resetStatusCommandOptions(): Promise<void> {
  const { statusCommand } = await import("./status.js");
  const internals = statusCommand as unknown as {
    _optionValues: Record<string, unknown>;
  };
  for (const opt of statusCommand.options) {
    internals._optionValues[opt.attributeName()] = undefined;
  }
}

describe("status command --resource-type filter (Story 56-it1-01)", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    // Re-prime the module mocks vitest's `restoreMocks: true` wipes
    // between tests in other describe blocks (see existing comment in
    // the --bp-coverage DI describe), and clear leftover commander state.
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    vi.mocked(fetchManagedResources).mockReset();
    vi.mocked(buildStatusData).mockReset();
    await resetStatusCommandOptions();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("forwards --resource-type S3 (shorthand) as AWS::S3::Bucket to core", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue([mockResources[0]!]);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 1,
      totalEstimatedMonthlyCost: "$5.00/month",
      byType: [
        {
          type: "AWS::S3::Bucket",
          count: 1,
          estimatedMonthlyCost: "$5.00/month",
        },
      ],
      byRegion: [
        { region: "us-east-1", count: 1, estimatedMonthlyCost: "$5.00/month" },
      ],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    try {
      await statusCommand.parseAsync(
        ["node", "status", "--resource-type", "S3", "--json"],
        { from: "user" },
      );
    } catch {
      // process.exit throws
    }

    expect(fetchManagedResources).toHaveBeenCalledWith(
      undefined,
      "AWS::S3::Bucket",
    );
  });

  it("rejects an unsupported --resource-type with the SSO hint and skips AWS", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue([]);

    await expect(
      statusCommand.parseAsync(
        ["node", "status", "--resource-type", "NOT-A-REAL-TYPE"],
        { from: "user" },
      ),
    ).rejects.toThrow(/Unknown --resource-type "NOT-A-REAL-TYPE"/);

    // AWS must NOT have been hit when validation fails.
    expect(fetchManagedResources).not.toHaveBeenCalled();

    const stderrOutput = stderrSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("");
    // SSO hint header is rendered via renderError's `why:` channel.
    expect(stderrOutput).toContain("What you can create");
    expect(stderrOutput).toContain("AWS::S3::Bucket");
  });

  it("no --resource-type flag leaves filter undefined (regression)", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [],
      byRegion: [],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    try {
      await statusCommand.parseAsync(["node", "status", "--json"], {
        from: "user",
      });
    } catch {
      // process.exit throws
    }

    expect(fetchManagedResources).toHaveBeenCalledWith(undefined, undefined);
  });

  // Story 56-it2-04 P1-02: a non-INVALID_RESOURCE_TYPE_CODE throw from
  // the shared resolver now routes through `renderError` before being
  // re-thrown. Previously Commander dumped a bare stack and the user
  // had no actionable message. We mock the resolver to throw an
  // AssigneeError with a non-INVALID code and assert the friendly
  // fallback appears on stderr (renderError writes there).
  it("P1-02: non-INVALID_RESOURCE_TYPE_CODE resolver error still renders before re-throw", async () => {
    vi.resetModules();
    vi.doMock("./resource-type-filter.js", async () => {
      const actual = await vi.importActual<
        typeof import("./resource-type-filter.js")
      >("./resource-type-filter.js");
      const { AssigneeError } = await import("@assignee/core");
      return {
        ...actual,
        resolveResourceTypeFilter: (_input: string): string => {
          throw new AssigneeError(
            "simulated upstream failure",
            "SOME_OTHER_CODE",
          );
        },
      };
    });

    try {
      const { statusCommand } = await import("./status.js");

      await expect(
        statusCommand.parseAsync(["node", "status", "--resource-type", "ec2"], {
          from: "user",
        }),
      ).rejects.toThrow("simulated upstream failure");

      // renderError writes to stderr — the stderrSpy captures it.
      const stderrOutput = stderrSpy.mock.calls
        .map((c: unknown[]) => c[0])
        .join("");
      expect(stderrOutput).toContain(
        'Failed to validate --resource-type "ec2"',
      );
      expect(stderrOutput).toContain("`assignee status --help`");
      expect(stderrOutput).toContain("simulated upstream failure");
    } finally {
      vi.doUnmock("./resource-type-filter.js");
      vi.resetModules();
    }
  });
});

describe("status --bp-coverage uses status-factory for DI", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    // Re-prime module mocks because prior describes call restoreAllMocks,
    // which clears vi.fn() implementations created in vi.mock factories.
    const { getBpDir } = await import("./status-factory.js");
    const { computeBPCoverage, renderBPCoverage } =
      await import("./status-bp-coverage.js");
    vi.mocked(getBpDir).mockReset();
    vi.mocked(computeBPCoverage).mockReset();
    vi.mocked(renderBPCoverage).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls getBpDir() from status-factory and forwards the injected dir to computeBPCoverage", async () => {
    const { getBpDir } = await import("./status-factory.js");
    const { computeBPCoverage } = await import("./status-bp-coverage.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(getBpDir).mockReturnValue("/virtual/bp-fixture");
    const payload = {
      totalRules: 42,
      byCategory: [],
      bySeverity: [],
      byResourceType: [],
    };
    vi.mocked(computeBPCoverage).mockReturnValue(payload as never);

    // --json forces a deterministic output path (commander option state from
    // prior describes leaks through the shared statusCommand singleton).
    await statusCommand.parseAsync(
      ["node", "status", "--bp-coverage", "--json"],
      { from: "user" },
    );

    // Factory was consulted and its value flowed into the consumer
    expect(getBpDir).toHaveBeenCalledTimes(1);
    expect(computeBPCoverage).toHaveBeenCalledWith("/virtual/bp-fixture");
    expect(computeBPCoverage).toHaveBeenCalledTimes(1);
  });

  it("--bp-coverage --json writes JSON to stdout without hitting the real filesystem", async () => {
    const { getBpDir } = await import("./status-factory.js");
    const { computeBPCoverage } = await import("./status-bp-coverage.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(getBpDir).mockReturnValue("/virtual/bp-fixture-json");
    const payload = {
      totalRules: 7,
      byCategory: [{ category: "security", count: 7 }],
      bySeverity: [],
      byResourceType: [],
    };
    vi.mocked(computeBPCoverage).mockReturnValue(payload as never);

    await statusCommand.parseAsync(
      ["node", "status", "--bp-coverage", "--json"],
      { from: "user" },
    );

    expect(getBpDir).toHaveBeenCalled();
    expect(computeBPCoverage).toHaveBeenCalledWith("/virtual/bp-fixture-json");
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join("");
    expect(JSON.parse(output)).toEqual(payload);
  });
});

// ────────────────────────────────────────────────────────────────────────
// Epic 92 e92.u.a (A-12, D-36): observability envelope
// ────────────────────────────────────────────────────────────────────────

describe("status observability — Epic 92 e92.u.a", () => {
  let stdoutSpy: MockInstance<typeof process.stdout.write>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;
  let exitSpy: MockInstance<typeof process.exit>;

  beforeEach(async () => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
    stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
    // Re-prime shared mocks in case a prior describe block cleared them.
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { log } = await import("../utils/logger.js");
    vi.mocked(fetchManagedResources).mockReset();
    vi.mocked(buildStatusData).mockReset();
    vi.mocked(log).mockReset();
    await resetStatusCommandOptions();
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("D-36: emits STATUS_STARTED + STATUS_COMPLETE around a successful run", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { log } = await import("../utils/logger.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [],
      byRegion: [],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    await statusCommand.parseAsync(["node", "status", "--json"], {
      from: "user",
    });

    const calls = vi
      .mocked(log)
      .mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

    const started = calls.find(
      (ev) => ev["action"] === "status_started" && ev["level"] === "info",
    );
    expect(started).toBeDefined();
    expect(started!["runId"]).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect((started!["extras"] as Record<string, unknown>)["intent"]).toBe(
      "status",
    );

    const completed = calls.find((ev) => ev["action"] === "status_complete");
    expect(completed).toBeDefined();
    expect(completed!["level"]).toBe("info");
    expect(completed!["result"]).toBe("ok");
    expect(typeof completed!["durationMs"]).toBe("number");
    // Same runId on start and complete — correlation holds end-to-end.
    expect(completed!["runId"]).toBe(started!["runId"]);
  });

  it("D-36: emits STATUS_COMPLETE at error level when the body throws", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { log } = await import("../utils/logger.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockRejectedValue(
      new Error("AWS credentials not found"),
    );

    try {
      await statusCommand.parseAsync(["node", "status"], { from: "user" });
    } catch {
      // The action wraps in AssigneeError("STATUS_ERROR"); that's fine.
    }

    const calls = vi
      .mocked(log)
      .mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);

    const errorComplete = calls.find(
      (ev) => ev["action"] === "status_complete" && ev["level"] === "error",
    );
    expect(errorComplete).toBeDefined();
    expect(errorComplete!["result"]).toBe("error");
    expect(
      (errorComplete!["extras"] as Record<string, unknown>)["errorMessage"],
    ).toBe("AWS credentials not found");
  });

  it("A-12: `status <runId>` warns then still renders the default summary", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { log } = await import("../utils/logger.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [],
      byRegion: [],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    // Use default `from: "node"` so commander strips argv[0]/argv[1] and
    // the third element becomes the [runId] positional. `from: "user"`
    // (used by tests above) does NOT strip a prefix — which was harmless
    // before e92.u.a added the argument but would capture "node" as the
    // positional with the new surface.
    await statusCommand.parseAsync(["node", "status", "stale-run-id-abc-123"]);

    // A structured WARN event lands alongside the INFO start event.
    const calls = vi
      .mocked(log)
      .mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const warn = calls.find(
      (ev) => ev["action"] === "status_started" && ev["level"] === "warn",
    );
    expect(warn).toBeDefined();
    const extras = warn!["extras"] as Record<string, unknown>;
    expect(extras["warning"]).toBe("runId-positional-ignored");
    expect(extras["suppliedRunId"]).toBe("stale-run-id-abc-123");
    expect(extras["hint"]).toContain("assignee list --json");

    // Human-facing stderr line is emitted outside --json so operators
    // without --verbose still see the warning.
    const stderrOutput = stderrSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("");
    expect(stderrOutput).toContain("[WARN]");
    expect(stderrOutput).toContain("stale-run-id-abc-123");
    expect(stderrOutput).toContain("assignee list --json");

    // And the default summary did NOT get blocked — buildStatusData ran.
    expect(fetchManagedResources).toHaveBeenCalled();
    expect(buildStatusData).toHaveBeenCalled();
  });

  it("A-12: `status <runId> --json` suppresses the human-readable stderr WARN but keeps the structured event", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { log } = await import("../utils/logger.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [],
      byRegion: [],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    await statusCommand.parseAsync([
      "node",
      "status",
      "stale-run-id-json",
      "--json",
    ]);

    const stderrOutput = stderrSpy.mock.calls
      .map((c: unknown[]) => c[0])
      .join("");
    // JSON mode: no human-readable `[WARN]` line on stderr.
    expect(stderrOutput).not.toContain("[WARN]");

    // Structured WARN event still emitted so the machinery is honest
    // about dropping the runId.
    const calls = vi
      .mocked(log)
      .mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const warn = calls.find(
      (ev) => ev["action"] === "status_started" && ev["level"] === "warn",
    );
    expect(warn).toBeDefined();
    expect((warn!["extras"] as Record<string, unknown>)["suppliedRunId"]).toBe(
      "stale-run-id-json",
    );
  });

  it("regression: `status` (no positional) emits NO WARN event", async () => {
    const { fetchManagedResources } =
      await import("../services/list-resources.js");
    const { buildStatusData } =
      await import("../services/status-aggregator.js");
    const { log } = await import("../utils/logger.js");
    const { statusCommand } = await import("./status.js");

    vi.mocked(fetchManagedResources).mockResolvedValue(mockResources);
    vi.mocked(buildStatusData).mockResolvedValue({
      totalResources: 2,
      totalEstimatedMonthlyCost: "$15.00/month",
      byType: [],
      byRegion: [],
      lastUpdated: "2026-03-22T00:00:00.000Z",
    });

    // Default `from: "node"` so argv[0]="node" and argv[1]="status" are
    // stripped — no surplus positional captured as runId.
    await statusCommand.parseAsync(["node", "status"]);

    const calls = vi
      .mocked(log)
      .mock.calls.map((c: unknown[]) => c[0] as Record<string, unknown>);
    const warn = calls.find(
      (ev) => ev["action"] === "status_started" && ev["level"] === "warn",
    );
    expect(warn).toBeUndefined();
  });
});
