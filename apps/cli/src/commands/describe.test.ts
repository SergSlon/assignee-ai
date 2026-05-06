/**
 * Tests for the `assignee describe` command (SSH-bundle Story iv).
 *
 * Covers command-level wiring: argument parsing, --json envelope shape,
 * not-found error path, EC2 happy / divergence rendering, non-EC2 fast
 * path. Service-layer logic (the live-fetch overlay) is exercised
 * through the same vitest test against the real `describeResource`
 * implementation — only the AWS SDK call is mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProvisionRecord } from "@assignee/core";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const {
  mockEc2Send,
  mockEc2Destroy,
  mockTryGetAmiDefaultUser,
  mockRenderError,
  mockExistsSync,
} = vi.hoisted(() => ({
  mockEc2Send: vi.fn(),
  mockEc2Destroy: vi.fn(),
  mockTryGetAmiDefaultUser: vi.fn(),
  mockRenderError: vi.fn(),
  // Pre-demo audit M1: `describe-resource.ts` gates the Connect-line
  // keyName overlay on existsSync of the local
  // `~/.assignee/keys/<name>.pem`. Default to TRUE so the existing
  // happy-path assertions (`state.keyName === KEY_NAME`,
  // `Connect: ...` rendering) keep passing on CI's fresh runners
  // (which never have the .pem file). The describe-resource
  // unit-test owns the suppression-branch coverage.
  mockExistsSync: vi.fn(() => true),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: mockExistsSync,
  };
});

vi.mock("@aws-sdk/client-ec2", () => {
  function DescribeInstancesCommand(input: unknown) {
    return { _type: "DescribeInstancesCommand", input };
  }
  return { DescribeInstancesCommand };
});

vi.mock("@assignee/core", async () => {
  const actual =
    await vi.importActual<typeof import("@assignee/core")>("@assignee/core");
  class FakeEC2 {
    send = mockEc2Send;
    destroy = mockEc2Destroy;
  }
  return {
    ...actual,
    createEC2Client: vi.fn(() => new FakeEC2()),
    tryGetAmiDefaultUser: mockTryGetAmiDefaultUser,
    defaultMemoryService: {
      readProvisionRecord: vi.fn(),
    },
  };
});

vi.mock("../config/aws-credentials.js", () => ({
  tryAssigneeCredentials: vi.fn(() => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  })),
}));

vi.mock("../config/constants.js", () => ({
  AWS_REGION: "us-east-1",
}));

// Mock renderError so we can assert the WHAT / FIX / WHY triple is
// surfaced exactly once on every error path (text + JSON not-found,
// and the generic catch). The real implementation calls stopSpinner
// + writes to stderr — neither relevant to the assertion semantics.
vi.mock("../utils/display.js", async () => {
  const actual = await vi.importActual<typeof import("../utils/display.js")>(
    "../utils/display.js",
  );
  return {
    ...actual,
    renderError: mockRenderError,
  };
});

// Stop the spinner module imported transitively by the apply-success
// renderer from doing real I/O — it imports @clack/prompts which throws
// at import time when stdin is not a TTY in some test environments.
vi.mock(
  "../../../../packages/core/src/utils/display-output/spinner.js",
  () => ({
    startSpinner: vi.fn(),
    updateSpinner: vi.fn(),
    stopSpinner: vi.fn(),
  }),
);

import { buildDescribeCommand } from "./describe.js";
import { defaultMemoryService } from "@assignee/core";

// ── Realistic fixtures ───────────────────────────────────────────────────────

const RUN_ID = "550e8400-e29b-41d4-a716-446655440000";
const EC2_INSTANCE_ID = "i-0abc123def4567890";
const EC2_FULL_ARN = `arn:aws:ec2:us-east-1:123456789012:instance/${EC2_INSTANCE_ID}`;
const APPLY_TIME_IP = "54.99.10.5";
const LIVE_IP = "54.198.42.117";
const LIVE_DNS = "ec2-54-198-42-117.compute-1.amazonaws.com";
const KEY_NAME = "assignee-ssh-key";
const AMI_ID = "ami-0c02fb55956c7d316";
const SSH_USERNAME = "ec2-user";

const S3_RUN_ID = "660e8400-e29b-41d4-a716-446655440000";
const S3_ARN = "arn:aws:s3:::my-static-site-1714867200";

function ec2Provision(
  overrides: Partial<ProvisionRecord> = {},
): ProvisionRecord {
  return {
    runId: RUN_ID,
    resourceType: "AWS::EC2::Instance",
    resourceArn: EC2_FULL_ARN,
    region: "us-east-1",
    desiredStateHash: "abc123",
    estimatedMonthlyCost: "$8.30/mo",
    timestamp: "2026-05-05T10:00:00.000Z",
    publicIpAddressAtApply: APPLY_TIME_IP,
    ...overrides,
  };
}

function s3Provision(): ProvisionRecord {
  return {
    runId: S3_RUN_ID,
    resourceType: "AWS::S3::Bucket",
    resourceArn: S3_ARN,
    region: "us-east-1",
    desiredStateHash: "def456",
    estimatedMonthlyCost: "$0.023/GB-month",
    timestamp: "2026-05-05T11:00:00.000Z",
  };
}

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown, ..._args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, restore: () => spy.mockRestore() };
}

function captureStderr() {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: unknown, ..._args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, restore: () => spy.mockRestore() };
}

function setTty(isTty: boolean) {
  Object.defineProperty(process.stdout, "isTTY", {
    value: isTty,
    configurable: true,
  });
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  mockTryGetAmiDefaultUser.mockReset();
  mockRenderError.mockReset();
  setTty(false); // default: non-TTY for deterministic plain-text output
  process.exitCode = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

describe("assignee describe — argument routing", () => {
  it("forwards a UUID-shaped runId to readProvisionRecord", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            { InstanceId: EC2_INSTANCE_ID, PublicIpAddress: LIVE_IP },
          ],
        },
      ],
    });

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync(["node", "describe", RUN_ID]);
      expect(defaultMemoryService.readProvisionRecord).toHaveBeenCalledWith(
        RUN_ID,
      );
    } finally {
      out.restore();
    }
  });

  it("forwards a full ARN to readProvisionRecord", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            { InstanceId: EC2_INSTANCE_ID, PublicIpAddress: LIVE_IP },
          ],
        },
      ],
    });

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync([
        "node",
        "describe",
        EC2_FULL_ARN,
      ]);
      expect(defaultMemoryService.readProvisionRecord).toHaveBeenCalledWith(
        EC2_FULL_ARN,
      );
    } finally {
      out.restore();
    }
  });
});

describe("assignee describe — text output", () => {
  it("renders apply-success line with live IP for EC2", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision({ publicIpAddressAtApply: LIVE_IP }),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: LIVE_IP,
              PublicDnsName: LIVE_DNS,
              KeyName: KEY_NAME,
              ImageId: AMI_ID,
            },
          ],
        },
      ],
    });
    mockTryGetAmiDefaultUser.mockResolvedValueOnce(SSH_USERNAME);

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync(["node", "describe", RUN_ID]);
      const text = out.chunks.join("");
      expect(text).toContain(EC2_FULL_ARN);
      expect(text).toContain(`Public IP: ${LIVE_IP}`);
      expect(text).toContain(`Public DNS: ${LIVE_DNS}`);
      expect(text).toContain(
        `Connect: ssh -i ~/.assignee/keys/${KEY_NAME}.pem ${SSH_USERNAME}@${LIVE_IP}`,
      );
      // Equal IPs collapse — no divergence annotation.
      expect(text).not.toContain("at apply time");
    } finally {
      out.restore();
    }
  });

  it("renders divergence annotation when live IP differs from apply-time IP", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision({ publicIpAddressAtApply: APPLY_TIME_IP }),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: LIVE_IP,
              PublicDnsName: LIVE_DNS,
              KeyName: KEY_NAME,
              ImageId: AMI_ID,
            },
          ],
        },
      ],
    });
    mockTryGetAmiDefaultUser.mockResolvedValueOnce(SSH_USERNAME);

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync(["node", "describe", RUN_ID]);
      const text = out.chunks.join("");
      expect(text).toContain(`Public IP: ${LIVE_IP}`);
      expect(text).toContain(`(was ${APPLY_TIME_IP} at apply time)`);
    } finally {
      out.restore();
    }
  });

  it("non-EC2 (S3): no DescribeInstances call, no Public IP line", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      s3Provision(),
    );

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync(["node", "describe", S3_RUN_ID]);
      const text = out.chunks.join("");
      expect(mockEc2Send).not.toHaveBeenCalled();
      expect(text).toContain(S3_ARN);
      expect(text).not.toContain("Public IP:");
      expect(text).not.toContain("Connect:");
    } finally {
      out.restore();
    }
  });
});

describe("assignee describe — JSON output", () => {
  it("emits an ok=true envelope with all relevant fields for EC2 with divergence", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: LIVE_IP,
              PublicDnsName: LIVE_DNS,
              KeyName: KEY_NAME,
              ImageId: AMI_ID,
            },
          ],
        },
      ],
    });
    mockTryGetAmiDefaultUser.mockResolvedValueOnce(SSH_USERNAME);

    const out = captureStdout();
    try {
      await buildDescribeCommand().parseAsync([
        "node",
        "describe",
        RUN_ID,
        "--json",
      ]);
      const text = out.chunks.join("");
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(parsed["ok"]).toBe(true);
      expect(parsed["runId"]).toBe(RUN_ID);
      expect(parsed["arn"]).toBe(EC2_FULL_ARN);
      expect(parsed["resourceType"]).toBe("AWS::EC2::Instance");
      expect(parsed["region"]).toBe("us-east-1");
      expect(parsed["publicIpAddress"]).toBe(LIVE_IP);
      expect(parsed["publicDnsName"]).toBe(LIVE_DNS);
      expect(parsed["publicIpAddressAtApply"]).toBe(APPLY_TIME_IP);
      expect(parsed["keyName"]).toBe(KEY_NAME);
      expect(parsed["amiId"]).toBe(AMI_ID);
      expect(parsed["sshUsername"]).toBe(SSH_USERNAME);
      expect(parsed["liveFetchAttempted"]).toBe(true);
      expect(parsed["liveFetchSucceeded"]).toBe(true);
    } finally {
      out.restore();
    }
  });

  it("emits an ok=false envelope when no provision record matches", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      undefined,
    );

    const out = captureStdout();
    const errOut = captureStderr();
    try {
      await expect(
        buildDescribeCommand().parseAsync([
          "node",
          "describe",
          "not-a-real-id",
          "--json",
        ]),
      ).rejects.toMatchObject({ code: "DESCRIBE_NOT_FOUND" });

      // JSON envelope on stdout
      const stdoutText = out.chunks.join("");
      const parsed = JSON.parse(stdoutText) as Record<string, unknown>;
      expect(parsed["ok"]).toBe(false);
      expect(
        ((parsed["error"] as { code?: string } | undefined) ?? {}).code,
      ).toBe("DESCRIBE_NOT_FOUND");

      // Exit code propagated.
      expect(process.exitCode).toBe(1);
    } finally {
      out.restore();
      errOut.restore();
    }
  });
});

describe("assignee describe — text-mode error paths", () => {
  it("text mode not-found: renderError fires with WHAT / FIX / WHY triple, exit 1, AssigneeError thrown", async () => {
    // Reviewer HIGH #2: the prior version of this test bypassed the
    // command and called `describeResource` directly. That left the
    // `renderError` triple + exit-code-1 branch in the text-mode
    // not-found path (`describe.ts:148-170`) entirely uncovered for
    // text mode — only JSON mode hit it. The factory pattern
    // (`buildDescribeCommand()`) hands every test a clean Command,
    // so we can drive the not-found path through parseAsync without
    // Commander's `_optionValues` leaking `--json` from a prior test.
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      undefined,
    );

    const out = captureStdout();
    const errOut = captureStderr();
    try {
      await expect(
        buildDescribeCommand().parseAsync([
          "node",
          "describe",
          "not-a-real-id",
          // No --json: we are exercising the text-mode branch.
        ]),
      ).rejects.toMatchObject({
        code: "DESCRIBE_NOT_FOUND",
        // alreadyRendered=true so `command-runner.ts` does not
        // double-render the triple at the outer catch boundary.
        alreadyRendered: true,
      });

      // The friendly WHAT / FIX / WHY triple was surfaced via
      // `renderError`, EXACTLY once.
      expect(mockRenderError).toHaveBeenCalledTimes(1);
      expect(mockRenderError).toHaveBeenCalledWith(
        'No provision record found for "not-a-real-id".',
        "Run `assignee list` to see all managed resources, or `assignee list --json | jq` to find a specific run id or ARN.",
        {
          why: "No matching record exists in ~/.assignee/memory/provisions.json.",
        },
      );

      // Text mode: stdout MUST stay clean (the JSON envelope is
      // opt-in via --json). The friendly message goes to the renderer
      // mock, not stdout.
      expect(out.chunks.join("")).toBe("");

      // Exit-code propagated (not_found path also sets it).
      expect(process.exitCode).toBe(1);
    } finally {
      out.restore();
      errOut.restore();
    }
  });

  it("generic failure path (HIGH #1): non-not-found error sets process.exitCode=1 even without --json", async () => {
    // Reviewer HIGH #1 fix: before the fix, a transient EC2 SDK
    // exception that escaped describeResource's internal try/catch
    // (or a ProvisionRecord schema-validation error) would rethrow
    // as `DESCRIBE_ERROR` without setting `process.exitCode`. Scripts
    // doing `assignee describe ... && echo ok` would see exit 0 even
    // though the call failed. We now set
    // `process.exitCode = ProcessExitCode.GENERIC_ERROR` (= 1) before
    // the generic throw, matching the not-found branch.
    vi.mocked(defaultMemoryService.readProvisionRecord).mockRejectedValue(
      new Error("Disk read error: EIO on provisions.json"),
    );

    const out = captureStdout();
    const errOut = captureStderr();
    try {
      await expect(
        buildDescribeCommand().parseAsync([
          "node",
          "describe",
          "550e8400-e29b-41d4-a716-446655440000",
        ]),
      ).rejects.toMatchObject({
        code: "DESCRIBE_ERROR",
        alreadyRendered: true,
      });

      expect(mockRenderError).toHaveBeenCalledTimes(1);
      expect(mockRenderError).toHaveBeenCalledWith(
        "Failed to describe resource.",
        "Check your AWS credentials and try again.",
        { why: "Disk read error: EIO on provisions.json" },
      );

      // The whole point of HIGH #1: exit code is 1, not undefined.
      expect(process.exitCode).toBe(1);
    } finally {
      out.restore();
      errOut.restore();
    }
  });
});
