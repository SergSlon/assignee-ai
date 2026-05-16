/**
 * Story 46.2 — display-plan source-suffix rendering.
 *
 * Verifies that `formatCostLine` appends the right "(live)" / "(cached)" /
 * "(estimated)" / "(from log)" / "" suffix when given each `DataSource`
 * value, and that the legacy callers (no source) still work unchanged.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  formatCostLine,
  formatPricingBreakdown,
  parsePlanJsonStream,
  renderPlanBox,
  serializePlanEnvelope,
  serializeErrorEnvelope,
} from "./display-plan.js";
import { formatDesiredState } from "./display-helpers/format-desired-state.js";
import type { DataSource } from "../pricing/types.js";
import type { RenderableState } from "./display-helpers/renderable-state.js";
import type { PricingBreakdown } from "../pricing/decomposer-types.js";

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

  // ── Epic 98 e98.W5.N4 (B-04 + B-05) — error.detail bag ──────────

  it("emits error.detail.errorMessage when passed (B-04 closure)", () => {
    const out = serializeErrorEnvelope(
      "APPLY_FAILED",
      "Invalid id",
      "Run --verbose",
      {
        errorMessage: 'Invalid id: "igw-xxx" (Service: Ec2, Status Code: 400)',
      },
    );
    const parsed = JSON.parse(out) as {
      error: {
        code: string;
        message: string;
        hint: string;
        detail: { errorMessage: string };
      };
    };
    expect(parsed.error.code).toBe("APPLY_FAILED");
    expect(parsed.error.detail.errorMessage).toBe(
      'Invalid id: "igw-xxx" (Service: Ec2, Status Code: 400)',
    );
  });

  it("emits error.detail.practiceIds[] when passed (B-05 closure)", () => {
    const out = serializeErrorEnvelope(
      "BP_BLOCKED",
      "Apply blocked by BP-IGW-001.",
      undefined,
      { practiceIds: ["BP-IGW-001", "BP-S3-001"] },
    );
    const parsed = JSON.parse(out) as {
      error: { code: string; detail: { practiceIds: string[] } };
    };
    expect(parsed.error.code).toBe("BP_BLOCKED");
    expect(parsed.error.detail.practiceIds).toEqual([
      "BP-IGW-001",
      "BP-S3-001",
    ]);
  });

  it("OMITS error.detail when the bag has no defined keys (stable shape for non-opt-in callers)", () => {
    const out = serializeErrorEnvelope("X", "y", "z", {});
    const parsed = JSON.parse(out) as { error: Record<string, unknown> };
    expect(parsed.error).not.toHaveProperty("detail");
  });

  it("OMITS error.detail when practiceIds is an empty array (hasDefinedKeys guard)", () => {
    const out = serializeErrorEnvelope("BP_BLOCKED", "y", undefined, {
      practiceIds: [],
    });
    const parsed = JSON.parse(out) as { error: Record<string, unknown> };
    expect(parsed.error).not.toHaveProperty("detail");
  });

  it("OMITS error.detail when all fields are undefined (hasDefinedKeys guard)", () => {
    const out = serializeErrorEnvelope("X", "y", undefined, {
      errorMessage: undefined,
      practiceIds: undefined,
    });
    const parsed = JSON.parse(out) as { error: Record<string, unknown> };
    expect(parsed.error).not.toHaveProperty("detail");
  });

  it("emits error.detail alongside hint when both are provided", () => {
    const out = serializeErrorEnvelope("APPLY_FAILED", "msg", "hint", {
      errorMessage: "concrete cause",
    });
    const parsed = JSON.parse(out) as {
      error: { hint: string; detail: { errorMessage: string } };
    };
    expect(parsed.error.hint).toBe("hint");
    expect(parsed.error.detail.errorMessage).toBe("concrete cause");
  });
});

// ─── formatPricingBreakdown — tiered line item rendering ─────────────────────

describe("formatPricingBreakdown — tiered rate display (feature-pricing-tiered-rate-display)", () => {
  /** Minimal flat-rate line item result */
  function flatItem(label: string, displayPrice: string) {
    return {
      lineItem: {
        label,
        kind: "usage_based" as const,
        description: "test",
        priceUnit: "/GB",
        quantity: 0,
        unit: "GB",
        serviceCode: "AmazonS3",
        filters: [],
      },
      unitPrice: displayPrice,
      monthlyCost: null,
      displayPrice,
    };
  }

  /** Tiered line item result (as produced by breakdown.ts when tiered path fires) */
  function tieredItem(label: string, text: string) {
    return {
      lineItem: {
        label,
        kind: "usage_based" as const,
        description: "test",
        priceUnit: "/GB",
        quantity: 0,
        unit: "GB",
        serviceCode: "AWSDataTransfer",
        filters: [],
      },
      unitPrice: "tiered",
      monthlyCost: null,
      displayPrice: `${text} (tiered)`,
      tiers: [
        {
          beginRange: 0,
          endRange: 100,
          rate: "0.0000000000",
          currency: "USD",
          unit: "GB",
        },
        { beginRange: 100, rate: "0.0900000000", currency: "USD", unit: "GB" },
      ],
    };
  }

  it("renders tiered S3 data-transfer-out line with the tier ladder string", () => {
    const breakdown: PricingBreakdown = {
      fixedItems: [],
      usageBasedItems: [
        flatItem("Storage", "$0.0230/GB-mo"),
        tieredItem(
          "Data transfer out",
          "free up to 100 GB, $0.090/GB next 10 TB",
        ),
      ],
      fixedSubtotal: 0,
      fetchedAt: "2026-05-06",
      hasPartialFailure: false,
      hasCacheHits: false,
    };

    const output = formatPricingBreakdown(breakdown);
    expect(output).toContain("Data transfer out");
    expect(output).toContain("free up to 100 GB");
    expect(output).toContain("(tiered)");
  });

  it("suppresses the ⚠ warning when all line items are resolved (no genuine failure)", () => {
    const breakdown: PricingBreakdown = {
      fixedItems: [],
      usageBasedItems: [
        flatItem("Storage", "$0.0230/GB-mo"),
        tieredItem(
          "Data transfer out",
          "free up to 100 GB, $0.090/GB next 10 TB",
        ),
      ],
      fixedSubtotal: 0,
      fetchedAt: "2026-05-06",
      hasPartialFailure: false,
      hasCacheHits: false,
    };

    const output = formatPricingBreakdown(breakdown);
    expect(output).not.toContain("⚠ Some prices unavailable");
  });

  it("emits the ⚠ warning when hasPartialFailure is true (genuine MCP failure)", () => {
    const breakdown: PricingBreakdown = {
      fixedItems: [],
      usageBasedItems: [
        flatItem("Storage", "$0.0230/GB-mo"),
        flatItem("PUT requests", "unavailable"), // genuine failure
      ],
      fixedSubtotal: 0,
      fetchedAt: "2026-05-06",
      hasPartialFailure: true,
      hasCacheHits: false,
    };

    const output = formatPricingBreakdown(breakdown);
    expect(output).toContain("⚠ Some prices unavailable");
  });

  it("wraps long tier-ladder strings onto a second indented line", () => {
    // A 4-tier string exceeds PRICE_COL_WIDTH (54 chars)
    const longTierText =
      "free up to 100 GB, $0.090/GB next 10 TB, $0.085/GB next 40 TB, …";
    const breakdown: PricingBreakdown = {
      fixedItems: [],
      usageBasedItems: [
        {
          lineItem: {
            label: "Data transfer out",
            kind: "usage_based",
            description: "",
            priceUnit: "/GB",
            quantity: 0,
            unit: "GB",
            serviceCode: "AWSDataTransfer",
            filters: [],
          },
          unitPrice: "tiered",
          monthlyCost: null,
          displayPrice: `${longTierText} (tiered)`,
          tiers: [],
        },
      ],
      fixedSubtotal: 0,
      fetchedAt: "2026-05-06",
      hasPartialFailure: false,
      hasCacheHits: false,
    };

    const output = formatPricingBreakdown(breakdown);
    const lines = output.split("\n");
    // Should span at least 2 lines for the data transfer entry
    const transferLines = lines.filter(
      (l) =>
        l.includes("Data transfer out") ||
        (l.includes("GB") && l.includes("TB") && l.includes("$")),
    );
    expect(transferLines.length).toBeGreaterThanOrEqual(2);
  });
});

