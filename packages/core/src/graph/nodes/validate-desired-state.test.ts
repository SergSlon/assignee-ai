import { describe, it, expect } from "vitest";
import {
  validateS3BucketName,
  validateDesiredState,
  validateDesiredStateNode,
  formatValidationError,
} from "./validate-desired-state.js";
import { ExecutionStatus } from "../../schema/graph-state.js";
import type { AgentState } from "../graph-state.js";

// Minimal AgentState factory — typed loosely because AgentState is a
// LangGraph annotation whose runtime type is `any`-shaped. We only need
// the three fields the node reads.
const mkState = (partial: Partial<AgentState>): AgentState =>
  ({
    executionStatus: ExecutionStatus.PENDING,
    resourceType: "",
    desiredState: {},
    ...partial,
  }) as unknown as AgentState;

describe("validateS3BucketName", () => {
  // -- Happy path --------------------------------------------------------

  it("accepts a typical production-style name", () => {
    const r = validateS3BucketName("assignee-website-bucket-7785581e");
    expect(r.ok).toBe(true);
    expect(r.error).toBeUndefined();
  });

  it("accepts dot-separated DNS-style names", () => {
    const r = validateS3BucketName("app1.logs.prod");
    expect(r.ok).toBe(true);
  });

  it("accepts exactly 3-char name (lower boundary)", () => {
    const r = validateS3BucketName("abc");
    expect(r.ok).toBe(true);
  });

  it("accepts exactly 63-char name (upper boundary)", () => {
    const name = "a".repeat(63);
    expect(name.length).toBe(63);
    const r = validateS3BucketName(name);
    expect(r.ok).toBe(true);
  });

  it("accepts name with digits at start and end", () => {
    const r = validateS3BucketName("1-app-logs-9");
    expect(r.ok).toBe(true);
  });

  it("treats empty string as valid (AWS auto-generates)", () => {
    expect(validateS3BucketName("").ok).toBe(true);
  });

  // -- Length --------------------------------------------------------------

  it("rejects 2-char name (below min)", () => {
    const r = validateS3BucketName("ab");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3-63");
    expect(r.fix).toBeDefined();
  });

  it("rejects 64-char name (above max)", () => {
    const name = "a".repeat(64);
    const r = validateS3BucketName(name);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("3-63");
  });

  // -- Charset -------------------------------------------------------------

  it("rejects uppercase characters", () => {
    const r = validateS3BucketName("MyBucket");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-z0-9.-]");
  });

  it("rejects underscores", () => {
    const r = validateS3BucketName("my_bucket");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-z0-9.-]");
  });

  it("rejects names with spaces", () => {
    const r = validateS3BucketName("my bucket");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("[a-z0-9.-]");
  });

  // -- Start / end boundary ------------------------------------------------

  it("rejects name that starts with '.'", () => {
    const r = validateS3BucketName(".assignee-logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("start and end");
  });

  it("rejects name that ends with '-'", () => {
    const r = validateS3BucketName("assignee-logs-");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("start and end");
  });

  it("rejects name that starts with '-'", () => {
    const r = validateS3BucketName("-assignee-logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("start and end");
  });

  // -- Adjacent dots / dot-hyphen -----------------------------------------

  it("rejects adjacent dots '..'", () => {
    const r = validateS3BucketName("assignee..logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("adjacent dots");
  });

  it("rejects '.-' adjacency", () => {
    const r = validateS3BucketName("assignee.-logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'.-' or '-.'");
  });

  it("rejects '-.' adjacency", () => {
    const r = validateS3BucketName("assignee-.logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("'.-' or '-.'");
  });

  // -- IPv4 ---------------------------------------------------------------

  it("rejects IPv4-shaped names like 192.168.1.1", () => {
    const r = validateS3BucketName("192.168.1.1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("IPv4");
  });

  it("rejects IPv4-shaped 10.0.0.1", () => {
    const r = validateS3BucketName("10.0.0.1");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("IPv4");
  });

  // -- Reserved prefixes / suffixes ---------------------------------------

  it("rejects xn-- prefix (IDN ACE)", () => {
    const r = validateS3BucketName("xn--my-bucket");
    expect(r.ok).toBe(false);
    expect(r.error).toContain('"xn--"');
  });

  it("rejects sthree- prefix", () => {
    const r = validateS3BucketName("sthree-assignee-logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sthree-");
  });

  it("rejects sthree-configurator prefix (subset of sthree-)", () => {
    const r = validateS3BucketName("sthree-configurator-logs");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("sthree-");
  });

  it("rejects -s3alias suffix", () => {
    const r = validateS3BucketName("my-access-point-s3alias");
    expect(r.ok).toBe(false);
    expect(r.error).toContain("-s3alias");
  });
});

describe("validateDesiredState dispatcher", () => {
  it("returns ok=true for a resource type with no registered validator", () => {
    const r = validateDesiredState("AWS::Lambda::Function", {
      FunctionName: "my-fn",
    });
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("returns ok=true for undefined desiredState", () => {
    const r = validateDesiredState("AWS::S3::Bucket", undefined);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("returns ok=true for S3::Bucket with a valid BucketName", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {
      BucketName: "assignee-website-bucket-7785581e",
    });
    expect(r.ok).toBe(true);
  });

  it("returns ok=true for S3::Bucket when BucketName is omitted (auto-generate)", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {});
    expect(r.ok).toBe(true);
  });

  it("returns ok=false for S3::Bucket with an IPv4-shaped name", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {
      BucketName: "192.168.1.1",
    });
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]!.error).toContain("IPv4");
  });

  it("returns ok=false for xn-- prefix", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {
      BucketName: "xn--my-bucket",
    });
    expect(r.ok).toBe(false);
  });

  it("returns ok=false for -s3alias suffix", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {
      BucketName: "my-access-point-s3alias",
    });
    expect(r.ok).toBe(false);
  });

  it("ignores non-string BucketName (delegates to schema sanitizer)", () => {
    const r = validateDesiredState("AWS::S3::Bucket", {
      BucketName: 12345,
    });
    // Non-string value: validator doesn't assert S3 rules — schema layer
    // is responsible for type coercion/rejection.
    expect(r.ok).toBe(true);
  });
});

