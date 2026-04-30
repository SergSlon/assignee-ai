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

// ── Epic 92 Wave 1 (e92.1.b): mock the three direct-SDK clients the
//    new special-path handlers call (KMS, Secrets, EventBridge).
//    Each client stores a `send` stub so tests can control response
//    shape and assert on the command arguments.
const mockKmsSend = vi.fn();
vi.mock("@aws-sdk/client-kms", () => {
  class MockKMSClient {
    send = mockKmsSend;
    destroy = vi.fn();
  }
  return {
    KMSClient: MockKMSClient,
    ScheduleKeyDeletionCommand: vi.fn((input: unknown) => ({
      _type: "ScheduleKeyDeletion",
      input,
    })),
  };
});

const mockSecretsSend = vi.fn();
vi.mock("@aws-sdk/client-secrets-manager", () => {
  class MockSecretsManagerClient {
    send = mockSecretsSend;
    destroy = vi.fn();
  }
  return {
    SecretsManagerClient: MockSecretsManagerClient,
    DeleteSecretCommand: vi.fn((input: unknown) => ({
      _type: "DeleteSecret",
      input,
    })),
  };
});

const mockEventBridgeSend = vi.fn();
vi.mock("@aws-sdk/client-eventbridge", () => {
  class MockEventBridgeClient {
    send = mockEventBridgeSend;
    destroy = vi.fn();
  }
  return {
    EventBridgeClient: MockEventBridgeClient,
    DeleteEventBusCommand: vi.fn((input: unknown) => ({
      _type: "DeleteEventBus",
      input,
    })),
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
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {}) as never);

    try {
      const { destroyCommand } = await import("./destroy.js");
      await destroyCommand.parseAsync([
        "node",
        "destroy",
        "--target-account",
        "123456789012",
        "test-bucket",
      ]);
    } finally {
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    }

    const stderrText = stderrCalls.join("");
    // Must contain user-facing intent keywords.
    expect(stderrText).toContain("cross-account");
    expect(stderrText).toContain("not yet available");
    // Must NOT leak internal tracker names.
    expect(stderrText).not.toMatch(/Epic\s+\d+/i);
    expect(stderrText).not.toMatch(/story\s+\d+-W\d+/i);
    // Exit code must be NOT_IMPLEMENTED (12).
    expect(exitSpy).toHaveBeenCalledWith(12);
  });
});
