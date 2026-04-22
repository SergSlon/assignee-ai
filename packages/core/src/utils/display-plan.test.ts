/**
 * Story 46.2 — display-plan source-suffix rendering.
 *
 * Verifies that `formatCostLine` appends the right "(live)" / "(cached)" /
 * "(estimated)" / "(from log)" / "" suffix when given each `DataSource`
 * value, and that the legacy callers (no source) still work unchanged.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  formatCostLine,
  parsePlanJsonStream,
  renderPlanBox,
  serializePlanEnvelope,
  serializeErrorEnvelope,
} from "./display-plan.js";
import type { DataSource } from "../pricing/types.js";
import type { RenderableState } from "./display-helpers/renderable-state.js";

describe("formatCostLine — source suffix rendering (Story 46.2)", () => {
  it.each([
    ["mcp", "$32.85/mo", "$32.85/mo (live)"],
    ["cached", "$32.85/mo", "$32.85/mo (cached)"],
    ["fallback", "~$32/mo", "~$32/mo (estimated)"],
    ["offline", "$10.00/month", "$10.00/month (from log)"],
    ["free", "Free", "Free"],
  ] as Array<[DataSource, string, string]>)(
    "%s source → suffix",
    (source, label, expected) => {
      expect(formatCostLine(label, source)).toBe(expected);
    },
  );

  it("returns N/A when estimatedMonthlyCost is undefined and no source", () => {
    expect(formatCostLine(undefined)).toBe("N/A");
  });

  it("returns bare N/A (no suffix) when estimatedMonthlyCost is undefined even if source is set (F7)", () => {
    // The provenance suffix only applies to a real dollar amount.
    // "N/A (live)" is contradictory — flagged by Edge Case Hunter F7
    // and Blind Hunter 7 in the Story 46.2 review pass.
    expect(formatCostLine(undefined, "mcp")).toBe("N/A");
    expect(formatCostLine(undefined, "fallback")).toBe("N/A");
    expect(formatCostLine(undefined, "free")).toBe("N/A");
  });

  it("returns the bare label when source is omitted (back-compat)", () => {
    // Existing call sites that don't yet pass a source must continue to
    // work — the suffix is a strict opt-in.
    expect(formatCostLine("$5.00/mo")).toBe("$5.00/mo");
  });

  it("free source on a non-Free label still produces no suffix", () => {
    // Defensive: a free-tier resource that for some reason renders a
    // dollar amount must NOT get an "(estimated)" tag tacked on.
    expect(formatCostLine("$0.00/mo", "free")).toBe("$0.00/mo");
  });
});

// ── Epic 92 Wave 2.c — JSON envelope helpers (A-02 / D-29 / D-30) ────
describe("parsePlanJsonStream — compound NDJSON → array (A-02)", () => {
  // Real-shape payload captured from an S3 bucket plan run on 2026-04-10.
  // Primitive values preserved verbatim to keep the round-trip honest.
  const s3Payload = {
    resourceType: "AWS::S3::Bucket",
    region: "us-east-1",
    desiredState: {
      BucketName: "audit-logs-2026",
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    },
    estimatedMonthlyCost: "$0.023/mo",
    pricingBreakdown: null,
    bpFindings: [],
    appliedFixes: [],
    freeTierNote: null,
    adviceHints: [],
  };
  const lambdaPayload = {
    resourceType: "AWS::Lambda::Function",
    region: "us-east-1",
    desiredState: {
      FunctionName: "image-processor",
      Runtime: "nodejs20.x",
      Handler: "index.handler",
      Role: "arn:aws:iam::210987654321:role/lambda-exec",
    },
    estimatedMonthlyCost: "$0.20/mo",
    pricingBreakdown: null,
    bpFindings: [],
    appliedFixes: [],
    freeTierNote: null,
    adviceHints: [],
  };

  it("returns [] for empty input", () => {
    expect(parsePlanJsonStream("")).toEqual([]);
  });

  it("parses a single pretty-printed JSON object", () => {
    const buffered = JSON.stringify(s3Payload, null, 2) + "\n";
    const out = parsePlanJsonStream(buffered);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(s3Payload);
  });

  it("parses two concatenated pretty-printed JSON objects (NDJSON → 2 elements)", () => {
    // This is the exact shape that today fails `JSON.parse` end-to-end.
    const buffered =
      JSON.stringify(s3Payload, null, 2) +
      "\n" +
      JSON.stringify(lambdaPayload, null, 2) +
      "\n";
    const out = parsePlanJsonStream(buffered);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual(s3Payload);
    expect(out[1]).toEqual(lambdaPayload);
  });

  it("ignores braces inside string values (quoted `}` does not end an object)", () => {
    // BP message text legitimately contains `{` and `}` characters —
    // the depth counter must honor string boundaries.
    const payload = {
      resourceType: "AWS::S3::Bucket",
      bpFindings: [
        {
          practiceId: "BP-S3-010",
          message: "Add LifecycleConfiguration: { Rules: [...] } to enable",
          blocking: false,
        },
      ],
    };
    const buffered = JSON.stringify(payload, null, 2) + "\n";
    const out = parsePlanJsonStream(buffered);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(payload);
  });

  it('honors escaped quotes inside strings (\\") without losing depth tracking', () => {
    const payload = {
      resourceType: "AWS::Lambda::Function",
      desiredState: {
        Description: 'A function that says "hello \\"world\\""',
      },
    };
    const buffered = JSON.stringify(payload, null, 2) + "\n";
    const out = parsePlanJsonStream(buffered);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(payload);
  });

  it("skips malformed slices but keeps forward progress on valid ones", () => {
    // Simulate a truncated write followed by a complete payload. This
    // guards the `JSON.parse` try/catch branch so a single corrupt
    // object does not abort the whole envelope.
    const buffered =
      '{"resourceType":"AWS::S3::Bucket","desiredState":' +
      "\n" +
      JSON.stringify(lambdaPayload, null, 2) +
      "\n";
    const out = parsePlanJsonStream(buffered);
    // The broken leading fragment — `{"resourceType":"AWS::S3::Bucket","desiredState":`
    // — technically reaches depth 0 via mismatched brackets? No: the
    // leading `{` has no matching `}` before the Lambda payload opens
    // its own `{`. We expect the parser to recover with the Lambda
    // payload parsed correctly.
    expect(out.length).toBeGreaterThanOrEqual(1);
    const last = out[out.length - 1] as typeof lambdaPayload;
    expect(last.resourceType).toBe("AWS::Lambda::Function");
  });
});

describe("serializePlanEnvelope — single vs compound (A-02)", () => {
  const payload = {
    resourceType: "AWS::S3::Bucket",
    region: "us-east-1",
    desiredState: { BucketName: "demo" },
    estimatedMonthlyCost: "$0.023/mo",
    pricingBreakdown: null,
    bpFindings: [],
    appliedFixes: [],
    freeTierNote: null,
    adviceHints: [],
  };

  it("single-payload array → { ok: true, plan: <payload> }", () => {
    const out = serializePlanEnvelope([payload]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.plan).toEqual(payload);
    expect(parsed.plans).toBeUndefined();
  });

  it("multi-payload array → { ok: true, plans: [...] }", () => {
    const lambda = { ...payload, resourceType: "AWS::Lambda::Function" };
    const out = serializePlanEnvelope([payload, lambda]);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(Array.isArray(parsed.plans)).toBe(true);
    expect(parsed.plans).toHaveLength(2);
    expect(parsed.plan).toBeUndefined();
  });

  it("envelope always ends with a trailing newline", () => {
    const out = serializePlanEnvelope([payload]);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("output is valid JSON (jq -e equivalent)", () => {
    const lambda = { ...payload, resourceType: "AWS::Lambda::Function" };
    const out = serializePlanEnvelope([payload, lambda]);
    expect(() => JSON.parse(out)).not.toThrow();
  });
});

// ── Epic 94 N8 (C-01) — companion rendering tag ────────────────────
describe("renderPlanBox — companion tag (Epic 94 N8 / C-01)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let captured: string;

  afterEach(() => {
    stdoutSpy?.mockRestore();
  });

  function installStdoutCapture(): void {
    captured = "";
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: unknown) => {
        captured +=
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8");
        return true;
      });
  }

  const baseState: RenderableState = {
    resourceType: "AWS::ApiGatewayV2::Api",
    runId: "run-e94-n8",
    desiredState: {
      ProtocolType: "WEBSOCKET",
      RouteSelectionExpression: "$request.body.action",
    },
    estimatedMonthlyCost: "Free",
  };

  it("renders a plain `Resource Type:` row when provisionable is true", () => {
    installStdoutCapture();
    renderPlanBox({ ...baseState, provisionable: true });
    expect(captured).toContain("Resource Type:");
    expect(captured).toContain("AWS::ApiGatewayV2::Api");
    // No `[companion]` prefix on provisionable resources.
    expect(captured).not.toContain("[companion]");
  });

  it("renders a plain `Resource Type:` row when provisionable is undefined (default)", () => {
    installStdoutCapture();
    renderPlanBox(baseState);
    expect(captured).toContain("Resource Type:");
    expect(captured).not.toContain("[companion]");
  });

  it("prefixes the resource type with `[companion]` when provisionable is false", () => {
    installStdoutCapture();
    renderPlanBox({ ...baseState, provisionable: false });
    expect(captured).toContain("[companion] AWS::ApiGatewayV2::Api");
  });

  it("companion render still surfaces the desiredState (WEBSOCKET + $request.body.action visible)", () => {
    // This is the load-bearing assertion for C-01: the user MUST be
    // able to see the WebSocket API's ProtocolType + RouteSelectionExpression
    // VALUES before apply. `formatDesiredState` humanizes the KEY names
    // for AWS::ApiGatewayV2::Api (ProtocolType → "Protocol",
    // RouteSelectionExpression → "Route Selection Expression"), so the
    // assertion pins the VALUES (which are the bits that tell a
    // WebSocket API apart from an HTTP fallback).
    installStdoutCapture();
    renderPlanBox({ ...baseState, provisionable: false });
    expect(captured).toContain("WEBSOCKET");
    expect(captured).toContain("$request.body.action");
    // Humanized key labels (friendly-names.ts) for AWS::ApiGatewayV2::Api.
    expect(captured).toContain("Protocol");
    expect(captured).toContain("Route Selection Expression");
  });
});

describe("serializeErrorEnvelope — failure path (D-29 / D-30)", () => {
  it("emits { ok: false, error: { code, message } } without hint", () => {
    const out = serializeErrorEnvelope(
      "UNSUPPORTED_RESOURCE",
      "Cannot plan: unsupported resource type.",
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toEqual({
      code: "UNSUPPORTED_RESOURCE",
      message: "Cannot plan: unsupported resource type.",
    });
  });

  it("emits { ok: false, error: { code, message, hint } } with hint", () => {
    const out = serializeErrorEnvelope(
      "INVALID_RESOURCE_TYPE",
      'Unknown --resource-type "NotAThing".',
      "Pass a supported CFN type (e.g. AWS::S3::Bucket).",
    );
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("INVALID_RESOURCE_TYPE");
    expect(parsed.error.message).toBe('Unknown --resource-type "NotAThing".');
    expect(parsed.error.hint).toBe(
      "Pass a supported CFN type (e.g. AWS::S3::Bucket).",
    );
  });

  it("trailing newline present — piped consumers read one full line", () => {
    const out = serializeErrorEnvelope("X", "y");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("output is valid JSON under jq -e .", () => {
    const out = serializeErrorEnvelope("X", "y", "z");
    expect(() => JSON.parse(out)).not.toThrow();
  });
});
