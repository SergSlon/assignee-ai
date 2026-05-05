/**
 * Tests for `describeResource` — the SSH-bundle Story iv service helper.
 *
 * Covers the polymorphism (runId vs ARN), the live DescribeInstances
 * overlay (happy path / divergence / fetch-failure), and the non-EC2
 * fast path. All AWS-shape values are real (real-shape ARNs, real
 * `i-…` instance IDs, real-shape PublicDnsName template) per
 * `feedback_real_data_mocks_all_cases`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProvisionRecord } from "@assignee/core";

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockEc2Send, mockEc2Destroy, mockTryGetAmiDefaultUser } = vi.hoisted(
  () => ({
    mockEc2Send: vi.fn(),
    mockEc2Destroy: vi.fn(),
    mockTryGetAmiDefaultUser: vi.fn(),
  }),
);

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

import {
  describeResource,
  DescribeNotFoundError,
} from "./describe-resource.js";
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

function s3Provision(
  overrides: Partial<ProvisionRecord> = {},
): ProvisionRecord {
  return {
    runId: S3_RUN_ID,
    resourceType: "AWS::S3::Bucket",
    resourceArn: S3_ARN,
    region: "us-east-1",
    desiredStateHash: "def456",
    estimatedMonthlyCost: "$0.023/GB-month",
    timestamp: "2026-05-05T11:00:00.000Z",
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockEc2Send.mockReset();
  mockEc2Destroy.mockReset();
  mockTryGetAmiDefaultUser.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("describeResource — polymorphism (runId vs ARN)", () => {
  it("forwards a UUID-shaped runId to readProvisionRecord verbatim", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: EC2_INSTANCE_ID }] }],
    });

    await describeResource(RUN_ID);

    expect(defaultMemoryService.readProvisionRecord).toHaveBeenCalledWith(
      RUN_ID,
    );
  });

  it("forwards a full ARN to readProvisionRecord verbatim", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: EC2_INSTANCE_ID }] }],
    });

    await describeResource(EC2_FULL_ARN);

    expect(defaultMemoryService.readProvisionRecord).toHaveBeenCalledWith(
      EC2_FULL_ARN,
    );
  });

  it("throws DescribeNotFoundError when readProvisionRecord returns undefined", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      undefined,
    );

    await expect(describeResource("not-a-real-id")).rejects.toBeInstanceOf(
      DescribeNotFoundError,
    );
    await expect(describeResource("not-a-real-id")).rejects.toMatchObject({
      code: "DESCRIBE_NOT_FOUND",
      message: expect.stringContaining(
        'No provision record found for "not-a-real-id"',
      ),
    });
  });
});

describe("describeResource — EC2 live overlay", () => {
  it("happy path: live IP equals apply-time IP — no divergence annotation", async () => {
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

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBe(LIVE_IP);
    expect(result.state.publicDnsName).toBe(LIVE_DNS);
    expect(result.state.keyName).toBe(KEY_NAME);
    expect(result.state.amiId).toBe(AMI_ID);
    expect(result.state.sshUsername).toBe(SSH_USERNAME);
    // Equal IPs collapse — no annotation.
    expect(result.publicIpAddressAtApplyForAnnotation).toBeUndefined();
    expect(result.liveFetchAttempted).toBe(true);
    expect(result.liveFetchSucceeded).toBe(true);
  });

  it("divergence: live IP differs from apply-time IP — annotation surfaced", async () => {
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

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBe(LIVE_IP);
    expect(result.publicIpAddressAtApplyForAnnotation).toBe(APPLY_TIME_IP);
  });

  it("DescribeInstances issued with bare InstanceId, not the full ARN", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [{ Instances: [{ InstanceId: EC2_INSTANCE_ID }] }],
    });

    await describeResource(RUN_ID);

    expect(mockEc2Send).toHaveBeenCalledWith(
      expect.objectContaining({
        _type: "DescribeInstancesCommand",
        input: { InstanceIds: [EC2_INSTANCE_ID] },
      }),
    );
  });

  it("live fetch fails: falls back to apply-time IP, no divergence annotation", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockRejectedValueOnce(
      Object.assign(new Error("Rate exceeded"), {
        name: "ThrottlingException",
      }),
    );

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBe(APPLY_TIME_IP);
    expect(result.state.publicDnsName).toBeUndefined();
    expect(result.state.sshUsername).toBeUndefined();
    expect(result.publicIpAddressAtApplyForAnnotation).toBeUndefined();
    expect(result.liveFetchSucceeded).toBe(false);
  });

  it("backwards-compat: pre-Story-iv record (no publicIpAddressAtApply) renders without annotation", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision({ publicIpAddressAtApply: undefined }),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              PublicIpAddress: LIVE_IP,
            },
          ],
        },
      ],
    });

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBe(LIVE_IP);
    expect(result.publicIpAddressAtApplyForAnnotation).toBeUndefined();
  });

  it("DescribeInstances returns no Reservations: falls back to apply-time IP", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    mockEc2Send.mockResolvedValueOnce({ Reservations: [] });

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBe(APPLY_TIME_IP);
    expect(result.liveFetchSucceeded).toBe(false);
  });

  it("EC2 with no public IP (private subnet): live fetch succeeds, no IP, no annotation", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision({ publicIpAddressAtApply: undefined }),
    );
    mockEc2Send.mockResolvedValueOnce({
      Reservations: [
        {
          Instances: [
            {
              InstanceId: EC2_INSTANCE_ID,
              // No PublicIpAddress — private subnet.
              PrivateIpAddress: "10.0.1.42",
            },
          ],
        },
      ],
    });

    const result = await describeResource(RUN_ID);

    expect(result.state.publicIpAddress).toBeUndefined();
    expect(result.state.publicDnsName).toBeUndefined();
    expect(result.publicIpAddressAtApplyForAnnotation).toBeUndefined();
    expect(result.liveFetchSucceeded).toBe(true);
  });
});

describe("describeResource — non-EC2 fast path", () => {
  it("S3 bucket: no DescribeInstances call, render from provision record only", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      s3Provision(),
    );

    const result = await describeResource(S3_RUN_ID);

    expect(mockEc2Send).not.toHaveBeenCalled();
    expect(result.state.resourceType).toBe("AWS::S3::Bucket");
    expect(result.state.resourceArn).toBe(S3_ARN);
    expect(result.state.publicIpAddress).toBeUndefined();
    expect(result.liveFetchAttempted).toBe(false);
    expect(result.liveFetchSucceeded).toBe(false);
  });
});

describe("describeResource — no caching (each call is fresh)", () => {
  it("two calls: DescribeInstances issued each time so stop/start IP changes are observable", async () => {
    vi.mocked(defaultMemoryService.readProvisionRecord).mockResolvedValue(
      ec2Provision(),
    );
    // Simulate a stop/start cycle re-issuing the public IP between
    // the two `describe` invocations — the second call MUST observe
    // the new value rather than a stale cached one.
    const FIRST_LIVE_IP = "54.198.42.117";
    const SECOND_LIVE_IP = "54.198.42.200";
    mockEc2Send
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: EC2_INSTANCE_ID, PublicIpAddress: FIRST_LIVE_IP },
            ],
          },
        ],
      })
      .mockResolvedValueOnce({
        Reservations: [
          {
            Instances: [
              { InstanceId: EC2_INSTANCE_ID, PublicIpAddress: SECOND_LIVE_IP },
            ],
          },
        ],
      });

    const first = await describeResource(RUN_ID);
    const second = await describeResource(RUN_ID);

    expect(mockEc2Send).toHaveBeenCalledTimes(2);
    expect(first.state.publicIpAddress).toBe(FIRST_LIVE_IP);
    expect(second.state.publicIpAddress).toBe(SECOND_LIVE_IP);
  });
});
