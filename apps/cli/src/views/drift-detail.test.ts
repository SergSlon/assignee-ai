import { describe, it, expect } from "vitest";
import { renderDriftDetail } from "./drift-detail.js";
import { DriftStatus, ChangeType, type DriftResult } from "@assignee/core";

describe("drift-detail view", () => {
  const baseDriftResult: DriftResult = {
    resourceType: "AWS::S3::Bucket",
    resourceId: "my-app-bucket",
    status: DriftStatus.IN_SYNC,
    driftedFields: [],
    checkedAt: "2026-03-24T10:00:00.000Z",
    desiredState: { BucketName: "my-app-bucket" },
    actualState: { BucketName: "my-app-bucket" },
  };

  it("renders IN_SYNC resource header with no drifted fields", () => {
    const output = renderDriftDetail(baseDriftResult, { noColor: true });
    expect(output).toContain("AWS::S3::Bucket");
    expect(output).toContain("my-app-bucket");
    expect(output).toContain("IN_SYNC");
  });

  it("renders MODIFIED field showing desired -> actual", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "VersioningConfiguration.Status",
          desiredValue: "Enabled",
          actualValue: "Suspended",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("DRIFTED");
    expect(output).toContain("VersioningConfiguration.Status");
    expect(output).toContain("Enabled");
    expect(output).toContain("Suspended");
    expect(output).toContain("1 fields changed");
  });

  it("renders ADDED_EXTERNALLY field in yellow style", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "LoggingConfiguration",
          desiredValue: undefined,
          actualValue: { DestinationBucketName: "logs-bucket" },
          changeType: ChangeType.ADDED_EXTERNALLY,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("LoggingConfiguration");
    expect(output).toContain("added externally");
    expect(output).toContain("logs-bucket");
  });

  it("renders REMOVED field", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "AccelerateConfiguration",
          desiredValue: { AccelerationStatus: "Enabled" },
          actualValue: undefined,
          changeType: ChangeType.REMOVED,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("AccelerateConfiguration");
    expect(output).toContain("(removed)");
    expect(output).toContain("Enabled");
  });

  it("renders nested dot-notation paths", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "Encryption.SSEAlgorithm",
          desiredValue: "aws:kms",
          actualValue: "AES256",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("Encryption.SSEAlgorithm");
  });

  it("renders array diff with index notation", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "Tags[2].Value",
          desiredValue: "production",
          actualValue: "staging",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("Tags[2].Value");
  });

  it("shows matching fields in verbose mode", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.IN_SYNC,
      desiredState: { BucketName: "my-app-bucket", Region: "us-east-1" },
      actualState: { BucketName: "my-app-bucket", Region: "us-east-1" },
    };

    const output = renderDriftDetail(result, {
      noColor: true,
      verbose: true,
    });
    expect(output).toContain("Matching fields");
    expect(output).toContain("BucketName");
  });

  it("strips ANSI codes in --no-color mode", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "Field",
          desiredValue: "a",
          actualValue: "b",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };

    const output = renderDriftDetail(result, { noColor: true });
    // No ANSI escape sequences
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("detects CloudFormation provenance from tags", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      actualState: {
        BucketName: "my-app-bucket",
        Tags: [
          { Key: "aws:cloudformation:stack-name", Value: "my-stack" },
          { Key: "aws:cloudformation:logical-id", Value: "MyBucket" },
        ],
      },
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain(
      "Last modified by: CloudFormation (stack: my-stack)",
    );
  });

  it("renders last provisioned date when provided", () => {
    const output = renderDriftDetail(baseDriftResult, {
      noColor: true,
      lastProvisioned: "2026-03-20T14:30:00Z",
    });
    expect(output).toContain("Last provisioned: 2026-03-20T14:30:00Z");
  });

  it("renders error message for ERROR status", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.ERROR,
      errorMessage: "Access denied to resource",
    };

    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("ERROR");
    expect(output).toContain("Access denied to resource");
  });
});
