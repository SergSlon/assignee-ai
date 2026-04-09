import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  computeBPCoverage,
  renderBPCoverage,
  renderBPCoverageGaps,
  filterActionableGaps,
  type BPCoverageData,
} from "./status-bp-coverage.js";

function createTempBPDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bp-coverage-"));
  return dir;
}

function writeBPFile(
  baseDir: string,
  service: string,
  filename: string,
  content: string,
): void {
  const svcDir = path.join(baseDir, service);
  fs.mkdirSync(svcDir, { recursive: true });
  fs.writeFileSync(path.join(svcDir, filename), content, "utf-8");
}

const makeRule = (
  id: string,
  resourceType: string,
  opts?: {
    autoFixable?: boolean;
    fixType?: string;
    source?: string;
    severity?: string;
    propertyPath?: string;
  },
) =>
  `
id: ${id}
title: "Test rule ${id}"
severity: ${opts?.severity ?? "HIGH"}
resource_type: "${resourceType}"
property_path: "${opts?.propertyPath ?? id}"
check_type: "equals"
expected_value: true
source: "${opts?.source ?? "Test"}"
category: security
lastVerified: "2026-03-24"
${opts?.autoFixable ? "autoFixable: true\ndesiredStatePatch:\n  Test: true" : ""}
${opts?.fixType === "auto" ? "fixType: auto" : ""}
${opts?.fixType === "interactive" ? 'fixType: "interactive"\ninteractiveOptions:\n  - label: "test"\n    action: "prompt_value"' : ""}
`.trim();

