/**
 * Tests for `assignee destroy` command.
 *
 * @see Story 18.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mocks (accessible inside vi.mock factories) ─────────────────────
const {
  mockText,
  mockOutro,
  mockIsCancel,
  mockCCSend,
  mockTaggingSend,
  mockLambdaSend,
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
  mockLambdaSend: vi.fn(),
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

vi.mock("@aws-sdk/client-lambda", () => {
  class MockLambdaClient {
    send = mockLambdaSend;
  }
  return {
    LambdaClient: MockLambdaClient,
    CreateEventSourceMappingCommand: vi.fn(),
    DeleteEventSourceMappingCommand: vi.fn(),
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
      await expect(
        destroyAction("some-resource", { includeIam: true }),
      ).rejects.toThrow("--include-iam can only be used with --all");
    });
  });

  describe("--dry-run without --all", () => {
    it("rejects --dry-run without --all", async () => {
      await expect(
        destroyAction("some-resource", { dryRun: true }),
      ).rejects.toThrow("--dry-run can only be used with --all");
    });
  });

  describe("missing resource argument", () => {
    it("rejects when no resource and no --all", async () => {
      await expect(destroyAction(undefined, {})).rejects.toThrow(
        "Resource ARN or name is required",
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

  describe("confirmation prompt", () => {
    it('exact "yes" input proceeds with delete', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("yes");
      mockDestroySingleResource.mockResolvedValue({
        success: true,
        resourceType: "AWS::S3::Bucket",
        identifier: "test-bucket",
        arn: "arn:aws:s3:::test-bucket",
      });

      await destroyAction("test-bucket", {});
      expect(stdoutOutput).toContain("Resource destroyed");
    });

    it('"y" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("y");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"Y" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("Y");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"YES" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("YES");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"no" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("no");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "Destroy cancelled.",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
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
