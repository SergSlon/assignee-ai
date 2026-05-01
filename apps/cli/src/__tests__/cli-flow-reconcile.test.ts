/**
 * CLI Flow Reconcile — tests for reconcileResource handler and MemoryService:
 *   - reconcileResource with injected mocks (dry-run, auto-reconcile, skip, accept, error)
 *   - MemoryService provision log operations
 *
 * These tests use the shared stdout capture helper because reconcileResource
 * writes TTY output during its flow.
 *
 * @see Stories 33.x — CLI integration test matrix (split from cli-flow-matrix.test.ts)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  captureOutput,
  restoreOutput,
  getStdout,
} from "./cli-flow-test-utils.js";

// ═════════════════════════════════════════════════════════════════════════════
// RECONCILE — reconcileResource with injected mocks
// ═════════════════════════════════════════════════════════════════════════════

describe("reconcileResource", () => {
  beforeEach(() => {
    captureOutput();
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    restoreOutput();
  });

  it("returns skip when dry-run is true", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn().mockResolvedValue([null, { requestToken: "t" }]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "Versioning",
            desiredValue: "Enabled",
            actualValue: "Suspended",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: true,
        autoReconcile: false,
        promptFn: vi.fn(),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("skip");
    const output = getStdout();
    expect(output).toContain("dry-run");
  });

  it("auto-reconcile calls updateResource without prompt", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn().mockResolvedValue([null, { requestToken: "t" }]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();
    const promptFn = vi.fn();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "Versioning",
            desiredValue: "Enabled",
            actualValue: "Suspended",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: true,
        promptFn,
        confirmFn: vi.fn().mockResolvedValue(true),
      },
    );

    expect(action).toBe("reconcile");
    expect(promptFn).not.toHaveBeenCalled();
    expect(mockPort.updateResource).toHaveBeenCalled();
  });

  it("user choosing Skip returns skip action", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "X",
            desiredValue: "a",
            actualValue: "b",
            changeType: "MODIFIED" as const,
          },
        ],
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Skip"),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("skip");
    expect(mockPort.updateResource).not.toHaveBeenCalled();
  });

  it("user choosing Accept returns accept action", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi.fn(),
      getRequestStatus: vi.fn(),
    };

    const memory = {
      readProvisions: vi.fn().mockResolvedValue([
        {
          resourceArn: "arn:aws:s3:::test",
          desiredStateHash: "old",
          timestamp: "2024-01-01",
        },
      ]),
      appendProvision: vi.fn().mockResolvedValue(undefined),
      writeProvision: vi.fn().mockResolvedValue(undefined),
    } as never;

    const action = await reconcileResource(
      {
        resourceType: "AWS::S3::Bucket",
        resourceId: "arn:aws:s3:::test",
        status: "DRIFTED" as const,
        checkedAt: new Date().toISOString(),
        driftedFields: [
          {
            path: "X",
            desiredValue: "a",
            actualValue: "b",
            changeType: "MODIFIED" as const,
          },
        ],
        actualState: { X: "b" },
      },
      mockPort,
      memory,
      {
        dryRun: false,
        autoReconcile: false,
        promptFn: vi.fn().mockResolvedValue("Accept"),
        confirmFn: vi.fn(),
      },
    );

    expect(action).toBe("accept");
  });

  it("reconcile with port error throws", async () => {
    const { reconcileResource } = await import("../commands/reconcile.js");
    const { MemoryService } = await import("../services/memory.js");

    const mockPort = {
      getResource: vi.fn(),
      createResource: vi.fn(),
      deleteResource: vi.fn(),
      updateResource: vi
        .fn()
        .mockResolvedValue([
          { kind: "SERVICE_ERROR", message: "AWS down" },
          null,
        ]),
      getRequestStatus: vi.fn(),
    };

    const memory = new MemoryService();

    await expect(
      reconcileResource(
        {
          resourceType: "AWS::S3::Bucket",
          resourceId: "arn:aws:s3:::test",
          status: "DRIFTED" as const,
          checkedAt: new Date().toISOString(),
          driftedFields: [
            {
              path: "X",
              desiredValue: "a",
              actualValue: "b",
              changeType: "MODIFIED" as const,
            },
          ],
        },
        mockPort,
        memory,
        {
          dryRun: false,
          autoReconcile: true,
          promptFn: vi.fn(),
          confirmFn: vi.fn().mockResolvedValue(true),
        },
      ),
    ).rejects.toThrow("AWS down");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// MEMORY SERVICE — provision log operations
// ═════════════════════════════════════════════════════════════════════════════

describe("MemoryService", () => {
  it("can be instantiated with custom directory", async () => {
    // Direct import (no mock) — tests the constructor
    const mod = await vi.importActual<typeof import("../services/memory.js")>(
      "../services/memory.js",
    );
    const svc = new mod.MemoryService("/tmp/test-memory");
    // Stronger than toBeDefined: assert the constructed object exposes
    // the documented MemoryService API surface.
    expect(svc).toBeInstanceOf(mod.MemoryService);
    expect(typeof svc.readProvisions).toBe("function");
    expect(typeof svc.appendProvision).toBe("function");
  });
});
