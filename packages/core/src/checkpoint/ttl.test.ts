/**
 * Tests for `isCheckpointExpired` (ttl.ts).
 *
 * Recovery-path focus (P035 — 0 % coverage closure):
 *   - Freshly-created checkpoint → not expired
 *   - Checkpoint created exactly at TTL boundary → expired
 *   - Checkpoint whose created_at is far in the past → expired
 *   - Non-standard TTL values (1h, 168h)
 *   - Edge: TTL of 0 → always expired
 *   - Edge: created_at in the future (clock-skew) → not expired
 */

import { describe, expect, it } from "vitest";
import { isCheckpointExpired } from "./ttl.js";
import { CHECKPOINT_VERSION } from "../schema/checkpoint.js";
import type { PlanCheckpoint } from "../schema/checkpoint.js";

// ── helpers ───────────────────────────────────────────────────────────

function makeCheckpoint(createdAtMs: number, ttlHours: number): PlanCheckpoint {
  return {
    checkpoint_version: CHECKPOINT_VERSION,
    created_at: new Date(createdAtMs).toISOString(),
    ttl_hours: ttlHours,
    runId: crypto.randomUUID(),
    userIntent: "Create an EC2 instance",
    resourceType: "AWS::EC2::Instance",
    desiredState: { InstanceType: "t3.micro" },
    estimatedMonthlyCost: "$0.02",
    preflightPassed: true,
    currentResourceIndex: 0,
    completedResources: [],
  };
}

// ── tests ─────────────────────────────────────────────────────────────

describe("isCheckpointExpired", () => {
  it("returns false for a freshly-created checkpoint (72h TTL, just now)", () => {
    const cp = makeCheckpoint(Date.now(), 72);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("returns false for a checkpoint 1 hour old with 72h TTL", () => {
    const cp = makeCheckpoint(Date.now() - 60 * 60 * 1000, 72);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("returns false for a checkpoint 71.9h old with 72h TTL (just under boundary)", () => {
    const almostExpiredMs = Date.now() - 71.9 * 60 * 60 * 1000;
    const cp = makeCheckpoint(almostExpiredMs, 72);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("returns true for a checkpoint 73h old with 72h TTL (past boundary)", () => {
    const expiredMs = Date.now() - 73 * 60 * 60 * 1000;
    const cp = makeCheckpoint(expiredMs, 72);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("returns true for a checkpoint 100h old with 72h default TTL", () => {
    const cp = makeCheckpoint(Date.now() - 100 * 60 * 60 * 1000, 72);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("returns true for a checkpoint 25h old with 24h TTL", () => {
    const cp = makeCheckpoint(Date.now() - 25 * 60 * 60 * 1000, 24);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("returns false for a checkpoint 23h old with 24h TTL", () => {
    const cp = makeCheckpoint(Date.now() - 23 * 60 * 60 * 1000, 24);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("supports a 1h TTL — expired after 2h", () => {
    const cp = makeCheckpoint(Date.now() - 2 * 60 * 60 * 1000, 1);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("supports a 1h TTL — not expired 30 minutes in", () => {
    const cp = makeCheckpoint(Date.now() - 30 * 60 * 1000, 1);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("supports a 168h (7-day) TTL — not expired at 167h", () => {
    const cp = makeCheckpoint(Date.now() - 167 * 60 * 60 * 1000, 168);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("supports a 168h TTL — expired at 169h", () => {
    const cp = makeCheckpoint(Date.now() - 169 * 60 * 60 * 1000, 168);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("EDGE: TTL of 0 — always expired immediately", () => {
    // A checkpoint with 0h TTL expires the instant it is created.
    // Date.now() is strictly > created_at + 0, even if only by 1 ms.
    const cp = makeCheckpoint(Date.now() - 1, 0);
    expect(isCheckpointExpired(cp)).toBe(true);
  });

  it("EDGE: created_at in the far future (clock-skew / backdated) → not expired", () => {
    // If a system's clock was set forward and wrote a checkpoint, another
    // system with an earlier clock should still treat it as not-expired
    // (conservative: don't prune what we can't confirm is stale).
    const futureMs = Date.now() + 48 * 60 * 60 * 1000;
    const cp = makeCheckpoint(futureMs, 72);
    expect(isCheckpointExpired(cp)).toBe(false);
  });

  it("uses the checkpoint's own ttl_hours, not a hardcoded constant", () => {
    // Two checkpoints with identical age but different TTLs must disagree
    const ageMs = Date.now() - 10 * 60 * 60 * 1000; // 10h old
    const short = makeCheckpoint(ageMs, 8); // 8h TTL → expired
    const long = makeCheckpoint(ageMs, 24); // 24h TTL → not expired
    expect(isCheckpointExpired(short)).toBe(true);
    expect(isCheckpointExpired(long)).toBe(false);
  });
});
