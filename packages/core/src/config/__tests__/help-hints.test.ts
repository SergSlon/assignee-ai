import { describe, it, expect } from "vitest";
import {
  BEGINNER_EXAMPLE_TYPES,
  HINT_MAX_COLUMNS,
  buildSupportedTypesBlock,
  getCompoundPatterns,
  getPatternCount,
  getSupportedResourceTypes,
  getSupportedTypeCount,
  getTypeHint,
  renderClarifierExampleList,
  renderPatternsHint,
  renderSupportedTypesHint,
} from "../help-hints.js";
import { UnsupportedResourceError } from "../../errors.js";
import { SUPPORTED_TYPES_ARRAY } from "../resource-types/supported.js";
import { defaultPatternRegistry } from "../../pattern-templates/index.js";

describe("help-hints — registry-derivation (drift guards)", () => {
  it("getSupportedTypeCount matches SUPPORTED_TYPES_ARRAY.length", () => {
    expect(getSupportedTypeCount()).toBe(SUPPORTED_TYPES_ARRAY.length);
    // e98.W5.N5 (B-03): AWS::EC2::EIP promoted to first-class → 38.
    expect(getSupportedTypeCount()).toBe(38);
  });

  it("getPatternCount matches defaultPatternRegistry.size()", () => {
    expect(getPatternCount()).toBe(defaultPatternRegistry.size());
    // Epic 92 wave 2.b: added `websocket-api` pattern → 11 total.
    expect(getPatternCount()).toBe(11);
  });

  it("getSupportedResourceTypes returns the registry contents verbatim", () => {
    expect(getSupportedResourceTypes()).toStrictEqual(SUPPORTED_TYPES_ARRAY);
  });

  it("getCompoundPatterns mirrors defaultPatternRegistry.list() shape", () => {
    const registered = defaultPatternRegistry.list();
    const exposed = getCompoundPatterns();

    expect(exposed).toHaveLength(registered.length);
    for (let i = 0; i < registered.length; i += 1) {
      expect(exposed[i]).toEqual({
        patternId: registered[i]!.patternId,
        displayName: registered[i]!.displayName,
        resourceCount: registered[i]!.resourceList.length,
      });
    }
  });
});

describe("renderSupportedTypesHint — CLI style", () => {
  const hint = renderSupportedTypesHint("cli");

  it("opens with the registry-derived count", () => {
    expect(hint).toContain(
      `What you can create (${getSupportedTypeCount()} resource types):`,
    );
  });

  it("includes every domain group header", () => {
    for (const group of [
      "Compute",
      "Storage",
      "Databases",
      "Networking",
      "Edge / CDN",
      "API",
      "Messaging",
      "Security",
      "Containers",
      "Observability",
    ]) {
      expect(hint).toContain(group);
    }
  });

  it("does NOT embed an Examples: block (Epic 96 B4/B5)", () => {
    // The CLI-style hint is composed alongside per-command
    // `addHelpText` wrappers that carry command-specific examples.
    // Embedding an `Examples:` header here caused `plan --help` and
    // `apply --help` to render two Examples sections (shipped-wired
    // contract E tripwire, probes e96.W1.B4/B5).
    expect(hint).not.toContain("Examples:");
  });

  it("every line fits within HINT_MAX_COLUMNS columns", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });
});

describe("renderSupportedTypesHint — short style", () => {
  const hint = renderSupportedTypesHint("short");

  it("opens with the registry-derived count", () => {
    expect(hint).toContain(
      `What you can create (${getSupportedTypeCount()} resource types):`,
    );
  });

  it("stays within HINT_MAX_COLUMNS per line", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });

  // Epic 96 Wave 2 R3 (D-03): the short variant used to hand-maintain
  // its own grid that drifted behind the registry. Now it delegates to
  // `buildSupportedTypesBlock()` so the CLI --help surface and the
  // intent-parser errorMessage surface can never disagree.
  it("delegates to buildSupportedTypesBlock (D-03 drift guard)", () => {
    expect(renderSupportedTypesHint("short")).toBe(buildSupportedTypesBlock());
  });

  it("includes every domain group header (parity with cli)", () => {
    for (const group of [
      "Compute",
      "Storage",
      "Databases",
      "Networking",
      "Edge / CDN",
      "API",
      "Messaging",
      "Security",
      "Containers",
      "Observability",
    ]) {
      expect(hint).toContain(group);
    }
  });
});

