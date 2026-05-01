import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ExecutionMode, ExecutionStatus } from "../index.js";

// NOTE: Plain functions/classes survive vitest's mockReset:true. vi.fn-based
// mocks have their default behavior re-installed in beforeEach.
//
// Story 50-4 Wave 5 Pass I: moved from `apps/cli/src/services/graph.test.ts`.
// Assertions unchanged — only mock-target paths + test-side import paths
// point at core-internal modules (createGraph lives in core now).
//
// C4 fix (Wave 1): the `vi.mock("../services/cloudcontrol-client.js", ...)`
// block has been removed. createGraph now handles missing credentials
// gracefully — it emits a stderr warning and constructs the AWS SDK client
// directly, so the test mask was hiding the real bug (empty-string creds
// being passed to the validating factory). Tests that exercise the compiled
// graph set mock ASSIGNEE_OPERATOR_* env vars via ProcessEnvConfigAdapter
// so createCloudControlClient is called with real (test-fixture) credentials.

// Mock AI SDK (used by intent-parser and plan-generator)
vi.mock("ai", () => ({
  generateText: vi.fn(),
  Output: { object: vi.fn() },
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: () => () => undefined,
}));

// Mock LlmAdapter so create-graph.ts doesn't resolve real providers.
// Return Result tuples matching LlmPort interface.
vi.mock("../llm/adapter.js", () => ({
  LlmAdapter: vi.fn(),
}));

// Mock the nodes that have external dependencies or side-effects
// W11-S1: schemaFetcherNode is no longer exported directly — the module now
// exports a factory `createSchemaFetcherNode(service)` that returns a node
// function. Tests intercept by hoisting a single vi.fn() and having the
// factory return it on every invocation.
const mockSchemaFetcherFn = vi.hoisted(() => vi.fn());
vi.mock("./nodes/schema-fetcher.js", () => ({
  createSchemaFetcherNode: () => mockSchemaFetcherFn,
}));

vi.mock("./nodes/preflight-guard.js", () => ({
  preflightGuardNode: vi.fn(),
}));

vi.mock("./nodes/human-approval.js", () => ({
  humanApprovalNode: vi.fn(),
}));

vi.mock("./nodes/result-formatter.js", () => ({
  resultFormatterNode: vi.fn(),
}));

import { createGraph } from "./create-graph.js";
import { LlmAdapter } from "../llm/adapter.js";
// W11-S1: schemaFetcherNode replaced by createSchemaFetcherNode factory; the
// mock returns `mockSchemaFetcherFn` so tests control behaviour via that spy
// directly (no `vi.mocked(...)` wrapper needed).
import { preflightGuardNode } from "./nodes/preflight-guard.js";
import { humanApprovalNode } from "./nodes/human-approval.js";
import { resultFormatterNode } from "./nodes/result-formatter.js";

// Real test-fixture credentials (shape matches IAM long-term access keys).
// These are never sent to AWS — the plan-mode graph never calls the provisioner.
const TEST_ACCESS_KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const TEST_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

/** Saved process.env values — restored in afterEach. */
let savedAccessKey: string | undefined;
let savedSecretKey: string | undefined;

beforeEach(() => {
  // Capture originals so we can restore them even if a test mutates them.
  savedAccessKey = process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
  savedSecretKey = process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

  // Default: set valid-looking operator credentials so createCloudControlClient
  // is exercised through the real validating path. Tests that need to exercise
  // the missing-credential path delete these in their own setup.
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = TEST_ACCESS_KEY_ID;
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = TEST_SECRET_ACCESS_KEY;

  vi.mocked(LlmAdapter).mockImplementation(
    () =>
      ({
        generateStructured: vi
          .fn()
          .mockResolvedValue([null, { resourceType: "AWS::S3::Bucket" }]),
        generateText: vi
          .fn()
          .mockResolvedValue([null, '{"BucketName":"test-bucket"}']),
      }) as unknown as InstanceType<typeof LlmAdapter>,
  );
  mockSchemaFetcherFn.mockResolvedValue({
    resourceSchema: {
      properties: { BucketName: { type: "string" } },
      required: ["BucketName"],
    },
  } as never);
  vi.mocked(preflightGuardNode).mockResolvedValue({
    preflightPassed: true,
    estimatedMonthlyCost: "N/A",
  } as never);
  vi.mocked(humanApprovalNode).mockResolvedValue({} as never);
  vi.mocked(resultFormatterNode).mockResolvedValue({} as never);
});

afterEach(() => {
  // Restore operator credential env vars to their original state.
  if (savedAccessKey === undefined) {
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
  } else {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = savedAccessKey;
  }
  if (savedSecretKey === undefined) {
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
  } else {
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = savedSecretKey;
  }
});

describe("createGraph", () => {
  it("graph compiles and runs in plan mode without hitting resource_provisioner", async () => {
    const graph = createGraph();

    const result = await graph.invoke(
      {
        userIntent: "Create an S3 bucket named test-bucket",
        executionMode: ExecutionMode.PLAN,
      },
      { configurable: { thread_id: "test-thread-plan" } },
    );

    // Plan mode routes preflight → result_formatter (skips human_approval/resource_provisioner)
    expect(result.executionStatus).not.toBe(ExecutionStatus.FAILED);
    expect(result.preflightPassed).toBe(true);
  });

  it("emits a stderr warning when operator credentials are absent — does not throw", () => {
    // Remove operator credentials to exercise the missing-cred fallback path.
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      // createGraph must NOT throw even when credentials are absent
      // (lenient-at-construction contract from R10a-03).
      expect(() => createGraph()).not.toThrow();

      // The warning message must have been written to stderr.
      const calls = stderrSpy.mock.calls.map((args) => String(args[0]));
      expect(
        calls.some((msg) =>
          msg.includes(
            "assignee: operator credentials not found — downstream AWS calls will fail with auth errors",
          ),
        ),
      ).toBe(true);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("does not write a missing-cred warning when valid operator credentials are present", () => {
    // Credentials are set in beforeEach — no warning should be emitted.
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    try {
      expect(() => createGraph()).not.toThrow();

      const calls = stderrSpy.mock.calls.map((args) => String(args[0]));
      expect(
        calls.some((msg) => msg.includes("operator credentials not found")),
      ).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});