describe("status-bp-coverage", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempBPDir();
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("computeBPCoverage", () => {
    it("counts rules per resource type", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket", { propertyPath: "A" }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-002.yaml",
        makeRule("BP-S3-002", "AWS::S3::Bucket", { propertyPath: "B" }),
      );
      writeBPFile(
        tempDir,
        "ec2",
        "BP-EC2-001.yaml",
        makeRule("BP-EC2-001", "AWS::EC2::Instance", { propertyPath: "C" }),
      );

      const data = computeBPCoverage(tempDir);

      expect(data.summary.totalRules).toBe(3);
      const s3 = data.resourceTypes.find(
        (r) => r.resourceType === "AWS::S3::Bucket",
      );
      expect(s3?.total).toBe(2);
      const ec2 = data.resourceTypes.find(
        (r) => r.resourceType === "AWS::EC2::Instance",
      );
      expect(ec2?.total).toBe(1);
    });

    it("counts auto-fixable and interactive rules", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket", {
          autoFixable: true,
          fixType: "auto",
          propertyPath: "A",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-002.yaml",
        makeRule("BP-S3-002", "AWS::S3::Bucket", {
          fixType: "interactive",
          propertyPath: "B",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-003.yaml",
        makeRule("BP-S3-003", "AWS::S3::Bucket", { propertyPath: "C" }),
      );

      const data = computeBPCoverage(tempDir);

      expect(data.summary.autoFixable).toBe(1);
      expect(data.summary.interactive).toBe(1);
      expect(data.summary.manualOnly).toBe(1);
    });

    it("identifies coverage gaps for supported types", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket"),
      );

      const data = computeBPCoverage(tempDir);

      // Should list supported types that have no rules
      expect(data.gaps).toContain("AWS::EC2::Instance");
      expect(data.gaps).not.toContain("AWS::S3::Bucket");
    });

    it("computes source breakdown", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket", {
          source: "FSBP",
          propertyPath: "A",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-002.yaml",
        makeRule("BP-S3-002", "AWS::S3::Bucket", {
          source: "TrustedAdvisor",
          propertyPath: "B",
        }),
      );

      const data = computeBPCoverage(tempDir);

      expect(data.sources["FSBP"]).toBe(1);
      expect(data.sources["TrustedAdvisor"]).toBe(1);
    });

    it("computes severity distribution", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket", {
          severity: "CRITICAL",
          propertyPath: "A",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-002.yaml",
        makeRule("BP-S3-002", "AWS::S3::Bucket", {
          severity: "HIGH",
          propertyPath: "B",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-003.yaml",
        makeRule("BP-S3-003", "AWS::S3::Bucket", {
          severity: "HIGH",
          propertyPath: "C",
        }),
      );

      const data = computeBPCoverage(tempDir);

      expect(data.severityDistribution["CRITICAL"]).toBe(1);
      expect(data.severityDistribution["HIGH"]).toBe(2);
    });

    it("handles empty directory", () => {
      const data = computeBPCoverage(tempDir);

      expect(data.summary.totalRules).toBe(0);
      expect(data.resourceTypes).toHaveLength(0);
    });

    it("skips invalid YAML files", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket"),
      );
      writeBPFile(tempDir, "s3", "invalid.yaml", "id: [bad yaml");

      const data = computeBPCoverage(tempDir);
      // Should still count the valid rule
      expect(data.summary.totalRules).toBe(1);
    });

    it("computes auto-fix percentage correctly", () => {
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-001.yaml",
        makeRule("BP-S3-001", "AWS::S3::Bucket", {
          autoFixable: true,
          fixType: "auto",
          propertyPath: "A",
        }),
      );
      writeBPFile(
        tempDir,
        "s3",
        "BP-S3-002.yaml",
        makeRule("BP-S3-002", "AWS::S3::Bucket", { propertyPath: "B" }),
      );

      const data = computeBPCoverage(tempDir);

      expect(data.summary.autoFixPercent).toBe(50);
    });
  });

  describe("renderBPCoverage", () => {
    it("renders table output", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);

      const data: BPCoverageData = {
        resourceTypes: [
          {
            resourceType: "AWS::S3::Bucket",
            total: 5,
            autoFixable: 3,
            interactive: 1,
            manualOnly: 1,
            lastVerified: "2026-03-24",
          },
        ],
        summary: {
          totalRules: 5,
          autoFixable: 3,
          interactive: 1,
          manualOnly: 1,
          autoFixPercent: 60,
        },
        gaps: ["AWS::EC2::Instance"],
        sources: { FSBP: 3, TrustedAdvisor: 2 },
        severityDistribution: { CRITICAL: 1, HIGH: 2, MEDIUM: 2 },
      };

      renderBPCoverage(data);

      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("BP Coverage Dashboard");
      expect(output).toContain("AWS::S3::Bucket");
      expect(output).toContain("5 rules");
      expect(output).toContain("60%");
      expect(output).toContain("Gap Analysis");
      expect(output).toContain("AWS::EC2::Instance");
      expect(output).toContain("Source Breakdown");
      expect(output).toContain("FSBP: 3");

      stdoutSpy.mockRestore();
    });
  });

  describe("renderBPCoverageGaps", () => {
    it("prints the green 0-gaps header when every type has coverage", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      renderBPCoverageGaps([]);
      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("0 BP coverage gaps");
      expect(output).toContain("every supported type has at least one rule");
      stdoutSpy.mockRestore();
    });

    it("prints a one-per-line list when gaps exist and uses plural label", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      renderBPCoverageGaps([
        "AWS::EC2::RouteTable",
        "AWS::EC2::VPCGatewayAttachment",
        "AWS::EC2::SubnetRouteTableAssociation",
      ]);
      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("3 BP coverage gaps");
      expect(output).toContain("AWS::EC2::RouteTable");
      expect(output).toContain("AWS::EC2::VPCGatewayAttachment");
      expect(output).toContain("AWS::EC2::SubnetRouteTableAssociation");
      stdoutSpy.mockRestore();
    });

    it("uses singular label when exactly 1 gap exists", () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockReturnValue(true);
      renderBPCoverageGaps(["AWS::Only::One"]);
      const output = stdoutSpy.mock.calls.map((c) => c[0]).join("");
      expect(output).toContain("1 BP coverage gap");
      expect(output).not.toContain("1 BP coverage gaps");
      stdoutSpy.mockRestore();
    });
  });

  describe("filterActionableGaps", () => {
    it("drops the 4 structural/cross-reference types by default", () => {
      const raw = [
        "AWS::EC2::RouteTable",
        "AWS::EC2::VPCGatewayAttachment",
        "AWS::EC2::SubnetRouteTableAssociation",
        "AWS::EFS::MountTarget",
      ];
      expect(filterActionableGaps(raw)).toEqual([]);
    });

    it("keeps non-structural gaps intact", () => {
      expect(
        filterActionableGaps([
          "AWS::EC2::Instance",
          "AWS::EC2::RouteTable",
          "AWS::S3::Bucket",
        ]),
      ).toEqual(["AWS::EC2::Instance", "AWS::S3::Bucket"]);
    });

    it("returns empty array for empty input", () => {
      expect(filterActionableGaps([])).toEqual([]);
    });
  });
});
