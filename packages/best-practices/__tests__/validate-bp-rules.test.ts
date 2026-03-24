/**
 * Tests for BP Validation logic (Story 30.6).
 * Self-contained — embeds minimal validation logic to avoid cross-package imports.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "yaml";
import { z } from "zod";
import { bestPracticeSchema } from "../src/schema.js";

const SKIP_DIRS = new Set(["src", "dist", "node_modules", "__tests__"]);

interface ValidationError {
  filePath: string;
  ruleId: string;
  message: string;
}

function findYamlFiles(baseDir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(baseDir)) {
    if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
    const entryPath = path.join(baseDir, entry);
    if (!fs.statSync(entryPath).isDirectory()) continue;
    for (const file of fs.readdirSync(entryPath)) {
      if (!file.endsWith(".yaml") && !file.endsWith(".yml")) continue;
      files.push(path.join(entryPath, file));
    }
  }
  return files;
}

function validateBPRules(baseDir: string): ValidationError[] {
  const errors: ValidationError[] = [];
  const files = findYamlFiles(baseDir);
  const idMap = new Map<string, string>();
  const dedupMap = new Map<string, string>();

  for (const filePath of files) {
    const relPath = path.relative(baseDir, filePath);
    let parsed: Record<string, unknown>;

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      parsed = parse(content) as Record<string, unknown>;
    } catch (err) {
      errors.push({
        filePath: relPath,
        ruleId: "unknown",
        message: `YAML parse error: ${err instanceof Error ? err.message : "unknown"}`,
      });
      continue;
    }

    const ruleId = typeof parsed.id === "string" ? parsed.id : "unknown";
    const result = bestPracticeSchema.safeParse(parsed);
    if (!result.success) {
      for (const issue of result.error.issues) {
        errors.push({
          filePath: relPath,
          ruleId,
          message: `Schema: ${issue.path.join(".")}: ${issue.message}`,
        });
      }
      continue;
    }

    const existingFile = idMap.get(ruleId);
    if (existingFile) {
      errors.push({
        filePath: relPath,
        ruleId,
        message: `Duplicate ID: '${ruleId}' also defined in ${existingFile}`,
      });
    } else {
      idMap.set(ruleId, relPath);
    }

    const data = result.data;
    const dedupKey = `${data.resource_type}::${data.property_path}`;
    const existingRule = dedupMap.get(dedupKey);
    if (existingRule) {
      errors.push({
        filePath: relPath,
        ruleId,
        message: `Potential duplicate: ${dedupKey} also checked by ${existingRule}`,
      });
    } else {
      dedupMap.set(dedupKey, ruleId);
    }
  }
  return errors;
}

function createTempBPDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bp-validate-"));
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

const validRule = `
id: BP-S3-001
title: "Test rule"
severity: HIGH
resource_type: "AWS::S3::Bucket"
property_path: "Encryption"
check_type: "exists"
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-24"
`.trim();

const validRule2 = `
id: BP-S3-002
title: "Test rule 2"
severity: MEDIUM
resource_type: "AWS::S3::Bucket"
property_path: "Versioning"
check_type: "equals"
expected_value: "Enabled"
source: "Test"
category: reliability
lastVerified: "2026-03-24"
`.trim();

describe("validate-bp-rules (Story 30.6)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempBPDir();
  });
  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("findYamlFiles", () => {
    it("finds YAML files in service directories", () => {
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", validRule);
      writeBPFile(tempDir, "ec2", "BP-EC2-001.yaml", validRule);
      expect(findYamlFiles(tempDir)).toHaveLength(2);
    });

    it("skips __tests__, src, dist, node_modules directories", () => {
      writeBPFile(tempDir, "__tests__", "fixture.yaml", validRule);
      writeBPFile(tempDir, "src", "schema.yaml", validRule);
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", validRule);
      expect(findYamlFiles(tempDir)).toHaveLength(1);
    });
  });

  describe("validateBPRules", () => {
    it("returns no errors for valid rules", () => {
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", validRule);
      writeBPFile(tempDir, "s3", "BP-S3-002.yaml", validRule2);
      expect(validateBPRules(tempDir)).toHaveLength(0);
    });

    it("detects schema validation errors", () => {
      const invalidRule = `
id: BP-S3-001
title: ""
severity: INVALID
resource_type: "AWS::S3::Bucket"
property_path: "x"
check_type: "equals"
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-24"
`.trim();
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", invalidRule);
      const errors = validateBPRules(tempDir);
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]!.message).toContain("Schema");
    });

    it("detects duplicate IDs", () => {
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", validRule);
      writeBPFile(tempDir, "ec2", "BP-S3-001-dup.yaml", validRule);
      const errors = validateBPRules(tempDir);
      const dupErrors = errors.filter((e) =>
        e.message.includes("Duplicate ID"),
      );
      expect(dupErrors).toHaveLength(1);
    });

    it("detects resource_type + property_path duplicates", () => {
      const rule2 = validRule.replace("BP-S3-001", "BP-S3-099");
      writeBPFile(tempDir, "s3", "BP-S3-001.yaml", validRule);
      writeBPFile(tempDir, "s3", "BP-S3-099.yaml", rule2);
      const errors = validateBPRules(tempDir);
      const dupErrors = errors.filter((e) =>
        e.message.includes("Potential duplicate"),
      );
      expect(dupErrors).toHaveLength(1);
    });

    it("detects YAML parse errors", () => {
      writeBPFile(tempDir, "s3", "bad.yaml", "id: [invalid yaml");
      expect(validateBPRules(tempDir).length).toBeGreaterThan(0);
    });

    it("validates ID format", () => {
      const badIdRule = validRule.replace("BP-S3-001", "bp-s3-1");
      writeBPFile(tempDir, "s3", "bad-id.yaml", badIdRule);
      expect(validateBPRules(tempDir).length).toBeGreaterThan(0);
    });

    it("validates fixType=auto requires autoFixable and desiredStatePatch", () => {
      const autoRule = `
id: BP-S3-099
title: "Bad auto fix"
severity: HIGH
resource_type: "AWS::S3::Bucket"
property_path: "SomeField"
check_type: "equals"
expected_value: true
source: "Test"
category: security
lastVerified: "2026-03-24"
fixType: "auto"
`.trim();
      writeBPFile(tempDir, "s3", "BP-S3-099.yaml", autoRule);
      expect(validateBPRules(tempDir).length).toBeGreaterThan(0);
    });
  });
});
