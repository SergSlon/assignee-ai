/**
 * W4-01 (Epic 100 Round 3) — Port-contract test suite for CheckpointerPort.
 *
 * This suite defines the contract that ALL adapter implementations MUST
 * satisfy. The same tests are reused in file-durable-adapter.test.ts to
 * verify FileDurableCheckpointerAdapter. Add new adapters by importing
 * `runCheckpointerPortContractTests` and passing an adapter factory.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryCheckpointerAdapter } from "./in-memory-adapter.js";
import { CHECKPOINT_VERSION } from "../schema/checkpoint.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";
import type { CheckpointerPort } from "../ports/checkpoint-port.js";

// ── Shared fixture factory ────────────────────────────────────────────

function makeCheckpoint(
  overrides: Partial<PlanCheckpoint> = {},
): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date().toISOString(),
    ttl_hours: 24,
    runId: crypto.randomUUID(),
    userIntent: "create an S3 bucket named my-test-bucket",
    resourceType: "AWS::S3::Bucket",
    desiredState: { BucketName: "my-test-bucket" },
    estimatedMonthlyCost: "$0.02",
    preflightPassed: true,
    currentResourceIndex: 0,
    completedResources: [],
    ...overrides,
  };
}

function makeExpiredCheckpoint(): PlanCheckpoint {
  const past = new Date(Date.now() - 1000 * 60 * 60 * 25); // 25 hours ago
  return makeCheckpoint({
    created_at: past.toISOString(),
    ttl_hours: 24,
  });
}

// ── Port-contract test suite (runs against ANY adapter) ──────────────

/**
 * Exported so FileDurableCheckpointerAdapter.test.ts can reuse the same
 * contract assertions. Pass an async factory that returns a fresh adapter
 * instance for each test.
 */
export function runCheckpointerPortContractTests(
  label: string,
  factory: () => Promise<CheckpointerPort> | CheckpointerPort,
): void {
  describe(`CheckpointerPort contract — ${label}`, () => {
    let adapter: CheckpointerPort;

    beforeEach(async () => {
      adapter = await factory();
    });

    it("save returns a non-empty reference string", async () => {
      const cp = makeCheckpoint();
      const ref = await adapter.save(cp);
      expect(typeof ref).toBe("string");
      expect(ref.length).toBeGreaterThan(0);
    });

    it("load returns undefined for unknown runId", async () => {
      const result = await adapter.load(crypto.randomUUID());
      expect(result).toBeUndefined();
    });

    it("load returns the saved checkpoint", async () => {
      const cp = makeCheckpoint();
      await adapter.save(cp);
      const loaded = await adapter.load(cp.runId);
      expect(loaded).toBeDefined();
      expect(loaded!.runId).toBe(cp.runId);
      expect(loaded!.userIntent).toBe(cp.userIntent);
      expect(loaded!.desiredState).toEqual(cp.desiredState);
    });

    it("save is idempotent — overwrite preserves the latest version", async () => {
      const cp = makeCheckpoint();
      await adapter.save(cp);
      const updated = { ...cp, userIntent: "updated intent" };
      await adapter.save(updated);
      const loaded = await adapter.load(cp.runId);
      expect(loaded!.userIntent).toBe("updated intent");
    });

    it("list returns empty array when no checkpoints exist", async () => {
      const list = await adapter.list();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(0);
    });

    it("list returns all saved checkpoints", async () => {
      const cp1 = makeCheckpoint();
      const cp2 = makeCheckpoint();
      await adapter.save(cp1);
      await adapter.save(cp2);
      const list = await adapter.list();
      expect(list.length).toBe(2);
      const ids = new Set(list.map((c) => c.runId));
      expect(ids.has(cp1.runId)).toBe(true);
      expect(ids.has(cp2.runId)).toBe(true);
    });

    it("list is ordered newest-first", async () => {
      const older = makeCheckpoint({
        created_at: new Date(Date.now() - 5000).toISOString(),
      });
      const newer = makeCheckpoint({
        created_at: new Date().toISOString(),
      });
      await adapter.save(older);
      await adapter.save(newer);
      const list = await adapter.list();
      expect(list.length).toBe(2);
      expect(list[0]!.runId).toBe(newer.runId);
      expect(list[1]!.runId).toBe(older.runId);
    });

    it("delete removes the checkpoint", async () => {
      const cp = makeCheckpoint();
      await adapter.save(cp);
      await adapter.delete(cp.runId);
      const loaded = await adapter.load(cp.runId);
      expect(loaded).toBeUndefined();
    });

    it("delete is a no-op for non-existent runId", async () => {
      // Must not throw
      await expect(
        adapter.delete(crypto.randomUUID()),
      ).resolves.toBeUndefined();
    });

    it("prune removes expired checkpoints", async () => {
      const fresh = makeCheckpoint();
      const expired = makeExpiredCheckpoint();
      await adapter.save(fresh);
      await adapter.save(expired);
      const deleted = await adapter.prune();
      expect(deleted).toBe(1);
      expect(await adapter.load(fresh.runId)).toBeDefined();
      expect(await adapter.load(expired.runId)).toBeUndefined();
    });

    it("prune returns 0 when no checkpoints are expired", async () => {
      const cp = makeCheckpoint();
      await adapter.save(cp);
      const deleted = await adapter.prune();
      expect(deleted).toBe(0);
    });

    it("prune on empty store returns 0", async () => {
      const deleted = await adapter.prune();
      expect(deleted).toBe(0);
    });
  });
}

// ── In-memory adapter tests ───────────────────────────────────────────

runCheckpointerPortContractTests(
  "InMemoryCheckpointerAdapter",
  () => new InMemoryCheckpointerAdapter(),
);
