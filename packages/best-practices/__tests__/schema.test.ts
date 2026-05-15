import { describe, it, expect } from "vitest";
import { ZodError } from "zod";
import { bestPracticeSchema } from "../src/schema.js";
import { POLICY_ANTIPATTERN_NAMES } from "../src/types.js";

const validBP = {
  id: "BP-S3-001",
  title: "S3 Public Access Block not enabled",
  severity: "CRITICAL",
  resource_type: "AWS::S3::Bucket",
  property_path: "PublicAccessBlockConfiguration.BlockPublicAcls",
  check_type: "equals",
  expected_value: true,
  source: "AWS Security Hub FSBP",
  source_id: "S3.1",
  description:
    "S3 buckets should have public access blocked to prevent data exposure",
  remediation:
    "Enable all four PublicAccessBlockConfiguration settings: BlockPublicAcls, BlockPublicPolicy, IgnorePublicAcls, RestrictPublicBuckets",
  category: "security",
  lastVerified: "2026-03-22",
} as const;

describe("bestPracticeSchema", () => {
  it("validates a complete valid BP object", () => {
    const result = bestPracticeSchema.parse(validBP);
    expect(result.id).toBe("BP-S3-001");
    expect(result.severity).toBe("CRITICAL");
  });

  it("validates a valid BP with only required fields", () => {
    const minimal = {
      id: "BP-EC2-001",
      title: "EC2 test rule",
      severity: "HIGH",
      resource_type: "AWS::EC2::Instance",
      property_path: "Monitoring.Enabled",
      check_type: "equals",
      expected_value: true,
      source: "CIS Benchmark",
      category: "reliability",
      lastVerified: "2026-01-15",
    };
    const result = bestPracticeSchema.parse(minimal);
    expect(result.id).toBe("BP-EC2-001");
    expect(result.source_id).toBeUndefined();
    expect(result.description).toBeUndefined();
  });

  it("validates a BP with triggers", () => {
    const withTriggers = {
      ...validBP,
      triggers: [
        { resourceType: "AWS::S3::Bucket", always: true },
        { intentKeywords: ["s3", "bucket", "storage"] },
        {
          fieldCondition: "PublicAccessBlockConfiguration",
          patternId: "public-s3",
        },
      ],
    };
    const result = bestPracticeSchema.parse(withTriggers);
    expect(result.triggers).toHaveLength(3);
  });

  it("rejects missing required field (id)", () => {
    // Tier C: drop redundant toBeDefined() — find!() at the find site
    // and let the assertion fail naturally with a clear message if the
    // expected zod error path is missing.
    const { id: _id, ...noId } = validBP;
    expect(() => bestPracticeSchema.parse(noId)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(noId);
    } catch (err) {
      expect(err).toBeInstanceOf(ZodError);
      const zodErr = err as ZodError;
      const idError = zodErr.errors.find((e) => e.path.includes("id"))!;
      expect(idError.path).toContain("id");
    }
  });

  it('rejects invalid severity value "LOW"', () => {
    // Tier C: same pattern + assert the message in one go
    const badSeverity = { ...validBP, severity: "LOW" };
    expect(() => bestPracticeSchema.parse(badSeverity)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(badSeverity);
    } catch (err) {
      const zodErr = err as ZodError;
      const sevError = zodErr.errors.find((e) => e.path.includes("severity"))!;
      expect(sevError.message).toContain("Invalid enum value");
    }
  });

  it("rejects invalid id format (missing BP- prefix)", () => {
    // Tier C: same pattern
    const badId = { ...validBP, id: "S3-001" };
    expect(() => bestPracticeSchema.parse(badId)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(badId);
    } catch (err) {
      const zodErr = err as ZodError;
      const idError = zodErr.errors.find((e) => e.path.includes("id"))!;
      expect(idError.message).toContain("BP ID must match format");
    }
  });

  it("rejects extra unknown field in strict mode", () => {
    // Tier C: same pattern
    const withExtra = { ...validBP, unknownField: "should fail" };
    expect(() => bestPracticeSchema.parse(withExtra)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(withExtra);
    } catch (err) {
      const zodErr = err as ZodError;
      const extraError = zodErr.errors.find((e) =>
        e.message.includes("Unrecognized key"),
      )!;
      expect(extraError.message).toContain("Unrecognized key");
    }
  });

  it("rejects missing lastVerified", () => {
    const { lastVerified: _lv, ...noLastVerified } = validBP;
    expect(() => bestPracticeSchema.parse(noLastVerified)).toThrow(ZodError);
  });

  it("rejects invalid lastVerified format", () => {
    const badDate = { ...validBP, lastVerified: "03-22-2026" };
    expect(() => bestPracticeSchema.parse(badDate)).toThrow(ZodError);
  });

  it("validates blocking: true", () => {
    const withBlocking = { ...validBP, blocking: true };
    const result = bestPracticeSchema.parse(withBlocking);
    expect(result.blocking).toBe(true);
  });

  it("defaults blocking to false when not specified", () => {
    const result = bestPracticeSchema.parse(validBP);
    expect(result.blocking).toBe(false);
  });

  it("rejects non-boolean blocking value", () => {
    const badBlocking = { ...validBP, blocking: "yes" };
    expect(() => bestPracticeSchema.parse(badBlocking)).toThrow(ZodError);
  });

  // M-γ-07: enum dedup — cost_optimization removed, cost is the only cost category
  it('accepts category "cost"', () => {
    const withCost = { ...validBP, category: "cost" };
    const result = bestPracticeSchema.parse(withCost);
    expect(result.category).toBe("cost");
  });

  it('rejects deprecated category "cost_optimization"', () => {
    const withCostOpt = { ...validBP, category: "cost_optimization" };
    expect(() => bestPracticeSchema.parse(withCostOpt)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(withCostOpt);
    } catch (err) {
      const zodErr = err as ZodError;
      const catError = zodErr.errors.find((e) => e.path.includes("category"))!;
      expect(catError.message).toContain("Invalid enum value");
    }
  });

  it("accepts all canonical category values", () => {
    const categories = [
      "security",
      "cost",
      "reliability",
      "performance",
      "compliance",
    ] as const;
    for (const cat of categories) {
      const bp = { ...validBP, category: cat };
      expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
    }
  });
});

