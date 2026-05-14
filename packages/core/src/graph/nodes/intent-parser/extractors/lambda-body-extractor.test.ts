/**
 * Tests for the Lambda body intent extractor.
 *
 * SX-7 / PH1-D-1 — completes PR #52 regression. Probe variations A-F
 * from the story spec.
 */

import { describe, it, expect } from "vitest";
import { extractLambdaBody } from "./lambda-body-extractor.js";
import { RESOURCE_TYPES } from "@/index.js";

const LAMBDA = RESOURCE_TYPES.LAMBDA_FUNCTION;

describe("extractLambdaBody — Lambda body propagation (SX-7)", () => {
  // ── Variation A — body propagation, classic "returns X" ───────────────────
  it("Variation A — sets Code.ZipFile containing user's body literal for 'returns Hello World'", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function named genai-next-hello that returns Hello World",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code).toBeDefined();
    expect(code.ZipFile).toBeDefined();
    expect(code.ZipFile).toContain("Hello World");
    expect(code.ZipFile).toContain("statusCode: 200");
  });

  // ── Variation B — placeholder fallback when no body phrase ────────────────
  it("Variation B — leaves elicited.Code unset for plain Lambda intent (placeholder fallback)", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with an exec role",
      LAMBDA,
      elicited,
    );
    expect(elicited["Code"]).toBeUndefined();
  });

  // ── Variation C — "prints X" phrasing on scheduled-lambda-style intent ────
  it("Variation C — captures 'prints timestamp' from scheduled-lambda intent", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Scheduled lambda every 5 minutes that prints timestamp",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code?.ZipFile).toContain("timestamp");
  });

  // ── Variation D — "returns Pong" on serverless-api-style intent ───────────
  it("Variation D — captures 'returns Pong' from serverless-api intent", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody("Serverless API that returns Pong", LAMBDA, elicited);
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code?.ZipFile).toContain("Pong");
  });

  // ── Variation E — "logs payload" on message-processing-style intent ───────
  it("Variation E — captures 'logs payload' from message-processing intent", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Lambda that processes SQS messages and logs payload",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code?.ZipFile).toContain("payload");
  });

  // ── Variation F — user-supplied Code.Handler preserved alongside ZipFile ──
  it("Variation F — merges with existing elicited.Code (preserves Handler)", () => {
    const elicited: Record<string, unknown> = {
      Code: { Handler: "custom.handler" },
    };
    extractLambdaBody(
      "Create a Lambda named foo that responds with hi",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string; Handler?: string };
    expect(code.Handler).toBe("custom.handler");
    expect(code.ZipFile).toContain("hi");
  });

  // ── Non-Lambda guard ──────────────────────────────────────────────────────
  it("does NOT fire for non-Lambda resource types", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create an S3 bucket that returns Pong",
      RESOURCE_TYPES.S3_BUCKET,
      elicited,
    );
    expect(elicited["Code"]).toBeUndefined();
  });

  // ── Variation E end-to-end (message-processing compound) ──────────────────
  // The message-processing compound surfaces SQS_QUEUE as its primary
  // resource type per patternPrimaryResourceType, but the user's intent
  // describes a Lambda body. The gate must accept this case OR Variation E
  // is broken end-to-end.
  it("Variation E end-to-end — fires for message-processing intent where primaryType=SQS_QUEUE", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Lambda that processes SQS messages and logs payload",
      RESOURCE_TYPES.SQS_QUEUE,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code?.ZipFile).toContain("payload");
  });

  // ── SQS gate WITHOUT lambda mention should NOT fire ────────────────────────
  it("does NOT fire for SQS_QUEUE intent that does not mention lambda", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create an SQS queue that returns messages quickly",
      RESOURCE_TYPES.SQS_QUEUE,
      elicited,
    );
    expect(elicited["Code"]).toBeUndefined();
  });

  // ── Empty body literal guard ──────────────────────────────────────────────
  it("does NOT fire when the body phrase matches but captures empty string", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody("Create a Lambda that returns .", LAMBDA, elicited);
    // "returns " followed by "." → captured group is " " (whitespace), trimmed to empty.
    expect(elicited["Code"]).toBeUndefined();
  });

  // ── Sentence-terminator boundary ──────────────────────────────────────────
  it("stops body capture at sentence terminator (semicolon)", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda that returns OK; with 256 MB memory",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("OK");
    expect(code.ZipFile).not.toContain("256 MB");
  });

  // ── Single-quote escaping ─────────────────────────────────────────────────
  it("escapes single quotes in the body literal to keep emitted JS valid", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda that returns it's working",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("it\\'s working");
  });
});
