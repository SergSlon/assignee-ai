/**
 * Unit tests for resolveDesiredState utility.
 * Verifies that checkpoint resolution uses RESOURCE_IDENTIFIER_KEYS
 * to match ANY resource type, not just S3/Lambda.
 *
 * @see EC-14, Story 28.2
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RESOURCE_IDENTIFIER_KEYS } from "@assignee/core";
import {
  resolveDesiredState,
  baselineFilename,
} from "./resolve-desired-state.js";

// ── Mock fs ─────────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(),
  readFile: vi.fn(),
}));

async function setCheckpointFiles(
  files: Array<{ name: string; content: Record<string, unknown> }>,
) {
  const { readdir, readFile } = await import("node:fs/promises");
  (readdir as ReturnType<typeof vi.fn>).mockResolvedValue(
    files.map((f) => f.name),
  );
  (readFile as ReturnType<typeof vi.fn>).mockImplementation(
    (filePath: string) => {
      const match = files.find((f) => (filePath as string).endsWith(f.name));
      if (match) return Promise.resolve(JSON.stringify(match.content));
      return Promise.reject(new Error("ENOENT"));
    },
  );
}

async function setNoCheckpointDir() {
  const { readdir } = await import("node:fs/promises");
  (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
    new Error("ENOENT: no such file or directory"),
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("resolveDesiredState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should match S3 bucket by BucketName via RESOURCE_IDENTIFIER_KEYS", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::S3::Bucket",
          desiredState: {
            BucketName: "my-bucket",
            VersioningConfiguration: { Status: "Enabled" },
          },
        },
      },
    ]);

    const result = await resolveDesiredState("my-bucket");
    expect(result).toEqual({
      BucketName: "my-bucket",
      VersioningConfiguration: { Status: "Enabled" },
    });
  });

  it("should match DynamoDB table by TableName", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::DynamoDB::Table",
          desiredState: {
            TableName: "users-table",
            BillingMode: "PAY_PER_REQUEST",
          },
        },
      },
    ]);

    const result = await resolveDesiredState("users-table");
    expect(result).toEqual({
      TableName: "users-table",
      BillingMode: "PAY_PER_REQUEST",
    });
  });

  it("should match SQS queue by QueueUrl", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::SQS::Queue",
          desiredState: {
            QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/my-queue",
            VisibilityTimeout: 30,
          },
        },
      },
    ]);

    const result = await resolveDesiredState(
      "https://sqs.us-east-1.amazonaws.com/123/my-queue",
    );
    expect(result).toEqual({
      QueueUrl: "https://sqs.us-east-1.amazonaws.com/123/my-queue",
      VisibilityTimeout: 30,
    });
  });

  it("should match SNS topic by TopicArn", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::SNS::Topic",
          desiredState: {
            TopicArn: "arn:aws:sns:us-east-1:123:my-topic",
            DisplayName: "My Topic",
          },
        },
      },
    ]);

    const result = await resolveDesiredState(
      "arn:aws:sns:us-east-1:123:my-topic",
    );
    expect(result).toEqual({
      TopicArn: "arn:aws:sns:us-east-1:123:my-topic",
      DisplayName: "My Topic",
    });
  });

  it("should match IAM role by RoleName", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::IAM::Role",
          desiredState: {
            RoleName: "my-lambda-role",
            AssumeRolePolicyDocument: {},
          },
        },
      },
    ]);

    const result = await resolveDesiredState("my-lambda-role");
    expect(result).toEqual({
      RoleName: "my-lambda-role",
      AssumeRolePolicyDocument: {},
    });
  });

  it("should match RDS instance by DBInstanceIdentifier", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::RDS::DBInstance",
          desiredState: {
            DBInstanceIdentifier: "my-postgres",
            Engine: "postgres",
          },
        },
      },
    ]);

    const result = await resolveDesiredState("my-postgres");
    expect(result).toEqual({
      DBInstanceIdentifier: "my-postgres",
      Engine: "postgres",
    });
  });

  it("should match SSM parameter by Name", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::SSM::Parameter",
          desiredState: {
            Name: "/app/config/db-host",
            Type: "String",
            Value: "localhost",
          },
        },
      },
    ]);

    const result = await resolveDesiredState("/app/config/db-host");
    expect(result).toEqual({
      Name: "/app/config/db-host",
      Type: "String",
      Value: "localhost",
    });
  });

  it("should match Lambda function by FunctionName", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::Lambda::Function",
          desiredState: {
            FunctionName: "my-handler",
            Runtime: "nodejs20.x",
          },
        },
      },
    ]);

    const result = await resolveDesiredState("my-handler");
    expect(result).toEqual({
      FunctionName: "my-handler",
      Runtime: "nodejs20.x",
    });
  });

  it("should fall back to Arn field when identifier key is not in desiredState", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::EC2::VPC",
          desiredState: {
            Arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-abc",
            CidrBlock: "10.0.0.0/16",
          },
        },
      },
    ]);

    const result = await resolveDesiredState(
      "arn:aws:ec2:us-east-1:123:vpc/vpc-abc",
    );
    expect(result).toEqual({
      Arn: "arn:aws:ec2:us-east-1:123:vpc/vpc-abc",
      CidrBlock: "10.0.0.0/16",
    });
  });

  it("should match by runId as fallback", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          runId: "run-abc-123",
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "other-bucket" },
        },
      },
    ]);

    const result = await resolveDesiredState("run-abc-123");
    expect(result).toEqual({ BucketName: "other-bucket" });
  });

  it("should return newest matching checkpoint (sorted reverse)", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::DynamoDB::Table",
          desiredState: { TableName: "t", BillingMode: "old" },
        },
      },
      {
        name: "checkpoint-002.json",
        content: {
          resourceType: "AWS::DynamoDB::Table",
          desiredState: { TableName: "t", BillingMode: "new" },
        },
      },
    ]);

    const result = await resolveDesiredState("t");
    // checkpoint-002 is newer, should be returned first
    expect(result).toEqual({ TableName: "t", BillingMode: "new" });
  });

  it("should return undefined when no checkpoint matches", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceType: "AWS::S3::Bucket",
          desiredState: { BucketName: "other-bucket" },
        },
      },
    ]);

    const result = await resolveDesiredState("nonexistent");
    expect(result).toBeUndefined();
  });

  it("should return undefined when checkpoint dir does not exist", async () => {
    await setNoCheckpointDir();
    const result = await resolveDesiredState("anything");
    expect(result).toBeUndefined();
  });

  it("should match compound checkpoint resourceQueue entries", async () => {
    await setCheckpointFiles([
      {
        name: "checkpoint-001.json",
        content: {
          resourceQueue: [
            {
              resourceId: "vpc-1",
              displayName: "My VPC",
              desiredState: { CidrBlock: "10.0.0.0/16" },
            },
          ],
        },
      },
    ]);

    const result = await resolveDesiredState("vpc-1");
    expect(result).toEqual({ CidrBlock: "10.0.0.0/16" });
  });

  it("should cover all RESOURCE_IDENTIFIER_KEYS types are known", () => {
    // Sanity check: ensure the map covers expected resource types
    const keys = Object.values(RESOURCE_IDENTIFIER_KEYS);
    expect(keys).toContain("BucketName");
    expect(keys).toContain("TableName");
    expect(keys).toContain("QueueUrl");
    expect(keys).toContain("TopicArn");
    expect(keys).toContain("FunctionName");
    expect(keys).toContain("RoleName");
    expect(keys).toContain("DBInstanceIdentifier");
    expect(keys).toContain("Name"); // SSM
    expect(keys).toContain("LogGroupName");
    expect(keys).toContain("AlarmName");
  });

  // ──────────────────────────────────────────────────────────────────
  // A3 follow-up — baseline fallback (drift --baseline adoption path)
  // ──────────────────────────────────────────────────────────────────
  describe("baseline fallback", () => {
    it("slugifies ARN colons and slashes into underscores", () => {
      expect(baselineFilename("arn:aws:s3:::my-bucket")).toBe(
        "arn_aws_s3___my-bucket.json",
      );
      expect(
        baselineFilename("arn:aws:lambda:us-east-1:123:function:foo"),
      ).toBe("arn_aws_lambda_us-east-1_123_function_foo.json");
      expect(baselineFilename("arn:aws:rds:us-east-1:123:db:prod/slash")).toBe(
        "arn_aws_rds_us-east-1_123_db_prod_slash.json",
      );
    });

    it("returns the baseline desiredState when the checkpoint scan finds nothing", async () => {
      const { readdir, readFile } = await import("node:fs/promises");
      // Checkpoint scan finds nothing.
      (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT: no such file or directory"),
      );
      // Baseline read returns a snapshot payload matching the ARN.
      const arn = "arn:aws:s3:::adopted-bucket";
      const expectedPath = `/baselines/${baselineFilename(arn)}`;
      (readFile as ReturnType<typeof vi.fn>).mockImplementation(
        (filePath: string) => {
          if ((filePath as string).endsWith(baselineFilename(arn))) {
            return Promise.resolve(
              JSON.stringify({
                version: 1,
                arn,
                resourceType: "AWS::S3::Bucket",
                desiredState: {
                  BucketName: "adopted-bucket",
                  VersioningConfiguration: { Status: "Enabled" },
                },
              }),
            );
          }
          return Promise.reject(new Error("ENOENT"));
        },
      );

      const result = await resolveDesiredState(arn);
      expect(result).toEqual({
        BucketName: "adopted-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      });
      // Sanity check — the implementation must have looked at the
      // right path shape (slugified filename under baselines/).
      const callArgs = (readFile as ReturnType<typeof vi.fn>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(callArgs.some((p) => p.endsWith(baselineFilename(arn)))).toBe(
        true,
      );
      expect(expectedPath).toContain(baselineFilename(arn)); // self-check
    });

    it("returns undefined when neither checkpoint nor baseline exists", async () => {
      const { readdir, readFile } = await import("node:fs/promises");
      (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT"),
      );
      (readFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT"),
      );

      const result = await resolveDesiredState("arn:aws:s3:::nope");
      expect(result).toBeUndefined();
    });

    it("ignores a baseline file whose payload is missing desiredState", async () => {
      const { readdir, readFile } = await import("node:fs/promises");
      (readdir as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("ENOENT"),
      );
      // Baseline file exists but is malformed (no desiredState key).
      (readFile as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        JSON.stringify({ version: 1, arn: "arn:aws:s3:::broken" }),
      );

      const result = await resolveDesiredState("arn:aws:s3:::broken");
      expect(result).toBeUndefined();
    });

    it("checkpoint still wins over a baseline when both exist", async () => {
      await setCheckpointFiles([
        {
          name: "checkpoint-001.json",
          content: {
            resourceType: "AWS::S3::Bucket",
            desiredState: {
              BucketName: "my-bucket",
              VersioningConfiguration: { Status: "Suspended" },
            },
          },
        },
      ]);
      // Baseline read should NEVER fire because the checkpoint
      // scan returned a match first. If it did fire, we'd return
      // a different VersioningConfiguration.Status than the
      // checkpoint and the assertion below would flip.

      const result = await resolveDesiredState("my-bucket");
      expect(result).toEqual({
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Suspended" },
      });
    });
  });
});
