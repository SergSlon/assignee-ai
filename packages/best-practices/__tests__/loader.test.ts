import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { loadBestPractices, BPSchemaError } from "../src/loader.js";

const FIXTURES_DIR = join(import.meta.dirname, "fixtures");

describe("loadBestPractices", () => {
  it("loads valid BP YAML files from a directory", () => {
    const testDir = join(FIXTURES_DIR, "loader-valid-test");
    const serviceDir = join(testDir, "s3");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "BP-S3-001.yaml"),
      `id: BP-S3-001
title: "S3 Public Access Block not enabled"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "PublicAccessBlockConfiguration.BlockPublicAcls"
check_type: equals
expected_value: true
source: "AWS Security Hub FSBP"
source_id: "S3.1"
description: "S3 buckets should have public access blocked"
remediation: "Enable PublicAccessBlockConfiguration"
category: security
lastVerified: "2026-03-22"
`,
    );

    try {
      const result = loadBestPractices(testDir);
      expect(result).toHaveLength(1);
      expect(result[0]?.id).toBe("BP-S3-001");
      expect(result[0]?.severity).toBe("CRITICAL");
      expect(result[0]?.category).toBe("security");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("throws BPSchemaError with file path for invalid YAML", () => {
    const testDir = join(FIXTURES_DIR, "loader-invalid-test");
    const serviceDir = join(testDir, "s3");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "bad.yaml"),
      `title: "Missing required id field"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
    );

    try {
      expect(() => loadBestPractices(testDir)).toThrow(BPSchemaError);
      try {
        loadBestPractices(testDir);
      } catch (err) {
        expect(err).toBeInstanceOf(BPSchemaError);
        const bpErr = err as BPSchemaError;
        expect(bpErr.filePath).toContain("bad.yaml");
        expect(bpErr.fieldErrors.length).toBeGreaterThan(0);
        expect(bpErr.message).toContain("Invalid BP schema");
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("returns empty array for directory with no YAML files", () => {
    const testDir = join(FIXTURES_DIR, "loader-empty-test");
    const serviceDir = join(testDir, "empty-service");
    mkdirSync(serviceDir, { recursive: true });

    try {
      const result = loadBestPractices(testDir);
      expect(result).toEqual([]);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("throws for non-existent directory", () => {
    const nonExistent = join(FIXTURES_DIR, "does-not-exist-12345");
    expect(() => loadBestPractices(nonExistent)).toThrow();
  });

  it("loads multiple BP files from multiple service directories", () => {
    const testDir = join(FIXTURES_DIR, "loader-multi-test");
    const s3Dir = join(testDir, "s3");
    const ec2Dir = join(testDir, "ec2");
    mkdirSync(s3Dir, { recursive: true });
    mkdirSync(ec2Dir, { recursive: true });

    writeFileSync(
      join(s3Dir, "BP-S3-001.yaml"),
      `id: BP-S3-001
title: "S3 rule"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
    );

    writeFileSync(
      join(ec2Dir, "BP-EC2-001.yaml"),
      `id: BP-EC2-001
title: "EC2 rule"
severity: HIGH
resource_type: "AWS::EC2::Instance"
property_path: "Monitoring.Enabled"
check_type: equals
expected_value: true
source: "CIS"
category: reliability
lastVerified: "2026-03-22"
`,
    );

    try {
      const result = loadBestPractices(testDir);
      expect(result).toHaveLength(2);
      const ids = result.map((r) => r.id).sort();
      expect(ids).toEqual(["BP-EC2-001", "BP-S3-001"]);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // M-γ-06: fail-fast on invalid category (e.g. deprecated cost_optimization)
  it("throws BPSchemaError immediately on invalid category value", () => {
    const testDir = join(FIXTURES_DIR, "loader-bad-category-test");
    const serviceDir = join(testDir, "ec2");
    mkdirSync(serviceDir, { recursive: true });
    writeFileSync(
      join(serviceDir, "BP-EC2-BAD.yaml"),
      `id: BP-EC2-001
title: "EC2 cost rule"
severity: HIGH
resource_type: "AWS::EC2::Instance"
property_path: "SomeField"
check_type: equals
expected_value: true
source: "Test"
category: cost_optimization
lastVerified: "2026-03-22"
`,
    );

    try {
      expect(() => loadBestPractices(testDir)).toThrow(BPSchemaError);
      try {
        loadBestPractices(testDir);
      } catch (err) {
        expect(err).toBeInstanceOf(BPSchemaError);
        const bpErr = err as BPSchemaError;
        expect(bpErr.filePath).toContain("BP-EC2-BAD.yaml");
        expect(bpErr.fieldErrors.some((e) => e.includes("category"))).toBe(
          true,
        );
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // M-γ-06: collect-all — two files with distinct ZodErrors → both paths in one error
  it("collects all ZodErrors from multiple invalid files before throwing", () => {
    const testDir = join(FIXTURES_DIR, "loader-collect-all-test");
    const s3Dir = join(testDir, "s3");
    const ec2Dir = join(testDir, "ec2");
    mkdirSync(s3Dir, { recursive: true });
    mkdirSync(ec2Dir, { recursive: true });

    // Missing `id` field
    writeFileSync(
      join(s3Dir, "BP-S3-BAD.yaml"),
      `title: "S3 bad rule — no id"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
    );

    // Invalid severity value
    writeFileSync(
      join(ec2Dir, "BP-EC2-BAD.yaml"),
      `id: BP-EC2-001
title: "EC2 bad rule — bad severity"
severity: UNKNOWN_SEVERITY
resource_type: "AWS::EC2::Instance"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
    );

    try {
      expect(() => loadBestPractices(testDir)).toThrow(BPSchemaError);
      try {
        loadBestPractices(testDir);
      } catch (err) {
        expect(err).toBeInstanceOf(BPSchemaError);
        const bpErr = err as BPSchemaError;
        // Both file paths must appear in the aggregated message.
        expect(bpErr.message).toContain("BP-S3-BAD.yaml");
        expect(bpErr.message).toContain("BP-EC2-BAD.yaml");
        // Message must report the count.
        expect(bpErr.message).toMatch(/2 file\(s\)/);
        // fieldErrors must be non-empty.
        expect(bpErr.fieldErrors.length).toBeGreaterThan(0);
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // M-γ-06: collect-all — three invalid files → all three paths in one error
  it("collects errors from three invalid files in a single throw", () => {
    const testDir = join(FIXTURES_DIR, "loader-collect-three-test");
    const svcDir = join(testDir, "svc");
    mkdirSync(svcDir, { recursive: true });

    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        join(svcDir, `BP-SVC-BAD-${i}.yaml`),
        `title: "Missing id #${i}"
severity: HIGH
resource_type: "AWS::SVC::Resource"
property_path: "Field"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
      );
    }

    try {
      expect(() => loadBestPractices(testDir)).toThrow(BPSchemaError);
      try {
        loadBestPractices(testDir);
      } catch (err) {
        expect(err).toBeInstanceOf(BPSchemaError);
        const bpErr = err as BPSchemaError;
        expect(bpErr.message).toMatch(/3 file\(s\)/);
        for (let i = 1; i <= 3; i++) {
          expect(bpErr.message).toContain(`BP-SVC-BAD-${i}.yaml`);
        }
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // M-γ-06: duplicate-id detection — two files sharing the same id → throws with both paths
  it("throws BPSchemaError when two files share the same BP id", () => {
    const testDir = join(FIXTURES_DIR, "loader-dup-id-test");
    const s3Dir = join(testDir, "s3");
    const ec2Dir = join(testDir, "ec2");
    mkdirSync(s3Dir, { recursive: true });
    mkdirSync(ec2Dir, { recursive: true });

    const sharedId = "BP-S3-001";
    const validYaml = (id: string, title: string) =>
      `id: ${id}
title: "${title}"
severity: HIGH
resource_type: "AWS::S3::Bucket"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`;

    writeFileSync(
      join(s3Dir, "BP-S3-001.yaml"),
      validYaml(sharedId, "S3 rule first"),
    );
    writeFileSync(
      join(ec2Dir, "BP-S3-001-dup.yaml"),
      validYaml(sharedId, "S3 rule duplicate"),
    );

    try {
      expect(() => loadBestPractices(testDir)).toThrow(BPSchemaError);
      try {
        loadBestPractices(testDir);
      } catch (err) {
        expect(err).toBeInstanceOf(BPSchemaError);
        const bpErr = err as BPSchemaError;
        // The duplicate-id message must mention the conflicting ID and at least the duplicate file.
        const combined = bpErr.message + bpErr.fieldErrors.join(" ");
        expect(combined).toContain(sharedId);
        expect(combined).toContain("duplicate");
      }
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("skips non-YAML files in service directories", () => {
    const testDir = join(FIXTURES_DIR, "loader-skip-test");
    const serviceDir = join(testDir, "s3");
    mkdirSync(serviceDir, { recursive: true });

    writeFileSync(join(serviceDir, "README.md"), "# Not a YAML file");
    writeFileSync(
      join(serviceDir, "BP-S3-001.yaml"),
      `id: BP-S3-001
title: "S3 rule"
severity: CRITICAL
resource_type: "AWS::S3::Bucket"
property_path: "Test.Path"
check_type: equals
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-22"
`,
    );

    try {
      const result = loadBestPractices(testDir);
      expect(result).toHaveLength(1);
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});
