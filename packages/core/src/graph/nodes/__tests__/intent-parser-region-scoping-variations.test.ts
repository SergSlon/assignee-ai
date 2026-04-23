/**
 * Epic 98 Wave 2 fixer e98.W2.R1 — region-regex scope fix.
 *
 * Closes B-09 + B-10 live-FAILs from Epic 97:
 *
 *   - B-09 (`my-abc-1` tripwire): the region extractor accepted
 *     `[a-z]{2,3}(?:-[a-z]+){1,3}-\d+` anywhere in the intent, so a
 *     resource name following `named <X>` could be misclassified as an
 *     unknown region. `Create a lambda named my-abc-1` matched `my-abc-1`
 *     and surfaced `Unknown AWS region "my-abc-1"`.
 *
 *   - B-10: when both an in-name region substring (`us-east-1` inside
 *     `my-bucket-us-east-1-fake`) AND an explicit tail (`region eu-west-2`)
 *     were present, the extractor picked the first match and lost the
 *     user's explicit assertion. Epic 96 W1.B3 papered over the
 *     substring-inside-name case but did not backstop the tail-wins
 *     invariant with a multi-variation probe.
 *
 * This suite locks the new two-pass contract:
 *
 *   1. Explicit region-tail (`region <X>` / `in <X>` / `at <X>`) wins
 *      over any substring candidate in the intent body.
 *   2. Fallback substring scan runs against an intent where `named <X>`
 *      / `called <X>` / `name=<X>` spans have been masked out, so user-
 *      chosen resource names never pollute the region extractor.
 *   3. Adversarial `region eu-west-fake-1` still fails loudly (the
 *      user explicitly asserted a region; we must not silently drop it).
 */

import { describe, it, expect, vi } from "vitest";
import { RESOURCE_TYPES } from "@/index.js";
import { extractAssertedValues } from "../intent-parser.js";

// Suppress structured-log output emitted by extractRegion in the
// REGION_EXTRACTION path; tests assert on the extraction result, not
// the telemetry side-effect.
vi.mock("../../../utils/logger/index.js", () => ({
  log: vi.fn(),
  LOG_ACTIONS: {
    INTENT_PARSED: "intent_parsed",
    REGION_EXTRACTION: "region_extraction",
  },
}));

describe("intent-parser region scoping (e98.W2.R1)", () => {
  // -------------------------------------------------------------------
  // Variation 1 — B-09 tripwire: alpha-alpha-digit name never triggers
  // a region false-positive.
  // -------------------------------------------------------------------
  it("does NOT classify `my-abc-1` as a region when it is a resource name", () => {
    const out = extractAssertedValues(
      "Create a lambda named my-abc-1",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  it("does NOT classify `called my-xyz-2` as a region (called alias)", () => {
    const out = extractAssertedValues(
      "Create a lambda called my-xyz-2",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  it("does NOT classify `name=sqs-json-1776927324` as a region (kv form)", () => {
    const out = extractAssertedValues(
      "Create an SQS queue name=sqs-json-1776927324",
      RESOURCE_TYPES.SQS_QUEUE,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Variation 2 — explicit tail wins over substring inside name.
  // -------------------------------------------------------------------
  it("prefers explicit `region eu-west-2` tail over in-name substring `us-east-1`", () => {
    const out = extractAssertedValues(
      "create S3 bucket named my-bucket-us-east-1-fake region eu-west-2",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("eu-west-2");
  });

  it("prefers explicit `in us-west-2` tail over in-name substring", () => {
    const out = extractAssertedValues(
      "Create a lambda named my-fn in us-west-2",
      RESOURCE_TYPES.LAMBDA_FUNCTION,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
  });

  it("prefers explicit `at ap-southeast-2` tail over in-name substring", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket named log-us-east-1-archive at ap-southeast-2",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("ap-southeast-2");
  });

  // -------------------------------------------------------------------
  // Variation 3 — region-shaped substring inside name never clobbers
  // the default (no tail keyword present).
  // -------------------------------------------------------------------
  it("does NOT extract `ap-northeast-2` from a name that merely contains the substring", () => {
    const out = extractAssertedValues(
      "create S3 bucket named log-ap-northeast-2-archive",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Variation 4 — bare intent produces no region assertion (no error).
  // -------------------------------------------------------------------
  it("emits no region assertion and no error on a bare intent", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Variation 5 — adversarial region-shaped token via explicit `region`
  // keyword still fails loudly (unknown-region error must surface).
  // -------------------------------------------------------------------
  it("fails loudly on `region eu-west-fake-1` (explicit assertion of unknown region)", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket in region eu-west-fake-1",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors.some((e) => e.includes("Unknown AWS region"))).toBe(true);
    expect(out.elicited["__assertedRegion"]).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Regression lock — existing Epic 96 W1.B3 cases still pass.
  // -------------------------------------------------------------------
  it("bare `in us-west-2` tail is still lifted into __assertedRegion", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket in us-west-2",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
  });

  it("tail region followed by clause punctuation still resolves", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket in us-west-2, encrypted",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("us-west-2");
  });

  it("name=<token> kv form does not collide with tail `region`", () => {
    const out = extractAssertedValues(
      "Create an S3 bucket name=my-bucket-us-east-1-fake region eu-west-2",
      RESOURCE_TYPES.S3_BUCKET,
    );
    expect(out.errors).toEqual([]);
    expect(out.elicited["__assertedRegion"]).toBe("eu-west-2");
  });
});