// ── SX-5 / PH1-F-2: empty-row suppression in configBlock rendering ────────────
//
// Probe plan variations A-D test formatDesiredState directly (the function
// that populates the Config: block). This avoids TTY/boxen complexity while
// testing the canonical render logic. renderPlanBox is separately tested below
// for a lightweight integration path.

describe("formatDesiredState — empty-row suppression (SX-5 / PH1-F-2)", () => {
  // Variation A — VPCSecurityGroupIds: [] (empty array)
  // The row should be suppressed entirely (no blank "VPC Security Groups" line).
  it("Variation A — VPCSecurityGroupIds: [] is suppressed (no blank security group row)", () => {
    const result = formatDesiredState(
      {
        DBInstanceIdentifier: "my-rds-instance",
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        VPCSecurityGroupIds: [],
      },
      "AWS::RDS::DBInstance",
    );
    // The row "VPC Security Groups" (or any label for VPCSecurityGroupIds)
    // must NOT be present because the value renders as an empty string.
    expect(result).not.toMatch(/VPCSecurityGroupIds/i);
    expect(result).not.toMatch(/VPC Security Groups/i);
    // Other non-empty rows must still appear.
    expect(result).toContain("my-rds-instance");
    expect(result).toContain("db.t3.micro");
  });

  // Variation B — non-empty VPCSecurityGroupIds: ["sg-12345"] is preserved
  it("Variation B — VPCSecurityGroupIds: [sg-12345] is preserved (row renders normally)", () => {
    const result = formatDesiredState(
      {
        DBInstanceIdentifier: "my-rds-instance",
        DBInstanceClass: "db.t3.micro",
        Engine: "mysql",
        VPCSecurityGroupIds: ["sg-12345"],
      },
      "AWS::RDS::DBInstance",
    );
    // Row must appear with the sg- value.
    expect(result).toContain("sg-12345");
    // Other rows preserved too.
    expect(result).toContain("my-rds-instance");
  });

  // Variation C — empty string value (Comment: "")
  it("Variation C — Comment: empty string is suppressed", () => {
    const result = formatDesiredState({
      FunctionName: "my-lambda",
      Runtime: "nodejs20.x",
      Comment: "",
    });
    // Row must NOT be present because value is an empty string.
    expect(result).not.toMatch(/Comment/i);
    // Other rows preserved.
    expect(result).toContain("my-lambda");
    expect(result).toContain("nodejs20.x");
  });

  // Variation D — null / undefined value is NOT suppressed (renders as "-")
  // The null/undefined path in formatValue returns "-" (non-empty), so the row
  // should remain visible. This verifies we only suppress truly empty-string
  // renders, not missing/null values.
  it("Variation D — null value renders as dash, row is NOT suppressed", () => {
    const result = formatDesiredState({
      BucketName: "my-bucket",
      OptionalField: null,
    });
    // null → "-" which is non-empty, so the row should remain.
    // The friendly-names resolver may humanize the key (e.g. "Optional Field"),
    // so we check for the dash value rather than the raw key name.
    expect(result).toContain("-");
    expect(result).toContain("my-bucket");
    // The raw key OR its humanized variant must appear (not suppressed).
    expect(result).toMatch(/Optional\s*Field/i);
  });

  // Non-regression: an entirely empty desiredState object → "(none)"
  it("entirely empty state object → returns (none)", () => {
    const result = formatDesiredState({});
    expect(result).toBe("(none)");
  });

  // Non-regression: a state where the ONLY field is an empty array produces
  // an empty-string result (all rows suppressed, join gives "").
  it("only field is an empty array → all rows suppressed → join returns empty string", () => {
    const result = formatDesiredState({ Tags: [] });
    expect(result).toBe("");
  });
});

