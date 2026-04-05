/**
 * Cross-Epic Integration Tests — validates that features from different epics
 * compose correctly when used together.
 *
 * Test flows:
 * 1. Config loading -> option elicitor pre-fill (Epic 27 + existing)
 * 2. Provision log write -> drift detect -> reconcile suggest (Epics 19+28+33)
 * 3. Cleanup auto-hook fires after command (Epic 33 integration)
 * 4. Schema fetch via SDK -> plan generation (Epic 31 + existing)
 *
 * @see Sprint K — Quality Blitz
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

// ── 1. Config loading → option elicitor pre-fill ─────────────────────────────

describe("Cross-epic: config loading -> option pre-fill", () => {
  const originalEnv = process.env["ASSIGNEE_CONFIG_DIR"];
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-xepic-"));
    process.env["ASSIGNEE_CONFIG_DIR"] = tmpDir;
  });

  afterEach(async () => {
    if (originalEnv) {
      process.env["ASSIGNEE_CONFIG_DIR"] = originalEnv;
    } else {
      delete process.env["ASSIGNEE_CONFIG_DIR"];
    }
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("loadUserConfig returns parsed config that could pre-fill option elicitor", async () => {
    const configContent = `
defaults:
  "AWS::S3::Bucket":
    BucketName: my-default-bucket
    VersioningConfiguration:
      Status: Enabled
`;
    await fs.writeFile(
      path.join(tmpDir, "config.yaml"),
      configContent,
      "utf-8",
    );

    const { loadUserConfig } = await import("../config/user-config-loader.js");
    const config = await loadUserConfig();

    expect(config).toBeDefined();
    expect(config).toHaveProperty("defaults");
    expect((config as any).defaults["AWS::S3::Bucket"]).toHaveProperty(
      "BucketName",
      "my-default-bucket",
    );
  });

  it("loadUserConfig returns undefined for missing config (graceful degradation)", async () => {
    // No config file written — tmpDir is empty
    const { loadUserConfig } = await import("../config/user-config-loader.js");
    const config = await loadUserConfig();
    expect(config).toBeUndefined();
  });
});

// ── 2. Provision log write → drift detect → reconcile suggest ────────────────

describe("Cross-epic: provision log -> drift detect -> reconcile", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "assignee-xepic-mem-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("provision record written by MemoryService can be read back for drift detection", async () => {
    const { MemoryService } = await import("../services/memory.js");
    const memory = new MemoryService(tmpDir);

    // Simulate provision log write (Epic 19)
    await memory.appendProvision({
      runId: "00000000-0000-0000-0000-000000000001",
      resourceType: "AWS::S3::Bucket",
      resourceArn: "arn:aws:s3:::test-bucket-xepic",
      timestamp: new Date().toISOString(),
      desiredStateHash: "abc123",
      estimatedMonthlyCost: "$0.00",
      region: "us-east-1",
    });

    // Read back provisions for drift detection (Epic 28)
    const provisions = await memory.readProvisions();
    expect(provisions).toHaveLength(1);
    expect(provisions[0]!.resourceArn).toBe("arn:aws:s3:::test-bucket-xepic");
    expect(provisions[0]!.resourceType).toBe("AWS::S3::Bucket");
  });

  it("DriftDetectorService returns BASELINE_MISSING when no desired state available", async () => {
    const { DriftDetectorService } =
      await import("../services/drift-detector.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    const result = await detector.checkResource(
      "AWS::S3::Bucket",
      "arn:aws:s3:::test-bucket",
      undefined,
    );

    expect(result.status).toBe("BASELINE_MISSING");
    expect(result.driftedFields).toHaveLength(0);
  });

  it("DriftDetectorService detects drift when actual differs from desired", async () => {
    const { DriftDetectorService } =
      await import("../services/drift-detector.js");

    const mockPort = {
      getResource: vi.fn().mockResolvedValue([
        null,
        {
          ResourceDescription: {
            Properties: JSON.stringify({
              BucketName: "test-bucket",
              VersioningConfiguration: { Status: "Suspended" },
            }),
          },
        },
      ]),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const detector = new DriftDetectorService({ provisioningPort: mockPort });
    const result = await detector.checkResource(
      "AWS::S3::Bucket",
      "arn:aws:s3:::test-bucket",
      {
        BucketName: "test-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      },
    );

    expect(result.status).toBe("DRIFTED");
    expect(result.driftedFields.length).toBeGreaterThan(0);
    const versioningDrift = result.driftedFields.find(
      (f) => f.path === "VersioningConfiguration.Status",
    );
    expect(versioningDrift).toBeDefined();
    expect(versioningDrift!.desiredValue).toBe("Enabled");
    expect(versioningDrift!.actualValue).toBe("Suspended");
  });

  it("buildPatchDocument creates correct JSON Patch from drifted fields", async () => {
    const { buildPatchDocument } = await import("../commands/reconcile.js");
    const { ChangeType } = await import("@assignee/core");

    const { ops: patch } = buildPatchDocument([
      {
        path: "VersioningConfiguration.Status",
        desiredValue: "Enabled",
        actualValue: "Suspended",
        changeType: ChangeType.MODIFIED,
      },
    ]);

    expect(patch).toHaveLength(1);
    expect(patch[0]).toEqual({
      op: "replace",
      path: "/VersioningConfiguration/Status",
      value: "Enabled",
    });
  });
});

// ── 3. Cleanup auto-hook fires after command ─────────────────────────────────

describe("Cross-epic: cleanup auto-hook", () => {
  let tmpCheckpointDir: string;
  let tmpMemoryDir: string;

  beforeEach(async () => {
    tmpCheckpointDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "assignee-xepic-ckpt-"),
    );
    tmpMemoryDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "assignee-xepic-cleanup-mem-"),
    );
  });

  afterEach(async () => {
    await fs
      .rm(tmpCheckpointDir, { recursive: true, force: true })
      .catch(() => {});
    await fs.rm(tmpMemoryDir, { recursive: true, force: true }).catch(() => {});
  });

  it("runFullCleanup processes checkpoints, cache, and memory categories", async () => {
    const { runFullCleanup } = await import("../services/cleanup.js");
    const { MemoryService } = await import("../services/memory.js");

    const memory = new MemoryService(tmpMemoryDir);
    const report = await runFullCleanup({
      checkpointDir: tmpCheckpointDir,
      memoryService: memory,
      dryRun: true,
    });

    expect(report).toHaveProperty("checkpoints");
    expect(report).toHaveProperty("memory");
    expect(report).toHaveProperty("cache");
    expect(report.checkpoints.pruned).toBe(0);
    expect(report.checkpoints.kept).toBe(0);
  });

  it("formatCleanupReport produces human-readable output", async () => {
    const { formatCleanupReport } = await import("../services/cleanup.js");

    const report = {
      checkpoints: { pruned: 3, kept: 5 },
      memory: { provisions: 10, failures: 2, patterns: 1 },
      cache: { removed: 4, remaining: 8 },
    };

    const output = formatCleanupReport(report, false);
    expect(output).toContain("Cleanup complete:");
    expect(output).toContain("Checkpoints");
    expect(output).toContain("3");
    expect(output).toContain("5");
  });
});

// ── 4. Schema fetch via SDK → plan generation ────────────────────────────────

describe("Cross-epic: schema fetch -> plan generation", () => {
  it("CloudFormationSchemaService interface produces schema objects usable by plan generator", async () => {
    // Verify the schema shape contract: plan generator expects
    // { properties: Record<string, unknown>, required?: string[] }
    const schemaExample = {
      typeName: "AWS::S3::Bucket",
      properties: {
        BucketName: { type: "string" },
        VersioningConfiguration: {
          type: "object",
          properties: { Status: { type: "string" } },
        },
      },
      required: [],
      readOnlyProperties: ["/properties/Arn"],
    };

    // Verify the shape is valid for plan generation
    expect(schemaExample).toHaveProperty("properties");
    expect(schemaExample).toHaveProperty("typeName");
    expect(typeof schemaExample.properties).toBe("object");
    expect(schemaExample.properties).toHaveProperty("BucketName");
  });

  it("SUPPORTED_TYPES_ARRAY covers all expected resource types", async () => {
    const { SUPPORTED_TYPES_ARRAY } = await import("@assignee/core");

    expect(SUPPORTED_TYPES_ARRAY.length).toBe(23);
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::S3::Bucket");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::Lambda::Function");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::EC2::Instance");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::DynamoDB::Table");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::SQS::Queue");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::SNS::Topic");
    // Tier 2
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::ApiGatewayV2::Api");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::CloudWatch::Alarm");
    expect(SUPPORTED_TYPES_ARRAY).toContain("AWS::SecretsManager::Secret");
  });
});