describe("renderSupportedTypesHint — MCP style", () => {
  const hint = renderSupportedTypesHint("mcp");

  it("is a single line", () => {
    expect(hint).not.toContain("\n");
  });

  it("mentions the registry-derived count", () => {
    expect(hint).toContain(`Supported types (${getSupportedTypeCount()})`);
  });

  it("points the reader at `assignee plan --help`", () => {
    expect(hint).toContain("assignee plan --help");
  });
});

describe("renderPatternsHint — CLI style", () => {
  const hint = renderPatternsHint("cli");

  it("opens with the registry-derived pattern count", () => {
    expect(hint).toContain(
      `Architecture patterns (${getPatternCount()} compound,`,
    );
  });

  it("mentions every registered pattern by displayName", () => {
    for (const p of defaultPatternRegistry.list()) {
      expect(hint.toLowerCase()).toContain(p.displayName.toLowerCase());
    }
  });

  it("every line fits within HINT_MAX_COLUMNS columns", () => {
    for (const line of hint.split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });
});

describe("renderPatternsHint — short / mcp style", () => {
  it("short style lists every patternId", () => {
    const hint = renderPatternsHint("short");
    expect(hint).toContain(`Compound patterns (${getPatternCount()}):`);
    for (const p of defaultPatternRegistry.list()) {
      expect(hint).toContain(p.patternId);
    }
  });

  it("mcp style is identical to short (compact surfaces share it)", () => {
    expect(renderPatternsHint("mcp")).toBe(renderPatternsHint("short"));
  });
});

// Drift guard — the most important test in the module. Closes the
// L6-test-review coverage gap for L3-H2: every registered type must be
// represented in the rendered hint so the grouped layout cannot fall
// behind the SUPPORTED_TYPES_ARRAY registry silently.
describe("drift guard — registry coverage", () => {
  it("every supported type is mentioned in the CLI hint (or its family alias)", () => {
    const hint = renderSupportedTypesHint("cli").toLowerCase();

    // Map each CFN type to the family alias shown in the grouped hint.
    // If a type changes its alias here, either the hint or this map
    // needs updating.
    const cfnToAlias: Record<string, string> = {
      "AWS::S3::Bucket": "s3 bucket",
      "AWS::S3::BucketPolicy": "s3 bucket policy",
      "AWS::SSM::Parameter": "ssm parameter",
      "AWS::IAM::Role": "iam role",
      "AWS::EC2::Instance": "ec2 instance",
      "AWS::RDS::DBInstance": "rds db instance",
      "AWS::Lambda::Function": "lambda function",
      "AWS::EC2::VPC": "vpc",
      "AWS::EC2::Subnet": "subnet",
      "AWS::EC2::SecurityGroup": "security group",
      "AWS::DynamoDB::Table": "dynamodb table",
      "AWS::SQS::Queue": "sqs queue",
      "AWS::SNS::Topic": "sns topic",
      "AWS::ElasticLoadBalancingV2::LoadBalancer": "load balancer",
      "AWS::ECS::Cluster": "ecs cluster",
      "AWS::ECR::Repository": "ecr repository",
      "AWS::Logs::LogGroup": "cloudwatch logs",
      "AWS::EC2::InternetGateway": "internet gateway",
      "AWS::EC2::RouteTable": "route table",
      "AWS::EC2::Route": "route",
      "AWS::EC2::NatGateway": "nat gateway",
      "AWS::ApiGatewayV2::Api": "api gateway v2",
      "AWS::CloudWatch::Alarm": "cloudwatch alarm",
      "AWS::SecretsManager::Secret": "secrets manager",
      "AWS::EC2::VPCGatewayAttachment": "vpc gateway attachment",
      "AWS::EC2::SubnetRouteTableAssociation": "route table association",
      "AWS::EFS::FileSystem": "efs file system",
      "AWS::EFS::MountTarget": "efs mount target",
      "AWS::Events::Rule": "eventbridge rule",
      "AWS::Events::EventBus": "eventbridge event bus",
      "AWS::SNS::Subscription": "sns subscription",
      "AWS::KMS::Key": "kms key",
      "AWS::Events::Connection": "eventbridge connection",
      "AWS::Events::ApiDestination": "eventbridge api destination",
      "AWS::CloudFront::Distribution": "cloudfront distribution",
      "AWS::CloudFront::OriginAccessControl": "cloudfront oac",
      "AWS::RDS::DBSubnetGroup": "rds db subnet group",
      // e98.W5.N5 (B-03): EIP promoted to first-class.
      "AWS::EC2::EIP": "elastic ip",
    };

    // Every SUPPORTED_TYPES_ARRAY entry must have an alias in the map
    // (so adding a new type without updating the hint fails here).
    for (const t of SUPPORTED_TYPES_ARRAY) {
      expect(cfnToAlias[t], `missing alias for ${t}`).toBeDefined();
      expect(hint, `hint missing entry for ${t}`).toContain(cfnToAlias[t]!);
    }
  });

  it("every registered pattern appears in the CLI patterns hint", () => {
    const hint = renderPatternsHint("cli").toLowerCase();
    for (const p of defaultPatternRegistry.list()) {
      expect(hint, `patterns hint missing ${p.patternId}`).toContain(
        p.displayName.toLowerCase(),
      );
    }
  });
});

// Story 56-it2-04 L3-L3 — curated beginner example list shared between
// the CLI clarifier and any future UX surface that needs a friendly
// "name a resource type" nudge.
describe("BEGINNER_EXAMPLE_TYPES + renderClarifierExampleList", () => {
  // Map each curated example label to the CFN type it implies, so we
  // can assert every example corresponds to a real supported type.
  // Kept here (not in the module under test) so adding a label forces
  // the author to also claim which CFN type it represents.
  const labelToCfn: Record<string, string> = {
    "S3 bucket": "AWS::S3::Bucket",
    "Lambda function": "AWS::Lambda::Function",
    "DynamoDB table": "AWS::DynamoDB::Table",
  };

  it("BEGINNER_EXAMPLE_TYPES is a non-empty frozen array", () => {
    expect(Array.isArray(BEGINNER_EXAMPLE_TYPES)).toBe(true);
    expect(BEGINNER_EXAMPLE_TYPES.length).toBeGreaterThan(0);
    expect(Object.isFrozen(BEGINNER_EXAMPLE_TYPES)).toBe(true);
  });

  it("every curated label maps to an entry in SUPPORTED_TYPES_ARRAY (drift guard)", () => {
    for (const label of BEGINNER_EXAMPLE_TYPES) {
      const cfn = labelToCfn[label];
      expect(
        cfn,
        `curated beginner label "${label}" has no known CFN mapping in the test`,
      ).toBeDefined();
      expect(
        SUPPORTED_TYPES_ARRAY,
        `label "${label}" → ${cfn} must exist in SUPPORTED_TYPES_ARRAY`,
      ).toContain(cfn);
    }
  });

  // Story 62-it1-02 / L3-001 MED: complementary token-based drift guard.
  // The labelToCfn map above is curator-maintained; this test is map-free
  // and instead derives the canonical service token from the first word of
  // each curated label ("S3 bucket" → "S3", "Lambda function" → "Lambda",
  // "DynamoDB table" → "DynamoDB") and asserts at least one entry in
  // SUPPORTED_TYPES_ARRAY contains that token. This catches the case where
  // a registry rename leaves an example pointing at a service that no
  // longer exists, even if the curator forgets to update the labelToCfn
  // map in the test file.
  it("every curated label's service token appears in SUPPORTED_TYPES_ARRAY (token drift guard)", () => {
    for (const label of BEGINNER_EXAMPLE_TYPES) {
      const token = label.split(/\s+/)[0];
      expect(
        token,
        `curated beginner label "${label}" yielded an empty service token`,
      ).toBeTruthy();
      const matches = SUPPORTED_TYPES_ARRAY.filter((t) => t.includes(token!));
      expect(
        matches.length,
        `service token "${token}" (from label "${label}") must match at least one SUPPORTED_TYPES_ARRAY entry — registry rename suspected`,
      ).toBeGreaterThan(0);
    }
  });

  it("renderClarifierExampleList joins the labels with commas and an etc. suffix", () => {
    const rendered = renderClarifierExampleList();
    expect(rendered.endsWith(", etc.")).toBe(true);
    for (const label of BEGINNER_EXAMPLE_TYPES) {
      expect(rendered).toContain(label);
    }
    // Exact canonical shape for the current 3-entry curation.
    expect(rendered).toBe("S3 bucket, Lambda function, DynamoDB table, etc.");
  });

  // Epic 65-it1-01 (L3-L1 LOW): defensive guard for the degenerate case
  // where the curated beginner-example list is empty. Without the guard,
  // `[].join(", ")` yields "" and the suffix produces the visually broken
  // fragment ", etc." — this test documents that we now return "" instead.
  //
  // `BEGINNER_EXAMPLE_TYPES` is frozen so we can't mutate the real export.
  // The function accepts an optional `examples` parameter (default is the
  // frozen curated list) specifically so this guard is directly testable
  // without module-reimport gymnastics.
  it("renderClarifierExampleList returns '' when examples list is empty (Epic 65-it1-01 L3-L1)", () => {
    // Passing `[]` exercises the freeze-bypass path — it does NOT mutate
    // BEGINNER_EXAMPLE_TYPES, so the default-arg behaviour for every other
    // caller is unchanged.
    expect(renderClarifierExampleList([])).toBe("");
  });

  it("renderClarifierExampleList still renders correctly with a non-empty custom list (guard regression)", () => {
    // Sanity check that the injectable parameter preserves the normal
    // rendering when the list is non-empty — the guard only short-circuits
    // on empty input.
    expect(renderClarifierExampleList(["EC2 instance", "VPC"])).toBe(
      "EC2 instance, VPC, etc.",
    );
  });
});

// Story e92-3a (Epic 92 wave 3.a) — Supported-types block SSO API.
describe("buildSupportedTypesBlock + getTypeHint (Epic 92 wave 3.a)", () => {
  it("buildSupportedTypesBlock returns the CLI-style grouped grid", () => {
    const block = buildSupportedTypesBlock();
    expect(block).toContain(
      `What you can create (${SUPPORTED_TYPES_ARRAY.length} resource types):`,
    );
    for (const group of [
      "Compute",
      "Storage",
      "Databases",
      "Networking",
      "Edge / CDN",
      "API",
      "Messaging",
      "Security",
      "Containers",
      "Observability",
    ]) {
      expect(block).toContain(group);
    }
    // Epic 96 Wave 1 B4/B5: the shared block intentionally does NOT
    // emit its own `Examples:` heading — the per-command help wrappers
    // carry command-specific examples, and embedding one here caused
    // `plan --help` / `apply --help` to render two Examples blocks
    // (shipped-wired-contract E tripwire).
    expect(block).not.toContain("Examples:");
  });

  it("buildSupportedTypesBlock output equals renderSupportedTypesHint('cli') (SSO invariant)", () => {
    expect(buildSupportedTypesBlock()).toBe(renderSupportedTypesHint("cli"));
  });

  it("buildSupportedTypesBlock every line fits within HINT_MAX_COLUMNS", () => {
    for (const line of buildSupportedTypesBlock().split("\n")) {
      expect(line.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
    }
  });

  it("getTypeHint returns a single-line, compact breadcrumb", () => {
    const hint = getTypeHint();
    expect(hint).not.toContain("\n");
    expect(hint).toContain("assignee plan --help");
    expect(hint.length).toBeLessThanOrEqual(HINT_MAX_COLUMNS);
  });

  it("getTypeHint does NOT contain the full grouped grid (D-33 guarantee)", () => {
    const hint = getTypeHint();
    expect(hint).not.toContain("Compute");
    expect(hint).not.toContain("Networking");
    expect(hint).not.toContain("What you can create (");
  });
});

describe("UnsupportedResourceError — SSO message (Epic 92 wave 3.a / D-32)", () => {
  it("uses getTypeHint() breadcrumb, not the full grouped grid", () => {
    const err = new UnsupportedResourceError("AWS::DynamoDB::GlobalTable");
    expect(err.message).toContain("AWS::DynamoDB::GlobalTable");
    expect(err.message).toContain(getTypeHint());
    expect(err.message).not.toContain("What you can create (");
    expect(err.message).not.toContain("Compute       EC2");
    expect(err.message).not.toContain("Networking    VPC");
  });

  it("code field is UNSUPPORTED_RESOURCE (machine-readable stability)", () => {
    const err = new UnsupportedResourceError("AWS::DoesNotExist::Type");
    expect(err.code).toBe("UNSUPPORTED_RESOURCE");
    expect(err.name).toBe("UnsupportedResourceError");
  });

  it("drift guard: getTypeHint does not embed a count", () => {
    const hint = getTypeHint();
    expect(hint).not.toMatch(/\(\d+ resource types\)/);
  });
});
