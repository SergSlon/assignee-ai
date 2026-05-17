/**
 * Tests for renderSecurityWarnings, formatFindings (non-TTY), renderError (structured),
 * renderResourceTable, renderEmptyList, renderStatusSummary, renderEmptyStatus,
 * formatDesiredState, and resolveSetKey.
 *
 * Split from display.test.ts (W19-S1).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { MockInstance } from "vitest";
import type { BPFinding } from "@assignee/best-practices";

// ── Story 19.2: renderSecurityWarnings ─────────────────────────────────────

describe("renderSecurityWarnings", () => {
  let writeSpy: MockInstance;

  beforeEach(() => {
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders CRITICAL finding with red indicator", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::my-bucket", [
      {
        severity: "CRITICAL",
        title: "S3 bucket has public read access",
        recommendation: "Block public access",
        service: "SecurityHub",
        source: "mcp",
      },
    ]);

    const allOutput = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(allOutput).toContain("Security findings for arn:aws:s3:::my-bucket");
    expect(allOutput).toContain("[CRITICAL] S3 bucket has public read access");
    expect(allOutput).toContain("Block public access");
  });

  it("renders multiple findings with recommendations", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::test-bucket", [
      {
        severity: "CRITICAL",
        title: "Public access enabled",
        recommendation: "Disable public access",
        service: "SecurityHub",
        source: "mcp",
      },
      {
        severity: "HIGH",
        title: "No encryption",
        recommendation: "Enable SSE-S3",
        service: "SecurityHub",
        source: "mcp",
      },
    ]);

    const allOutput = writeSpy.mock.calls.map((c) => c[0]).join("");
    expect(allOutput).toContain("[CRITICAL] Public access enabled");
    expect(allOutput).toContain("[HIGH] No encryption");
    expect(allOutput).toContain("Disable public access");
    expect(allOutput).toContain("Enable SSE-S3");
  });

  it("does nothing when findings array is empty", async () => {
    const { renderSecurityWarnings } = await import("./display.js");

    renderSecurityWarnings("arn:aws:s3:::my-bucket", []);

    expect(writeSpy).not.toHaveBeenCalled();
  });
});

describe("renderSecurityWarnings", () => {
  it("no findings — no output", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);
    const { renderSecurityWarnings } = await import("./display.js");
    renderSecurityWarnings("arn:aws:s3:::test", []);
    expect(stdoutSpy).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it("CRITICAL + HIGH findings — shows both with icons", async () => {
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((() => true) as never);
    const { renderSecurityWarnings } = await import("./display.js");
    renderSecurityWarnings("arn:aws:s3:::test", [
      {
        severity: "CRITICAL",
        title: "Public bucket",
        recommendation: "Block public access",
        service: "s3",
        source: "mcp",
      },
      {
        severity: "HIGH",
        title: "No encryption",
        recommendation: "Enable SSE",
        service: "s3",
        source: "mcp",
      },
    ]);
    const output = stdoutSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("Public bucket");
    expect(output).toContain("No encryption");
    expect(output).toContain("Block public access");
    stdoutSpy.mockRestore();
  });
});

// ── Story 9.9: formatFindings — non-TTY ──────────────────────────────────────

describe("formatFindings — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("empty findings → 'All checks passed'", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([]);
    expect(result).toContain("PASS All checks passed");
  });

  it("undefined findings → 'All checks passed'", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings(undefined);
    expect(result).toContain("PASS All checks passed");
  });

  it("blocking finding → [BLOCK] marker in output", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        practiceId: "BP-S3-002",
        title: "S3 encryption required",
        category: "security",
        severity: "CRITICAL",
        message: "Encryption missing",
        blocking: true,
      },
    ] as BPFinding[]);
    expect(result).toContain("[BLOCK]");
    expect(result).toContain("1 blocking");
  });

  it("mixed severities → correct counts in summary", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        practiceId: "BP-S3-001",
        title: "Block public access",
        category: "security",
        severity: "CRITICAL",
        message: "Critical issue",
        blocking: false,
      },
      {
        practiceId: "BP-EC2-001",
        title: "EC2 IMDSv2",
        category: "security",
        severity: "HIGH",
        message: "High issue",
        blocking: false,
      },
      {
        practiceId: "BP-S3-006",
        title: "S3 lifecycle",
        category: "cost",
        severity: "MEDIUM",
        message: "Medium issue",
        blocking: false,
      },
      {
        practiceId: "BP-LOGS-001",
        title: "CloudWatch retention",
        category: "operations",
        severity: "INFO",
        message: "Info note",
        blocking: false,
      },
    ] as BPFinding[]);
    expect(result).toContain("1 critical");
    expect(result).toContain("1 high");
    expect(result).toContain("1 medium");
    expect(result).toContain("1 info");
    expect(result).toContain("[CRITICAL]");
    expect(result).toContain("[HIGH]");
    expect(result).toContain("[MEDIUM]");
    expect(result).toContain("[INFO]");
  });

  it("finding with remediation hint included in output", async () => {
    const { formatFindings } = await import("./display.js");
    const result = formatFindings([
      {
        practiceId: "BP-S3-001",
        title: "Block public access",
        category: "security",
        severity: "HIGH",
        message: "Public access enabled",
        remediation: "Set BlockPublicAccess to true",
        blocking: false,
      },
    ] as BPFinding[]);
    expect(result).toContain("Set BlockPublicAccess to true");
  });
});

// ── renderError — structured format ──────────────────────────────────────────

describe("renderError — structured format", () => {
  it("includes why context when provided", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    renderError("Something failed", "Check logs", { why: "Network timeout" });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[CONTEXT] Network timeout");
    expect(output).toContain("[FIX] Check logs");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  // Epic 92 u.e (D-31): when the `why` context string equals the
  // headline, the CONTEXT line is pure noise — omit it.
  it("D-31: omits [CONTEXT] when why equals the message verbatim", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    const text = "Failed to list managed resources.";
    renderError(text, "Check your AWS credentials", { why: text });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain(`[ERROR] ${text}`);
    // CONTEXT line is suppressed — otherwise it would restate the
    // headline with no new information.
    expect(output).not.toContain(`[CONTEXT] ${text}`);
    // The FIX line still renders.
    expect(output).toContain("[FIX] Check your AWS credentials");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("D-31: dedup survives leading/trailing whitespace differences", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    renderError("Something failed", undefined, {
      why: "  Something failed  ",
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[ERROR] Something failed");
    expect(output).not.toContain("[CONTEXT]");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  // Regression: different why/message still produces a [CONTEXT] line.
  it("D-31 regression: distinct why still renders [CONTEXT]", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    renderError("Outer failure", "Retry", {
      why: "Inner root cause — timeout",
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[CONTEXT] Inner root cause — timeout");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  // Story 94-R7 (D-10): header-plus-details dedup. When `context.why`
  // begins with the headline followed by a blank line and then the
  // useful details, the headline prefix is redundant and must be
  // stripped so CONTEXT renders only the new information. This is
  // the shape `list.ts` passes when the resolver throws an
  // AssigneeError whose `message` is `"<headline>\n\n<registry-grid>"`.
  it("D-10: strips redundant headline prefix from CONTEXT (header+details)", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    const headline = 'Unknown --resource-type "NOT-A-REAL-TYPE".';
    const details = "What you can create (37 resource types):\n\n  ...grid...";
    renderError(headline, "Pass a supported CFN type", {
      why: `${headline}\n\n${details}`,
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain(`[ERROR] ${headline}`);
    // CONTEXT must contain the details but NOT a second headline.
    expect(output).toContain("[CONTEXT] What you can create");
    // The literal `[CONTEXT] Unknown --resource-type` line (the
    // redundant headline repeat) must not appear.
    expect(output).not.toContain(`[CONTEXT] ${headline}`);
    expect(output).toContain("[FIX] Pass a supported CFN type");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  // D-10 regression: if `why` does NOT start with the headline, it
  // must render verbatim — the prefix-strip must not over-match.
  it("D-10 regression: unrelated why still renders in full", async () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { renderError } = await import("./display.js");
    renderError("Headline A", "fix-it", {
      why: "Completely different root cause body.",
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("[CONTEXT] Completely different root cause body.");
    writeSpy.mockRestore();
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── renderResourceTable / renderEmptyList / renderStatusSummary / renderEmptyStatus ──

describe("renderResourceTable — non-TTY", () => {
  beforeEach(() => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("renders tab-separated rows", async () => {
    const { renderResourceTable } = await import("./display.js");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    renderResourceTable([
      {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::test",
        region: "us-east-1",
        createdDate: "2024-01-01",
        estimatedMonthlyCost: "$0.02",
      },
    ]);
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    writeSpy.mockRestore();
    expect(output).toContain("AWS::S3::Bucket\t");
    expect(output).toContain("arn:aws:s3:::test");
    expect(output).toContain("us-east-1");
  });

  // bug-s3-bucket-policy-attach-failure-observability — list output
  // surfaces a warning row underneath any S3 bucket whose provision
  // record carries `compensatingPolicyAttached: false`.
  it("emits a warning row for an S3 bucket where the compensating policy attach failed", async () => {
    const { renderResourceTable } = await import("./display.js");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    renderResourceTable([
      {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::failed-policy-bucket",
        region: "us-east-1",
        createdDate: "2026-05-08",
        estimatedMonthlyCost: "$0.02",
        compensatingPolicyAttached: false,
        compensatingPolicyError: "AccessDenied: PutBucketPolicy not allowed",
      },
    ]);
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    writeSpy.mockRestore();
    expect(output).toContain("arn:aws:s3:::failed-policy-bucket");
    // Warning row must follow the main row.
    expect(output).toContain("Compensating bucket policy missing");
    expect(output).toContain("AccessDenied: PutBucketPolicy not allowed");
    expect(output).toContain("re-run `assignee setup` to retry");
    // L2 fix: pin the non-TTY-specific `WARNING:` prefix so the
    // plain-path branch of `renderPlainTable` is not silently
    // collapsed into the TTY-only chalk-yellow path. The TTY
    // branch emits the same suffix WITHOUT the `WARNING:` token,
    // so this assertion is non-trivial — a regression that
    // routed both branches through chalk-yellow would fail here.
    expect(output).toContain("WARNING: Compensating bucket policy missing");
  });

  it("does NOT emit a warning row for buckets where the compensating policy attached cleanly", async () => {
    const { renderResourceTable } = await import("./display.js");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    renderResourceTable([
      {
        resourceType: "AWS::S3::Bucket",
        arn: "arn:aws:s3:::happy-bucket",
        region: "us-east-1",
        createdDate: "2026-05-08",
        estimatedMonthlyCost: "$0.02",
        // compensatingPolicyAttached: true means the field is set but
        // happy — renderer must NOT add a warning row.
        compensatingPolicyAttached: true,
      },
    ]);
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    writeSpy.mockRestore();
    expect(output).toContain("arn:aws:s3:::happy-bucket");
    expect(output).not.toContain("Compensating bucket policy missing");
  });

  it("does NOT emit a warning row for non-S3 / pre-bug rows where the field is undefined", async () => {
    const { renderResourceTable } = await import("./display.js");
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    renderResourceTable([
      {
        resourceType: "AWS::Lambda::Function",
        arn: "arn:aws:lambda:us-east-1:112233445566:function:fn",
        region: "us-east-1",
        createdDate: "2026-05-08",
        estimatedMonthlyCost: "$0.20/mo",
        // compensatingPolicyAttached intentionally omitted.
      },
    ]);
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    writeSpy.mockRestore();
    expect(output).not.toContain("Compensating bucket policy missing");
  });
});

describe("renderEmptyList — non-TTY", () => {
  it("renders hint message", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderEmptyList } = await import("./display.js");
    renderEmptyList();
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("No resources managed");
    expect(output).toContain("assignee apply");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderStatusSummary — non-TTY", () => {
  it("renders plain text summary", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderStatusSummary } = await import("./display.js");
    renderStatusSummary({
      totalResources: 3,
      totalEstimatedMonthlyCost: "$5.00",
      byType: [
        { type: "AWS::S3::Bucket", count: 2, estimatedMonthlyCost: "$1.00" },
      ],
      byRegion: [
        { region: "us-east-1", count: 3, estimatedMonthlyCost: "$5.00" },
      ],
      lastUpdated: new Date().toISOString(),
    });
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("Total Resources: 3");
    expect(output).toContain("AWS::S3::Bucket");
    expect(output).toContain("us-east-1");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

describe("renderEmptyStatus — non-TTY", () => {
  it("renders hint message", async () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    const writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const { renderEmptyStatus } = await import("./display.js");
    renderEmptyStatus();
    const output = writeSpy.mock.calls.map((c) => String(c[0])).join("");
    expect(output).toContain("No resources managed");
    // Story 108-A-05: path is now noun-grouped `assignee infra plan`.
    expect(output).toContain("assignee infra plan");
    writeSpy.mockRestore();
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });
});

// ── Story 18.11: formatDesiredState tests ─────────────────────────────────────

describe("formatDesiredState", () => {
  let formatDesiredState: typeof import("./display.js").formatDesiredState;

  beforeEach(async () => {
    const display = await import("./display.js");
    formatDesiredState = display.formatDesiredState;
  });

  it("maps known keys to friendly names", () => {
    const result = formatDesiredState({ InstanceType: "t3.micro" });
    expect(result).toContain("Instance Type");
    expect(result).toContain("t3.micro");
  });

  it("falls back to spaced PascalCase for unknown keys", () => {
    const result = formatDesiredState({ SomeCustomProperty: "my-value" });
    expect(result).toContain("Some Custom Property");
    expect(result).toContain("my-value");
  });

  it("renders booleans as Yes/No", () => {
    const result = formatDesiredState({ MultiAZ: true });
    expect(result).toContain("Yes");
  });

  it("renders false booleans as No", () => {
    const result = formatDesiredState({ MultiAZ: false });
    expect(result).toContain("No");
  });

  it("joins arrays with commas", () => {
    const result = formatDesiredState({
      SecurityGroupIds: ["sg-123", "sg-456"],
    });
    expect(result).toContain("sg-123, sg-456");
  });

  it("renders Tag arrays as Key:Value pairs", () => {
    const result = formatDesiredState({
      Tags: [
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ],
    });
    expect(result).toContain("env:prod, team:backend");
  });

  it("returns (none) for empty state", () => {
    const result = formatDesiredState({});
    expect(result).toBe("(none)");
  });

  it("handles nested objects — S3 encryption shows friendly format", () => {
    const result = formatDesiredState({
      BucketEncryption: {
        ServerSideEncryptionConfiguration: "AES256",
      },
    });
    expect(result).toContain("AES-256 (SSE-S3) enabled");
  });
});

// ── P0-1 regression: resource-type-scoped label resolution ───────────────────
//
// Bug: FRIENDLY_NAMES was a flat Record<string, string>, so
// `[CfnKey.TYPE]: "Load Balancer Type"` (intended for ELBv2) was applied to
// EVERY resource whose CFN schema has a top-level `Type` property — SSM
// Parameter, CloudWatch Alarm, DynamoDB (free-form) — producing "Load Balancer
// Type   String" in SSM plans. Fix: per-resource overrides via
// FRIENDLY_NAMES_BY_TYPE + resourceType arg to formatDesiredState.
describe("formatDesiredState — per-resource-type label resolution (P0-1)", () => {
  let formatDesiredState: typeof import("./display.js").formatDesiredState;
  let RESOURCE_TYPES: typeof import("../config/resource-types/named.js").RESOURCE_TYPES;

  beforeEach(async () => {
    const display = await import("./display.js");
    formatDesiredState = display.formatDesiredState;
    const core = await import("../config/resource-types/named.js");
    RESOURCE_TYPES = core.RESOURCE_TYPES;
  });

  it("SSM Parameter: Type renders as 'Parameter Type', not 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::SSM::Parameter
    const result = formatDesiredState(
      {
        Name: "/my-app/config/db-host",
        Type: "String",
        Value: "db.example.com",
        Description: "Database host",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("String");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("SSM Parameter: SecureString Type renders as 'Parameter Type'", () => {
    const result = formatDesiredState(
      {
        Name: "/prod/db/password",
        Type: "SecureString",
        Value: "s3cr3t",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("SecureString");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("SSM Parameter: StringList Type renders as 'Parameter Type'", () => {
    const result = formatDesiredState(
      {
        Name: "/app/allowed-origins",
        Type: "StringList",
        Value: "https://a.com,https://b.com",
      },
      RESOURCE_TYPES.SSM_PARAMETER,
    );
    expect(result).toContain("Parameter Type");
    expect(result).toContain("StringList");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("ELBv2 LoadBalancer: Type renders as 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::ElasticLoadBalancingV2::LoadBalancer
    const result = formatDesiredState(
      {
        Name: "my-alb",
        Type: "application",
        Scheme: "internet-facing",
        Subnets: ["subnet-abc", "subnet-def"],
      },
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(result).toContain("Load Balancer Type");
    expect(result).toContain("application");
  });

  it("ELBv2 LoadBalancer: network type renders as 'Load Balancer Type'", () => {
    const result = formatDesiredState(
      {
        Name: "my-nlb",
        Type: "network",
        Scheme: "internal",
      },
      RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    );
    expect(result).toContain("Load Balancer Type");
    expect(result).toContain("network");
  });

  it("DynamoDB Table: KeySchema renders without 'Load Balancer Type' for nested KeyType", () => {
    // Real CFN shape for AWS::DynamoDB::Table — KeySchema is nested, the
    // nested KeyType field must NOT be relabeled globally.
    const result = formatDesiredState(
      {
        TableName: "my-table",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
      },
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    expect(result).toContain("Table Name");
    expect(result).toContain("my-table");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("DynamoDB Table: free-form top-level Type never leaks 'Load Balancer Type'", () => {
    // Defensive — if anything ever places a top-level Type on DynamoDB, we
    // must NOT reuse the ELBv2 label.
    const result = formatDesiredState(
      {
        TableName: "my-table",
        Type: "GlobalTable",
      },
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("GlobalTable");
  });

  it("CloudWatch Alarm: top-level Type renders as 'Alarm Type', not 'Load Balancer Type'", () => {
    // Real CFN shape for AWS::CloudWatch::Alarm (plus synthetic Type field —
    // some composite alarm forms surface Type, and we must never mislabel it)
    const result = formatDesiredState(
      {
        AlarmName: "high-cpu",
        MetricName: "CPUUtilization",
        Namespace: "AWS/EC2",
        Type: "MetricAlarm",
        Threshold: 80,
        ComparisonOperator: "GreaterThanThreshold",
      },
      RESOURCE_TYPES.CLOUDWATCH_ALARM,
    );
    expect(result).toContain("Alarm Type");
    expect(result).toContain("MetricAlarm");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("ELBv2 TargetGroup: no plugin override defined — Type falls back to spacePascalCase, NOT 'Load Balancer Type'", () => {
    // AWS::ElasticLoadBalancingV2::TargetGroup has no plugin yet, but may be
    // surfaced via generic plan rendering. The fix removes the global
    // [CfnKey.TYPE] entry so unknown resource types fall back safely.
    const result = formatDesiredState(
      {
        Name: "my-tg",
        Port: 443,
        Protocol: "HTTPS",
        TargetType: "instance",
        VpcId: "vpc-abc",
      },
      "AWS::ElasticLoadBalancingV2::TargetGroup",
    );
    // Port/Protocol/VpcId still resolve via the global map
    expect(result).toContain("VPC");
    // TargetType is not in the global map — falls back to spacePascalCase
    expect(result).toContain("Target Type");
    expect(result).toContain("instance");
    expect(result).not.toContain("Load Balancer Type");
  });

  it("unknown resource type: top-level Type falls back to spacePascalCase, never 'Load Balancer Type'", () => {
    // Defensive fallback — passing an unknown resourceType must never resurface the old bug.
    const result = formatDesiredState(
      { Type: "SomeValue", Name: "x" },
      "AWS::Some::NewResource",
    );
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("SomeValue");
  });

  it("no resource type passed: preserves legacy behavior for global-only labels", () => {
    // Backward compatibility — callers that don't pass a resourceType still
    // get sensible labels for unambiguous fields.
    const result = formatDesiredState({
      InstanceType: "t3.micro",
      BucketName: "my-bucket",
    });
    expect(result).toContain("Instance Type");
    expect(result).toContain("Bucket Name");
  });

  it("no resource type passed: top-level Type no longer mislabels as 'Load Balancer Type'", () => {
    // This is the raw reproduction from the bug report — no resourceType
    // supplied, just a desiredState with a Type field. It must fall back to
    // spacePascalCase, never the old ELBv2 label.
    const result = formatDesiredState({ Name: "/test", Type: "String" });
    expect(result).not.toContain("Load Balancer Type");
    expect(result).toContain("Type");
    expect(result).toContain("String");
  });
});

// ── resolveSetKey ─────────────────────────────────────────────────────────────

describe("resolveSetKey", () => {
  it("resolves human alias 'size' to InstanceType", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("size")).toBe("InstanceType");
  });

  it("resolves human alias 'memory' to MemorySize", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("memory")).toBe("MemorySize");
  });

  it("resolves friendly name 'Instance Type' case-insensitively", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("instance type")).toBe("InstanceType");
  });

  it("passes through PascalCase CfnKeys unchanged", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("BucketName")).toBe("BucketName");
  });

  it("returns unknown keys unchanged", async () => {
    const { resolveSetKey } = await import("./display.js");
    expect(resolveSetKey("unknownField")).toBe("unknownField");
  });
});
