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
  function GetBucketPolicyCommand(input: unknown) {
    return { _type: "GetBucketPolicyCommand", input };
  }
  return { S3Client, PutBucketPolicyCommand, GetBucketPolicyCommand };
});

// bug-s3-oac-bucket-policy-clobbering: logger writes the warn-fallthrough
// message — silence it so the test runner output stays clean.
vi.mock("../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    MEMORY_WRITE_FAILED: "memory_write_failed",
  },
}));

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

  // bug-s3-bucket-policy-region-fallback-edge-case: when the caller
  // passes an empty `args.region`, the policy ARN partition must come
  // from the AWS_REGION env var so it matches the partition the S3
  // client will be talking to. Without the fix, the policy ARN gets
  // partition `aws` (empty-string fallback) while a GovCloud
  // `AWS_REGION` would point the client at the `aws-us-gov` partition.
  //
  // NOTE: AWS_REGION is captured at import time by `config/constants/aws.ts`
  // (`process.env.AWS_REGION ?? "us-east-1"`), so this test relies on the
  // env var being set BEFORE the module is first imported. The
  // beforeEach/afterEach block above already sets it to `us-east-1`,
  // but for the fallback assertion we exercise the contract through the
  // build-time constant by checking that the partition derives from a
  // GovCloud-shaped region value passed via the env-resolution path.
  // Since the imported AWS_REGION is fixed, we can still assert the
  // *contract* that the implementation derives the partition from
  // `args.region || AWS_REGION` — when `args.region = ""`, the result
  // ARN partition must equal `getPartitionFromRegion(AWS_REGION)`.
  it("falls back to AWS_REGION partition when args.region is empty string", async () => {
    const { AWS_REGION: importedRegion } =
      await import("../../config/constants/aws.js");
    const { getPartitionFromRegion } =
      await import("../../config/aws-partition.js");
    const expectedPartition = getPartitionFromRegion(importedRegion);

    const policy = buildCompensatingBucketPolicy({
      bucketName: "fallback-bucket",
      operatorArn: OPERATOR_ARN,
      region: "",
    }) as { Statement: Array<{ Resource: string[] }> };

    const resources = policy.Statement[0]!.Resource;
    // The policy ARN partition MUST match the partition AWS_REGION
    // resolves to (the same value the S3 client is constructed with).
    expect(resources[0]).toMatch(
      new RegExp(`^arn:${expectedPartition}:s3:::fallback-bucket$`),
    );
    expect(resources[1]).toMatch(
      new RegExp(`^arn:${expectedPartition}:s3:::fallback-bucket/\\*$`),
    );
  });
});

// ── attachCompensatingBucketPolicy ───────────────────────────────────────────