// ── EPIC-106-4 / PH5-4-A: underscore-prefix internal field filtering ──────────

describe("formatDesiredState — underscore-prefix field filtering (EPIC-106-4 / PH5-4-A)", () => {
  // Variation A — _VpcDefaultHint is filtered (no row rendered)
  it("Variation A — _VpcDefaultHint key is filtered from display", () => {
    const result = formatDesiredState({
      _VpcDefaultHint: "default-vpc",
      FileSystemId: "fs-12345",
    });
    expect(result).not.toContain("_VpcDefaultHint");
    expect(result).not.toContain("Vpc Default Hint");
    expect(result).not.toContain("default-vpc");
    expect(result).toContain("fs-12345");
  });

  // Variation B — generic filter: _resourceId filtered, BucketName preserved
  it("Variation B — _resourceId filtered; non-underscore BucketName row preserved", () => {
    const result = formatDesiredState({
      _resourceId: "abc123",
      BucketName: "mybucket",
    });
    expect(result).not.toContain("_resourceId");
    expect(result).not.toContain("abc123");
    expect(result).toContain("mybucket");
  });

  // Variation B (extended) — _provisionRecord also filtered
  it("Variation B (extended) — _provisionRecord is also filtered generically", () => {
    const result = formatDesiredState({
      _provisionRecord: "rec-xyz",
      EnvironmentName: "prod",
    });
    expect(result).not.toContain("_provisionRecord");
    expect(result).not.toContain("rec-xyz");
    expect(result).toContain("prod");
  });
});