describe("formatValidationError", () => {
  it("formats error with [ERROR] and [FIX] prefixes when fix is present", () => {
    const msg = formatValidationError({
      ok: false,
      error: "bad name",
      fix: "use dashes",
    });
    expect(msg).toBe("[ERROR] bad name [FIX] use dashes");
  });

  it("omits [FIX] when fix is absent", () => {
    const msg = formatValidationError({ ok: false, error: "bad name" });
    expect(msg).toBe("[ERROR] bad name");
  });

  it("uses fallback error text when error field is missing", () => {
    const msg = formatValidationError({ ok: false });
    expect(msg).toContain("[ERROR]");
    expect(msg).toContain("desiredState validation failed");
  });
});

describe("validateDesiredStateNode", () => {
  it("passes through unchanged on valid state (returns empty patch)", async () => {
    const state = mkState({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "assignee-logs-prod" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch).toEqual({});
  });

  it("short-circuits when executionStatus is not PENDING", async () => {
    const state = mkState({
      executionStatus: ExecutionStatus.FAILED,
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "192.168.1.1" },
    });
    const patch = await validateDesiredStateNode(state);
    // Must NOT overwrite a prior FAILED state or re-emit an error.
    expect(patch).toEqual({});
  });

  it("short-circuits when resourceType is missing", async () => {
    const state = mkState({
      resourceType: "",
      desiredState: { BucketName: "192.168.1.1" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch).toEqual({});
  });

  it("sets FAILED + [ERROR]/[FIX] message on invalid BucketName", async () => {
    const state = mkState({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "192.168.1.1" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("[ERROR]");
    expect(patch.errorMessage).toContain("IPv4");
    expect(patch.errorMessage).toContain("[FIX]");
  });

  it("sets FAILED on xn-- prefix with actionable fix", async () => {
    const state = mkState({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: "xn--my-bucket" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("xn--");
    expect(patch.errorMessage).toContain("[FIX]");
  });

  it("sets FAILED on leading '.' with guidance", async () => {
    const state = mkState({
      resourceType: "AWS::S3::Bucket",
      desiredState: { BucketName: ".assignee-logs" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(patch.errorMessage).toContain("start and end");
  });

  it("passes through unchanged for unregistered resource types", async () => {
    const state = mkState({
      resourceType: "AWS::Lambda::Function",
      desiredState: { FunctionName: "my-fn" },
    });
    const patch = await validateDesiredStateNode(state);
    expect(patch).toEqual({});
  });
});
