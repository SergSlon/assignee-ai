/**
 * Tests for `s3-compensating-bucket-policy.ts`.
 *
 * Coverage:
 *   - buildCompensatingBucketPolicy: correct policy shape, sorted actions,
 *     correct resource ARNs (bucket + bucket/*), condition tag, partition-aware.
 *   - attachCompensatingBucketPolicy: PutBucketPolicyCommand called with correct
 *     Bucket + Policy; failure mode (SDK throws → AttachResult { attached: false }).
 *   - managedByTag override (non-default tag value).
 *
 * All AWS-shape values use realistic patterns per feedback_real_data_mocks_all_cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Hoisted mock refs ────────────────────────────────────────────────────────
const { mockS3Send } = vi.hoisted(() => ({
  mockS3Send: vi.fn(),
}));

vi.mock("@aws-sdk/client-s3", () => {
  class S3Client {
    send = mockS3Send;
  }
  function PutBucketPolicyCommand(input: unknown) {
    return { _type: "PutBucketPolicyCommand", input };
  }
  return { S3Client, PutBucketPolicyCommand };
});

// Snapshot env so credential mutations don't leak between tests.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
  process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
    "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
  process.env["AWS_REGION"] = "us-east-1";
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

import {
  buildCompensatingBucketPolicy,
  attachCompensatingBucketPolicy,
  COMPENSATING_POLICY_ACTIONS,
  MANAGED_BY_TAG_KEY,
  MANAGED_BY_TAG_VALUE,
} from "../s3-compensating-bucket-policy.js";
import { S3Client } from "@aws-sdk/client-s3";

// ── Realistic fixtures ────────────────────────────────────────────────────────

const BUCKET_NAME = "assignee-myapp-assets-2026";
const OPERATOR_ARN = "arn:aws:iam::112233445566:user/assignee-operator";
const REGION = "us-east-1";
const BUCKET_ARN = `arn:aws:s3:::${BUCKET_NAME}`;

// ── buildCompensatingBucketPolicy ────────────────────────────────────────────

describe("buildCompensatingBucketPolicy", () => {
  it("produces a well-formed policy with correct Sid, Effect, Principal", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    }) as {
      Version: string;
      Statement: Array<{
        Sid: string;
        Effect: string;
        Principal: { AWS: string };
        Action: string[];
        Resource: string[];
        Condition: Record<string, Record<string, string>>;
      }>;
    };

    expect(policy.Version).toBe("2012-10-17");
    expect(policy.Statement).toHaveLength(1);

    const stmt = policy.Statement[0]!;
    expect(stmt.Sid).toBe("AssigneeOperatorDestructiveTagScoped");
    expect(stmt.Effect).toBe("Allow");
    expect(stmt.Principal).toEqual({ AWS: OPERATOR_ARN });
  });

  it("sorts the 6 compensating actions alphabetically", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    }) as { Statement: Array<{ Action: string[] }> };

    const actions = policy.Statement[0]!.Action;
    expect(actions).toEqual([...COMPENSATING_POLICY_ACTIONS].sort());
    // Verify sorted order (snapshot).
    expect(actions).toEqual([
      "s3:DeleteBucket",
      "s3:DeleteBucketPolicy",
      "s3:DeleteObject",
      "s3:DeleteObjectVersion",
      "s3:ListBucket",
      "s3:ListBucketVersions",
    ]);
  });

  it("sets Resource to bucket ARN + bucket/* ARN (both)", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    }) as { Statement: Array<{ Resource: string[] }> };

    const resources = policy.Statement[0]!.Resource;
    expect(resources).toHaveLength(2);
    expect(resources).toContain(BUCKET_ARN);
    expect(resources).toContain(`${BUCKET_ARN}/*`);
  });

  it("conditions the Allow on aws:ResourceTag/managed-by = assignee-ai", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    }) as {
      Statement: Array<{
        Condition: { StringEquals: Record<string, string> };
      }>;
    };

    const condition = policy.Statement[0]!.Condition;
    expect(condition.StringEquals).toEqual({
      [`aws:ResourceTag/${MANAGED_BY_TAG_KEY}`]: MANAGED_BY_TAG_VALUE,
    });
  });

  it("uses partition-aware ARN — eu-west-1 still uses arn:aws partition", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: "myapp-eu-bucket",
      operatorArn: OPERATOR_ARN,
      region: "eu-west-1",
    }) as { Statement: Array<{ Resource: string[] }> };

    const resources = policy.Statement[0]!.Resource;
    expect(resources[0]).toMatch(/^arn:aws:s3:::/);
  });

  it("uses arn:aws-us-gov partition for us-gov-east-1 region", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: "govcloud-bucket",
      operatorArn: "arn:aws-us-gov:iam::112233445566:user/assignee-operator",
      region: "us-gov-east-1",
    }) as { Statement: Array<{ Resource: string[] }> };

    const resources = policy.Statement[0]!.Resource;
    expect(resources[0]).toMatch(/^arn:aws-us-gov:s3:::/);
    expect(resources[1]).toMatch(/^arn:aws-us-gov:s3:::/);
  });

  it("respects the managedByTag override", () => {
    const policy = buildCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
      managedByTag: "test-tag-value",
    }) as {
      Statement: Array<{
        Condition: { StringEquals: Record<string, string> };
      }>;
    };

    const condition = policy.Statement[0]!.Condition;
    expect(
      condition.StringEquals[`aws:ResourceTag/${MANAGED_BY_TAG_KEY}`],
    ).toBe("test-tag-value");
  });
});

// ── attachCompensatingBucketPolicy ───────────────────────────────────────────

describe("attachCompensatingBucketPolicy", () => {
  it("calls PutBucketPolicyCommand with correct Bucket and Policy string", async () => {
    mockS3Send.mockResolvedValueOnce({});

    const client = new S3Client({ region: REGION });
    const result = await attachCompensatingBucketPolicy(
      {
        bucketName: BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
        region: REGION,
      },
      client,
    );

    expect(result).toEqual({ attached: true });
    expect(mockS3Send).toHaveBeenCalledTimes(1);

    const [calledWith] = mockS3Send.mock.calls[0] as [
      { _type: string; input: { Bucket: string; Policy: string } },
    ];
    expect(calledWith._type).toBe("PutBucketPolicyCommand");
    expect(calledWith.input.Bucket).toBe(BUCKET_NAME);

    // Verify the Policy field is valid JSON and matches the expected shape.
    const parsedPolicy = JSON.parse(calledWith.input.Policy) as {
      Statement: Array<{
        Sid: string;
        Principal: { AWS: string };
        Condition: { StringEquals: Record<string, string> };
      }>;
    };
    expect(parsedPolicy.Statement[0]!.Sid).toBe(
      "AssigneeOperatorDestructiveTagScoped",
    );
    expect(parsedPolicy.Statement[0]!.Principal.AWS).toBe(OPERATOR_ARN);
    expect(
      parsedPolicy.Statement[0]!.Condition.StringEquals[
        `aws:ResourceTag/${MANAGED_BY_TAG_KEY}`
      ],
    ).toBe(MANAGED_BY_TAG_VALUE);
  });

  it("returns { attached: false, reason } when PutBucketPolicyCommand throws — does NOT propagate", async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("Access Denied"), {
        name: "AccessDeniedException",
        $fault: "client",
      }),
    );

    const client = new S3Client({ region: REGION });
    const result = await attachCompensatingBucketPolicy(
      {
        bucketName: BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
        region: REGION,
      },
      client,
    );

    expect(result.attached).toBe(false);
    expect(result.reason).toContain("Access Denied");
    // Must NOT throw — caller decides how to handle.
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("returns { attached: false, reason } for throttling errors", async () => {
    mockS3Send.mockRejectedValueOnce(
      Object.assign(new Error("Rate exceeded"), {
        name: "ThrottlingException",
        $fault: "client",
      }),
    );

    const client = new S3Client({ region: REGION });
    const result = await attachCompensatingBucketPolicy(
      {
        bucketName: BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
        region: REGION,
      },
      client,
    );

    expect(result.attached).toBe(false);
    expect(result.reason).toContain("Rate exceeded");
  });

  it("returns { attached: false, reason } for non-Error throws (string error)", async () => {
    mockS3Send.mockRejectedValueOnce("unexpected string error");

    const client = new S3Client({ region: REGION });
    const result = await attachCompensatingBucketPolicy(
      {
        bucketName: BUCKET_NAME,
        operatorArn: OPERATOR_ARN,
        region: REGION,
      },
      client,
    );

    expect(result.attached).toBe(false);
    expect(result.reason).toBe("unexpected string error");
  });

  it("creates its own S3Client from operator credentials when none is injected", async () => {
    mockS3Send.mockResolvedValueOnce({});

    // No client injected — should use env credentials.
    const result = await attachCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    });

    expect(result.attached).toBe(true);
    expect(mockS3Send).toHaveBeenCalledTimes(1);
  });

  it("uses AWS_REGION from env when region arg is empty string", async () => {
    mockS3Send.mockResolvedValueOnce({});

    const result = await attachCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: "",
    });

    // Should not throw (falls back to AWS_REGION env var).
    expect(result.attached).toBe(true);
  });
});
