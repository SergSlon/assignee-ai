/**
 * Unit tests for checkpoint service (serializeCheckpoint, saveCheckpoint, loadCheckpointFromPath).
 *
 * @see Story 20.2, Story 20.3
 */

import { describe, it, expect, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import {
  serializeCheckpoint,
  saveCheckpoint,
  loadCheckpointFromPath,
  MCP_CHECKPOINT_DIR,
} from "../services/checkpoint.js";
import { CHECKPOINT_VERSION, CheckpointError } from "@assignee/core";

// ── Use real fs for integration-style tests ─────────────────────────────────

describe("checkpoint service", () => {
  const tmpDir = path.join(os.tmpdir(), `assignee-mcp-test-${Date.now()}`);

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe("MCP_CHECKPOINT_DIR", () => {
    it("should be in the system temp directory", () => {
      expect(MCP_CHECKPOINT_DIR).toContain(os.tmpdir());
      expect(MCP_CHECKPOINT_DIR).toContain("assignee-mcp-checkpoints");
    });
  });

  describe("serializeCheckpoint", () => {
    it("should produce a valid checkpoint with required fields", () => {
      const runId = crypto.randomUUID();
      const result = serializeCheckpoint({
        runId,
        userIntent: "Create an S3 bucket",
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test-bucket" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      });

      expect(result.checkpoint_version).toBe(CHECKPOINT_VERSION);
      expect(result.created_at).toBeDefined();
      expect(result.ttl_hours).toBe(72);
      expect(result.runId).toBe(runId);
      expect(result.userIntent).toBe("Create an S3 bucket");
      expect(result.resourceType).toBe("AWS::S3::Bucket");
      expect(result.desiredState).toEqual({ BucketName: "test-bucket" });
      expect(result.estimatedMonthlyCost).toBe("$0.00");
      expect(result.preflightPassed).toBe(true);
    });

    it("should use defaults for optional fields", () => {
      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create something",
      });

      expect(result.resourceType).toBe("unknown");
      expect(result.desiredState).toEqual({});
      expect(result.estimatedMonthlyCost).toBe("N/A");
      expect(result.preflightPassed).toBe(false);
    });

    it("should serialize resourceQueue when present", () => {
      const queue = [
        {
          resourceId: "vpc-1",
          resourceType: "AWS::EC2::VPC",
          displayName: "My VPC",
        },
        {
          resourceId: "subnet-1",
          resourceType: "AWS::EC2::Subnet",
          displayName: "Public Subnet",
        },
      ];

      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create a VPC with subnet",
        resourceQueue: queue,
      });

      expect(result.resourceQueue).toHaveLength(2);
      expect(result.resourceQueue![0]!.resourceId).toBe("vpc-1");
      expect(result.resourceQueue![0]!.desiredState).toEqual({});
    });

    it("should extract patternId from resourcePattern", () => {
      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create a static website",
        resourcePattern: { patternId: "static-website" },
      });

      expect(result.resourcePatternId).toBe("static-website");
    });

    it("should handle missing resourcePattern gracefully", () => {
      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create an S3 bucket",
      });

      expect(result.resourcePatternId).toBeUndefined();
    });

    it("should include elicitedOptions when present", () => {
      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create an S3 bucket",
        elicitedOptions: { versioning: true, encryption: "AES256" },
      });

      expect(result.elicitedOptions).toEqual({
        versioning: true,
        encryption: "AES256",
      });
    });

    it("should produce a created_at in ISO format", () => {
      const result = serializeCheckpoint({
        runId: crypto.randomUUID(),
        userIntent: "Create something",
      });

      const parsed = new Date(result.created_at);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  describe("saveCheckpoint + loadCheckpointFromPath round-trip", () => {
    it("should save and load a valid checkpoint", async () => {
      const runId = crypto.randomUUID();
      const checkpoint = serializeCheckpoint({
        runId,
        userIntent: "Create an S3 bucket",
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
      });

      const filePath = await saveCheckpoint(checkpoint, tmpDir);

      expect(filePath).toContain(`checkpoint-${runId}.json`);
      expect(filePath).toContain(tmpDir);

      const loaded = await loadCheckpointFromPath(filePath);

      expect(loaded.runId).toBe(runId);
      expect(loaded.userIntent).toBe("Create an S3 bucket");
      expect(loaded.resourceType).toBe("AWS::S3::Bucket");
      expect(loaded.desiredState).toEqual({ BucketName: "test" });
    });

    it("should create the directory if it does not exist", async () => {
      const nestedDir = path.join(tmpDir, "nested", "deep");
      const runId = crypto.randomUUID();

      const checkpoint = serializeCheckpoint({
        runId,
        userIntent: "Create an S3 bucket",
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        preflightPassed: true,
      });

      const filePath = await saveCheckpoint(checkpoint, nestedDir);
      expect(filePath).toContain(nestedDir);

      const loaded = await loadCheckpointFromPath(filePath);
      expect(loaded.runId).toBe(runId);
    });
  });

  describe("loadCheckpointFromPath error handling", () => {
    it("should throw CheckpointError for non-existent file", async () => {
      await expect(
        loadCheckpointFromPath("/tmp/nonexistent-checkpoint-xyz.json"),
      ).rejects.toThrow(CheckpointError);
      await expect(
        loadCheckpointFromPath("/tmp/nonexistent-checkpoint-xyz.json"),
      ).rejects.toThrow("not found");
    });

    it("should throw CheckpointError for invalid JSON", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, "corrupt.json");
      await fs.writeFile(filePath, "{not valid json!!!", "utf-8");

      await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
        CheckpointError,
      );
      await expect(loadCheckpointFromPath(filePath)).rejects.toThrow("Corrupt");
    });

    it("should throw CheckpointError for expired checkpoint", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tmpDir, { recursive: true });

      const expiredCheckpoint = {
        checkpoint_version: CHECKPOINT_VERSION,
        created_at: new Date(Date.now() - 73 * 60 * 60 * 1000).toISOString(),
        ttl_hours: 72,
        runId: crypto.randomUUID(),
        userIntent: "Create something",
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
        elicitedOptions: {},
      };

      const filePath = path.join(tmpDir, "expired.json");
      await fs.writeFile(filePath, JSON.stringify(expiredCheckpoint), "utf-8");

      await expect(loadCheckpointFromPath(filePath)).rejects.toThrow("expired");
    });

    it("should throw CheckpointError when preflightPassed is false", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tmpDir, { recursive: true });

      const checkpoint = {
        checkpoint_version: CHECKPOINT_VERSION,
        created_at: new Date().toISOString(),
        ttl_hours: 72,
        runId: crypto.randomUUID(),
        userIntent: "Create something",
        resourceType: "AWS::S3::Bucket",
        desiredState: { BucketName: "test" },
        estimatedMonthlyCost: "$0.00",
        preflightPassed: false,
        elicitedOptions: {},
      };

      const filePath = path.join(tmpDir, "no-preflight.json");
      await fs.writeFile(filePath, JSON.stringify(checkpoint), "utf-8");

      await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
        "preflight",
      );
    });

    it("should throw CheckpointError when desiredState is empty", async () => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(tmpDir, { recursive: true });

      const checkpoint = {
        checkpoint_version: CHECKPOINT_VERSION,
        created_at: new Date().toISOString(),
        ttl_hours: 72,
        runId: crypto.randomUUID(),
        userIntent: "Create something",
        resourceType: "AWS::S3::Bucket",
        desiredState: {},
        estimatedMonthlyCost: "$0.00",
        preflightPassed: true,
        elicitedOptions: {},
      };

      const filePath = path.join(tmpDir, "empty-state.json");
      await fs.writeFile(filePath, JSON.stringify(checkpoint), "utf-8");

      await expect(loadCheckpointFromPath(filePath)).rejects.toThrow(
        "desiredState",
      );
    });
  });
});
