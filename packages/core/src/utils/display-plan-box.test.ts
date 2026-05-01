/**
 * Tests for renderPlanBox (basic), renderError, renderApplySuccess, renderOutro,
 * renderCompoundPartialFailure, renderCompoundSuccess, and formatAppliedFixes.
 *
 * Split from display.test.ts (W19-S1). Covers: display.ts non-TTY (CI) mode
 * and renderPlanBox — with BP findings.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { BPFinding } from "@assignee/best-practices";
import { captureStream, mockState } from "./__tests__/display-test-utils.js";

describe("display.ts — non-TTY (CI) mode", () => {
  beforeEach(() => {
    // Force non-TTY mode
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Restore TTY to undefined (default in test env)
    Object.defineProperty(process.stdout, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stderr, "isTTY", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(process.stdin, "isTTY", {
      value: undefined,
      configurable: true,
    });
  });

  it("renderPlanBox writes plain text without ANSI codes", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).toContain("AWS::S3::Bucket");
    expect(output).toContain("my-test-bucket");
    expect(output).toContain("~$0.02/month");
    // Run ID is hidden unless verbose is set (Story 18.11)
    // No ANSI escape codes
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("formatAppliedFixes includes BP rule ID per fix (Item 4a)", async () => {
    const { formatAppliedFixes } = await import("./display-plan.js");
    const line = formatAppliedFixes([
      {
        practiceId: "BP-S3-006",
        title: "Server-side encryption required",
        fieldPath: "BucketEncryption",
        oldValue: undefined,
        newValue: { SSEAlgorithm: "AES256" },
      },
      {
        practiceId: "BP-S3-001",
        title: "S3 bucket should block public ACLs",
        fieldPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
        oldValue: false,
        newValue: true,
      },
    ]);
    expect(line).not.toBeNull();
    // Each line must carry the practiceId so users can grep the library
    expect(line).toContain("BP-S3-006");
    expect(line).toContain("BP-S3-001");
    // And the human-readable title for context
    expect(line).toContain("Server-side encryption required");
    expect(line).toContain("S3 bucket should block public ACLs");
    // And a value-diff arrow for each fix
    const arrows = (line!.match(/→/g) ?? []).length;
    expect(arrows).toBe(2);
    // Header shows total count
    expect(line).toContain("2 fixes applied");
  });

  it("formatAppliedFixes returns null for empty/undefined", async () => {
    const { formatAppliedFixes } = await import("./display-plan.js");
    expect(formatAppliedFixes(undefined)).toBeNull();
    expect(formatAppliedFixes([])).toBeNull();
  });

  describe("renderCompoundPartialFailure (Item 1)", () => {
    const fakePattern = {
      patternId: "vpc-networking",
      displayName: "VPC Networking",
      description: "test",
      triggerKeywords: [],
      resources: [],
      dependencyOrder: [],
    } as unknown as import("../pattern-templates/types.js").ArchitecturePattern;

    it("lists successes, failure, and not-attempted in a structured block", async () => {
      const { renderCompoundPartialFailure } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stderr);

      renderCompoundPartialFailure({
        pattern: fakePattern,
        completed: [
          {
            resourceId: "vpc",
            resourceType: "AWS::EC2::VPC",
            resourceArn: "vpc-0abc",
            executionStatus: "SUCCESS" as never,
          },
          {
            resourceId: "subnet-public-a",
            resourceType: "AWS::EC2::Subnet",
            resourceArn: "subnet-0def",
            executionStatus: "SUCCESS" as never,
          },
        ],
        failedResource: {
          resourceId: "natgw",
          resourceType: "AWS::EC2::NatGateway",
          displayName: "NAT Gateway",
          errorMessage:
            "AccessDenied: User is not authorized to perform: ec2:CreateNatGateway",
        },
        notAttempted: [
          {
            resourceId: "private-route",
            resourceType: "AWS::EC2::Route",
            displayName: "Private Route",
          },
          {
            resourceId: "subnet-rt-assoc-a",
            resourceType: "AWS::EC2::SubnetRouteTableAssociation",
            displayName: "Subnet/RT Association",
          },
        ] as never,
        runId: "run-abc-123",
      });
      restore();

      const output = chunks.join("");
      // Header + pattern name
      expect(output).toContain("VPC Networking");
      expect(output).toContain("halted at AWS::EC2::NatGateway");
      // (i) Successes
      expect(output).toContain("Successfully provisioned (2)");
      expect(output).toContain("AWS::EC2::VPC");
      expect(output).toContain("vpc-0abc");
      expect(output).toContain("subnet-0def");
      // (ii) Failure + reason
      expect(output).toContain("Failed:");
      expect(output).toContain("AWS::EC2::NatGateway");
      expect(output).toContain("ec2:CreateNatGateway");
      // (iii) Not attempted
      expect(output).toContain("Not attempted (2)");
      expect(output).toContain("Private Route");
      expect(output).toContain("Subnet/RT Association");
      // (iv) Recovery actions
      expect(output).toContain("Next steps:");
      expect(output).toContain("assignee destroy subnet-0def");
      expect(output).toContain("assignee destroy vpc-0abc");
      // Reverse-order destroy: subnet destroy line must come BEFORE vpc destroy line
      const subnetDestroyIdx = output.indexOf("assignee destroy subnet-0def");
      const vpcDestroyIdx = output.indexOf("assignee destroy vpc-0abc");
      expect(subnetDestroyIdx).toBeGreaterThan(-1);
      expect(vpcDestroyIdx).toBeGreaterThan(subnetDestroyIdx);
      // Resume command points users at `assignee apply --checkpoint <path>`
      // (the real resume flow) — NOT `assignee status <runId> --resume`,
      // which never existed on the status subcommand and used to ship as
      // a broken suggestion. See apps/cli/src/commands/apply.ts:51-54 for
      // the -c, --checkpoint <path> option that owns resumption.
      expect(output).toContain(
        "assignee apply --checkpoint .assignee/checkpoint-run-abc-123.json",
      );
      // Stronger guard: the output must NOT mention the old broken suggestion.
      // Running `assignee status <runId> --resume` hits
      // `error: unknown option '--resume'` because status has no such flag.
      expect(output).not.toContain("--resume");
      expect(output).not.toMatch(/assignee\s+status\s+\S+\s+--\S+/);
    });

    it("every 'assignee <cmd> ... --<flag>' suggestion references a real flag", async () => {
      // Regression guard for the "broken suggestion" class of bug.
      //
      // The previous revision of compound-failure.ts emitted
      //     `assignee status ${runId} --resume`
      // which looks plausible but the status command never defined --resume.
      // The original test asserted the literal string and therefore codified
      // the bug rather than catching it.
      //
      // This test scans the rendered output for every `assignee <cmd> ... --<flag>`
      // pattern and cross-checks the flag against a hardcoded known-flags map
      // seeded from each command's `.option(...)` list as of HEAD.
      //
      // If a future contributor adds a new flag-mention to any compound-failure
      // string, this test will fail loudly with "unknown flag" — prompting
      // them to either fix the string or extend the map below (after verifying
      // the flag actually exists in the matching command module).
      //
      // Cross-package imports (core → apps/cli) are disallowed by the
      // workspace layout, so the map is hardcoded and annotated with source
      // anchors instead of programmatically loaded.
      const { renderCompoundPartialFailure } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stderr);

      renderCompoundPartialFailure({
        pattern: fakePattern,
        completed: [
          {
            resourceId: "vpc",
            resourceType: "AWS::EC2::VPC",
            resourceArn: "vpc-0abc",
            executionStatus: "SUCCESS" as never,
          },
          {
            resourceId: "subnet-public-a",
            resourceType: "AWS::EC2::Subnet",
            resourceArn: "subnet-0def",
            executionStatus: "SUCCESS" as never,
          },
        ],
        failedResource: {
          resourceId: "natgw",
          resourceType: "AWS::EC2::NatGateway",
          displayName: "NAT Gateway",
          errorMessage: "AccessDenied: ec2:CreateNatGateway",
        },
        notAttempted: [
          {
            resourceId: "private-route",
            resourceType: "AWS::EC2::Route",
            displayName: "Private Route",
          },
        ] as never,
        runId: "run-flag-validator-1",
      });
      restore();

      const output = chunks.join("");

      // Known flags per subcommand — source anchors listed so a future
      // contributor knows where to verify before extending this map.
      //   apply  → apps/cli/src/commands/apply.ts:38-64
      //   status → apps/cli/src/commands/status.ts:42-56
      //   destroy takes positional ARNs, no flags used in compound-failure output
      const KNOWN_FLAGS: Record<string, ReadonlySet<string>> = {
        apply: new Set([
          "--wizard",
          "--quick",
          "--no-advice",
          "--yes",
          "-y",
          "--checkpoint",
          "-c",
          "--source",
          "-s",
          "--set",
        ]),
        status: new Set([
          "--json",
          "--region",
          "--resource-type",
          "--bp-coverage",
          "--gaps-only",
          "--include-structural-gaps",
        ]),
        destroy: new Set<string>(),
      };

      // Extract every `assignee <cmd> ... --<flag>` pair from the output.
      // The regex is greedy within a single line; we walk all matches so a
      // line with multiple flags is still covered.
      const pairRegex = /assignee\s+(\S+)(?:\s+[^\n]*?)?(\s--[\w-]+)/g;
      const pairs: Array<{ cmd: string; flag: string; line: string }> = [];
      for (const line of output.split("\n")) {
        for (const m of line.matchAll(pairRegex)) {
          pairs.push({ cmd: m[1]!, flag: m[2]!.trim(), line });
        }
      }

      // Sanity: the compound-failure renderer should emit at least one
      // flag-bearing suggestion (the --checkpoint resume line). If this
      // ever goes to 0, the fixture or the renderer stopped emitting
      // actionable commands — surface that as a test failure.
      expect(pairs.length).toBeGreaterThan(0);

      for (const { cmd, flag, line } of pairs) {
        const known = KNOWN_FLAGS[cmd];
        expect(
          known,
          `compound-failure output mentions unknown subcommand '${cmd}' in line: ${line}`,
        ).toBeDefined();
        expect(
          known!.has(flag),
          `compound-failure output suggests 'assignee ${cmd} ... ${flag}' but ${flag} is not in the known-flags map for '${cmd}'. ` +
            `Either the suggestion is broken, or the map needs updating after a new flag was added (see apps/cli/src/commands/${cmd}.ts).`,
        ).toBe(true);
      }
    });

    it("annotates composite-identifier resources with cascade note", async () => {
      const { renderCompoundPartialFailure } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stderr);

      renderCompoundPartialFailure({
        pattern: fakePattern,
        completed: [
          {
            resourceId: "rt",
            resourceType: "AWS::EC2::RouteTable",
            resourceArn: "rtb-0abc",
            executionStatus: "SUCCESS" as never,
          },
          {
            resourceId: "public-route",
            resourceType: "AWS::EC2::Route",
            // Composite identifier — destroy resolver cannot match it
            resourceArn: "rtb-0abc|0.0.0.0/0",
            executionStatus: "SUCCESS" as never,
          },
        ],
        failedResource: {
          resourceId: "natgw",
          resourceType: "AWS::EC2::NatGateway",
          errorMessage: "InsufficientInstanceCapacity",
        },
        notAttempted: [],
        runId: "run-composite-1",
      });
      restore();

      const output = chunks.join("");
      // RouteTable gets a normal destroy line
      expect(output).toContain("assignee destroy rtb-0abc");
      // But Route (composite id) gets a comment, not a destroy command
      expect(output).toMatch(
        /# AWS::EC2::Route: cascades from parent.*rtb-0abc\|0.0.0.0\/0/,
      );
      // And does NOT emit a bogus destroy command with the pipe character
      expect(output).not.toContain("assignee destroy rtb-0abc|0.0.0.0/0");
    });

    it("renders 'nothing was provisioned' when completed is empty", async () => {
      const { renderCompoundPartialFailure } = await import("./display.js");
      const { chunks, restore } = captureStream(process.stderr);

      renderCompoundPartialFailure({
        pattern: fakePattern,
        completed: [],
        failedResource: {
          resourceId: "vpc",
          resourceType: "AWS::EC2::VPC",
          errorMessage: "InvalidVpcRange: CIDR must be /16-/28",
        },
        notAttempted: [
          {
            resourceId: "subnet",
            resourceType: "AWS::EC2::Subnet",
            displayName: "Public Subnet",
          },
        ] as never,
        runId: "run-empty",
      });
      restore();

      const output = chunks.join("");
      expect(output).not.toContain("Successfully provisioned");
      expect(output).toContain("Failed:");
      expect(output).toContain("InvalidVpcRange");
      expect(output).toContain("Nothing was provisioned");
      // No destroy/resume commands when nothing landed
      expect(output).not.toContain("assignee destroy");
      expect(output).not.toContain("--resume");
      expect(output).not.toContain("--checkpoint");
    });
  });

  it("renderPlanBox includes Resource Type, Region, Config, Estimated Cost fields", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).toContain("Resource Type");
    expect(output).toContain("Region");
    expect(output).toContain("Config");
    expect(output).toContain("Estimated Cost");
  });

  it("renderPlanBox hides Run ID unless verbose is set", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox(mockState);
    restore();

    const output = chunks.join("");
    expect(output).not.toContain("Run ID");
  });

  it("renderPlanBox shows Run ID when verbose is true", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({ ...mockState, verbose: true });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Run ID");
  });

  it("renderError writes plain text without ANSI codes", async () => {
    const { renderError } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stderr);

    renderError("Something went wrong", "Check your credentials");
    restore();

    const output = chunks.join("");
    expect(output).toContain("Something went wrong");
    expect(output).toContain("Check your credentials");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it('renderError includes "Supported types" text for unsupported resource hint', async () => {
    const { renderError } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stderr);

    renderError(
      "Unsupported resource type",
      "Supported types: AWS::S3::Bucket, AWS::EC2::Instance",
    );
    restore();

    const output = chunks.join("");
    expect(output).toContain("Supported types:");
    expect(output).toContain("AWS::S3::Bucket");
  });

  it("renderApplySuccess writes ARN and RunID in plain text", async () => {
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess({
      ...mockState,
      resourceArn: "arn:aws:s3:::my-test-bucket",
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("arn:aws:s3:::my-test-bucket");
    expect(output).toContain("run-display-test-123");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  // Wave 11 P2-6 / test-arch F5: renderApplySuccess(state, displayArn?)
  // gained an explicit displayArn parameter in Wave 8 (BUG-5 / V6 P0
  // fix). Existing tests still call the legacy 1-arg form, so the new
  // explicit-takes-precedence branch was uncovered. Pin the contract:
  // when displayArn is passed, it MUST be shown instead of
  // state.resourceArn — that's how result-formatter.ts surfaces the
  // resolved full ARN while keeping state.resourceArn as the bare
  // CCAPI primary identifier (the V6 P0 invariant).
  it("renderApplySuccess prefers the explicit displayArn over state.resourceArn", async () => {
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess(
      {
        ...mockState,
        // BARE CCAPI primary identifier (the V6 P0 invariant — never mutate this)
        resourceArn: "my-test-bucket",
      },
      // Explicit full ARN passed by result-formatter.ts after STS lookup
      "arn:aws:s3:::my-test-bucket",
    );
    restore();

    const output = chunks.join("");
    // Explicit displayArn appears
    expect(output).toContain("arn:aws:s3:::my-test-bucket");
    // The bare identifier from state.resourceArn must NOT appear as the
    // ARN line — it would be misleading and the whole point of the
    // displayArn parameter is to suppress this exact case.
    expect(output).toMatch(/ARN:\s*arn:aws:s3:::my-test-bucket/);
  });

  it("renderApplySuccess falls back to state.resourceArn when displayArn is undefined", async () => {
    // The legacy 1-arg form still works (the helper is backwards
    // compatible). When STS lookup fails and result-formatter falls
    // back to passing only state, the bare identifier is what the
    // user sees.
    const { renderApplySuccess } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderApplySuccess({
      ...mockState,
      resourceArn: "fallback-bucket-name",
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("fallback-bucket-name");
  });

  it("renderOutro writes success message in plain text", async () => {
    const { renderOutro } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderOutro(true);
    restore();

    const output = chunks.join("");
    expect(output).toContain("completed successfully");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  it("renderOutro writes failure message in plain text", async () => {
    const { renderOutro } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderOutro(false);
    restore();

    const output = chunks.join("");
    expect(output).toContain("failed");
    expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
  });
});

it("renderCompoundSuccess writes all resource types and pattern name in plain text", async () => {
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        resourceId: "lambda-execution-role",
        resourceType: "AWS::IAM::Role",
        resourceArn: "arn:aws:iam::123:role/exec-role",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "lambda-fn",
        resourceType: "AWS::Lambda::Function",
        resourceArn: "arn:aws:lambda::123:function:my-fn",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "serverless-api",
      displayName: "Serverless API",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
  );
  restore();

  const output = chunks.join("");
  expect(output).toContain("Serverless API");
  expect(output).toContain("AWS::IAM::Role");
  expect(output).toContain("AWS::Lambda::Function");
  expect(output).toContain("arn:aws:iam::123:role/exec-role");
  expect(output).not.toMatch(/\x1b\[[0-9;]*m/);
});

// Wave 11 P2-6 / test-arch F6: renderCompoundSuccess gained an
// optional `displayArns` parameter (Map<resourceId, fullArn>) in
// Wave 8 so the compound apply success line shows full ARNs without
// mutating state.resourceArn (the V6 P0 invariant). Pin the contract.
it("renderCompoundSuccess prefers explicit displayArns map over each resource's bare resourceArn", async () => {
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        // BARE CCAPI identifiers (V6 P0 invariant — these are what the
        // marker resolver substitutes into child fields)
        resourceId: "vpc-1",
        resourceType: "AWS::EC2::VPC",
        resourceArn: "vpc-0123456789abcdef0",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "subnet-1",
        resourceType: "AWS::EC2::Subnet",
        resourceArn: "subnet-0123456789abcdef0",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "minimal-vpc",
      displayName: "Minimal VPC",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
    // Explicit display map keyed by resourceId — what result-formatter
    // builds after STS lookup
    {
      "vpc-1": "arn:aws:ec2:us-east-1:210987654321:vpc/vpc-0123456789abcdef0",
      "subnet-1":
        "arn:aws:ec2:us-east-1:210987654321:subnet/subnet-0123456789abcdef0",
    },
  );
  restore();

  const output = chunks.join("");
  // The full ARNs from displayArns appear, not the bare identifiers
  expect(output).toContain(
    "arn:aws:ec2:us-east-1:210987654321:vpc/vpc-0123456789abcdef0",
  );
  expect(output).toContain(
    "arn:aws:ec2:us-east-1:210987654321:subnet/subnet-0123456789abcdef0",
  );
});

it("renderCompoundSuccess falls back to resource.resourceArn when displayArns map lacks the entry", async () => {
  // Partial coverage: STS may have resolved the first resource but
  // not the second (rare, but possible when CCAPI returns mixed
  // identifier shapes). Each resource falls back independently.
  const { renderCompoundSuccess } = await import("./display.js");
  const { chunks, restore } = captureStream(process.stdout);

  renderCompoundSuccess(
    [
      {
        resourceId: "resolved",
        resourceType: "AWS::S3::Bucket",
        resourceArn: "my-bucket",
        executionStatus: "SUCCESS",
      },
      {
        resourceId: "unresolved",
        resourceType: "AWS::Lambda::Function",
        resourceArn: "my-fn-bare-fallback",
        executionStatus: "SUCCESS",
      },
    ],
    {
      patternId: "p",
      displayName: "Test",
      keywords: [],
      resourceList: [],
      dependencyOrder: [],
      defaultOptions: {},
    },
    {
      // Only `resolved` got a full ARN — `unresolved` is missing
      resolved: "arn:aws:s3:::my-bucket",
    },
  );
  restore();

  const output = chunks.join("");
  expect(output).toContain("arn:aws:s3:::my-bucket");
  // The unresolved one falls back to its bare identifier
  expect(output).toContain("my-fn-bare-fallback");
});

describe("renderPlanBox — with BP findings", () => {
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

  it("includes findings in plan box output", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      bpFindings: [
        {
          practiceId: "BP-S3-002",
          title: "S3 encryption required",
          category: "security",
          severity: "CRITICAL",
          message: "Encryption not enabled",
          blocking: false,
        },
      ] as BPFinding[],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("[CRITICAL]");
    expect(output).toContain("1 critical");
  });

  it("includes free tier note in plan box", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      freeTierNote: {
        type: "always_free",
        message: "IAM is always free",
      },
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("IAM is always free");
    expect(output).toContain("Free Tier");
  });

  it("includes memory hints in plan box", async () => {
    const { renderPlanBox } = await import("./display.js");
    const { chunks, restore } = captureStream(process.stdout);

    renderPlanBox({
      ...mockState,
      memoryHints: ["Last deployed: $0.50/mo avg"],
    });
    restore();

    const output = chunks.join("");
    expect(output).toContain("Last deployed: $0.50/mo avg");
    expect(output).toContain("Cost History");
  });
});
