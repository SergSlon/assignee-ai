/**
 * Unit test for the `isE2eBucketName` predicate exported from
 * `e2e-plan.test.ts`. Epic 98 e98.W5.P2 (D-10): the predicate is
 * the single source of truth for the bucket-sweep match set, so
 * extending / narrowing it is an explicit test-triaged decision,
 * not an unconscious drift.
 *
 * NOT gated behind RUN_E2E — runs every `pnpm test` so a prefix
 * regression surfaces immediately (before a crashed e2e run leaks
 * buckets across the account).
 */

import { describe, it, expect } from "vitest";
import { isE2eBucketName } from "./e2e-plan-shared.js";

describe("isE2eBucketName — D-10 bucket-sweep predicate", () => {
  it("matches the generic `e2e-*` family", () => {
    expect(isE2eBucketName("e2e-test-1776953600")).toBe(true);
    expect(isE2eBucketName("e2e-epic35-proppath")).toBe(true);
  });

  it("matches the legacy `poc-apply-test-*` family", () => {
    expect(isE2eBucketName("poc-apply-test-1775")).toBe(true);
  });

  it("matches the `assignee-e2e-*` Slice A family (new in W5.P2)", () => {
    // Pre-W5.P2, these buckets were NOT swept — the e2e corpus
    // under e2e-plan.test.ts:1057+ creates them as
    // `assignee-e2e-s3-<ts>`, `assignee-e2e-role-<ts>`, etc. and
    // a crashed per-test cleanup leaked them forever.
    expect(isE2eBucketName("assignee-e2e-s3-1776953600")).toBe(true);
    expect(isE2eBucketName("assignee-e2e-role-1776")).toBe(true);
    expect(isE2eBucketName("assignee-e2e-ecr-abc")).toBe(true);
  });

  it("does NOT match buckets outside the e2e corpus", () => {
    // Regression guard — keep the predicate narrow so an accidental
    // broadening doesn't nuke production buckets.
    expect(isE2eBucketName("my-prod-bucket")).toBe(false);
    expect(isE2eBucketName("customer-data-2026")).toBe(false);
    expect(isE2eBucketName("assignee-operator-logs")).toBe(false);
    // Substring-match would have matched this one — prefix-only
    // discipline must hold:
    expect(isE2eBucketName("prod-e2e-observed")).toBe(false);
    expect(isE2eBucketName("staging-poc-apply-test-mirror")).toBe(false);
  });

  it("is case-sensitive (AWS bucket names are lowercase anyway, but pin the contract)", () => {
    expect(isE2eBucketName("E2E-test-1")).toBe(false);
    expect(isE2eBucketName("Assignee-E2E-s3-1")).toBe(false);
  });
});