// Base fixture for policy_antipattern rules (using real BP-SQS-006 shape)
const policyAntipatternBP = {
  id: "BP-SQS-006",
  title: "SQS queue policy should not allow wildcard actions",
  severity: "HIGH",
  resource_type: "AWS::SQS::Queue",
  property_path: "QueuePolicy.PolicyDocument",
  check_type: "policy_antipattern",
  expected_value: "wildcard-action",
  source: "AWS Guard Rules Registry",
  source_id: "sqs_queuepolicy_no_wildcard_action",
  category: "security",
  lastVerified: "2026-03-22",
};

// Base fixture for nested_array_predicate rules (using real BP-ECS-004 shape)
const nestedArrayBP = {
  id: "BP-ECS-004",
  title:
    "ECS task definition should not pass secrets as plaintext environment variables",
  severity: "CRITICAL",
  resource_type: "AWS::ECS::TaskDefinition",
  property_path: "ContainerDefinitions",
  check_type: "nested_array_predicate",
  expected_value:
    "Environment[?(@.Name=~/^(password|secret|api[_-]?key|token|connection[_-]?string)$/i)] does not exist",
  source: "FSBP",
  source_id: "ECS.8",
  category: "security",
  lastVerified: "2026-04-23",
};

// Base fixture for conditional_forbidden rules (using real BP-RT-001 shape)
const conditionalForbiddenBP = {
  id: "BP-RT-001",
  title: "No public route (0.0.0.0/0 via IGW) in private route tables",
  severity: "CRITICAL",
  resource_type: "AWS::EC2::Route",
  property_path: "GatewayId",
  check_type: "conditional_forbidden",
  condition: { field: "RouteTableType", value: "private" },
  expected_value:
    "Private subnets must route 0.0.0.0/0 through NatGateway, not InternetGateway",
  source: "AWS Well-Architected Framework",
  source_id: "SEC-05",
  category: "security",
  lastVerified: "2026-03-24",
};

