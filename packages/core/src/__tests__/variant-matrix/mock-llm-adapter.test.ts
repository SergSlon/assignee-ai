/**
 * MockLlmAdapter unit tests — variant-matrix shared fixture.
 *
 * Exercises:
 *   - Axis C — MockLlmAdapter determinism: forScriptedResponse(type, "CREATE")
 *              always returns the same scripted response regardless of call order.
 *   - Axis D — MockLlmAdapter unknown-type fallback: forScriptedResponse("unknown-type", "CREATE")
 *              returns UNSUPPORTED_SCRIPTED_RESPONSE rather than throwing.
 *   - Axis I — Build-time no-import leakage: this file does NOT import from apps/cli/.
 *
 * Story 108-B-01
 */

import { describe, it, expect } from "vitest";
import {
  MockLlmAdapter,
  UNSUPPORTED_SCRIPTED_RESPONSE,
} from "./mock-llm-adapter.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Axis C — determinism
// ---------------------------------------------------------------------------

describe("MockLlmAdapter Axis C — determinism", () => {
  it("forScriptedResponse(type, intentShape) returns the same scripted response on every call", async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::S3::Bucket",
      "CREATE",
    );
    const schema = z.object({ resourceType: z.string(), kind: z.string() });

    const [_err1, result1] = await adapter.generateStructured(
      "prompt-1",
      schema,
    );
    const [_err2, result2] = await adapter.generateStructured(
      "prompt-2",
      schema,
    );
    const [_err3, result3] = await adapter.generateStructured(
      "prompt-3",
      schema,
    );

    expect(result1).not.toBeNull();
    expect(result2).not.toBeNull();
    expect(result3).not.toBeNull();

    // Identity equality — same frozen fixture object returned every call.
    expect(result1).toBe(result2);
    expect(result2).toBe(result3);
  });

  it("forScriptedResponse always returns err=null (no error)", async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::Lambda::Function",
      "CREATE",
    );
    const schema = z.object({ resourceType: z.string(), kind: z.string() });
    const [err] = await adapter.generateStructured("any prompt", schema);
    expect(err).toBeNull();
  });

  it("forScriptedResponse for CREATE sets kind=create", () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::DynamoDB::Table",
      "CREATE",
    );
    expect(adapter.scriptedResponse.kind).toBe("create");
    expect(adapter.scriptedResponse.resourceType).toBe("AWS::DynamoDB::Table");
  });

  it("forScriptedResponse for DESCRIBE sets kind=query", () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::EC2::VPC",
      "DESCRIBE",
    );
    expect(adapter.scriptedResponse.kind).toBe("query");
    expect(adapter.scriptedResponse.resourceType).toBe("AWS::EC2::VPC");
  });

  it("forScriptedResponse for DESTROY sets kind=destroy", () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::RDS::DBInstance",
      "DESTROY",
    );
    expect(adapter.scriptedResponse.kind).toBe("destroy");
    expect(adapter.scriptedResponse.resourceType).toBe("AWS::RDS::DBInstance");
  });

  it("two adapters built from identical arguments return the same scriptedResponse instance", () => {
    const adapter1 = MockLlmAdapter.forScriptedResponse(
      "AWS::S3::Bucket",
      "CREATE",
    );
    const adapter2 = MockLlmAdapter.forScriptedResponse(
      "AWS::S3::Bucket",
      "CREATE",
    );
    // Same cached fixture — identity equality on the response object.
    expect(adapter1.scriptedResponse).toBe(adapter2.scriptedResponse);
  });

  it("callCount increments on each generateStructured call", async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::SQS::Queue",
      "CREATE",
    );
    const schema = z.object({ resourceType: z.string(), kind: z.string() });

    expect(adapter.callCount).toBe(0);
    await adapter.generateStructured("p1", schema);
    expect(adapter.callCount).toBe(1);
    await adapter.generateStructured("p2", schema);
    expect(adapter.callCount).toBe(2);
  });

  it("calls array records all prompt arguments", async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::SNS::Topic",
      "CREATE",
    );
    const schema = z.object({ resourceType: z.string(), kind: z.string() });

    await adapter.generateStructured("first-prompt", schema);
    await adapter.generateStructured("second-prompt", schema);

    expect(adapter.calls).toHaveLength(2);
    expect(adapter.calls[0]?.prompt).toBe("first-prompt");
    expect(adapter.calls[1]?.prompt).toBe("second-prompt");
  });
});

// ---------------------------------------------------------------------------
// Axis D — unknown-type fallback
// ---------------------------------------------------------------------------

describe("MockLlmAdapter Axis D — unknown-type fallback", () => {
  it('forScriptedResponse("unknown-type", "CREATE") returns UNSUPPORTED shape, not throw', async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "unknown-type",
      "CREATE",
    );
    const schema = z.object({ resourceType: z.string(), kind: z.string() });

    let threw = false;
    let result: unknown;
    let err: unknown;
    try {
      [err, result] = await adapter.generateStructured("any", schema);
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
    expect(err).toBeNull();
    expect(result).toBeDefined();
    expect((result as { resourceType: string }).resourceType).toBe(
      "UNSUPPORTED",
    );
  });

  it("UNSUPPORTED fallback is identical to UNSUPPORTED_SCRIPTED_RESPONSE constant", () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "not-a-cfn-type",
      "CREATE",
    );
    expect(adapter.scriptedResponse).toBe(UNSUPPORTED_SCRIPTED_RESPONSE);
  });

  it("empty string type returns UNSUPPORTED fallback", () => {
    const adapter = MockLlmAdapter.forScriptedResponse("", "CREATE");
    expect(adapter.scriptedResponse.resourceType).toBe("UNSUPPORTED");
  });

  it("non-AWS prefix type returns UNSUPPORTED fallback", () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "MyCustom::Type",
      "CREATE",
    );
    expect(adapter.scriptedResponse.resourceType).toBe("UNSUPPORTED");
  });
});

// ---------------------------------------------------------------------------
// generateText no-op (contract)
// ---------------------------------------------------------------------------

describe("MockLlmAdapter — generateText no-op", () => {
  it("generateText returns empty string and no error", async () => {
    const adapter = MockLlmAdapter.forScriptedResponse(
      "AWS::S3::Bucket",
      "CREATE",
    );
    const [err, text] = await adapter.generateText("any prompt");
    expect(err).toBeNull();
    expect(text).toBe("");
  });
});