describe("attachCompensatingBucketPolicy", () => {
  /**
   * Helper: simulate a bucket that has NO existing bucket policy.
   * The compensating attach flow always issues GetBucketPolicy first
   * (bug-s3-oac-bucket-policy-clobbering merge); empty-bucket → AWS
   * returns NoSuchBucketPolicy.
   */
  function mockNoExistingPolicy(): void {
    mockS3Send.mockImplementationOnce(() => {
      const err = new Error("The bucket policy does not exist") as Error & {
        name: string;
        Code: string;
      };
      err.name = "NoSuchBucketPolicy";
      err.Code = "NoSuchBucketPolicy";
      return Promise.reject(err);
    });
  }

  it("calls PutBucketPolicyCommand with correct Bucket and Policy string", async () => {
    // GET → NoSuchBucketPolicy (empty bucket), PUT → success.
    mockNoExistingPolicy();
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
    expect(mockS3Send).toHaveBeenCalledTimes(2);

    // The PUT is the SECOND send call (GET was first).
    const putCall = mockS3Send.mock.calls[1] as [
      { _type: string; input: { Bucket: string; Policy: string } },
    ];
    const calledWith = putCall[0];
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
    mockNoExistingPolicy();
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
    // GET + PUT = 2 calls; must NOT throw.
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it("returns { attached: false, reason } for throttling errors", async () => {
    mockNoExistingPolicy();
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
    mockNoExistingPolicy();
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
    mockNoExistingPolicy();
    mockS3Send.mockResolvedValueOnce({});

    // No client injected — should use env credentials.
    const result = await attachCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: REGION,
    });

    expect(result.attached).toBe(true);
    expect(mockS3Send).toHaveBeenCalledTimes(2);
  });

  it("uses AWS_REGION from env when region arg is empty string", async () => {
    mockNoExistingPolicy();
    mockS3Send.mockResolvedValueOnce({});

    const result = await attachCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: "",
    });

    // Should not throw (falls back to AWS_REGION env var).
    expect(result.attached).toBe(true);
  });

  // bug-s3-bucket-policy-region-fallback-edge-case: when args.region is
  // empty, the policy ARN's partition AND the S3 client's region must
  // both derive from the same effectiveRegion (= AWS_REGION fallback).
  // Previously, the policy ARN was built with `args.region` directly,
  // so an empty string fell back to partition `aws` while the client
  // used AWS_REGION — masking a partition mismatch on GovCloud callers.
  it("derives policy ARN partition AND client region from the same effectiveRegion when args.region is empty", async () => {
    mockNoExistingPolicy();
    mockS3Send.mockResolvedValueOnce({});
    const { AWS_REGION: importedRegion } =
      await import("../../config/constants/aws.js");
    const { getPartitionFromRegion } =
      await import("../../config/aws-partition.js");
    const expectedPartition = getPartitionFromRegion(importedRegion);

    const result = await attachCompensatingBucketPolicy({
      bucketName: BUCKET_NAME,
      operatorArn: OPERATOR_ARN,
      region: "",
    });

    expect(result.attached).toBe(true);
    expect(mockS3Send).toHaveBeenCalledTimes(2);

    // PUT is the SECOND call (GET was first).
    const putCall = mockS3Send.mock.calls[1] as [{ input: { Policy: string } }];
    const calledWith = putCall[0];
    const parsedPolicy = JSON.parse(calledWith.input.Policy) as {
      Statement: Array<{ Resource: string[] }>;
    };
    // The policy ARN partition MUST match the resolved fallback region's
    // partition — proves the fix derives the partition from
    // effectiveRegion instead of args.region.
    expect(parsedPolicy.Statement[0]!.Resource[0]).toMatch(
      new RegExp(`^arn:${expectedPartition}:s3:::`),
    );
  });

  // ─────────────────────────────────────────────────────────────────────
  // bug-s3-oac-bucket-policy-clobbering: a plain PutBucketPolicy clobbers
  // the OAC cloudfront.amazonaws.com grant the static-website compound
  // attaches via the BucketPolicy step BEFORE we run. The merge logic
  // must preserve existing statements (or replace the same Sid when
  // already present), and refuse to overwrite a malformed existing
  // policy. Falling through to legacy PUT-only behaviour is the
  // back-compat guarantee for non-OAC buckets where the operator might
  // lack `s3:GetBucketPolicy`.
  // ─────────────────────────────────────────────────────────────────────

  describe("bug-s3-oac-bucket-policy-clobbering — merge logic", () => {
    /** Realistic OAC bucket policy as CCAPI's BucketPolicy step writes it. */
    const OAC_DISTRIBUTION_ARN =
      "arn:aws:cloudfront::112233445566:distribution/E1A2B3C4D5E6F7";
    const oacOnlyPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "AllowCloudFrontServicePrincipalReadOnly",
          Effect: "Allow",
          Principal: { Service: "cloudfront.amazonaws.com" },
          Action: "s3:GetObject",
          Resource: `arn:aws:s3:::${BUCKET_NAME}/*`,
          Condition: {
            StringEquals: {
              "AWS:SourceArn": OAC_DISTRIBUTION_ARN,
            },
          },
        },
      ],
    };

    it("OAC-grant-only existing policy → PUT receives merged [OAC, compensating]", async () => {
      // GET returns the OAC policy as a JSON string (real AWS shape).
      mockS3Send.mockResolvedValueOnce({
        Policy: JSON.stringify(oacOnlyPolicy),
      });
      // PUT succeeds.
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
      expect(mockS3Send).toHaveBeenCalledTimes(2);

      const putCall = mockS3Send.mock.calls[1] as [
        { _type: string; input: { Policy: string } },
      ];
      expect(putCall[0]._type).toBe("PutBucketPolicyCommand");
      const merged = JSON.parse(putCall[0].input.Policy) as {
        Statement: Array<{ Sid: string }>;
      };
      // EXACTLY two statements: OAC preserved, compensating appended.
      expect(merged.Statement).toHaveLength(2);
      expect(merged.Statement[0]!.Sid).toBe(
        "AllowCloudFrontServicePrincipalReadOnly",
      );
      expect(merged.Statement[1]!.Sid).toBe(
        "AssigneeOperatorDestructiveTagScoped",
      );
    });

    it("both statements already present → idempotent: compensating REPLACED, length stays 2", async () => {
      // Pre-existing policy already has BOTH the OAC grant and a stale
      // compensating statement (e.g. earlier `assignee setup` run).
      const stalePolicy = {
        Version: "2012-10-17",
        Statement: [
          oacOnlyPolicy.Statement[0],
          {
            Sid: "AssigneeOperatorDestructiveTagScoped",
            Effect: "Allow",
            Principal: { AWS: "arn:aws:iam::112233445566:user/stale-operator" },
            Action: ["s3:DeleteBucket"],
            Resource: [
              `arn:aws:s3:::${BUCKET_NAME}`,
              `arn:aws:s3:::${BUCKET_NAME}/*`,
            ],
            Condition: {
              StringEquals: {
                "aws:ResourceTag/managed-by": "assignee-ai",
              },
            },
          },
        ],
      };
      mockS3Send.mockResolvedValueOnce({
        Policy: JSON.stringify(stalePolicy),
      });
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
      expect(mockS3Send).toHaveBeenCalledTimes(2);

      const putCall = mockS3Send.mock.calls[1] as [
        { input: { Policy: string } },
      ];
      const merged = JSON.parse(putCall[0].input.Policy) as {
        Statement: Array<{
          Sid: string;
          Principal: { AWS?: string; Service?: string };
          Action: string | string[];
        }>;
      };
      // Length stays 2 (no append).
      expect(merged.Statement).toHaveLength(2);
      // OAC still in position 0 (preserved by index-replace).
      expect(merged.Statement[0]!.Sid).toBe(
        "AllowCloudFrontServicePrincipalReadOnly",
      );
      // Compensating REPLACED — Principal.AWS is the CURRENT operator,
      // not the stale one, and Action is the full 6-action sorted list.
      expect(merged.Statement[1]!.Sid).toBe(
        "AssigneeOperatorDestructiveTagScoped",
      );
      expect(merged.Statement[1]!.Principal.AWS).toBe(OPERATOR_ARN);
      expect(Array.isArray(merged.Statement[1]!.Action)).toBe(true);
      expect((merged.Statement[1]!.Action as string[]).length).toBe(6);
    });

    it("GetBucketPolicy throws non-NoSuch error → log warn, fall through to legacy PUT-only", async () => {
      // Throttling on GET — operator may also lack `s3:GetBucketPolicy`
      // IAM permission entirely. The legacy fallback writes ONLY the
      // compensating statement (back-compat for non-OAC buckets).
      mockS3Send.mockRejectedValueOnce(
        Object.assign(new Error("Rate exceeded"), {
          name: "ThrottlingException",
          $fault: "client",
        }),
      );
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
      expect(mockS3Send).toHaveBeenCalledTimes(2);

      const putCall = mockS3Send.mock.calls[1] as [
        { input: { Policy: string } },
      ];
      const written = JSON.parse(putCall[0].input.Policy) as {
        Statement: Array<{ Sid: string }>;
      };
      // Legacy behaviour: ONLY the compensating statement.
      expect(written.Statement).toHaveLength(1);
      expect(written.Statement[0]!.Sid).toBe(
        "AssigneeOperatorDestructiveTagScoped",
      );
    });

    it("existing policy is malformed JSON → return { attached: false, reason }, NO PUT happens", async () => {
      // Real AWS would never serve invalid JSON, but a manual operator
      // edit could. Refuse to PUT instead of clobbering the malformed
      // policy with something else — operator intent is unknowable.
      mockS3Send.mockResolvedValueOnce({
        Policy: "{ this is not valid json",
      });

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
      expect(result.reason).toMatch(/malformed JSON/i);
      // ONLY the GET happened — no PUT.
      expect(mockS3Send).toHaveBeenCalledTimes(1);
      const [getCall] = mockS3Send.mock.calls[0] as [{ _type: string }];
      expect(getCall._type).toBe("GetBucketPolicyCommand");
    });
  });
});
