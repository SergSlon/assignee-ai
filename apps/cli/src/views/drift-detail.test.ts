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

  // ── Branch-coverage uplift (P066 R10b-01) ────────────────────────────────

  it("renders DELETED status through statusColor (branch: DriftStatus.DELETED)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DELETED,
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("DELETED");
  });

  it("renders BASELINE_MISSING status through statusColor (branch: DriftStatus.BASELINE_MISSING)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.BASELINE_MISSING,
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("BASELINE_MISSING");
  });

  it("statusColor default branch: unknown status string passes through unchanged", () => {
    const result = {
      ...baseDriftResult,
      // Use unknown cast chain to inject an unexpected status value
      status: "UNKNOWN_STATUS",
    } as unknown as DriftResult;
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("UNKNOWN_STATUS");
  });

  it("renders DELETED status with chalk color when noColor=false", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DELETED,
    };
    // When noColor=false the function routes through chalk.gray — just assert
    // the status string is present somewhere in the output (ANSI may surround it).
    const output = renderDriftDetail(result, { noColor: false });
    expect(output).toContain("DELETED");
  });

  it("renders ERROR status with chalk color when noColor=false (branch: chalk.yellow path)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.ERROR,
      errorMessage: "some error",
    };
    const output = renderDriftDetail(result, { noColor: false });
    expect(output).toContain("ERROR");
  });

  it("renders BASELINE_MISSING status with chalk color when noColor=false", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.BASELINE_MISSING,
    };
    const output = renderDriftDetail(result, { noColor: false });
    expect(output).toContain("BASELINE_MISSING");
  });

  it("detects cfnLogical-only provenance when stack-name tag is absent (branch: cfnLogical path)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      actualState: {
        BucketName: "my-app-bucket",
        Tags: [
          // Only the logical-id tag — no stack-name
          { Key: "aws:cloudformation:logical-id", Value: "MyLogicalBucket" },
        ],
      },
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain(
      "Last modified by: CloudFormation (logical ID: MyLogicalBucket)",
    );
  });

  it("returns undefined provenance when Tags array has no CFN keys", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      actualState: {
        BucketName: "my-app-bucket",
        Tags: [{ Key: "env", Value: "prod" }],
      },
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).not.toContain("Last modified by:");
  });

  it("returns undefined provenance when Tags is not an array (branch: !Array.isArray)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      actualState: {
        BucketName: "my-app-bucket",
        Tags: "not-an-array" as unknown as [],
      },
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).not.toContain("Last modified by:");
  });

  it("renders ADDED_EXTERNALLY without value when actualValue is absent (branch: val === '(absent)')", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "SomeExternalField",
          desiredValue: undefined,
          actualValue: undefined,
          changeType: ChangeType.ADDED_EXTERNALLY,
        },
      ],
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("added externally");
    // The value line should NOT be rendered when formatValue returns "(absent)"
    expect(output).not.toContain("(absent)");
  });

  it("formatValue renders null as '(null)' (branch: value === null)", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "NullField",
          desiredValue: null,
          actualValue: "present",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("(null)");
  });

  it("formatValue truncates long JSON objects to 200 chars (branch: json.length > 200)", () => {
    const bigObj: Record<string, string> = {};
    for (let i = 0; i < 50; i++) {
      bigObj[`key${i}`] = `value${i}`;
    }
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "LargeField",
          desiredValue: bigObj,
          actualValue: "small",
          changeType: ChangeType.MODIFIED,
        },
      ],
    };
    const output = renderDriftDetail(result, { noColor: true });
    expect(output).toContain("...");
  });

  it("verbose mode skips drifted paths when listing matching fields", () => {
    const result: DriftResult = {
      ...baseDriftResult,
      status: DriftStatus.DRIFTED,
      driftedFields: [
        {
          path: "VersioningConfiguration",
          desiredValue: "Enabled",
          actualValue: "Suspended",
          changeType: ChangeType.MODIFIED,
        },
      ],
      desiredState: {
        BucketName: "my-app-bucket",
        VersioningConfiguration: "Enabled",
        Region: "us-east-1",
      },
      actualState: {
        BucketName: "my-app-bucket",
        VersioningConfiguration: "Suspended",
        Region: "us-east-1",
      },
    };
    const output = renderDriftDetail(result, { noColor: true, verbose: true });
    // Matching fields shown
    expect(output).toContain("Matching fields:");
    expect(output).toContain("BucketName");
    expect(output).toContain("Region");
    // Drifted field NOT shown in the matching section
    const matchingSection = output.slice(output.indexOf("Matching fields:"));
    expect(matchingSection).not.toContain("VersioningConfiguration");
  });

  it("no verbose section when desiredState or actualState is absent", () => {
    const result: DriftResult = {
      resourceType: "AWS::S3::Bucket",
      resourceId: "bucket",
      status: DriftStatus.IN_SYNC,
      driftedFields: [],
      checkedAt: "2026-03-24T10:00:00.000Z",
      // desiredState and actualState intentionally omitted
    };
    const output = renderDriftDetail(result, { noColor: true, verbose: true });
    expect(output).not.toContain("Matching fields:");
  });
});
