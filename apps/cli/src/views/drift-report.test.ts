import { describe, it, expect } from "vitest";
import { buildDriftReport, type DriftReport } from "./drift-report.js";
import { DriftStatus, ChangeType, type DriftResult } from "@assignee/core";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function makeDriftResult(overrides?: Partial<DriftResult>): DriftResult {
  return {
    resourceType: "AWS::S3::Bucket",
    resourceId: "my-bucket",
    status: DriftStatus.IN_SYNC,
    driftedFields: [],
    checkedAt: "2026-03-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("drift-report", () => {
  describe("buildDriftReport", () => {
    it("generates a valid report with all required fields", () => {
      const results: DriftResult[] = [
        makeDriftResult(),
        makeDriftResult({
          resourceId: "other-bucket",
          status: DriftStatus.DRIFTED,
          driftedFields: [
            {
              path: "Versioning",
              desiredValue: "Enabled",
              actualValue: "Suspended",
              changeType: ChangeType.MODIFIED,
            },
          ],
        }),
      ];

      const report = buildDriftReport(results, {
        region: "us-west-2",
        assigneeVersion: "1.2.3",
        awsAccountId: "123456789012",
        checkDurationMs: 1500,
      });

      expect(report.reportId).toMatch(UUID_REGEX);
      expect(report.generatedAt).toMatch(ISO_REGEX);
      expect(report.region).toBe("us-west-2");
      expect(report.resources).toHaveLength(2);
    });

    it("computes summary counts correctly", () => {
      const results: DriftResult[] = [
        makeDriftResult({ status: DriftStatus.IN_SYNC }),
        makeDriftResult({ status: DriftStatus.IN_SYNC }),
        makeDriftResult({
          status: DriftStatus.DRIFTED,
          driftedFields: [
            {
              path: "x",
              desiredValue: 1,
              actualValue: 2,
              changeType: ChangeType.MODIFIED,
            },
          ],
        }),
        makeDriftResult({ status: DriftStatus.DELETED }),
        makeDriftResult({ status: DriftStatus.ERROR, errorMessage: "err" }),
      ];

      const report = buildDriftReport(results);

      expect(report.summary.total).toBe(5);
      expect(report.summary.inSync).toBe(2);
      expect(report.summary.drifted).toBe(1);
      expect(report.summary.deleted).toBe(1);
      expect(report.summary.errors).toBe(1);
    });

    it("reportId is a valid UUID", () => {
      const report = buildDriftReport([]);
      expect(report.reportId).toMatch(UUID_REGEX);
    });

    it("includes metadata fields", () => {
      const report = buildDriftReport([], {
        assigneeVersion: "2.0.0",
        awsAccountId: "111222333444",
        checkDurationMs: 999,
      });

      expect(report.metadata.assigneeVersion).toBe("2.0.0");
      expect(report.metadata.awsAccountId).toBe("111222333444");
      expect(report.metadata.checkDurationMs).toBe(999);
    });

    it("uses defaults when no options provided", () => {
      const report = buildDriftReport([]);

      expect(report.region).toBe("us-east-1");
      expect(report.metadata.assigneeVersion).toBe("0.0.0");
      expect(report.metadata.awsAccountId).toBe("unknown");
      expect(report.metadata.checkDurationMs).toBe(0);
    });

    it("output is valid JSON that can be parsed", () => {
      const report = buildDriftReport([makeDriftResult()]);
      const json = JSON.stringify(report, null, 2);
      const parsed = JSON.parse(json) as DriftReport;

      expect(parsed.reportId).toBeTruthy();
      expect(parsed.resources).toHaveLength(1);
      expect(parsed.summary.total).toBe(1);
    });

    it("includes full DriftResult data in resources array", () => {
      const result = makeDriftResult({
        status: DriftStatus.DRIFTED,
        driftedFields: [
          {
            path: "Encryption.SSEAlgorithm",
            desiredValue: "aws:kms",
            actualValue: "AES256",
            changeType: ChangeType.MODIFIED,
          },
        ],
        actualState: { Encryption: { SSEAlgorithm: "AES256" } },
        desiredState: { Encryption: { SSEAlgorithm: "aws:kms" } },
      });

      const report = buildDriftReport([result]);

      expect(report.resources[0]!.driftedFields).toHaveLength(1);
      expect(report.resources[0]!.driftedFields[0]!.path).toBe(
        "Encryption.SSEAlgorithm",
      );
      expect(report.resources[0]!.actualState).toBeDefined();
      expect(report.resources[0]!.desiredState).toBeDefined();
    });
  });
});
