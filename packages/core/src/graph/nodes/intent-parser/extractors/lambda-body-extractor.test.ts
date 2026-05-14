/**
 * Tests for the Lambda body intent extractor.
 *
 * SX-7 / PH1-D-1 — completes PR #52 regression.
 * EPIC-106-2 / PH5-5-A — adds Variations A-H for quoted-body + option-A
 * handler-body semantics, plus regression guard Variation F (no-body fallback).
 */

import { describe, it, expect } from "vitest";
import { extractLambdaBody } from "./lambda-body-extractor.js";
import { RESOURCE_TYPES } from "@/index.js";

const LAMBDA = RESOURCE_TYPES.LAMBDA_FUNCTION;

// ─── EPIC-106-2 / PH5-5-A: Quoted-body variations (A-H) ───────────────────

describe("extractLambdaBody — quoted-body option-A semantics (EPIC-106-2 / PH5-5-A)", () => {
  // ── Variation A — single-quoted return statement ─────────────────────────
  it("Variation A — single-quoted 'return event' → full handler body, no static envelope", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with body 'return event'",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code).toBeDefined();
    expect(code.ZipFile).toBeDefined();
    // Option A: the user's literal IS the handler body
    expect(code.ZipFile).toContain("return event");
    // NOT a static envelope
    expect(code.ZipFile).not.toContain("statusCode: 200");
    // Quote chars must NOT appear at the end of the captured token
    expect(code.ZipFile).not.toMatch(/return event['"` ]*['"` ]$/);
  });

  // ── Variation B — double-quoted return statement ──────────────────────────
  it('Variation B — double-quoted "return event" → same handler shape as Variation A', () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      'Create a Lambda function with body "return event"',
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("return event");
    expect(code.ZipFile).not.toContain("statusCode: 200");
  });

  // ── Variation C — backtick-quoted body ───────────────────────────────────
  it("Variation C — backtick-quoted `return event` → same handler shape", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with body `return event`",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("return event");
    expect(code.ZipFile).not.toContain("statusCode: 200");
  });

  // ── Variation D — arrow expression body ──────────────────────────────────
  // Chosen semantics: the captured body IS placed verbatim inside the handler
  // braces. For `x => x*2`, the handler body IS `x => x*2` — the expression
  // is placed in the handler body, not further wrapped. The user can invoke
  // it manually if needed. This is the simplest, least-surprising behaviour.
  it("Variation D — arrow expression 'x => x*2' is placed verbatim as handler body", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with body 'x => x*2'",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("x => x*2");
    expect(code.ZipFile).not.toContain("statusCode: 200");
  });

  // ── Variation E — JSON.stringify body ────────────────────────────────────
  it("Variation E — 'JSON.stringify(event)' → handler body contains full call", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with body 'JSON.stringify(event)'",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("JSON.stringify(event)");
    expect(code.ZipFile).not.toContain("statusCode: 200");
  });

  // ── Variation F — no quoted body (regression-guard, PH1-D-1 / SX-7) ─────
  // When NO `body 'X'` clause is present, the extractor must leave
  // elicited.Code unset so the pattern's placeholder ZipFile applies.
  // This is the exact closure condition of SX-7 / PH1-D-1. DO NOT weaken.
  it("Variation F — no body clause → Code left unset (SX-7 regression guard)", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody("Create a Lambda function", LAMBDA, elicited);
    expect(elicited["Code"]).toBeUndefined();
  });

  // ── Variation G — multi-statement body ───────────────────────────────────
  it("Variation G — multi-statement 'console.log(event); return event' → both statements in handler", () => {
    const elicited: Record<string, unknown> = {};
    extractLambdaBody(
      "Create a Lambda function with body 'console.log(event); return event'",
      LAMBDA,
      elicited,
    );
    const code = elicited["Code"] as { ZipFile?: string };
    expect(code.ZipFile).toContain("console.log(event)");
    expect(code.ZipFile).toContain("return event");
    expect(code.ZipFile).not.toContain("statusCode: 200");
  });

  // ── Variation H — quote-leak negative regression test ────────────────────
  // For ALL quoted-body variations (A-G) the captured ZipFile must NOT
  // end in a quote character. This is the primary PH5-5-A failure mode:
  // `event'` was captured instead of `return event`.
  it("Variation H — captured ZipFile never ends in a stray quote character (quote-leak guard)", () => {
    const cases = [
      "Create a Lambda function with body 'return event'",
      'Create a Lambda function with body "return event"',
      "Create a Lambda function with body `return event`",
      "Create a Lambda function with body 'x => x*2'",
      "Create a Lambda function with body 'JSON.stringify(event)'",
      "Create a Lambda function with body 'console.log(event); return event'",
    ];
    for (const intent of cases) {
      const elicited: Record<string, unknown> = {};
      extractLambdaBody(intent, LAMBDA, elicited);
      const code = elicited["Code"] as { ZipFile?: string };
      expect(code?.ZipFile, `ZipFile for: ${intent}`).toBeDefined();
      // The handler source must not end with a bare quote
      expect(code!.ZipFile, `ZipFile ends in quote for: ${intent}`).not.toMatch(
        /['"` ];\s*$/,
      );
      // More targeted: the captured body fragment inside the handler must
      // not be followed immediately by a stray quote before the closing `}`.
      // Pattern: content of the { ... } block must not contain a trailing quote.
      const handlerBody = code!.ZipFile!.match(
        /exports\.handler\s*=\s*async\s*\(event\)\s*=>\s*\{([\s\S]*)\};$/,
      );
      if (!handlerBody) {
        throw new Error(`Could not parse handler body from: ${code!.ZipFile}`);
      }
      const body = (handlerBody[1] as string).trim();
      expect(body, `Body ends in quote for: ${intent}`).not.toMatch(/['"`]$/);
    }
  });
});

// ─── Existing SX-7 / PH1-D-1 tests ──────────────────────────────────────────

describe("extractLambdaBody — Lambda body propagation (SX-7)", () => {
  // ── Variation A — body propagation, classic "returns X" ───────────────────
  // NOTE: unquoted verb-form intents use the static-envelope shape (existing
  // behaviour). Quoted-body intents use option-A handler-body shape (EPIC-106-2).
  // This test uses an unquoted verb-form intent → static-envelope shape correct.
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
