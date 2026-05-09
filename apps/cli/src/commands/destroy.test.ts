/**
 * Tests for `assignee destroy` command.
 *
 * @see Story 18.5
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";

// ── Hoisted mocks (accessible inside vi.mock factories) ─────────────────────
// A6 (2026-04-08): mockLambdaSend was removed after Lambda EventSourceMapping
// was migrated from the SDK fallback to CCAPI. The @aws-sdk/client-lambda
// module is no longer imported by sdk-fallback-dispatcher, so mocking it
// here is dead code.
//
// W6-S2: mockKmsSend / mockSecretsSend / mockEventBridgeSend are hoisted here
// so the cloudcontrol-client.js factory mock can close over them.  The raw
// SDK module mocks are kept only for the Command classes (ScheduleKeyDeletion-
// Command, etc.) that destroy.ts now imports statically.
const {
  mockText,
  mockOutro,
  mockIsCancel,
  mockCCSend,
  mockTaggingSend,
  mockSnsSend,
  mockResolveResource,
  mockCreateTaggingClient,
  mockDestroySingleResource,
  mockKmsSend,
  mockSecretsSend,
  mockEventBridgeSend,
  mockCreateKmsClient,
  mockCreateSecretsManagerClient,
  mockCreateEventBridgeClient,
} = vi.hoisted(() => ({
  mockText: vi.fn(),
  mockOutro: vi.fn(),
  mockIsCancel: vi.fn().mockReturnValue(false),
  mockCCSend: vi.fn(),
  mockTaggingSend: vi.fn(),
  mockSnsSend: vi.fn(),
  mockResolveResource: vi.fn(),
  mockCreateTaggingClient: vi.fn().mockReturnValue({}),
  mockDestroySingleResource: vi.fn(),
  mockKmsSend: vi.fn(),
  mockSecretsSend: vi.fn(),
  mockEventBridgeSend: vi.fn(),
  mockCreateKmsClient: vi.fn(),
  mockCreateSecretsManagerClient: vi.fn(),
  mockCreateEventBridgeClient: vi.fn(),
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

// ── Epic 92 Wave 1 (e92.1.b) / W6-S2 refactor ─────────────────────────────
// The three special-path handlers (KMS, Secrets, EventBridge) now construct
// clients via factories in `../services/cloudcontrol-client.js` rather than
// calling `new KMSClient(...)` etc. inline.  We keep the SDK module mocks
// only for the Command classes (ScheduleKeyDeletionCommand etc.) that
// destroy.ts imports statically.  The mock clients are wired up via the
// cloudcontrol-client.js factory mock below.
vi.mock("@aws-sdk/client-kms", () => {
  class KMSInvalidStateException extends Error {
    readonly $fault = "client";
    constructor(m: string) {
      super(m);
      this.name = "KMSInvalidStateException";
    }
  }
  class NotFoundException extends Error {
    readonly $fault = "client";
    constructor(m: string) {
      super(m);
      this.name = "NotFoundException";
    }
  }
  return {
    ScheduleKeyDeletionCommand: vi.fn((input: unknown) => ({
      _type: "ScheduleKeyDeletion",
      input,
    })),
    DescribeKeyCommand: vi.fn((input: unknown) => ({
      _type: "DescribeKey",
      input,
    })),
    KMSInvalidStateException,
    NotFoundException,
  };
});

vi.mock("@aws-sdk/client-secrets-manager", () => {
  class InvalidRequestException extends Error {
    readonly $fault = "client";
    constructor(m: string) {
      super(m);
      this.name = "InvalidRequestException";
    }
  }
  class ResourceNotFoundException extends Error {
    readonly $fault = "client";
    constructor(m: string) {
      super(m);
      this.name = "ResourceNotFoundException";
    }
  }
  return {
    DeleteSecretCommand: vi.fn((input: unknown) => ({
      _type: "DeleteSecret",
      input,
    })),
    DescribeSecretCommand: vi.fn((input: unknown) => ({
      _type: "DescribeSecret",
      input,
    })),
    InvalidRequestException,
    ResourceNotFoundException,
  };
});

vi.mock("@aws-sdk/client-eventbridge", () => {
  class ResourceNotFoundException extends Error {
    readonly $fault = "client";
    constructor(m: string) {
      super(m);
      this.name = "ResourceNotFoundException";
    }
  }
  return {
    DeleteEventBusCommand: vi.fn((input: unknown) => ({
      _type: "DeleteEventBus",
      input,
    })),
    ResourceNotFoundException,
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
  // Intentional mock: this targets the I/O service shim (cloudcontrol-client.js),
  // NOT the engine graph path (createGraph / create-graph.ts) that W1-C4 fixed.
  // The shim mock controls outbound CloudControl API calls; the engine mock path
  // is separately handled via vi.mock("../graph/create-graph.js") higher in the file.
  createCloudControlClient: vi.fn().mockReturnValue({ send: mockCCSend }),
  // W6-S2: the three destroy-special-path handlers now use factories from
  // cloudcontrol-client.js instead of constructing clients inline.  The
  // hoisted vi.fn() references (mockCreate*Client) are re-armed in beforeEach
  // so their implementations survive vi.clearAllMocks().
  createKmsClient: mockCreateKmsClient,
  createSecretsManagerClient: mockCreateSecretsManagerClient,
  createEventBridgeClient: mockCreateEventBridgeClient,
}));

vi.mock("../services/destroy-service.js", () => ({
  destroySingleResource: (...args: unknown[]) =>
    mockDestroySingleResource(...args),
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

vi.mock("../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
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

  // Re-arm the three factory mocks after clearAllMocks wipes their
  // implementations.  Hoisted vi.fn() references survive the clear; we just
  // restore the implementation here so every test starts with a working stub.
  mockCreateKmsClient.mockImplementation(() => ({
    send: mockKmsSend,
    destroy: vi.fn(),
  }));
  mockCreateSecretsManagerClient.mockImplementation(() => ({
    send: mockSecretsSend,
    destroy: vi.fn(),
  }));
  mockCreateEventBridgeClient.mockImplementation(() => ({
    send: mockEventBridgeSend,
    destroy: vi.fn(),
  }));

  // Re-arm mockIsCancel to return false. vi.clearAllMocks() does NOT reset
  // mockReturnValue() implementations; tests that call
  // `mockIsCancel.mockReturnValue(true)` would otherwise bleed into
  // subsequent tests (the "cancelled prompt" test sets true persistently).
  mockIsCancel.mockReturnValue(false);

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
  describe("missing resource argument", () => {
    it("rejects when no resource is passed", async () => {
      // Story 50-3: bulk destroy (--all) was removed; destroy always
      // needs a positional resource argument. Assertion matches the
      // invariant phrase "needs to know what to destroy" anchoring
      // the guide-the-user error.
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
});

// Story 50-3: the `--all bulk destroy` describe block was deleted along
// with the `--all` / `--include-iam` flags and the bulk-destroy service
// subtree. Single-resource destroy is the only mode.

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
        arn: "arn:aws:ecs:us-east-1:210987654321:cluster/my-cluster",
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
    expect(fn({ arn: "arn:aws:iam::210987654321:role/MyRole" })).toBe("MyRole");
  });
});

// ─── Epic 92 Wave 1 (e92.1.b) — CCAPI-bypass destroy paths ────────────────
//
// These tests cover the four findings that `destroy.ts` now handles
// inline with the direct AWS SDK instead of going through
// `destroy-service.ts` + CCAPI:
//
//   - D-21 — KMS destroy prints "Scheduled for deletion on <date>"
//            and honours `--pending-window-in-days`
//   - D-22 — KMS resolved identifier synthesizes a real ARN
//   - D-19/D-20 — EventBus destroy routes to DeleteEventBus by name
//   - D-25 — Secret destroy prints scheduled message or, with
//            `--force-delete-without-recovery`, prints destroyed
//
// All four share the same confirmation/resolution scaffolding as the
// S3 happy path above. The assertions focus on which AWS SDK command
// shape is sent and which renderer string is emitted.
describe("Epic 92 Wave 1 — destroy scheduled-deletion paths", () => {
  const kmsResource = {
    arn: "arn:aws:kms:us-east-1:210987654321:key/ba48550a-3f14-446e-8f0c-1473f345c62d",
    resourceType: "AWS::KMS::Key",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "ba48550a-3f14-446e-8f0c-1473f345c62d",
  };
  const secretResource = {
    arn: "arn:aws:secretsmanager:us-east-1:210987654321:secret:my-app/prod/db-password-AbCdEf",
    resourceType: "AWS::SecretsManager::Secret",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "my-app/prod/db-password",
  };
  // D-19 reproduction: real-world EventBus ARN where resource-resolver
  // mis-classifies as AWS::Events::Rule via SERVICE_TYPE_MAP. Our
  // inline dispatch must detect the `event-bus/` segment and route to
  // DeleteEventBus regardless of the classifier output.
  const eventBusResource = {
    arn: "arn:aws:events:us-east-1:210987654321:event-bus/e92d-bus-1776801116",
    resourceType: "AWS::Events::Rule", // INTENTIONALLY the wrong class
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "e92d-bus-1776801116",
  };

  it("KMS destroy with --pending-window-in-days 7 → ScheduleKeyDeletion(7)", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    // Simulate a realistic AWS response: DeletionDate set to 7 days out.
    const deletionDate = new Date("2026-04-27T00:00:00Z");
    mockKmsSend.mockResolvedValue({ DeletionDate: deletionDate });

    await destroyAction(kmsResource.arn, {
      yes: true,
      pendingWindowInDays: "7",
    });

    // Exactly one ScheduleKeyDeletion command with the 7-day window.
    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    const command = mockKmsSend.mock.calls[0]![0] as {
      _type: string;
      input: { KeyId: string; PendingWindowInDays: number };
    };
    expect(command._type).toBe("ScheduleKeyDeletion");
    expect(command.input.PendingWindowInDays).toBe(7);
    expect(command.input.KeyId).toBe(kmsResource.identifier);
    // Scheduled-deletion phrasing; NOT "Resource destroyed".
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-04-27");
    expect(stdoutOutput).not.toContain("Resource destroyed");
  });

  it("KMS destroy without --pending-window-in-days uses the 7-day default", async () => {
    // D-21 default rationale: 7 (minimum) beats 30 (AWS default) because
    // cost exposure during the window is real.
    mockResolveResource.mockResolvedValue(kmsResource);
    mockKmsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(kmsResource.arn, { yes: true });

    expect(mockKmsSend).toHaveBeenCalledTimes(1);
    const command = mockKmsSend.mock.calls[0]![0] as {
      input: { PendingWindowInDays: number };
    };
    expect(command.input.PendingWindowInDays).toBe(7);
  });

  it("KMS destroy rejects --pending-window-in-days 6 (below minimum)", async () => {
    await expect(
      destroyAction(kmsResource.arn, { yes: true, pendingWindowInDays: "6" }),
    ).rejects.toThrow(/between 7 and 30/);
    // Zero AWS traffic for the rejected call.
    expect(mockKmsSend).not.toHaveBeenCalled();
  });

  it("KMS destroy rejects --pending-window-in-days 31 (above maximum)", async () => {
    await expect(
      destroyAction(kmsResource.arn, { yes: true, pendingWindowInDays: "31" }),
    ).rejects.toThrow(/between 7 and 30/);
    expect(mockKmsSend).not.toHaveBeenCalled();
  });

  it("KMS destroy rejects non-integer --pending-window-in-days", async () => {
    await expect(
      destroyAction(kmsResource.arn, {
        yes: true,
        pendingWindowInDays: "14.5",
      }),
    ).rejects.toThrow(/between 7 and 30/);
  });

  it("Secret destroy with --recovery-window-in-days 7 → DeleteSecret(RecoveryWindow=7)", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    mockSecretsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(secretResource.arn, {
      yes: true,
      recoveryWindowInDays: "7",
    });

    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
    const command = mockSecretsSend.mock.calls[0]![0] as {
      _type: string;
      input: {
        SecretId: string;
        RecoveryWindowInDays?: number;
        ForceDeleteWithoutRecovery?: boolean;
      };
    };
    expect(command._type).toBe("DeleteSecret");
    expect(command.input.RecoveryWindowInDays).toBe(7);
    expect(command.input.ForceDeleteWithoutRecovery).toBeUndefined();
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-04-27");
    expect(stdoutOutput).not.toContain("Resource destroyed");
  });

  it("Secret destroy with --force-delete-without-recovery → DeleteSecret(Force=true)", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    mockSecretsSend.mockResolvedValue({});

    await destroyAction(secretResource.arn, {
      yes: true,
      forceDeleteWithoutRecovery: true,
    });

    expect(mockSecretsSend).toHaveBeenCalledTimes(1);
    const command = mockSecretsSend.mock.calls[0]![0] as {
      input: {
        ForceDeleteWithoutRecovery?: boolean;
        RecoveryWindowInDays?: number;
      };
    };
    expect(command.input.ForceDeleteWithoutRecovery).toBe(true);
    expect(command.input.RecoveryWindowInDays).toBeUndefined();
    // Force-delete IS genuinely destroyed, so the line is the plain one.
    expect(stdoutOutput).toContain("Resource destroyed");
  });

  it("Secret destroy rejects combining --recovery-window-in-days and --force-delete-without-recovery", async () => {
    await expect(
      destroyAction(secretResource.arn, {
        yes: true,
        recoveryWindowInDays: "14",
        forceDeleteWithoutRecovery: true,
      }),
    ).rejects.toThrow(/cannot be combined/);
    expect(mockSecretsSend).not.toHaveBeenCalled();
  });

  it("Secret destroy without flags uses default 7-day recovery window", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    mockSecretsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(secretResource.arn, { yes: true });

    const command = mockSecretsSend.mock.calls[0]![0] as {
      input: { RecoveryWindowInDays?: number };
    };
    expect(command.input.RecoveryWindowInDays).toBe(7);
  });

  it("EventBus destroy routes to DeleteEventBus by name (D-19)", async () => {
    // Regression: resource-resolver may classify the EventBus ARN as
    // AWS::Events::Rule (wrong) — our inline dispatch must detect the
    // `event-bus/` segment of the ARN and call DeleteEventBus anyway.
    mockResolveResource.mockResolvedValue(eventBusResource);
    mockEventBridgeSend.mockResolvedValue({});

    await destroyAction(eventBusResource.arn, { yes: true });

    expect(mockEventBridgeSend).toHaveBeenCalledTimes(1);
    const command = mockEventBridgeSend.mock.calls[0]![0] as {
      _type: string;
      input: { Name: string };
    };
    expect(command._type).toBe("DeleteEventBus");
    expect(command.input.Name).toBe("e92d-bus-1776801116");
    expect(stdoutOutput).toContain("Resource destroyed");
  });

  it("KMS flag passed against a non-KMS resource → actionable error", async () => {
    // Guard against silently ignoring user-specified flags on mismatched
    // types. Story invariant: flags must refuse to apply to the wrong
    // resource class.
    mockResolveResource.mockResolvedValue(mockResource);

    await expect(
      destroyAction("arn:aws:kms:us-east-1:210987654321:key/uuid", {
        yes: true,
        pendingWindowInDays: "10",
      }),
    ).rejects.toThrow(/only applies to AWS::KMS::Key/);
  });

  it("non-scheduled resource destroy (S3) is unaffected — still says 'Resource destroyed'", async () => {
    // Invariant from the story: non-scheduled types keep the original
    // line. This is the regression-guard.
    mockResolveResource.mockResolvedValue(mockResource);
    mockDestroySingleResource.mockResolvedValue({
      success: true,
      resourceType: "AWS::S3::Bucket",
      identifier: "test-bucket",
      arn: "arn:aws:s3:::test-bucket",
    });

    await destroyAction("test-bucket", { yes: true });

    expect(stdoutOutput).toContain("Resource destroyed");
    expect(stdoutOutput).not.toContain("Scheduled for deletion on");
    // Special-path SDKs must NOT be touched for S3.
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(mockSecretsSend).not.toHaveBeenCalled();
    expect(mockEventBridgeSend).not.toHaveBeenCalled();
  });
});

// ── Idempotent-success paths (KMSInvalidStateException / NotFoundException / etc.) ─────
//
// Covers the bug: `assignee destroy --all` reports 15 KMS keys FAILED when they're
// already in pending-deletion state. These tests mock the SDK to throw the typed
// exception and assert the destroy returns "already_pending" (success), not throws.

describe("Idempotent-success error classification", () => {
  const kmsResource = {
    arn: "arn:aws:kms:us-east-1:210987654321:key/ba48550a-3f14-446e-8f0c-1473f345c62d",
    resourceType: "AWS::KMS::Key",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "ba48550a-3f14-446e-8f0c-1473f345c62d",
  };
  const secretResource = {
    arn: "arn:aws:secretsmanager:us-east-1:210987654321:secret:my-app/prod/db-password-AbCdEf",
    resourceType: "AWS::SecretsManager::Secret",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "my-app/prod/db-password",
  };
  const eventBusResource = {
    arn: "arn:aws:events:us-east-1:210987654321:event-bus/e92d-bus-1776801116",
    resourceType: "AWS::Events::Rule", // intentionally wrong class (real-world classifier bug)
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "e92d-bus-1776801116",
  };

  it("KMS: KMSInvalidStateException with 'pending deletion' message → returns 'already_pending' (no throw)", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    // Import the class as constructed by the vi.mock factory above
    const { KMSInvalidStateException } = await import("@aws-sdk/client-kms");
    mockKmsSend.mockRejectedValue(
      new (KMSInvalidStateException as unknown as new (m: string) => Error)(
        "arn:aws:kms:us-east-1:210987654321:key/ba48550a is pending deletion.",
      ),
    );

    const result = await destroyAction(kmsResource.arn, { yes: true });

    // Must not throw — returns "already_pending" for bulk categorisation
    expect(result).toBe("already_pending");
    // Informs the user on stderr
    expect(stderrOutput).toContain("already scheduled for deletion");
    // Still renders the scheduled-deletion box on stdout (shows a date)
    expect(stdoutOutput).toContain("Scheduled for deletion");
  });

  it("KMS: KMSInvalidStateException with non-pending-deletion message (e.g. Disabled) → throws (genuine failure)", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const { KMSInvalidStateException } = await import("@aws-sdk/client-kms");
    mockKmsSend.mockRejectedValue(
      new (KMSInvalidStateException as unknown as new (m: string) => Error)(
        "arn:aws:kms:us-east-1:210987654321:key/ba48550a is disabled.",
      ),
    );

    await expect(destroyAction(kmsResource.arn, { yes: true })).rejects.toThrow(
      /Failed to schedule KMS key for deletion/,
    );
  });

  it("KMS: NotFoundException → returns 'already_pending' (key purged)", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const { NotFoundException } = await import("@aws-sdk/client-kms");
    mockKmsSend.mockRejectedValue(
      new (NotFoundException as unknown as new (m: string) => Error)(
        "Key 'ba48550a' does not exist.",
      ),
    );

    const result = await destroyAction(kmsResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    expect(stderrOutput).toContain("already scheduled for deletion");
  });

  it("SecretsManager: InvalidRequestException with 'was deleted' → returns 'already_pending'", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    const { InvalidRequestException } =
      await import("@aws-sdk/client-secrets-manager");
    mockSecretsSend.mockRejectedValue(
      new (InvalidRequestException as unknown as new (m: string) => Error)(
        "You can't perform this operation on the secret because it was deleted.",
      ),
    );

    const result = await destroyAction(secretResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    expect(stderrOutput).toContain("already deleted or scheduled");
    // Defect 4 symmetry fix (2026-05-09): the secret is in a recovery
    // window, NOT destroyed — rendering the honest "Scheduled for
    // deletion" line replaces the previous "Resource destroyed" lie.
    // When DescribeSecret can't recover the real ScheduledDeletionDate
    // (mock returns the same rejection), the unknown-date renderer
    // fires.
    expect(stdoutOutput).toContain("Scheduled for deletion");
    expect(stdoutOutput).not.toContain("Resource destroyed");
  });

  it("SecretsManager: ResourceNotFoundException → returns 'already_pending'", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    const { ResourceNotFoundException } =
      await import("@aws-sdk/client-secrets-manager");
    mockSecretsSend.mockRejectedValue(
      new (ResourceNotFoundException as unknown as new (m: string) => Error)(
        "Secrets Manager can't find the specified secret.",
      ),
    );

    const result = await destroyAction(secretResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    expect(stderrOutput).toContain("already deleted or scheduled");
  });

  it("EventBus: ResourceNotFoundException → success (no throw, 'Resource destroyed')", async () => {
    mockResolveResource.mockResolvedValue(eventBusResource);
    const { ResourceNotFoundException } =
      await import("@aws-sdk/client-eventbridge");
    mockEventBridgeSend.mockRejectedValue(
      new (ResourceNotFoundException as unknown as new (m: string) => Error)(
        "Event bus 'e92d-bus-1776801116' does not exist.",
      ),
    );

    // EventBus not-found is idempotent success — must NOT throw
    await expect(
      destroyAction(eventBusResource.arn, { yes: true }),
    ).resolves.not.toThrow();
    expect(stdoutOutput).toContain("Resource destroyed");
  });

  it("KMS: real genuine failures (throttling) still throw", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const throttleErr = new Error("ThrottlingException: Rate exceeded");
    throttleErr.name = "ThrottlingException";
    mockKmsSend.mockRejectedValue(throttleErr);

    await expect(destroyAction(kmsResource.arn, { yes: true })).rejects.toThrow(
      /Failed to schedule KMS key for deletion/,
    );
  });

  // ── Defect 1 (2026-05-09): pre-call neutral hint, no premature claim ──
  //
  // The previous wording ("KMS key scheduled NOW for deletion 7 days from now")
  // was a lie when the second ScheduleKeyDeletion call threw KMSInvalidStateException
  // before the notice's claim ever became true. The new wording describes only
  // what's about to be ATTEMPTED, never the outcome.

  it("Defect 1: KMS pre-call hint never claims 'scheduled NOW' even when key is already-pending", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const { KMSInvalidStateException } = await import("@aws-sdk/client-kms");
    mockKmsSend.mockRejectedValue(
      new (KMSInvalidStateException as unknown as new (m: string) => Error)(
        "arn:aws:kms:us-east-1:112233445566:key/abc is pending deletion.",
      ),
    );

    await destroyAction(kmsResource.arn, { yes: true });

    // The lying pre-call notice MUST be absent.
    expect(stderrOutput).not.toContain(
      "scheduled NOW for deletion 7 days from now",
    );
    // The honest hint MUST be present pre-call.
    expect(stderrOutput).toContain("preparing to destroy KMS key");
    expect(stderrOutput).toContain("AWS minimum 7-day waiting period");
  });

  it("Defect 1 symmetry: Secret pre-call hint never claims 'scheduled NOW' for already-pending secret", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    const { InvalidRequestException } =
      await import("@aws-sdk/client-secrets-manager");
    mockSecretsSend.mockRejectedValue(
      new (InvalidRequestException as unknown as new (m: string) => Error)(
        "You can't perform this operation on the secret because it was deleted.",
      ),
    );

    await destroyAction(secretResource.arn, { yes: true });

    expect(stderrOutput).not.toContain(
      "Secret scheduled NOW for deletion 7 days from now",
    );
    expect(stderrOutput).toContain("preparing to destroy secret");
    expect(stderrOutput).toContain("AWS minimum 7-day recovery window");
  });

  // ── Defect 4 (2026-05-09): real-DescribeKey date OR honest unknown line ──
  //
  // The previous code fabricated `Date.now() + 7d` when the key was already
  // PendingDeletion. The new code calls DescribeKey for the real DeletionDate;
  // if DescribeKey itself fails, the renderer prints the unknown-date line
  // (no fabricated YYYY-MM-DD).

  it("Defect 4 (a): KMS already-pending uses DescribeKey to render the REAL DeletionDate", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const { KMSInvalidStateException } = await import("@aws-sdk/client-kms");
    const realDeletionDate = new Date("2026-05-12T00:00:00Z");

    mockKmsSend
      // First call: ScheduleKeyDeletion → throws InvalidState/pending
      .mockRejectedValueOnce(
        new (KMSInvalidStateException as unknown as new (m: string) => Error)(
          "arn:aws:kms:us-east-1:112233445566:key/abc is pending deletion.",
        ),
      )
      // Second call: DescribeKey → returns the real KeyMetadata.DeletionDate
      .mockResolvedValueOnce({
        KeyMetadata: { DeletionDate: realDeletionDate },
      });

    const result = await destroyAction(kmsResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    // Honest output: the real date from DescribeKey, NOT a synthetic
    // Date.now() + window value.
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-05-12");
    // Two SDK calls were issued (ScheduleKeyDeletion + DescribeKey).
    expect(mockKmsSend).toHaveBeenCalledTimes(2);
    const secondCommand = mockKmsSend.mock.calls[1]![0] as { _type: string };
    expect(secondCommand._type).toBe("DescribeKey");
  });

  it("Defect 4 (b): KMS already-pending falls back to 'check AWS console' when DescribeKey ALSO fails", async () => {
    mockResolveResource.mockResolvedValue(kmsResource);
    const { KMSInvalidStateException } = await import("@aws-sdk/client-kms");

    // Both ScheduleKeyDeletion AND DescribeKey throw. The destroy must
    // still return "already_pending" — the parent operation logically
    // succeeded — but the rendered line MUST NOT contain a fabricated
    // YYYY-MM-DD date.
    const errInvalid = new (KMSInvalidStateException as unknown as new (
      m: string,
    ) => Error)("is pending deletion");
    mockKmsSend.mockRejectedValue(errInvalid);

    const result = await destroyAction(kmsResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    // Falls back to the unknown-date rendering.
    expect(stdoutOutput).toContain("check the AWS console");
    expect(stdoutOutput).toContain("Scheduled for deletion (");
    // The "Scheduled for deletion on YYYY-MM-DD" date form MUST be absent —
    // we don't have a real date and refuse to fabricate one.
    expect(stdoutOutput).not.toMatch(
      /Scheduled for deletion on \d{4}-\d{2}-\d{2}/,
    );
  });

  it("Defect 4 symmetry (a): Secret already-pending uses DescribeSecret to render the REAL ScheduledDeletionDate", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    const { InvalidRequestException } =
      await import("@aws-sdk/client-secrets-manager");
    const realDeletionDate = new Date("2026-05-13T00:00:00Z");

    mockSecretsSend
      // First call: DeleteSecret → throws InvalidRequest "was deleted"
      .mockRejectedValueOnce(
        new (InvalidRequestException as unknown as new (m: string) => Error)(
          "You can't perform this operation on the secret because it was deleted.",
        ),
      )
      // Second call: DescribeSecret → returns the real DeletedDate.
      .mockResolvedValueOnce({
        DeletedDate: realDeletionDate,
      });

    const result = await destroyAction(secretResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    expect(stdoutOutput).toContain("Scheduled for deletion on 2026-05-13");
    expect(stdoutOutput).not.toContain("Resource destroyed");
  });

  it("Defect 4 symmetry (b): Secret already-pending falls back to 'check AWS console' when DescribeSecret ALSO fails", async () => {
    mockResolveResource.mockResolvedValue(secretResource);
    const { InvalidRequestException } =
      await import("@aws-sdk/client-secrets-manager");

    // BOTH DeleteSecret AND DescribeSecret throw. Honest fallback expected.
    mockSecretsSend.mockRejectedValue(
      new (InvalidRequestException as unknown as new (m: string) => Error)(
        "You can't perform this operation on the secret because it was deleted.",
      ),
    );

    const result = await destroyAction(secretResource.arn, { yes: true });

    expect(result).toBe("already_pending");
    expect(stdoutOutput).toContain("check the AWS console");
    expect(stdoutOutput).not.toMatch(
      /Scheduled for deletion on \d{4}-\d{2}-\d{2}/,
    );
    expect(stdoutOutput).not.toContain("Resource destroyed");
  });
});

// ── W6-S2 — factory routing for KMS / SecretsManager / EventBridge ───────────
//
// Verifies that the three special-path destroy helpers use the service
// factories from `cloudcontrol-client.js` rather than constructing SDK
// clients inline.  This ensures:
//   (a) factory is called (interceptable by module-level vi.mock)
//   (b) credentials are forwarded correctly (with-creds vs no-creds)

describe("W6-S2 — destroy helpers use cloudcontrol-client.js factories", () => {
  const w6KmsResource = {
    arn: "arn:aws:kms:us-east-1:210987654321:key/ba48550a-3f14-446e-8f0c-1473f345c62d",
    resourceType: "AWS::KMS::Key",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "ba48550a-3f14-446e-8f0c-1473f345c62d",
  };
  const w6SecretResource = {
    arn: "arn:aws:secretsmanager:us-east-1:210987654321:secret:my-app/prod/db-password-AbCdEf",
    resourceType: "AWS::SecretsManager::Secret",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "my-app/prod/db-password",
  };
  const w6EventBusResource = {
    arn: "arn:aws:events:us-east-1:210987654321:event-bus/e92d-bus-1776801116",
    resourceType: "AWS::Events::Rule",
    region: "us-east-1",
    tags: { "managed-by": "assignee-ai" },
    identifier: "e92d-bus-1776801116",
  };

  it("scheduleKmsKeyDeletion calls createKmsClient with operator credentials", async () => {
    const { createKmsClient: mockCreateKmsClient } =
      await import("../services/cloudcontrol-client.js");
    mockResolveResource.mockResolvedValue(w6KmsResource);
    mockKmsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(w6KmsResource.arn, {
      yes: true,
      pendingWindowInDays: "7",
    });

    expect(mockCreateKmsClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
    );
  });

  it("deleteSecret calls createSecretsManagerClient with operator credentials", async () => {
    const { createSecretsManagerClient: mockCreateSMClient } =
      await import("../services/cloudcontrol-client.js");
    mockResolveResource.mockResolvedValue(w6SecretResource);
    mockSecretsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(w6SecretResource.arn, {
      yes: true,
      recoveryWindowInDays: "7",
    });

    expect(mockCreateSMClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
    );
  });

  it("deleteEventBus calls createEventBridgeClient with operator credentials", async () => {
    const { createEventBridgeClient: mockCreateEBClient } =
      await import("../services/cloudcontrol-client.js");
    mockResolveResource.mockResolvedValue(w6EventBusResource);
    mockEventBridgeSend.mockResolvedValue({});

    await destroyAction(w6EventBusResource.arn, { yes: true });

    expect(mockCreateEBClient).toHaveBeenCalledWith(
      expect.objectContaining({
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "us-east-1",
      }),
    );
  });

  it("scheduleKmsKeyDeletion calls createKmsClient with region-only when credentials absent", async () => {
    const { createKmsClient: mockCreateKmsClient } =
      await import("../services/cloudcontrol-client.js");
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    vi.mocked(tryAssigneeCredentials).mockReturnValue(undefined);

    mockResolveResource.mockResolvedValue(w6KmsResource);
    mockKmsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(w6KmsResource.arn, {
      yes: true,
      pendingWindowInDays: "7",
    });

    expect(mockCreateKmsClient).toHaveBeenCalledWith({ region: "us-east-1" });
  });

  it("deleteSecret calls createSecretsManagerClient with region-only when credentials absent", async () => {
    const { createSecretsManagerClient: mockCreateSMClient } =
      await import("../services/cloudcontrol-client.js");
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    vi.mocked(tryAssigneeCredentials).mockReturnValue(undefined);

    mockResolveResource.mockResolvedValue(w6SecretResource);
    mockSecretsSend.mockResolvedValue({
      DeletionDate: new Date("2026-04-27T00:00:00Z"),
    });

    await destroyAction(w6SecretResource.arn, {
      yes: true,
      recoveryWindowInDays: "7",
    });

    expect(mockCreateSMClient).toHaveBeenCalledWith({ region: "us-east-1" });
  });

  it("deleteEventBus calls createEventBridgeClient with region-only when credentials absent", async () => {
    const { createEventBridgeClient: mockCreateEBClient } =
      await import("../services/cloudcontrol-client.js");
    const { tryAssigneeCredentials } =
      await import("../config/aws-credentials.js");
    vi.mocked(tryAssigneeCredentials).mockReturnValue(undefined);

    mockResolveResource.mockResolvedValue(w6EventBusResource);
    mockEventBridgeSend.mockResolvedValue({});

    await destroyAction(w6EventBusResource.arn, { yes: true });

    expect(mockCreateEBClient).toHaveBeenCalledWith({ region: "us-east-1" });
  });
});

// ── W5-S0 — --target-account help description clean of internal trackers ─────
// Verifies that the --target-account option description rendered by --help
// (stdout) contains no internal tracker strings such as "Epic 101".

function captureFullDestroyHelp(cmd: Command): string {
  let captured = "";
  cmd.outputHelp({
    write: (chunk: string) => {
      captured += chunk;
    },
  } as unknown as { error: boolean });
  return captured;
}

describe("destroyCommand — --target-account help description (W5-S0)", () => {
  it("--help stdout for --target-account does not contain Epic/story tracker strings", async () => {
    const { destroyCommand } = await import("./destroy.js");
    const helpText = captureFullDestroyHelp(destroyCommand);
    // The option must be present in the help output.
    expect(helpText).toContain("--target-account");
    // Must NOT expose internal tracker names in user-facing output.
    expect(helpText).not.toMatch(/Epic\s+\d+/i);
    expect(helpText).not.toMatch(/story\s+\d+-W\d+/i);
  });
});

// ── W4-S5 — --target-account user-facing message (M-β-01) ───────────────────
// Verifies that --target-account exits NOT_IMPLEMENTED without leaking
// internal tracker strings ("Epic 101", "story", "W3-04") in stderr.

describe("destroyCommand — --target-account NOT_IMPLEMENTED message (W4-S5)", () => {
  it("exits NOT_IMPLEMENTED (12) for a valid 12-digit account ID", async () => {
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrCalls.push(String(chunk));
        return true;
      });
    // W12-S0: process.exit() replaced with process.exitCode = ...; return.
    // Spy must NOT be called; assert process.exitCode instead.
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called — should not happen");
    }) as never);

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { destroyCommand } = await import("./destroy.js");
      await destroyCommand.parseAsync([
        "node",
        "destroy",
        "--target-account",
        "112233445566",
        "test-bucket",
      ]);

      const stderrText = stderrCalls.join("");
      // Must contain user-facing intent keywords.
      expect(stderrText).toContain("cross-account");
      expect(stderrText).toContain("not yet available");
      // Must NOT leak internal tracker names.
      expect(stderrText).not.toMatch(/Epic\s+\d+/i);
      expect(stderrText).not.toMatch(/story\s+\d+-W\d+/i);
      // W12-S0: process.exit must NOT be called; process.exitCode set to 12.
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(12);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });

  // W12-S0: GENERIC_ERROR path — invalid account ID sets exitCode = 1.
  it("sets exitCode GENERIC_ERROR (1) for an invalid account ID without calling process.exit", async () => {
    const stderrCalls: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown): boolean => {
        stderrCalls.push(String(chunk));
        return true;
      });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called — should not happen");
    }) as never);

    const prevExitCode = process.exitCode;
    process.exitCode = undefined;
    try {
      const { destroyCommand } = await import("./destroy.js");
      await destroyCommand.parseAsync([
        "node",
        "destroy",
        "--target-account",
        "not-a-valid-id",
        "test-bucket",
      ]);

      const stderrText = stderrCalls.join("");
      expect(stderrText).toMatch(/[Ii]nvalid/);
      expect(exitSpy).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(1);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
      process.exitCode = prevExitCode;
    }
  });
});