describe("M-γ-08: policy_antipattern expected_value grammar validation", () => {
  it("accepts a valid policy_antipattern rule with a known antipattern name", () => {
    expect(() => bestPracticeSchema.parse(policyAntipatternBP)).not.toThrow();
  });

  it("accepts all known POLICY_ANTIPATTERN_NAMES as valid expected_value", () => {
    for (const name of POLICY_ANTIPATTERN_NAMES) {
      const bp = { ...policyAntipatternBP, expected_value: name };
      expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
    }
  });

  it("rejects policy_antipattern with non-string expected_value (number)", () => {
    const bad = { ...policyAntipatternBP, expected_value: 42 };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("expected_value"),
      )!;
      expect(issue.message).toContain(
        "policy_antipattern expected_value must be a string",
      );
    }
  });

  it("rejects policy_antipattern with non-string expected_value (boolean)", () => {
    const bad = { ...policyAntipatternBP, expected_value: true };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("expected_value"),
      )!;
      expect(issue.message).toContain(
        "policy_antipattern expected_value must be a string",
      );
    }
  });

  it("rejects policy_antipattern with an unknown antipattern name string", () => {
    const bad = {
      ...policyAntipatternBP,
      expected_value: "not-a-known-antipattern",
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("expected_value"),
      )!;
      expect(issue.message).toContain("Unknown policy_antipattern name");
      // Error message lists all known values for discoverability
      expect(issue.message).toContain("wildcard-resource");
    }
  });

  it("rejects policy_antipattern with expected_value: null", () => {
    const bad = { ...policyAntipatternBP, expected_value: null };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
  });

  it("rejects policy_antipattern with expected_value: [] (array)", () => {
    const bad = {
      ...policyAntipatternBP,
      expected_value: ["wildcard-resource"],
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
  });
});

describe("M-γ-08: nested_array_predicate expected_value grammar validation", () => {
  it("accepts a valid nested_array_predicate rule (BP-ECS-004 shape)", () => {
    expect(() => bestPracticeSchema.parse(nestedArrayBP)).not.toThrow();
  });

  it("accepts a minimal valid nested_array_predicate grammar", () => {
    const bp = {
      ...nestedArrayBP,
      expected_value: "Env[?(@.Name=~/^secret$/i)] does not exist",
    };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });

  it("rejects nested_array_predicate with non-string expected_value (number)", () => {
    const bad = { ...nestedArrayBP, expected_value: 123 };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("expected_value"),
      )!;
      expect(issue.message).toContain(
        "nested_array_predicate expected_value must be a string",
      );
    }
  });

  it("rejects nested_array_predicate with a malformed grammar string (wrong suffix)", () => {
    // Missing trailing "does not exist" → grammar fails
    const bad = {
      ...nestedArrayBP,
      expected_value: "Environment[?(@.Name=~/secret/i)]",
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("expected_value"),
      )!;
      expect(issue.message).toContain("does not match required grammar");
    }
  });

  it("rejects nested_array_predicate with a malformed grammar string (missing regex delimiter)", () => {
    const bad = {
      ...nestedArrayBP,
      expected_value: "Environment[?(@.Name==secret)] does not exist",
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
  });

  it("rejects nested_array_predicate with a plain string (no grammar at all)", () => {
    const bad = { ...nestedArrayBP, expected_value: "just a string" };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
  });
});

