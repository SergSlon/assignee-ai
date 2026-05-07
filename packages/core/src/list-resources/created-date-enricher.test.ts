/**
 * Tests for the created-date enricher.
 *
 * All AWS SDK calls are mocked — no live AWS calls in this test.
 * Covers happy paths for KMS and S3 (the primary "must work" types),
 * per-tuple failure degradation, and ARN parsing edge cases.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── SDK mocks — hoisted so they are in scope when the module loads ─────────
// Use prototype-level `send` so vi.mocked(Client.prototype.send) works.

const kmsSendMock = vi.fn();
const s3SendMock = vi.fn();
const cfSendMock = vi.fn();
const iamSendMock = vi.fn();
const lambdaSendMock = vi.fn();
const ddbSendMock = vi.fn();

vi.mock("@aws-sdk/client-kms", () => {
  const DescribeKeyCommand = vi.fn((args: unknown) => args);
  class KMSClient {
    send = kmsSendMock;
    destroy = vi.fn();
  }
  return { KMSClient, DescribeKeyCommand };
});

vi.mock("@aws-sdk/client-s3", () => {
  const ListBucketsCommand = vi.fn((args: unknown) => args);
  class S3Client {
    send = s3SendMock;
    destroy = vi.fn();
  }
  return { S3Client, ListBucketsCommand };
});

vi.mock("@aws-sdk/client-cloudfront", () => {
  const GetDistributionCommand = vi.fn((args: unknown) => args);
  class CloudFrontClient {
    send = cfSendMock;
    destroy = vi.fn();
  }
  return { CloudFrontClient, GetDistributionCommand };
});

vi.mock("@aws-sdk/client-iam", () => {
  const GetPolicyCommand = vi.fn((args: unknown) => args);
  class IAMClient {
    send = iamSendMock;
    destroy = vi.fn();
  }
  return { IAMClient, GetPolicyCommand };
});

vi.mock("@aws-sdk/client-lambda", () => {
  const GetFunctionConfigurationCommand = vi.fn((args: unknown) => args);
  class LambdaClient {
    send = lambdaSendMock;
    destroy = vi.fn();
  }
  return { LambdaClient, GetFunctionConfigurationCommand };
});

vi.mock("@aws-sdk/client-dynamodb", () => {
  const DescribeTableCommand = vi.fn((args: unknown) => args);
  class DynamoDBClient {
    send = ddbSendMock;
    destroy = vi.fn();
  }
  return { DynamoDBClient, DescribeTableCommand };
});

// Import AFTER mocks are registered
import { DescribeKeyCommand } from "@aws-sdk/client-kms";
import { ListBucketsCommand } from "@aws-sdk/client-s3";
import { GetDistributionCommand } from "@aws-sdk/client-cloudfront";
import { GetPolicyCommand } from "@aws-sdk/client-iam";
import { GetFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { createListCreatedDateEnricher } from "./created-date-enricher.js";
import type { ManagedResource } from "./types.js";

const TEST_CREDS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const TEST_REGION = "us-east-1";

function makeResource(
  arn: string,
  resourceType: string,
  region = "us-east-1",
): ManagedResource {
  return {
    resourceType,
    arn,
    keyKind: "arn",
    region,
    createdDate: "N/A",
    estimatedMonthlyCost: "N/A",
  };
}

describe("createListCreatedDateEnricher — KMS keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves creation date from DescribeKey response", async () => {
    const kmsArn =
      "arn:aws:kms:us-east-1:112233445566:key/b725bae0-1234-5678-abcd";
    kmsSendMock.mockResolvedValue({
      KeyMetadata: {
        CreationDate: new Date("2025-01-15T10:30:00.000Z"),
      },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    expect(result.get(kmsArn)).toBe("2025-01-15");
  });

  it("calls DescribeKeyCommand with the key ID extracted from ARN", async () => {
    const kmsArn =
      "arn:aws:kms:us-east-1:112233445566:key/b725bae0-1234-5678-abcd";
    kmsSendMock.mockResolvedValue({
      KeyMetadata: { CreationDate: new Date("2025-03-01T00:00:00.000Z") },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

    expect(DescribeKeyCommand).toHaveBeenCalledWith({
      KeyId: "b725bae0-1234-5678-abcd",
    });
  });

  it("handles multiple KMS keys in one call", async () => {
    const arn1 = "arn:aws:kms:us-east-1:112233445566:key/aaaaaaaa-1111";
    const arn2 = "arn:aws:kms:us-east-1:112233445566:key/bbbbbbbb-2222";

    kmsSendMock
      .mockResolvedValueOnce({
        KeyMetadata: { CreationDate: new Date("2025-01-01T00:00:00.000Z") },
      })
      .mockResolvedValueOnce({
        KeyMetadata: { CreationDate: new Date("2025-06-15T00:00:00.000Z") },
      });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(arn1, "AWS::KMS::Key"),
      makeResource(arn2, "AWS::KMS::Key"),
    ]);

    expect(result.get(arn1)).toBe("2025-01-01");
    expect(result.get(arn2)).toBe("2025-06-15");
  });

  it("does not add entry when DescribeKey fails for a key", async () => {
    const goodArn = "arn:aws:kms:us-east-1:112233445566:key/good-key-1234";
    const badArn = "arn:aws:kms:us-east-1:112233445566:key/bad-key-5678";

    kmsSendMock
      .mockResolvedValueOnce({
        KeyMetadata: { CreationDate: new Date("2025-01-01T00:00:00.000Z") },
      })
      .mockRejectedValueOnce(new Error("AccessDenied"));

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(goodArn, "AWS::KMS::Key"),
      makeResource(badArn, "AWS::KMS::Key"),
    ]);

    expect(result.get(goodArn)).toBe("2025-01-01");
    expect(result.has(badArn)).toBe(false);
  });
});

describe("createListCreatedDateEnricher — S3 buckets", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves creation date from ListBuckets response by matching bucket name", async () => {
    const s3Arn = "arn:aws:s3:::my-demo-logs-bucket";
    s3SendMock.mockResolvedValue({
      Buckets: [
        {
          Name: "my-demo-logs-bucket",
          CreationDate: new Date("2024-08-20T14:00:00.000Z"),
        },
        {
          Name: "other-bucket",
          CreationDate: new Date("2023-01-01T00:00:00.000Z"),
        },
      ],
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([makeResource(s3Arn, "AWS::S3::Bucket")]);

    expect(result.get(s3Arn)).toBe("2024-08-20");
  });

  it("issues ONE ListBuckets call for multiple S3 buckets in same region", async () => {
    const arn1 = "arn:aws:s3:::bucket-one";
    const arn2 = "arn:aws:s3:::bucket-two";
    s3SendMock.mockResolvedValue({
      Buckets: [
        {
          Name: "bucket-one",
          CreationDate: new Date("2025-02-10T00:00:00.000Z"),
        },
        {
          Name: "bucket-two",
          CreationDate: new Date("2025-03-15T00:00:00.000Z"),
        },
      ],
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    await enricher([
      makeResource(arn1, "AWS::S3::Bucket"),
      makeResource(arn2, "AWS::S3::Bucket"),
    ]);

    // Only one send call (ListBuckets is called once per region group)
    expect(s3SendMock).toHaveBeenCalledTimes(1);
    expect(ListBucketsCommand).toHaveBeenCalledTimes(1);
  });

  it("does not set entry when bucket not found in ListBuckets response", async () => {
    const s3Arn = "arn:aws:s3:::missing-bucket";
    s3SendMock.mockResolvedValue({ Buckets: [] });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([makeResource(s3Arn, "AWS::S3::Bucket")]);

    expect(result.has(s3Arn)).toBe(false);
  });
});

describe("createListCreatedDateEnricher — per-tuple failure degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("S3 failure does not prevent KMS enrichment from succeeding", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/good-key-aaaa";
    const s3Arn = "arn:aws:s3:::broken-bucket";

    // KMS succeeds
    kmsSendMock.mockResolvedValue({
      KeyMetadata: { CreationDate: new Date("2026-01-05T00:00:00.000Z") },
    });
    // S3 fails
    s3SendMock.mockRejectedValue(new Error("AccessDenied on ListBuckets"));

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(kmsArn, "AWS::KMS::Key"),
      makeResource(s3Arn, "AWS::S3::Bucket"),
    ]);

    // KMS resolved, S3 absent
    expect(result.get(kmsArn)).toBe("2026-01-05");
    expect(result.has(s3Arn)).toBe(false);
  });

  it("does not throw when all describe calls fail", async () => {
    const arn = "arn:aws:kms:us-east-1:112233445566:key/fail-key-0000";
    kmsSendMock.mockRejectedValue(new Error("Network error"));

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    // Must not throw
    await expect(
      enricher([makeResource(arn, "AWS::KMS::Key")]),
    ).resolves.toBeInstanceOf(Map);
  });
});

describe("createListCreatedDateEnricher — CloudFront distributions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves date from GetDistribution with (modified) annotation", async () => {
    const cfArn =
      "arn:aws:cloudfront::112233445566:distribution/E3B1MIRNBPH9JG";
    cfSendMock.mockResolvedValue({
      Distribution: {
        LastModifiedTime: new Date("2025-11-20T00:00:00.000Z"),
      },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(cfArn, "AWS::CloudFront::Distribution", "global"),
    ]);

    expect(result.get(cfArn)).toBe("2025-11-20 (modified)");
    expect(GetDistributionCommand).toHaveBeenCalledWith({
      Id: "E3B1MIRNBPH9JG",
    });
  });
});

describe("createListCreatedDateEnricher — IAM ManagedPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves date from GetPolicy CreateDate", async () => {
    const iamArn = "arn:aws:iam::112233445566:policy/AssigneeAuditorPolicy";
    iamSendMock.mockResolvedValue({
      Policy: {
        CreateDate: new Date("2024-03-10T00:00:00.000Z"),
      },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(iamArn, "AWS::IAM::ManagedPolicy", "global"),
    ]);

    expect(result.get(iamArn)).toBe("2024-03-10");
    expect(GetPolicyCommand).toHaveBeenCalledWith({ PolicyArn: iamArn });
  });
});

describe("createListCreatedDateEnricher — Lambda functions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves date from GetFunctionConfiguration LastModified with (modified) annotation", async () => {
    const lambdaArn =
      "arn:aws:lambda:us-east-1:112233445566:function:my-handler";
    lambdaSendMock.mockResolvedValue({
      LastModified: "2025-09-12T08:15:00.000+0000",
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(lambdaArn, "AWS::Lambda::Function"),
    ]);

    // F#9: Lambda LastModified is deploy-date, not creation; must be annotated
    expect(result.get(lambdaArn)).toBe("2025-09-12 (modified)");
    expect(GetFunctionConfigurationCommand).toHaveBeenCalledWith({
      FunctionName: "my-handler",
    });
  });
});

describe("createListCreatedDateEnricher — DynamoDB tables", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves date from DescribeTable CreationDateTime", async () => {
    const ddbArn =
      "arn:aws:dynamodb:us-east-1:112233445566:table/my-tasks-table";
    ddbSendMock.mockResolvedValue({
      Table: {
        CreationDateTime: new Date("2025-07-04T00:00:00.000Z"),
      },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(ddbArn, "AWS::DynamoDB::Table"),
    ]);

    expect(result.get(ddbArn)).toBe("2025-07-04");
    expect(DescribeTableCommand).toHaveBeenCalledWith({
      TableName: "my-tasks-table",
    });
  });
});

describe("createListCreatedDateEnricher — unsupported types", () => {
  it("skips resources with unsupported type and returns empty map", async () => {
    const arn =
      "arn:aws:ec2:us-east-1:112233445566:instance/i-1234567890abcdef0";
    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([makeResource(arn, "AWS::EC2::Instance")]);
    expect(result.size).toBe(0);
  });

  it("skips resources with empty ARN (non-taggable primaryIdentifier rows)", async () => {
    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      {
        resourceType: "AWS::EC2::RouteTable",
        arn: "",
        primaryIdentifier: "rtb-12345",
        keyKind: "primaryIdentifier",
        region: "us-east-1",
        createdDate: "N/A",
        estimatedMonthlyCost: "N/A",
      },
    ]);
    expect(result.size).toBe(0);
  });
});

// ── F#3: KMS alias ARN handling ────────────────────────────────────────────
describe("createListCreatedDateEnricher — KMS alias ARN", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes 'alias/my-key' (not bare 'my-key') for alias ARNs", async () => {
    // KMS alias ARN: arn:aws:kms:us-east-1:112233445566:alias/my-key
    const aliasArn =
      "arn:aws:kms:us-east-1:112233445566:alias/my-production-key";
    kmsSendMock.mockResolvedValue({
      KeyMetadata: { CreationDate: new Date("2025-04-01T00:00:00.000Z") },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([makeResource(aliasArn, "AWS::KMS::Key")]);

    // DescribeKey must be called with "alias/my-production-key", NOT "my-production-key"
    expect(DescribeKeyCommand).toHaveBeenCalledWith({
      KeyId: "alias/my-production-key",
    });
    expect(result.get(aliasArn)).toBe("2025-04-01");
  });

  it("still extracts bare key ID for key (non-alias) ARNs", async () => {
    const keyArn = "arn:aws:kms:us-east-1:112233445566:key/b725bae0-abcd-1234";
    kmsSendMock.mockResolvedValue({
      KeyMetadata: { CreationDate: new Date("2025-05-10T00:00:00.000Z") },
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    await enricher([makeResource(keyArn, "AWS::KMS::Key")]);

    expect(DescribeKeyCommand).toHaveBeenCalledWith({
      KeyId: "b725bae0-abcd-1234",
    });
  });
});

// ── F#8: NotFound errors should be silent ─────────────────────────────────
describe("createListCreatedDateEnricher — NotFound silent degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT emit a warning when KMS key is not found (NotFoundException)", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/deleted-key-1234";
    const notFoundErr = new Error("Key not found");
    (notFoundErr as Error & { name: string }).name = "NotFoundException";
    kmsSendMock.mockRejectedValue(notFoundErr);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
      const result = await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

      expect(stderrSpy).not.toHaveBeenCalled();
      expect(result.has(kmsArn)).toBe(false);
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it("emits a warning for non-NotFound KMS failures", async () => {
    const kmsArn = "arn:aws:kms:us-east-1:112233445566:key/access-denied-key";
    kmsSendMock.mockRejectedValue(new Error("AccessDenied"));

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
      await enricher([makeResource(kmsArn, "AWS::KMS::Key")]);

      expect(stderrSpy).toHaveBeenCalledTimes(1);
    } finally {
      stderrSpy.mockRestore();
    }
  });
});

// ── F#9: Lambda LastModified annotated as (modified) ──────────────────────
describe("createListCreatedDateEnricher — Lambda (modified) annotation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("annotates Lambda date with (modified) consistent with CloudFront", async () => {
    const lambdaArn = "arn:aws:lambda:us-east-1:112233445566:function:my-fn";
    lambdaSendMock.mockResolvedValue({
      LastModified: "2025-10-05T12:00:00.000+0000",
    });

    const enricher = createListCreatedDateEnricher(TEST_CREDS, TEST_REGION);
    const result = await enricher([
      makeResource(lambdaArn, "AWS::Lambda::Function"),
    ]);

    // Must include "(modified)" annotation — LastModified is not a creation date
    expect(result.get(lambdaArn)).toBe("2025-10-05 (modified)");
  });
});