// ── SX-5: renderPlanBox non-TTY integration for empty-row suppression ─────────

describe("renderPlanBox — empty-row suppression integration (SX-5)", () => {
  let captured: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;

  beforeEach(() => {
    captured = "";
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(((
      chunk: unknown,
    ) => {
      captured +=
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk as Uint8Array).toString("utf8");
      return true;
    }) as typeof process.stdout.write);
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  const baseRdsState: RenderableState = {
    resourceType: "AWS::RDS::DBInstance",
    runId: "run-sx5-a",
    desiredState: {
      DBInstanceIdentifier: "staging-db",
      DBInstanceClass: "db.t3.micro",
      Engine: "mysql",
      VPCSecurityGroupIds: [],
    },
    estimatedMonthlyCost: "~$15.00/mo",
  };

  it("plan box with VPCSecurityGroupIds: [] does not render a blank security-group row", () => {
    renderPlanBox(baseRdsState);
    // No blank VPCSecurityGroupIds row in the rendered plan box.
    expect(captured).not.toMatch(/VPC Security Groups\s*\n/);
    expect(captured).not.toMatch(/VPCSecurityGroupIds\s*\n/);
    // Other key fields still visible.
    expect(captured).toContain("staging-db");
    expect(captured).toContain("db.t3.micro");
  });

  it("plan box with VPCSecurityGroupIds: [sg-abc] renders the row normally", () => {
    renderPlanBox({
      ...baseRdsState,
      runId: "run-sx5-b",
      desiredState: {
        ...baseRdsState.desiredState,
        VPCSecurityGroupIds: ["sg-abc123"],
      },
    });
    expect(captured).toContain("sg-abc123");
  });
});

// ---------------------------------------------------------------------------
// Story 108-B-03 — renderCostBlock (non-TTY path, Axes A-K)
// ---------------------------------------------------------------------------
import { renderCostBlock } from "./display-plan.js";
import type { CostBlock } from "../graph/nodes/result-formatter/cost-block-types.js";

describe("renderCostBlock (Story 108-B-03)", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let stdoutSpy: any;
  let captured: string;

  beforeEach(() => {
    captured = "";
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .mockImplementation((chunk: any) => {
        captured += String(chunk);
        return true;
      });
    // Ensure non-TTY path (CI-safe).
    vi.spyOn(process.stdout, "isTTY", "get").mockReturnValue(
      false as unknown as true,
    );
  });

  afterEach(() => {
    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  // Axis A: standard priced resource.
  it("Axis A: priced resource emits 'Cost: Estimated: ~$X.XX/mo infra + ~N Bedrock tokens'", () => {
    const block: CostBlock = {
      infraCostMonthly: 32.85,
      bedrockTokens: 5000,
      freeTierNote: null,
      unavailable: false,
    };
    renderCostBlock(block);
    expect(captured).toContain("Cost: Estimated: ~$32.85/mo infra");
    expect(captured).toContain("Bedrock tokens to generate");
  });

  // Axis E: free-tier resource.
  it("Axis E: free-tier resource emits 'Free tier applies'", () => {
    const block: CostBlock = {
      infraCostMonthly: 0,
      bedrockTokens: 1000,
      freeTierNote: "Free tier: 750 hrs/mo",
      unavailable: false,
    };
    renderCostBlock(block);
    expect(captured).toContain("Free tier applies");
    expect(captured).toContain("Free tier: 750 hrs/mo");
  });

  // Axis G: unavailable resource.
  it("Axis G: unavailable=true emits 'Cost estimate: unavailable'", () => {
    const block: CostBlock = {
      infraCostMonthly: null,
      bedrockTokens: 0,
      freeTierNote: null,
      unavailable: true,
    };
    renderCostBlock(block);
    expect(captured).toContain("Cost estimate: unavailable");
  });

  // Axis G-2: null cost with no free-tier note → unavailable fallback.
  it("Axis G-2: null infraCostMonthly and no freeTierNote → 'Cost estimate: unavailable'", () => {
    const block: CostBlock = {
      infraCostMonthly: null,
      bedrockTokens: 500,
      freeTierNote: null,
      unavailable: false,
    };
    renderCostBlock(block);
    expect(captured).toContain("Cost estimate: unavailable");
  });

  // Axis I: no perResourceBreakdown → no breakdown section.
  it("Axis I: no perResourceBreakdown → breakdown section absent", () => {
    const block: CostBlock = {
      infraCostMonthly: 10.0,
      bedrockTokens: 200,
      freeTierNote: null,
      unavailable: false,
    };
    renderCostBlock(block);
    expect(captured).not.toContain("breakdown by resource");
  });

  // Axis J: perResourceBreakdown present → breakdown rendered.
  it("Axis J: perResourceBreakdown → breakdown entries rendered", () => {
    const block: CostBlock = {
      infraCostMonthly: 45.0,
      bedrockTokens: 3000,
      freeTierNote: null,
      unavailable: false,
      perResourceBreakdown: [
        { resourceType: "AWS::EC2::Instance", cost: "~$30.00/mo" },
        { resourceType: "AWS::RDS::DBInstance", cost: "~$15.00/mo" },
      ],
    };
    renderCostBlock(block);
    expect(captured).toContain("Cost breakdown by resource");
    expect(captured).toContain("AWS::EC2::Instance: ~$30.00/mo");
    expect(captured).toContain("AWS::RDS::DBInstance: ~$15.00/mo");
  });

  // Axis A+E combined: priced resource with free-tier note → cost line with note appended.
  it("Axis A+E: priced + freeTierNote → note appended to cost line", () => {
    const block: CostBlock = {
      infraCostMonthly: 5.0,
      bedrockTokens: 800,
      freeTierNote: "First 12 months free",
      unavailable: false,
    };
    renderCostBlock(block);
    expect(captured).toContain("~$5.00/mo infra");
    expect(captured).toContain("First 12 months free");
  });

  // Axis G: unavailable=true → freeTierNote suffix NOT appended (no misleading note).
  it("Axis G-3: unavailable=true → freeTierNote suffix NOT appended", () => {
    const block: CostBlock = {
      infraCostMonthly: null,
      bedrockTokens: 0,
      freeTierNote: "Some note",
      unavailable: true,
    };
    renderCostBlock(block);
    expect(captured).toContain("Cost estimate: unavailable");
    // The note must NOT be appended (freeTierSuffix guard: !costBlock.unavailable).
    expect(captured).not.toContain("Some note");
  });
});
