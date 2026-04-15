/**
 * Tests for `assignee destroy` command.
 *
 * @see Story 18.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks (accessible inside vi.mock factories) ─────────────────────
// A6 (2026-04-08): mockLambdaSend was removed after Lambda EventSourceMapping
// was migrated from the SDK fallback to CCAPI. The @aws-sdk/client-lambda
// module is no longer imported by sdk-fallback-dispatcher, so mocking it
// here is dead code.
const {
  mockText,
  mockOutro,
  mockIsCancel,
  mockCCSend,
  mockTaggingSend,
  mockSnsSend,
  mockResolveResource,
  mockCreateTaggingClient,
  mockPlanBulkDestroy,
  mockDestroySingleResource,
} = vi.hoisted(() => ({
  mockText: vi.fn(),
  mockOutro: vi.fn(),
  mockIsCancel: vi.fn().mockReturnValue(false),
  mockCCSend: vi.fn(),
  mockTaggingSend: vi.fn(),
  mockSnsSend: vi.fn(),
  mockResolveResource: vi.fn(),
  mockCreateTaggingClient: vi.fn().mockReturnValue({}),
  mockPlanBulkDestroy: vi.fn(),
  mockDestroySingleResource: vi.fn(),
}));

// ── Mock @clack/prompts ─────────────────────────────────────────────────────
vi.mock("@clack/prompts", () => ({
  text: (...args: unknown[]) => mockText(...args),
  outro: (...args: unknown[]) => mockOutro(...args),
  isCancel: (...args: unknown[]) => mockIsCancel(...args),
  spinner: () => ({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
  }),
  autocomplete: vi.fn(),
  autocompleteMultiselect: vi.fn(),
}));

// ── Mock boxen ──────────────────────────────────────────────────────────────
vi.mock("boxen", () => ({
  default: (content: string) => content,
}));

// ── Mock chalk ──────────────────────────────────────────────────────────────
vi.mock("chalk", () => {
  const identity = (s: string) => s;
  const withBold = Object.assign(identity, { bold: identity });
  return {
    default: {
      red: Object.assign(identity, { bold: withBold }),
      green: Object.assign(identity, { bold: withBold }),
      yellow: Object.assign(identity, { bold: withBold }),
      cyan: Object.assign(identity, { bold: withBold }),
      dim: identity,
      bold: identity,
    },
  };
});

// ── Mock AWS SDK clients ────────────────────────────────────────────────────
vi.mock("@aws-sdk/client-cloudcontrol", () => {
  class MockCloudControlClient {
    send = mockCCSend;
  }
  class ResourceNotFoundException extends Error {
    constructor(m: string) {
      super(m);
      this.name = "ResourceNotFoundException";
    }
  }
  class AlreadyExistsException extends Error {
    constructor(m: string) {
      super(m);
      this.name = "AlreadyExistsException";
    }
  }
  class ThrottlingException extends Error {
    constructor(m: string) {
      super(m);
      this.name = "ThrottlingException";
    }
  }
  class GeneralServiceException extends Error {
    constructor(m: string) {
      super(m);
      this.name = "GeneralServiceException";
    }
  }
  return {
    CloudControlClient: MockCloudControlClient,
    CreateResourceCommand: vi.fn(),
    DeleteResourceCommand: vi.fn(),
    GetResourceCommand: vi.fn(),
    GetResourceRequestStatusCommand: vi.fn(),
    ResourceNotFoundException,
    AlreadyExistsException,
    ThrottlingException,
    GeneralServiceException,
  };
});

vi.mock("@aws-sdk/client-resource-groups-tagging-api", () => {
  class MockResourceGroupsTaggingAPIClient {
    send = mockTaggingSend;
  }
  return {
    ResourceGroupsTaggingAPIClient: MockResourceGroupsTaggingAPIClient,
    GetResourcesCommand: vi.fn(),
  };
});

vi.mock("@aws-sdk/client-sns", () => {
  class MockSNSClient {
    send = mockSnsSend;
  }
  return {
    SNSClient: MockSNSClient,
    SubscribeCommand: vi.fn(),
    UnsubscribeCommand: vi.fn(),
  };
});

// ── Mock modules ────────────────────────────────────────────────────────────
vi.mock("../services/resource-resolver.js", () => ({
  resolveResource: (...args: unknown[]) => mockResolveResource(...args),
  createTaggingClient: (...args: unknown[]) => mockCreateTaggingClient(...args),
  // Story 48.6: single-flow uses this guard to route multi-match through
  // the disambiguation picker. Keep in sync with real implementation.
  isAmbiguousResolution: (value: unknown): boolean =>
    value !== null &&
    typeof value === "object" &&
    (value as { kind?: unknown }).kind === "ambiguous",
}));

vi.mock("../services/cloudcontrol-client.js", () => ({
  createCloudControlClient: vi.fn().mockReturnValue({ send: mockCCSend }),
}));

vi.mock("../services/destroy-service.js", () => ({
  destroySingleResource: (...args: unknown[]) =>
    mockDestroySingleResource(...args),
}));

vi.mock("../services/bulk-destroy.js", () => ({
  planBulkDestroy: (...args: unknown[]) => mockPlanBulkDestroy(...args),
}));

vi.mock("../services/billing.js", () => ({
  getCostSavingsEstimate: vi.fn().mockResolvedValue("$5.00/mo"),
}));

vi.mock("../services/mcp-client.js", () => ({
  getBillingMcpToolsAsync: vi.fn().mockResolvedValue([]),
}));

vi.mock("../utils/display.js", () => ({
  startSpinner: vi.fn(),
  stopSpinner: vi.fn(),
  updateSpinner: vi.fn(),
}));

vi.mock("../config/operator-credentials.js", () => ({
  operatorCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    region: "us-east-1",
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────
import { destroyAction } from "./destroy.js";

// No longer need to mock process.exit — source throws errors directly

// Store original isTTY values
const origStdinIsTTY = process.stdin.isTTY;
const origStdoutIsTTY = process.stdout.isTTY;

// Capture stderr/stdout writes
let stderrOutput: string;
let stdoutOutput: string;
const origStderrWrite = process.stderr.write.bind(process.stderr);
const origStdoutWrite = process.stdout.write.bind(process.stdout);

beforeEach(() => {
  vi.clearAllMocks();
  stderrOutput = "";
  stdoutOutput = "";

  process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
    stderrOutput += String(chunk);
    return true;
  }) as typeof process.stderr.write;

  process.stdout.write = vi.fn((chunk: string | Uint8Array) => {
    stdoutOutput += String(chunk);
    return true;
  }) as typeof process.stdout.write;

  // Default: interactive TTY
  Object.defineProperty(process.stdin, "isTTY", {
    value: true,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    writable: true,
    configurable: true,
  });

  // Set required env vars
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "test-key";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "test-secret";
  process.env["AWS_REGION"] = "us-east-1";
});

afterEach(() => {
  process.stderr.write = origStderrWrite;
  process.stdout.write = origStdoutWrite;
  Object.defineProperty(process.stdin, "isTTY", {
    value: origStdinIsTTY,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: origStdoutIsTTY,
    writable: true,
    configurable: true,
  });
});

const mockResource = {
  arn: "arn:aws:s3:::test-bucket",
  resourceType: "AWS::S3::Bucket",
  region: "us-east-1",
  tags: { "managed-by": "assignee-ai" },
  identifier: "test-bucket",
};

describe("assignee destroy", () => {
  describe("--include-iam without --all", () => {
    it("rejects --include-iam without --all", async () => {
      // Item 4b (2026-04-10): error text updated to a guide-the-user
      // message with a concrete `assignee destroy --all --include-iam`
      // suggestion. Assertion matches on the invariant phrase
      // "bulk-destroy mode" which anchors the guidance.
      await expect(
        destroyAction("some-resource", { includeIam: true }),
      ).rejects.toThrow(/--include-iam only works in bulk-destroy mode/);
    });
  });

  describe("--dry-run without --all", () => {
    it("rejects --dry-run without --all", async () => {
      await expect(
        destroyAction("some-resource", { dryRun: true }),
      ).rejects.toThrow(/--dry-run only works in bulk-destroy mode/);
    });
  });

  describe("missing resource argument", () => {
    it("rejects when no resource and no --all", async () => {
      // Item 4b (2026-04-10): error rewritten to guide-the-user with
      // concrete examples. Assertion matches the invariant phrase
      // "needs to know what to destroy" which anchors the guidance.
      await expect(destroyAction(undefined, {})).rejects.toThrow(
        /needs to know what to destroy/,
      );
    });
  });

  describe("resource resolution", () => {
    it("shows error when no managed resource is found", async () => {
      mockResolveResource.mockResolvedValue(null);

      await expect(destroyAction("nonexistent-bucket", {})).rejects.toThrow(
        'No managed resource found matching "nonexistent-bucket"',
      );
    });
  });

  describe("confirmation prompt (typed-name — Wave-2 P1-6)", () => {
    it("exact identifier match proceeds with delete", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("test-bucket");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", {});
      expect(stdoutOutput).toContain("Resource destroyed");
      // Verify the prompt message now quotes the identifier, not "yes"
      expect(mockText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("'test-bucket'"),
        }),
      );
    });

    it('legacy "yes" input aborts (typed-name gate is strict)', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("yes");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"y" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("y");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("identifier match is case-insensitive (TEST-BUCKET)", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("TEST-BUCKET");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        identifier: mockResource.identifier,
        resourceType: mockResource.resourceType,
      });

      await destroyAction("test-bucket", {});
      expect(mockDestroySingleResource).toHaveBeenCalled();
    });

    it("identifier match is case-insensitive (Test-Bucket)", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("Test-Bucket");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        identifier: mockResource.identifier,
        resourceType: mockResource.resourceType,
      });

      await destroyAction("test-bucket", {});
      expect(mockDestroySingleResource).toHaveBeenCalled();
    });

    it("whitespace-padded identifier is accepted (trimmed)", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("  test-bucket  ");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        identifier: mockResource.identifier,
        resourceType: mockResource.resourceType,
      });

      await destroyAction("test-bucket", {});
      expect(mockDestroySingleResource).toHaveBeenCalled();
    });

    it('"no" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("no");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("wrong identifier aborts (catches copy-paste errors)", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("other-bucket");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("falls back to last ARN segment when identifier is empty", async () => {
      const arnOnlyResource = {
        ...mockResource,
        identifier: "",
      };
      mockResolveResource.mockResolvedValue(arnOnlyResource);
      mockText.mockResolvedValue("test-bucket");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        identifier: "",
        resourceType: mockResource.resourceType,
      });

      await destroyAction("test-bucket", {});
      expect(mockDestroySingleResource).toHaveBeenCalled();
    });

    it("empty string input aborts", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("cancelled prompt (Ctrl+C) aborts", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      const cancelSymbol = Symbol("cancel");
      mockText.mockResolvedValue(cancelSymbol);
      mockIsCancel.mockReturnValue(true);

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });
  });

  describe("--yes flag", () => {
    it("auto-confirms without prompt", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", { yes: true });
      expect(mockText).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain("Resource destroyed");
    });

    it("warns when used in interactive TTY", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", { yes: true });
      expect(stderrOutput).toContain("--yes flag used in interactive session");
    });
  });

  describe("non-TTY without --yes", () => {
    it("produces error", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });

      mockResolveResource.mockResolvedValue(mockResource);

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy requires confirmation",
      );
    });
  });

  describe("cost savings display", () => {
    it("displays cost savings message on success", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", { yes: true });
      expect(stdoutOutput).toContain("Estimated savings:");
    });
  });

  describe("delete failure", () => {
    it("produces actionable error on delete failure", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockDestroySingleResource.mockResolvedValue({
        success: false,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
        error: "Destroy failed: BucketNotEmpty: The bucket is not empty",
      });

      await expect(destroyAction("test-bucket", { yes: true })).rejects.toThrow(
        "Destroy failed: BucketNotEmpty",
      );
    });
  });

  // ─── Story 48.6: multi-match disambiguation ────────────────────────────
  describe("multi-match disambiguation (Story 48.6)", () => {
    const ambiguousMatchA = {
      arn: "arn:aws:s3:::my-bucket-prod",
      resourceType: "AWS::S3::Bucket",
      region: "us-east-1",
      tags: { "managed-by": "assignee-ai", env: "prod" },
      identifier: "my-bucket-prod",
    };
    const ambiguousMatchB = {
      arn: "arn:aws:s3:::my-bucket-prod-replica",
      resourceType: "AWS::S3::Bucket",
      region: "us-west-2",
      tags: { "managed-by": "assignee-ai", env: "prod" },
      identifier: "my-bucket-prod-replica",
    };
    const ambiguousResolution = {
      kind: "ambiguous" as const,
      input: "my-bucket",
      matches: [ambiguousMatchA, ambiguousMatchB],
    };

    it("single match → no disambiguation prompt, straight to typed-confirm", async () => {
      // Regression: single match must NOT trigger the multi-match picker.
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("test-bucket");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", {});

      // Only ONE clack.text call — the typed-confirm. No picker prompt.
      expect(mockText).toHaveBeenCalledTimes(1);
      expect(mockText).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining("'test-bucket'"),
        }),
      );
    });

    it("multi-match → user picks by index → that resource flows through typed-confirm", async () => {
      mockResolveResource.mockResolvedValue(ambiguousResolution);
      // First clack.text: picker ("2"); second: typed-confirm (identifier).
      mockText
        .mockResolvedValueOnce("2")
        .mockResolvedValueOnce("my-bucket-prod-replica");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "my-bucket-prod-replica",
        arn: ambiguousMatchB.arn,
      });

      await destroyAction("my-bucket", {});

      expect(stdoutOutput).toContain(
        'Multiple managed resources match "my-bucket"',
      );
      expect(stdoutOutput).toContain("[1] " + ambiguousMatchA.arn);
      expect(stdoutOutput).toContain("[2] " + ambiguousMatchB.arn);
      expect(mockDestroySingleResource).toHaveBeenCalledTimes(1);
      expect(mockDestroySingleResource).toHaveBeenCalledWith(
        expect.objectContaining({ arn: ambiguousMatchB.arn }),
        expect.anything(),
      );
    });

    it("multi-match → user pastes an ARN from the list → that resource flows through typed-confirm", async () => {
      mockResolveResource.mockResolvedValue(ambiguousResolution);
      mockText
        .mockResolvedValueOnce(ambiguousMatchA.arn)
        .mockResolvedValueOnce("my-bucket-prod");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "my-bucket-prod",
        arn: ambiguousMatchA.arn,
      });

      await destroyAction("my-bucket", {});

      expect(mockDestroySingleResource).toHaveBeenCalledWith(
        expect.objectContaining({ arn: ambiguousMatchA.arn }),
        expect.anything(),
      );
    });

    it("multi-match → user types 'cancel' → UserCancelledError, zero destroy calls", async () => {
      mockResolveResource.mockResolvedValue(ambiguousResolution);
      mockText.mockResolvedValueOnce("cancel");

      await expect(destroyAction("my-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockDestroySingleResource).not.toHaveBeenCalled();
    });

    it("multi-match → Ctrl-C → UserCancelledError, zero destroy calls", async () => {
      mockResolveResource.mockResolvedValue(ambiguousResolution);
      const cancelSymbol = Symbol("cancel");
      mockText.mockResolvedValueOnce(cancelSymbol);
      mockIsCancel.mockReturnValueOnce(true);

      await expect(destroyAction("my-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockDestroySingleResource).not.toHaveBeenCalled();
    });

    it("multi-match + --yes → AssigneeError with actionable message, zero destroy calls", async () => {
      mockResolveResource.mockResolvedValue(ambiguousResolution);

      await expect(destroyAction("my-bucket", { yes: true })).rejects.toThrow(
        /Multiple managed resources match "my-bucket"; pass an explicit ARN\. Matches: arn:aws:s3:::my-bucket-prod, arn:aws:s3:::my-bucket-prod-replica/,
      );
      expect(mockText).not.toHaveBeenCalled();
      expect(mockDestroySingleResource).not.toHaveBeenCalled();
    });

    it("multi-match + non-TTY stdin (no --yes) → AssigneeError with actionable message", async () => {
      Object.defineProperty(process.stdin, "isTTY", {
        value: false,
        writable: true,
        configurable: true,
      });
      mockResolveResource.mockResolvedValue(ambiguousResolution);

      await expect(destroyAction("my-bucket", {})).rejects.toThrow(
        /Multiple managed resources match "my-bucket"; pass an explicit ARN\. Matches: /,
      );
      expect(mockText).not.toHaveBeenCalled();
      expect(mockDestroySingleResource).not.toHaveBeenCalled();
    });
  });

  // ── Bulk destroy (--all) ──────────────────────────────────────────────────
  describe("--all bulk destroy", () => {
    const tier1Resource = {
      arn: "arn:aws:logs:us-east-1:123456:log-group:my-logs",
      resourceType: "AWS::Logs::LogGroup",
      identifier: "my-logs",
      region: "us-east-1",
      tier: 1,
    };
    const tier2Resource = {
      arn: "arn:aws:lambda:us-east-1:123456:function:my-func",
      resourceType: "AWS::Lambda::Function",
      identifier: "my-func",
      region: "us-east-1",
      tier: 2,
    };
    const tier5Resource = {
      arn: "arn:aws:s3:::my-bucket",
      resourceType: "AWS::S3::Bucket",
      identifier: "my-bucket",
      region: "us-east-1",
      tier: 5,
    };

    it("calls planBulkDestroy and destroySingleResource for each resource", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [tier1Resource, tier2Resource],
        totalCount: 2,
        iamCount: 0,
        excludedCount: 0,
      });
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::Logs::LogGroup",
        identifier: "my-logs",
        arn: "arn:aws:logs:us-east-1:123456:log-group:my-logs",
      });

      await destroyAction(undefined, { all: true, yes: true });

      expect(mockPlanBulkDestroy).toHaveBeenCalled();
      expect(mockDestroySingleResource).toHaveBeenCalledTimes(2);
      expect(stdoutOutput).toContain("2 destroyed");
    });

    it("--all --dry-run shows plan but never calls destroySingleResource", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [tier1Resource, tier5Resource],
        totalCount: 2,
        iamCount: 0,
        excludedCount: 0,
      });

      await destroyAction(undefined, { all: true, dryRun: true });

      expect(mockPlanBulkDestroy).toHaveBeenCalled();
      expect(mockDestroySingleResource).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain("Dry run");
    });

    it("--all with zero resources shows no-resources message", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [],
        totalCount: 0,
        iamCount: 0,
        excludedCount: 0,
      });

      await destroyAction(undefined, { all: true, yes: true });

      expect(mockDestroySingleResource).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain("No managed resources found");
    });

    it("destroys in tier order (tier 1 before tier 5)", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [tier1Resource, tier2Resource, tier5Resource],
        totalCount: 3,
        iamCount: 0,
        excludedCount: 0,
      });
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "test",
        identifier: "test",
        arn: "test",
      });

      await destroyAction(undefined, { all: true, yes: true });

      const calls = mockDestroySingleResource.mock.calls;
      expect(calls[0]![0].tier).toBe(1);
      expect(calls[1]![0].tier).toBe(2);
      expect(calls[2]![0].tier).toBe(5);
    });

    it("failed destroy continues to next resource", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [tier1Resource, tier2Resource],
        totalCount: 2,
        iamCount: 0,
        excludedCount: 0,
      });
      mockDestroySingleResource
        .mockResolvedValueOnce({
          success: false,
          resourceType: "AWS::Logs::LogGroup",
          identifier: "my-logs",
          arn: tier1Resource.arn,
          error: "Access denied",
        })
        .mockResolvedValueOnce({
          success: true,
          resourceType: "AWS::Lambda::Function",
          identifier: "my-func",
          arn: tier2Resource.arn,
        });

      await destroyAction(undefined, { all: true, yes: true });

      // Both resources were attempted
      expect(mockDestroySingleResource).toHaveBeenCalledTimes(2);
    });

    it("summary shows correct destroyed/failed counts", async () => {
      mockPlanBulkDestroy.mockResolvedValue({
        resources: [tier1Resource, tier2Resource, tier5Resource],
        totalCount: 3,
        iamCount: 0,
        excludedCount: 0,
      });
      mockDestroySingleResource
        .mockResolvedValueOnce({
          success: true,
          resourceType: tier1Resource.resourceType,
          identifier: tier1Resource.identifier,
          arn: tier1Resource.arn,
        })
        .mockResolvedValueOnce({
          success: false,
          resourceType: tier2Resource.resourceType,
          identifier: tier2Resource.identifier,
          arn: tier2Resource.arn,
          error: "BucketNotEmpty",
        })
        .mockResolvedValueOnce({
          success: true,
          resourceType: tier5Resource.resourceType,
          identifier: tier5Resource.identifier,
          arn: tier5Resource.arn,
        });

      await destroyAction(undefined, { all: true, yes: true });

      expect(stdoutOutput).toContain("2 destroyed");
      expect(stdoutOutput).toContain("1 failed");
    });
  });
});

// ── P2-R2-5: resourceConfirmationToken edge cases ───────────────────────────

describe("resourceConfirmationToken — edge cases (P2-R2-5)", () => {
  // Lazy-import so it picks up the mocked module graph once.
  const load = async () =>
    (await import("./destroy.js")).resourceConfirmationToken;

  it("returns the raw identifier when present (happy path)", async () => {
    const fn = await load();
    expect(fn({ identifier: "my-bucket", arn: "arn:aws:s3:::my-bucket" })).toBe(
      "my-bucket",
    );
  });

  it("preserves internal spaces in identifier (case-insensitive paste)", async () => {
    const fn = await load();
    expect(
      fn({ identifier: "my bucket 1", arn: "arn:aws:s3:::my bucket 1" }),
    ).toBe("my bucket 1");
  });

  it("strips trailing slash from identifier (CFN Export edge case)", async () => {
    const fn = await load();
    expect(
      fn({
        identifier: "my-cluster/",
        arn: "arn:aws:ecs:us-east-1:111111111111:cluster/my-cluster",
      }),
    ).toBe("my-cluster");
  });

  it("falls back to ARN tail when identifier is pure whitespace", async () => {
    const fn = await load();
    expect(
      fn({
        identifier: "   ",
        arn: "arn:aws:s3:::my-bucket",
      }),
    ).toBe("my-bucket");
  });

  it("falls back to full ARN when identifier and tail both collapse to empty", async () => {
    const fn = await load();
    const arn = "arn:aws:s3:::my-bucket/";
    // identifier "   /" trims to empty; ARN tail pops to "" (because ARN ends in "/")
    expect(fn({ identifier: "   /", arn })).toBe(arn);
  });

  it("handles ARN-only input (no identifier) by using ARN tail", async () => {
    const fn = await load();
    expect(fn({ arn: "arn:aws:iam::111111111111:role/MyRole" })).toBe("MyRole");
  });
});
