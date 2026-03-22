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
}));

// ── Mock boxen ──────────────────────────────────────────────────────────────
vi.mock("boxen", () => ({
  default: (content: string) => content,
}));

// ── Mock chalk ──────────────────────────────────────────────────────────────
vi.mock("chalk", () => ({
  default: {
    red: (s: string) => s,
    green: (s: string) => s,
    yellow: (s: string) => s,
    cyan: { bold: (s: string) => s },
    dim: (s: string) => s,
  },
}));

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

// ── Import after mocks ─────────────────────────────────────────────────────
import { destroyAction } from "./destroy.js";

// Mock process.exit to throw instead of exiting
const mockExit = vi.spyOn(process, "exit").mockImplementation(((
  code?: number,
) => {
  throw new Error(`process.exit(${code})`);
}) as (code?: string | number | null | undefined) => never);

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

  // Re-mock process.exit after clearAllMocks
  mockExit.mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as (code?: string | number | null | undefined) => never);

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
  describe("--all rejection", () => {
    it("rejects --all with error message", async () => {
      await expect(destroyAction("--all", {})).rejects.toThrow(
        "process.exit(1)",
      );
      expect(stderrOutput).toContain("--all is not supported");
      expect(stderrOutput).toContain("Destroy resources individually");
    });
  });

  describe("resource resolution", () => {
    it("shows error when no managed resource is found", async () => {
      mockResolveResource.mockResolvedValue(null);

      await expect(destroyAction("nonexistent-bucket", {})).rejects.toThrow(
        "process.exit(1)",
      );
      expect(stderrOutput).toContain(
        'No managed resource found matching "nonexistent-bucket"',
      );
      expect(stderrOutput).toContain("assignee list");
    });
  });

  describe("confirmation prompt", () => {
    it('exact "yes" input proceeds with delete', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("yes");
      // deleteResource call
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-123" },
      });
      // getRequestStatus call
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
      });

      await destroyAction("test-bucket", {});
      expect(stdoutOutput).toContain("Resource destroyed");
    });

    it('"y" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("y");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"Y" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("Y");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"YES" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("YES");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it('"no" input aborts', async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("no");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("empty string input aborts", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockText.mockResolvedValue("");

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });

    it("cancelled prompt (Ctrl+C) aborts", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      const cancelSymbol = Symbol("cancel");
      mockText.mockResolvedValue(cancelSymbol);
      mockIsCancel.mockReturnValue(true);

      await expect(destroyAction("test-bucket", {})).rejects.toThrow(
        "process.exit(0)",
      );
      expect(mockOutro).toHaveBeenCalledWith("Destroy cancelled.");
    });
  });

  describe("--yes flag", () => {
    it("auto-confirms without prompt", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-123" },
      });
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
      });

      await destroyAction("test-bucket", { yes: true });
      expect(mockText).not.toHaveBeenCalled();
      expect(stdoutOutput).toContain("Resource destroyed");
    });

    it("warns when used in interactive TTY", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-123" },
      });
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
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
        "process.exit(1)",
      );
      expect(stderrOutput).toContain("Destroy requires confirmation");
      expect(stderrOutput).toContain("--yes");
    });
  });

  describe("cost savings display", () => {
    it("displays cost savings message on success", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-123" },
      });
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { OperationStatus: "SUCCESS" },
      });

      await destroyAction("test-bucket", { yes: true });
      expect(stdoutOutput).toContain("Estimated savings:");
    });
  });

  describe("delete failure", () => {
    it("produces actionable error on delete failure", async () => {
      mockResolveResource.mockResolvedValue(mockResource);
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: { RequestToken: "tok-123" },
      });
      mockCCSend.mockResolvedValueOnce({
        ProgressEvent: {
          OperationStatus: "FAILED",
          StatusMessage: "BucketNotEmpty: The bucket is not empty",
        },
      });

      await expect(destroyAction("test-bucket", { yes: true })).rejects.toThrow(
        "process.exit(1)",
      );
      expect(stderrOutput).toContain("Destroy failed");
      expect(stderrOutput).toContain("BucketNotEmpty");
    });
  });
});