describe("M-γ-08: condition field shape validation", () => {
  it("accepts a valid condition with field (string) and value (string)", () => {
    expect(() =>
      bestPracticeSchema.parse(conditionalForbiddenBP),
    ).not.toThrow();
  });

  it("accepts condition.value as a number", () => {
    const bp = {
      ...conditionalForbiddenBP,
      condition: { field: "MaxReceiveCount", value: 3 },
    };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });

  it("accepts condition.value as a boolean", () => {
    const bp = {
      ...conditionalForbiddenBP,
      condition: { field: "MultiAZ", value: true },
    };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });

  it("rejects condition missing the field key", () => {
    const bad = {
      ...conditionalForbiddenBP,
      condition: { wrongKey: "x", value: "private" },
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find(
        (e) => e.path.includes("condition") && e.path.includes("field"),
      )!;
      expect(issue.message).toContain("condition.field must be a string");
    }
  });

  it("rejects condition where field is not a string (number)", () => {
    const bad = {
      ...conditionalForbiddenBP,
      condition: { field: 42, value: "private" },
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find(
        (e) => e.path.includes("condition") && e.path.includes("field"),
      )!;
      expect(issue.message).toContain("condition.field must be a string");
    }
  });

  it("rejects condition where value is missing (undefined key)", () => {
    const bad = {
      ...conditionalForbiddenBP,
      condition: { field: "RouteTableType" },
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find(
        (e) => e.path.includes("condition") && e.path.includes("value"),
      )!;
      expect(issue.message).toContain(
        "condition.value must be a string, number, or boolean",
      );
    }
  });

  it("rejects condition where value is an object", () => {
    const bad = {
      ...conditionalForbiddenBP,
      condition: { field: "RouteTableType", value: { nested: "object" } },
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bad);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find(
        (e) => e.path.includes("condition") && e.path.includes("value"),
      )!;
      expect(issue.message).toContain(
        "condition.value must be a string, number, or boolean",
      );
    }
  });

  it("rejects condition where value is an array", () => {
    const bad = {
      ...conditionalForbiddenBP,
      condition: { field: "RouteTableType", value: ["private"] },
    };
    expect(() => bestPracticeSchema.parse(bad)).toThrow(ZodError);
  });

  it("accepts rules without condition (condition is optional)", () => {
    const bp = { ...validBP };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });
});

// Base fixture for skip_when_advisory guard tests (reliability, non-critical)
const reliabilityBP = {
  id: "BP-RDS-003",
  title: "RDS Multi-AZ",
  severity: "HIGH",
  resource_type: "AWS::RDS::DBInstance",
  property_path: "MultiAZ",
  check_type: "equals",
  expected_value: true,
  source: "FSBP",
  category: "reliability",
  lastVerified: "2026-03-22",
} as const;

describe("EPIC-106-6 nit: skip_when_advisory guard on compliance-critical rules", () => {
  it("accepts skip_when_advisory on a non-security, non-CRITICAL rule (reliability HIGH)", () => {
    const bp = {
      ...reliabilityBP,
      skip_when_advisory: ["RDS_ENVIRONMENT_TIER_DEFAULTS"],
    };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });

  it("rejects skip_when_advisory on a CRITICAL severity rule", () => {
    const bp = {
      ...validBP, // category: "security", severity: "CRITICAL"
      skip_when_advisory: ["SOME_ADVISOR"],
    };
    expect(() => bestPracticeSchema.parse(bp)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(bp);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("skip_when_advisory"),
      )!;
      expect(issue.message).toContain(
        "compliance-critical rules must always fire",
      );
    }
  });

  it("rejects skip_when_advisory on a security category rule (even if not CRITICAL)", () => {
    const securityHighBP = {
      ...reliabilityBP,
      id: "BP-RDS-008",
      severity: "HIGH",
      category: "security",
      skip_when_advisory: ["SOME_ADVISOR"],
    };
    expect(() => bestPracticeSchema.parse(securityHighBP)).toThrow(ZodError);
    try {
      bestPracticeSchema.parse(securityHighBP);
    } catch (err) {
      const zodErr = err as ZodError;
      const issue = zodErr.errors.find((e) =>
        e.path.includes("skip_when_advisory"),
      )!;
      expect(issue.message).toContain(
        "compliance-critical rules must always fire",
      );
    }
  });

  it("accepts skip_when_advisory: [] (empty array) on any rule — guard only fires on non-empty", () => {
    const bp = {
      ...validBP, // CRITICAL + security
      skip_when_advisory: [],
    };
    expect(() => bestPracticeSchema.parse(bp)).not.toThrow();
  });

  it("accepts skip_when_advisory absent on a security CRITICAL rule", () => {
    expect(() => bestPracticeSchema.parse(validBP)).not.toThrow();
  });
});
