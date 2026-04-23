import { describe, it, expect } from "vitest";
import { evaluateTriggers, loadBestPractices } from "../src/index.js";
import type { EvalContext } from "../src/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_ROOT = join(__dirname, "..");
const allPractices = loadBestPractices(BP_ROOT);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ctx(
  resourceType: string,
  desiredState: Record<string, unknown>,
): EvalContext {
  return { resourceType, desiredState };
}

function findingsFor(
  ruleId: string,
  resourceType: string,
  desiredState: Record<string, unknown>,
) {
  const practices = allPractices.filter((bp) => bp.id === ruleId);
  expect(practices.length).toBeGreaterThanOrEqual(1);
  return evaluateTriggers(ctx(resourceType, desiredState), practices);
}

/** Set a deeply-nested value given a dot+bracket path. */
function setNested(
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const segments = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const bracketMatch = seg.match(/^([^[]+)\[(\d+)\]$/);
    if (bracketMatch) {
      const [, field, idx] = bracketMatch;
      if (!current[field!]) current[field!] = [];
      const arr = current[field!] as unknown[];
      const index = parseInt(idx!, 10);
      if (!arr[index]) arr[index] = {};
      current = arr[index] as Record<string, unknown>;
    } else {
      if (!current[seg]) current[seg] = {};
      current = current[seg] as Record<string, unknown>;
    }
  }
  const lastSeg = segments[segments.length - 1]!;
  const lastBracket = lastSeg.match(/^([^[]+)\[(\d+)\]$/);
  if (lastBracket) {
    const [, field, idx] = lastBracket;
    if (!current[field!]) current[field!] = [];
    (current[field!] as unknown[])[parseInt(idx!, 10)] = value;
  } else {
    current[lastSeg] = value;
  }
}

/**
 * Build a desiredState where a path is set to the given value.
 * Handles dot-notation and bracket-notation paths.
 */
function stateWith(path: string, value: unknown): Record<string, unknown> {
  const obj: Record<string, unknown> = {};
  setNested(obj, path, value);
  return obj;
}

// ---------------------------------------------------------------------------
// Types for data-driven test specs
// ---------------------------------------------------------------------------

type CheckType =
  | "equals"
  | "not_equals"
  | "exists"
  | "not_exists"
  | "greater_than"
  | "less_than"
  | "contains"
  | "not_contains"
  | "not_contains_pattern"
  | "conditional_forbidden"
  | "awareness"
  | "cross_resource_count"
  | "cross_resource_reference"
  | "policy_antipattern"
  | "sg_high_risk_public_exposure"
  | "nested_array_predicate";

interface RuleSpec {
  id: string;
  resourceType: string;
  propertyPath: string;
  checkType: CheckType;
  expectedValue: unknown;
}

const ALWAYS_FIRE_TYPES: CheckType[] = [
  "awareness",
  "cross_resource_count",
  "cross_resource_reference",
];

// ---------------------------------------------------------------------------
// Generate "fires" and "does NOT fire" desiredState for each check type
// ---------------------------------------------------------------------------

function firingState(spec: RuleSpec): Record<string, unknown> {
  switch (spec.checkType) {
    case "equals":
      // Field not equal to expected → fires
      if (spec.expectedValue === true)
        return stateWith(spec.propertyPath, false);
      if (spec.expectedValue === false)
        return stateWith(spec.propertyPath, true);
      if (typeof spec.expectedValue === "number")
        return stateWith(spec.propertyPath, spec.expectedValue + 999);
      if (typeof spec.expectedValue === "string")
        return stateWith(spec.propertyPath, "__WRONG__");
      return {}; // missing field also fires

    case "not_equals": {
      // Epic 94 R4 (B-02): SG ingress rules use the `"<cidr>:<port>"`
      // grammar (BP-SG-002, BP-SG-005). Rule-runner now parses that
      // grammar and inspects the ingress ARRAY — a bare string
      // fixture no longer fires. Build a real CFN ingress element
      // instead so the "fires" branch exercises the intended logic.
      if (
        typeof spec.expectedValue === "string" &&
        /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}:\d{1,5}$/.test(
          spec.expectedValue,
        )
      ) {
        const [cidr, portStr] = spec.expectedValue.split(":");
        const port = Number(portStr);
        return stateWith(spec.propertyPath, [
          { IpProtocol: "tcp", FromPort: port, ToPort: port, CidrIp: cidr },
        ]);
      }
      // Field equals the unwanted value → fires
      return stateWith(spec.propertyPath, spec.expectedValue);
    }

    case "exists":
      // Field missing → fires
      return {};

    case "not_exists":
      // Field present → fires
      return stateWith(spec.propertyPath, "some-value");

    case "greater_than":
      // Field <= expected → fires
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue - 1 : 0,
      );

    case "less_than":
      // Field >= expected → fires
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue + 1 : 99999,
      );

    case "contains":
      // Field does NOT contain expected → fires
      return stateWith(spec.propertyPath, "__NO_MATCH__");

    case "not_contains":
      // Field DOES contain expected → fires
      if (typeof spec.expectedValue === "string") {
        return stateWith(
          spec.propertyPath,
          `prefix${spec.expectedValue}suffix`,
        );
      }
      return stateWith(spec.propertyPath, [spec.expectedValue]);

    case "not_contains_pattern":
      // Field contains at least one element that matches the regex → fires.
      // BP-IAM-017's pattern matches AWS-managed *FullAccess ARNs, so a
      // realistic triggering element is AmazonS3FullAccess.
      return stateWith(spec.propertyPath, [
        "arn:aws:iam::aws:policy/AmazonS3FullAccess",
      ]);

    case "conditional_forbidden":
      // Field exists → fires
      return stateWith(spec.propertyPath, "igw-12345");

    case "awareness":
    case "cross_resource_count":
    case "cross_resource_reference":
      // Always fires
      return stateWith(spec.propertyPath, "any-value");

    case "sg_high_risk_public_exposure": {
      // Epic 96 W3.N2 — BP-SG-004 narrowing. expected_value grammar is
      // "<cidr>:<p1>,<p2>,...". Fire by placing an ingress rule that
      // opens the target CIDR to the FIRST port in the set.
      if (typeof spec.expectedValue !== "string") {
        return stateWith(spec.propertyPath, []);
      }
      const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}):([\d,]+)$/.exec(
        spec.expectedValue,
      );
      if (m === null) return stateWith(spec.propertyPath, []);
      const cidr = m[1]!;
      const firstPort = Number(m[2]!.split(",")[0]);
      return stateWith(spec.propertyPath, [
        {
          IpProtocol: "tcp",
          FromPort: firstPort,
          ToPort: firstPort,
          CidrIp: cidr,
        },
      ]);
    }

    case "policy_antipattern": {
      // Build a minimal Allow statement that hits the named anti-pattern.
      // Callers pass the pattern name as expectedValue (same convention
      // the production check uses).
      const doc = buildAntipatternFiringDoc(String(spec.expectedValue));
      return stateWith(spec.propertyPath, doc);
    }

    case "nested_array_predicate": {
      // Epic 98 W4.B1 — grammar:
      //   "<innerArray>[?(@.<prop>=~/<regex>/<flags>)] does not exist"
      // Fire by placing one outer-array element whose inner array
      // contains an element whose <prop> matches the regex. Falls back
      // to the canonical ECS Environment=PASSWORD shape when the
      // grammar can't be parsed — keeps this test harness robust to
      // future YAML authors who mistype the expected_value; the rule's
      // own scope test (bp-ecs-004-scope.test.ts etc.) is the real
      // enforcement surface.
      const expr = String(spec.expectedValue);
      const m =
        /^([A-Za-z_][\w]*)\[\?\(@\.([A-Za-z_][\w]*)=~\/(.+?)\/[gimsuy]*\)\]\s+does not exist$/.exec(
          expr,
        );
      if (m === null) {
        return stateWith(spec.propertyPath, [
          { Environment: [{ Name: "PASSWORD", Value: "plaintext-bad" }] },
        ]);
      }
      const [, innerArray, prop, regexBody] = m;
      // Produce a sample value that MATCHES the regex by taking the
      // first literal alternative inside the pattern; fall back to a
      // fixed "PASSWORD" token which matches the BP-ECS-004 regex.
      const firstAlt = regexBody!
        .replace(/^\^\(?|\)?\$$/g, "")
        .split("|")[0]!
        .replace(/[\\[\]^$.?*+(){}]/g, "");
      const sample = firstAlt.length > 0 ? firstAlt.toUpperCase() : "PASSWORD";
      return stateWith(spec.propertyPath, [
        { [innerArray!]: [{ [prop!]: sample, Value: "bad-plaintext" }] },
      ]);
    }

    default:
      return {};
  }
}

/**
 * Build a real-shaped policy document that fires the named anti-pattern.
 * Each branch mirrors one case in `src/policy-inspector.ts`; if a new
 * anti-pattern is added to POLICY_ANTIPATTERNS the test harness must
 * grow a matching branch here (otherwise firingState returns {} and
 * the "fires" test fails with a clear diagnostic).
 */
function buildAntipatternFiringDoc(pattern: string): Record<string, unknown> {
  const base = { Version: "2012-10-17" };
  switch (pattern) {
    case "wildcard-resource":
      return {
        ...base,
        Statement: [{ Effect: "Allow", Action: "s3:GetObject", Resource: "*" }],
      };
    case "wildcard-action":
      return {
        ...base,
        Statement: [
          { Effect: "Allow", Action: "*", Resource: "arn:aws:s3:::b/*" },
        ],
      };
    case "wildcard-principal":
      return {
        ...base,
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: "arn:aws:s3:::b/*",
          },
        ],
      };
    case "wildcard-principal-no-condition":
      // Epic 98 W4.B2 — wildcard Principal + no Condition clause.
      // Canonical BP-SNS-004 firing shape: public SNS topic policy.
      return {
        ...base,
        Statement: [
          {
            Effect: "Allow",
            Principal: "*",
            Action: "sns:Subscribe",
            Resource: "arn:aws:sns:us-east-1:210987654321:public-notifications",
          },
        ],
      };
    case "missing-secure-transport-deny":
      // Epic 98 W4.B4 — absence check. Fires when the BucketPolicy
      // has no Deny-non-SSL statement. This fixture gives the bucket
      // a narrow Allow read but intentionally omits the required
      // Deny, so the missing-secure-transport-deny antipattern
      // matches (rule fires).
      return {
        ...base,
        Statement: [
          {
            Sid: "AllowPublicRead",
            Effect: "Allow",
            Principal: "*",
            Action: "s3:GetObject",
            Resource: "arn:aws:s3:::appdata-210987654321-us-east-1/*",
          },
        ],
      };
    case "allow-plus-not-action":
      return {
        ...base,
        Statement: [{ Effect: "Allow", NotAction: ["iam:*"], Resource: "*" }],
      };
    case "allow-plus-not-resource":
      return {
        ...base,
        Statement: [
          {
            Effect: "Allow",
            Action: "s3:DeleteObject",
            NotResource: "arn:aws:s3:::critical/*",
          },
        ],
      };
    case "allow-plus-not-principal":
      return {
        ...base,
        Statement: [
          {
            Effect: "Allow",
            NotPrincipal: { AWS: "arn:aws:iam::123456789012:root" },
            Action: "sts:AssumeRole",
          },
        ],
      };
    case "passrole-wildcard-resource":
      return {
        ...base,
        Statement: [{ Effect: "Allow", Action: "iam:PassRole", Resource: "*" }],
      };
    default:
      // Unknown pattern — return an empty-but-valid doc. The rule will
      // pass (no match) which makes the "fires" test fail visibly so
      // the test author notices the missing branch.
      return { ...base, Statement: [] };
  }
}

/**
 * Build a real-shaped policy document that does NOT match the named
 * anti-pattern — a narrow, auditable policy with no wildcards and no
 * inversions. Used by `passingState()`.
 */
function buildAntipatternPassingDoc(): Record<string, unknown> {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "NarrowRead",
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:ListBucket"],
        Resource: ["arn:aws:s3:::my-bucket", "arn:aws:s3:::my-bucket/*"],
      },
    ],
  };
}

/**
 * Build a real-shaped policy document that CONTAINS the desired
 * statement an absence antipattern looks for. Used by `passingState()`
 * for absence-semantics antipatterns (Epic 98 W4.B4+): the narrow
 * passing doc has no Deny-non-SSL clause, so for absence patterns we
 * need to emit the canonical mitigation instead.
 */
function buildAntipatternPassingDocForAbsence(
  pattern: string,
): Record<string, unknown> {
  switch (pattern) {
    case "missing-secure-transport-deny":
      return {
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "DenyNonSSL",
            Effect: "Deny",
            Principal: "*",
            Action: "s3:*",
            Resource: [
              "arn:aws:s3:::appdata-210987654321-us-east-1",
              "arn:aws:s3:::appdata-210987654321-us-east-1/*",
            ],
            Condition: {
              Bool: { "aws:SecureTransport": "false" },
            },
          },
        ],
      };
    default:
      // Unknown absence pattern — fall back to the narrow-passing
      // doc so the test fails loudly with a clear diagnostic.
      return buildAntipatternPassingDoc();
  }
}

function passingState(spec: RuleSpec): Record<string, unknown> {
  switch (spec.checkType) {
    case "equals":
      return stateWith(spec.propertyPath, spec.expectedValue);

    case "not_equals":
      // Epic 94 R4 (B-02): mirror the `firingState` branch — SG CIDR:port
      // rules need a real CFN ingress element whose CidrIp/port does NOT
      // match the unwanted value.
      if (
        typeof spec.expectedValue === "string" &&
        /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}:\d{1,5}$/.test(
          spec.expectedValue,
        )
      ) {
        const [, portStr] = spec.expectedValue.split(":");
        const port = Number(portStr);
        // Use a private CIDR so the target port is NOT open to 0.0.0.0/0.
        return stateWith(spec.propertyPath, [
          {
            IpProtocol: "tcp",
            FromPort: port,
            ToPort: port,
            CidrIp: "10.0.0.0/8",
          },
        ]);
      }
      // Field is different from unwanted value
      if (spec.expectedValue === true)
        return stateWith(spec.propertyPath, false);
      if (typeof spec.expectedValue === "string")
        return stateWith(spec.propertyPath, "__DIFFERENT__");
      return stateWith(spec.propertyPath, "__DIFFERENT__");

    case "exists":
      return stateWith(spec.propertyPath, "some-value");

    case "not_exists":
      return {};

    case "greater_than":
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue + 1 : 1,
      );

    case "less_than":
      return stateWith(
        spec.propertyPath,
        typeof spec.expectedValue === "number" ? spec.expectedValue - 1 : 0,
      );

    case "contains":
      if (typeof spec.expectedValue === "string") {
        return stateWith(
          spec.propertyPath,
          `prefix${spec.expectedValue}suffix`,
        );
      }
      return stateWith(spec.propertyPath, [spec.expectedValue]);

    case "not_contains":
      return stateWith(spec.propertyPath, "__CLEAN__");

    case "not_contains_pattern":
      // No element matches the regex → passes. BP-IAM-017's pattern
      // exempts ReadOnly and SecurityAudit — both are stable examples.
      return stateWith(spec.propertyPath, [
        "arn:aws:iam::aws:policy/ReadOnlyAccess",
        "arn:aws:iam::aws:policy/SecurityAudit",
      ]);

    case "conditional_forbidden":
      return {};

    case "policy_antipattern":
      // Presence patterns: return a narrow, auditable policy — no
      // wildcards, no inversions. The trust-policy rule (BP-IAM-015)
      // targets `AssumeRolePolicyDocument` which is shape-compatible;
      // we use the same doc for both.
      //
      // Absence patterns (Epic 98 W4.B4+): return a policy that
      // SATISFIES the required statement so the antipattern does
      // NOT match. `buildAntipatternPassingDocForAbsence` emits the
      // canonical Deny-non-SSL shape for missing-secure-transport-deny.
      if (spec.expectedValue === "missing-secure-transport-deny") {
        return stateWith(
          spec.propertyPath,
          buildAntipatternPassingDocForAbsence(String(spec.expectedValue)),
        );
      }
      return stateWith(spec.propertyPath, buildAntipatternPassingDoc());

    case "sg_high_risk_public_exposure": {
      // Passing case for BP-SG-004: an ingress rule that opens port 443
      // to 0.0.0.0/0 — a common HTTPS pattern that is intentionally NOT
      // in the DB/admin port set. If 443 somehow lands in the port set
      // the test will fail loudly, which is the intended safeguard.
      return stateWith(spec.propertyPath, [
        { IpProtocol: "tcp", FromPort: 443, ToPort: 443, CidrIp: "0.0.0.0/0" },
      ]);
    }

    case "nested_array_predicate": {
      // Passing case for BP-ECS-004: outer array contains one element
      // whose inner array entry's <prop> deliberately does NOT match
      // the secret regex. Uses a benign LOG_LEVEL env var — the
      // textbook "safe" ECS env-var example.
      return stateWith(spec.propertyPath, [
        { Environment: [{ Name: "LOG_LEVEL", Value: "debug" }] },
      ]);
    }

    // awareness/cross_resource_count/cross_resource_reference never pass
    default:
      return {};
  }
}

// ---------------------------------------------------------------------------
// ALL 130 BP rules organized by service
// ---------------------------------------------------------------------------

const s3Rules: RuleSpec[] = [
  {
    id: "BP-S3-001",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-002",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.BlockPublicPolicy",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-003",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.IgnorePublicAcls",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-004",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "PublicAccessBlockConfiguration.RestrictPublicBuckets",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-005",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "VersioningConfiguration.Status",
    checkType: "equals",
    expectedValue: "Enabled",
  },
  {
    id: "BP-S3-006",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "BucketEncryption",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-008",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "OwnershipControls.Rules[0].ObjectOwnership",
    checkType: "equals",
    expectedValue: "BucketOwnerEnforced",
  },
  {
    id: "BP-S3-009",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "NotificationConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-010",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "LifecycleConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    // Epic 98 W4.B4 — BP-S3-011 SSL-only HIGH MISLABELED closure.
    // Migrated from `check_type: awareness` on AWS::S3::Bucket →
    // structural absence-check on AWS::S3::BucketPolicy matching the
    // BP-S3-018/019/020 resource-level convention. The new
    // `missing-secure-transport-deny` antipattern fires when NO Deny
    // statement matches the canonical `aws:SecureTransport=false`
    // shape. Unlike presence patterns (BP-S3-018 etc.), a completely
    // missing BucketPolicy ALSO fires the rule — absence of the
    // required Deny is exactly the failure mode.
    id: "BP-S3-011",
    resourceType: "AWS::S3::BucketPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "missing-secure-transport-deny",
  },
  {
    id: "BP-S3-012",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "ObjectLockEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-S3-015",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "ReplicationConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-016",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "IntelligentTieringConfigurations",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3-017",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "LoggingConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  // ── A5.3: S3 bucket policy anti-patterns (Tier 3 of the cfn-guard gap
  // ── analysis). Target AWS::S3::BucketPolicy.PolicyDocument — a
  // ── separate resource from AWS::S3::Bucket, so these rules fire on
  // ── the BucketPolicy resource rather than the Bucket resource itself.
  {
    id: "BP-S3-018",
    resourceType: "AWS::S3::BucketPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-action",
  },
  {
    id: "BP-S3-019",
    resourceType: "AWS::S3::BucketPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-principal",
  },
  {
    id: "BP-S3-020",
    resourceType: "AWS::S3::BucketPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-action",
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion
  {
    id: "BP-S3-007",
    resourceType: "AWS::S3::Bucket",
    propertyPath: "LifecycleConfiguration.Rules",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-S3BP-001",
    resourceType: "AWS::S3::BucketPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-principal",
  },
  // (f) 2026-04-09 Task 9 follow-up: SSE-KMS ratchet for compliance
  // workloads — complements BP-S3-006 (which only requires some
  // BucketEncryption exists) by requiring aws:kms over AES256.
  {
    id: "BP-S3-013",
    resourceType: "AWS::S3::Bucket",
    propertyPath:
      "BucketEncryption.ServerSideEncryptionConfiguration[0].ServerSideEncryptionByDefault.SSEAlgorithm",
    checkType: "equals",
    expectedValue: "aws:kms",
  },
];

const ec2Rules: RuleSpec[] = [
  {
    id: "BP-EC2-001",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "MetadataOptions.HttpTokens",
    checkType: "equals",
    expectedValue: "required",
  },
  {
    id: "BP-EC2-002",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-003",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.VolumeType",
    checkType: "equals",
    expectedValue: "gp3",
  },
  {
    id: "BP-EC2-004",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "IamInstanceProfile",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-005",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SubnetId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-007",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "Monitoring.Enabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-009",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "NetworkInterfaces[0].AssociatePublicIpAddress",
    checkType: "not_equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-010",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SecurityGroupIds",
    checkType: "not_contains",
    expectedValue: "default",
  },
  {
    id: "BP-EC2-011",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "EbsOptimized",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-013",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "DisableApiTermination",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EC2-014",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "SubnetId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EC2-015",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceType",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-016",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "CreditSpecification.CPUCredits",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-017",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "MetadataOptions.HttpPutResponseHopLimit",
    checkType: "equals",
    expectedValue: 1,
  },
  {
    id: "BP-EC2-018",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceId",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-019",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "InstanceType",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-020",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-021",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "BlockDeviceMappings[0].Ebs.VolumeId",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-022",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "ElasticIpAssociation",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-EC2-023",
    resourceType: "AWS::EC2::Instance",
    propertyPath: "Tags",
    checkType: "awareness",
    expectedValue: true,
  },
];

const sgRules: RuleSpec[] = [
  {
    id: "BP-SG-001",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "not_equals",
    expectedValue: "0.0.0.0/0",
  },
  {
    id: "BP-SG-002",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "not_equals",
    expectedValue: "0.0.0.0/0:22",
  },
  {
    id: "BP-SG-005",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    // Epic 94 R4 (B-02). Re-tagged from `awareness` to `not_equals` with
    // the canonical `"<cidr>:<port>"` grammar BP-SG-002 uses. Was firing
    // as a CRITICAL false positive on every SG plan regardless of the
    // ports the user actually requested.
    checkType: "not_equals",
    expectedValue: "0.0.0.0/0:3389",
  },
  {
    id: "BP-SG-006",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "GroupDescription",
    checkType: "not_equals",
    expectedValue: "",
  },
  {
    id: "BP-SG-004",
    resourceType: "AWS::EC2::SecurityGroup",
    propertyPath: "SecurityGroupIngress",
    checkType: "sg_high_risk_public_exposure",
    expectedValue:
      "0.0.0.0/0:20,21,1433,1434,1521,3306,3389,4333,5432,5439,5500,6379,9200,27017",
  },
];

const igwRules: RuleSpec[] = [
  {
    id: "BP-IGW-001",
    resourceType: "AWS::EC2::InternetGateway",
    propertyPath: "VPCGatewayAttachment",
    checkType: "exists",
    expectedValue: "VpcId must reference a valid VPC",
  },
  {
    id: "BP-IGW-002",
    resourceType: "AWS::EC2::InternetGateway",
    propertyPath: "RouteTable.Routes",
    checkType: "exists",
    expectedValue:
      "Route with destination 0.0.0.0/0 targeting the InternetGateway",
  },
];

const natRules: RuleSpec[] = [
  {
    id: "BP-NAT-001",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "SubnetId",
    checkType: "cross_resource_count",
    expectedValue: ">=2 NatGateways...",
  },
  {
    id: "BP-NAT-002",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "ConnectivityType",
    checkType: "awareness",
    expectedValue: "Consider private connectivity...",
  },
  {
    id: "BP-NAT-003",
    resourceType: "AWS::EC2::NatGateway",
    propertyPath: "SubnetId",
    checkType: "cross_resource_reference",
    expectedValue: "SubnetId must reference a public subnet...",
  },
];

const rtRules: RuleSpec[] = [
  {
    id: "BP-RT-001",
    resourceType: "AWS::EC2::Route",
    propertyPath: "GatewayId",
    checkType: "conditional_forbidden",
    expectedValue: "Private subnets must route...",
  },
  {
    id: "BP-RT-002",
    resourceType: "AWS::EC2::Subnet",
    propertyPath: "SubnetRouteTableAssociation",
    checkType: "exists",
    expectedValue: "Every subnet should have...",
  },
];

const vpcNetworkRules: RuleSpec[] = [];

const rdsRules: RuleSpec[] = [
  {
    id: "BP-RDS-001",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "PubliclyAccessible",
    checkType: "equals",
    expectedValue: false,
  },
  {
    id: "BP-RDS-002",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "StorageEncrypted",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-003",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MultiAZ",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-004",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "DeletionProtection",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-005",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "BackupRetentionPeriod",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-RDS-007",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MonitoringInterval",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-RDS-008",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnableIAMDatabaseAuthentication",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-009",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "CopyTagsToSnapshot",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-010",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "AutoMinorVersionUpgrade",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-011",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnablePerformanceInsights",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-RDS-012",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "EnableCloudwatchLogsExports",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-RDS-013",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "DBInstanceIdentifier",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-RDS-014",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MultiAZ",
    checkType: "awareness",
    expectedValue: true,
  },
];

const lambdaRules: RuleSpec[] = [
  {
    id: "BP-LAMBDA-001",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "ReservedConcurrentExecutions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-002",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Architectures[0]",
    checkType: "equals",
    expectedValue: "arm64",
  },
  {
    id: "BP-LAMBDA-003",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "MemorySize",
    checkType: "greater_than",
    expectedValue: 128,
  },
  {
    id: "BP-LAMBDA-004",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Timeout",
    checkType: "less_than",
    expectedValue: 900,
  },
  {
    id: "BP-LAMBDA-005",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "DeadLetterConfig.TargetArn",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-006",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "VpcConfig.SubnetIds",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LAMBDA-007",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "python3.8",
  },
  {
    id: "BP-LAMBDA-010",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "python3.7",
  },
  {
    id: "BP-LAMBDA-011",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Runtime",
    checkType: "not_equals",
    expectedValue: "nodejs16.x",
  },
  {
    id: "BP-LAMBDA-012",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "CodeSigningConfigArn",
    checkType: "exists",
    expectedValue: true,
  },
  // ── A5.5: Lambda::Permission hygiene (Tier 4 of the cfn-guard gap
  // ── analysis). Target AWS::Lambda::Permission, not the Function.
  {
    id: "BP-LAMBDA-013",
    resourceType: "AWS::Lambda::Permission",
    propertyPath: "Principal",
    checkType: "not_equals",
    expectedValue: "*",
  },
  {
    id: "BP-LAMBDA-014",
    resourceType: "AWS::Lambda::Permission",
    propertyPath: "Action",
    checkType: "equals",
    expectedValue: "lambda:InvokeFunction",
  },
  // A8 follow-up: Lambda X-Ray tracing — easy observability lever.
  {
    id: "BP-LAMBDA-015",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "TracingConfig.Mode",
    checkType: "equals",
    expectedValue: "Active",
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: explicit
  // Timeout required (CFN default of 3s is almost never correct).
  {
    id: "BP-LAMBDA-008",
    resourceType: "AWS::Lambda::Function",
    propertyPath: "Timeout",
    checkType: "exists",
    expectedValue: true,
  },
];

const iamRules: RuleSpec[] = [
  {
    id: "BP-IAM-001",
    resourceType: "AWS::IAM::Policy",
    propertyPath: "PolicyDocument.Statement[0].Effect",
    checkType: "not_equals",
    expectedValue: "Allow",
  },
  {
    id: "BP-IAM-002",
    resourceType: "AWS::IAM::User",
    propertyPath: "MFADevices",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-003",
    resourceType: "AWS::IAM::User",
    propertyPath: "AccessKeyMaxAge",
    checkType: "less_than",
    expectedValue: 90,
  },
  {
    id: "BP-IAM-004",
    resourceType: "AWS::IAM::User",
    propertyPath: "AttachedPolicies",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-005",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "not_equals",
    expectedValue: "*",
  },
  {
    id: "BP-IAM-006",
    resourceType: "AWS::IAM::Role",
    propertyPath: "PermissionsBoundary",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-007",
    resourceType: "AWS::IAM::Role",
    propertyPath: "MaxSessionDuration",
    checkType: "less_than",
    expectedValue: 14401,
  },
  {
    id: "BP-IAM-008",
    resourceType: "AWS::IAM::Role",
    propertyPath: "Policies",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-IAM-009",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-IAM-010",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "awareness",
    expectedValue: true,
  },
  // ── A5.2: IAM policy-document anti-patterns (Tier 1 of the cfn-guard
  // ── gap analysis). Each uses the shared policy_antipattern check type
  // ── backed by src/policy-inspector.ts. See
  // ── docs/bp-cfn-guard-gap-analysis-2026-04-08.md for the full rationale.
  {
    id: "BP-IAM-011",
    resourceType: "AWS::IAM::ManagedPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-resource",
  },
  {
    id: "BP-IAM-012",
    resourceType: "AWS::IAM::ManagedPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "passrole-wildcard-resource",
  },
  {
    id: "BP-IAM-013",
    resourceType: "AWS::IAM::ManagedPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-action",
  },
  {
    id: "BP-IAM-014",
    resourceType: "AWS::IAM::ManagedPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-resource",
  },
  {
    id: "BP-IAM-015",
    resourceType: "AWS::IAM::Role",
    propertyPath: "AssumeRolePolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-principal",
  },
  {
    id: "BP-IAM-016",
    resourceType: "AWS::IAM::Role",
    propertyPath: "ManagedPolicyArns",
    checkType: "not_contains",
    expectedValue: "arn:aws:iam::aws:policy/AdministratorAccess",
  },
  // A1 warmup (2026-04-08) — elevated *FullAccess heuristic. Uses the
  // new `not_contains_pattern` check_type so the regex in the YAML is
  // exercised by the audit harness (fires on AmazonS3FullAccess,
  // passes on ReadOnlyAccess / SecurityAudit exemptions).
  {
    id: "BP-IAM-017",
    resourceType: "AWS::IAM::Role",
    propertyPath: "ManagedPolicyArns",
    checkType: "not_contains_pattern",
    expectedValue:
      "^arn:aws[\\w-]*:iam::aws:policy/(?!ReadOnly|SecurityAudit|Billing|Job-function/|service-role/)[A-Za-z0-9_-]*FullAccess$",
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: cap
  // MaxSessionDuration at 14400s (4h) to shrink credential-leak
  // exposure windows.
  {
    id: "BP-IAM-018",
    resourceType: "AWS::IAM::Role",
    propertyPath: "MaxSessionDuration",
    checkType: "less_than",
    expectedValue: 14401,
  },
];

const dynamodbRules: RuleSpec[] = [
  {
    id: "BP-DYNAMODB-001",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-002",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "DeletionProtectionEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-003",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "SSESpecification.SSEEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-005",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "BillingMode",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-DYNAMODB-006",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "BillingMode",
    checkType: "awareness",
    expectedValue: true,
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: enable
  // ContributorInsights for hot-key observability.
  {
    id: "BP-DYNAMODB-004",
    resourceType: "AWS::DynamoDB::Table",
    propertyPath: "ContributorInsightsSpecification.Enabled",
    checkType: "equals",
    expectedValue: true,
  },
];

const ecsRules: RuleSpec[] = [
  {
    id: "BP-ECS-001",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].Privileged",
    checkType: "not_equals",
    expectedValue: true,
  },
  {
    id: "BP-ECS-002",
    resourceType: "AWS::ECS::Service",
    propertyPath: "NetworkConfiguration.AwsvpcConfiguration.AssignPublicIp",
    checkType: "not_equals",
    expectedValue: "ENABLED",
  },
  {
    id: "BP-ECS-003",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].LogConfiguration",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-ECS-004",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions",
    checkType: "nested_array_predicate",
    expectedValue:
      "Environment[?(@.Name=~/^(password|secret|api[_-]?key|token|connection[_-]?string)$/i)] does not exist",
  },
  {
    id: "BP-ECS-005",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "ContainerDefinitions[0].ReadonlyRootFilesystem",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-ECS-006",
    resourceType: "AWS::ECS::TaskDefinition",
    propertyPath: "RequiresCompatibilities",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-ECS-007",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "ClusterSettings",
    checkType: "contains",
    expectedValue: { Name: "containerInsights", Value: "enabled" },
  },
  {
    id: "BP-ECS-008",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "Configuration.ExecuteCommandConfiguration.Logging",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-ECS-009",
    resourceType: "AWS::ECS::Cluster",
    propertyPath: "ServiceConnectDefaults.Namespace",
    checkType: "exists",
    expectedValue: true,
  },
];

const cloudwatchRules: RuleSpec[] = [
  {
    id: "BP-CW-001",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "AlarmActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CW-002",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "EvaluationPeriods",
    checkType: "greater_than",
    expectedValue: 1,
  },
  {
    id: "BP-CWA-001",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "OKActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CWA-002",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "InsufficientDataActions",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-CWA-003",
    resourceType: "AWS::CloudWatch::Alarm",
    propertyPath: "TreatMissingData",
    checkType: "not_equals",
    expectedValue: "notBreaching",
  },
];

const sqsRules: RuleSpec[] = [
  {
    id: "BP-SQS-001",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "SqsManagedSseEnabled",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-SQS-002",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "RedrivePolicy",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SQS-003",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "KmsMasterKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SQS-004",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "VisibilityTimeout",
    checkType: "greater_than",
    expectedValue: 0,
  },
  {
    id: "BP-SQS-005",
    resourceType: "AWS::SQS::Queue",
    propertyPath: "MessageRetentionPeriod",
    checkType: "greater_than",
    expectedValue: 60,
  },
  // ── A5.3: SQS queue policy anti-patterns. Target AWS::SQS::QueuePolicy,
  // ── a separate resource from AWS::SQS::Queue.
  {
    id: "BP-SQS-006",
    resourceType: "AWS::SQS::QueuePolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-action",
  },
  {
    id: "BP-SQS-007",
    resourceType: "AWS::SQS::QueuePolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-principal",
  },
  {
    id: "BP-SQS-008",
    resourceType: "AWS::SQS::QueuePolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-action",
  },
  {
    id: "BP-SQS-009",
    resourceType: "AWS::SQS::QueuePolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-principal",
  },
];

const smRules: RuleSpec[] = [
  {
    id: "BP-SM-001",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "SecretString",
    checkType: "not_exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-002",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "KmsKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-003",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "RotationSchedule",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SM-004",
    resourceType: "AWS::RDS::DBInstance",
    propertyPath: "MasterUserPassword",
    checkType: "contains",
    expectedValue: "{{resolve:secretsmanager:",
  },
  {
    id: "BP-SM-005",
    resourceType: "AWS::SecretsManager::Secret",
    propertyPath: "RotationRules",
    checkType: "exists",
    expectedValue: true,
  },
];

const snsRules: RuleSpec[] = [
  {
    id: "BP-SNS-001",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "KmsMasterKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SNS-002",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "DeliveryStatusLogging",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SNS-003",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "TopicArn",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    // Epic 98 W4.B2 — BP-SNS-004 MISLABELED closure. Migrated from
    // `check_type: awareness` → structural check via the new
    // `wildcard-principal-no-condition` antipattern. Kept on the
    // first-class `AWS::SNS::Topic` resource targeting the inline
    // `TopicPolicy` field — the `AWS::SNS::TopicPolicy` resource
    // type is not a first-class supported type yet, so targeting it
    // would make the rule unreachable on real plan output. The
    // inline TopicPolicy field IS the policy document (same
    // `{Version, Statement}` shape the inspector walks).
    id: "BP-SNS-004",
    resourceType: "AWS::SNS::Topic",
    propertyPath: "TopicPolicy",
    checkType: "policy_antipattern",
    expectedValue: "wildcard-principal-no-condition",
  },
  // ── A5.3: SNS topic policy anti-patterns. Target AWS::SNS::TopicPolicy,
  // ── a separate resource from AWS::SNS::Topic.
  {
    id: "BP-SNS-005",
    resourceType: "AWS::SNS::TopicPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-action",
  },
  {
    id: "BP-SNS-006",
    resourceType: "AWS::SNS::TopicPolicy",
    propertyPath: "PolicyDocument",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-principal",
  },
  // A10 (2026-04-09): AWS::SNS::Subscription promoted to first-class.
  // Closes the #1 SNS failure mode (silent drop on delivery exhaustion)
  // by requiring RedrivePolicy.deadLetterTargetArn to point at an SQS
  // DLQ. Mirrors BP-EVENTBUS-003 for the EventBridge custom event bus.
  // Named BP-SNS-007 (not BP-SNS-SUB-001) because the manifest schema
  // validator enforces a strict BP-{SERVICE}-{NNN} ID pattern — the
  // SNS service already owns BP-SNS-001..006 on AWS::SNS::Topic, so
  // this entry continues the sequence even though it targets a
  // different CloudFormation resource type.
  {
    id: "BP-SNS-007",
    resourceType: "AWS::SNS::Subscription",
    propertyPath: "RedrivePolicy.deadLetterTargetArn",
    checkType: "exists",
    expectedValue: true,
  },
];

const apigwRules: RuleSpec[] = [
  {
    id: "BP-APIGW-001",
    resourceType: "AWS::ApiGatewayV2::Stage",
    propertyPath: "AccessLogSettings.DestinationArn",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-APIGW-002",
    resourceType: "AWS::ApiGatewayV2::Api",
    propertyPath: "CorsConfiguration.AllowOrigins",
    checkType: "not_contains",
    expectedValue: "*",
  },
  {
    id: "BP-APIGW-003",
    resourceType: "AWS::ApiGatewayV2::Route",
    propertyPath: "AuthorizationType",
    checkType: "not_equals",
    expectedValue: "NONE",
  },
  // ── A5.5: API Gateway REST API hygiene (Tier 4). Target the v1
  // ── REST API resources (ApiGateway::Stage, ApiGateway::DomainName),
  // ── not the v2 HTTP API shapes that BP-APIGW-001..003 cover.
  {
    id: "BP-APIGW-004",
    resourceType: "AWS::ApiGateway::Stage",
    propertyPath: "MethodSettings",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-APIGW-005",
    resourceType: "AWS::ApiGateway::Stage",
    propertyPath: "MethodSettings",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-APIGW-006",
    resourceType: "AWS::ApiGateway::DomainName",
    propertyPath: "SecurityPolicy",
    checkType: "equals",
    expectedValue: "TLS_1_2",
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: disable the
  // default execute-api URL so the custom domain is the single
  // entrypoint (WAF / throttling / auth layers actually apply).
  {
    id: "BP-APIGW-007",
    resourceType: "AWS::ApiGatewayV2::Api",
    propertyPath: "DisableExecuteApiEndpoint",
    checkType: "equals",
    expectedValue: true,
  },
];

const ecrRules: RuleSpec[] = [
  {
    id: "BP-ECR-001",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "ImageScanningConfiguration.ScanOnPush",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-ECR-002",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "ImageTagMutability",
    checkType: "equals",
    expectedValue: "IMMUTABLE",
  },
  {
    id: "BP-ECR-003",
    resourceType: "AWS::ECR::Repository",
    propertyPath: "LifecyclePolicy",
    checkType: "exists",
    expectedValue: true,
  },
];

const elbRules: RuleSpec[] = [
  {
    id: "BP-ELB-001",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath: "LoadBalancerAttributes[deletion_protection.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
  {
    id: "BP-ELB-002",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath: "LoadBalancerAttributes[access_logs.s3.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
  {
    id: "BP-ELB-003",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath:
      "LoadBalancerAttributes[routing.http.drop_invalid_header_fields.enabled]",
    checkType: "equals",
    expectedValue: "true",
  },
  // ── A5.4: ELBv2 HTTPS hygiene (Tier 2 of the cfn-guard gap analysis).
  // ── These target AWS::ElasticLoadBalancingV2::Listener, not the
  // ── LoadBalancer resource — a new resource type in the audit harness.
  // ── runElbRuleTests is the bracket-key helper for LB attributes; these
  // ── listener rules use simple property paths and go through runRuleTests.
  {
    id: "BP-ELB-004",
    resourceType: "AWS::ElasticLoadBalancingV2::Listener",
    propertyPath: "Protocol",
    checkType: "not_equals",
    expectedValue: "HTTP",
  },
  {
    id: "BP-ELB-005",
    resourceType: "AWS::ElasticLoadBalancingV2::Listener",
    propertyPath: "Certificates",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-ELB-006",
    resourceType: "AWS::ElasticLoadBalancingV2::Listener",
    propertyPath: "SslPolicy",
    checkType: "equals",
    expectedValue: "ELBSecurityPolicy-TLS13-1-2-2021-06",
  },
  // BP-ELB-007 / BP-ELB-008 are awareness-only — they always fire on
  // their target resource type to surface cross-resource recommendations
  // (WAF association and HTTP→HTTPS redirect) that cannot be expressed
  // as a single-field check. The runRuleTests helper handles awareness
  // via ALWAYS_FIRE_TYPES.
  {
    id: "BP-ELB-007",
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    propertyPath: "Scheme",
    checkType: "awareness",
    expectedValue: true,
  },
  {
    id: "BP-ELB-008",
    resourceType: "AWS::ElasticLoadBalancingV2::Listener",
    propertyPath: "DefaultActions",
    checkType: "awareness",
    expectedValue: true,
  },
];

const logsRules: RuleSpec[] = [
  {
    id: "BP-LOGS-001",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "RetentionInDays",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LOGS-002",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "KmsKeyId",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-LOGS-003",
    resourceType: "AWS::Logs::LogGroup",
    propertyPath: "MetricFilters",
    checkType: "awareness",
    expectedValue: true,
  },
];

const ssmRules: RuleSpec[] = [
  {
    id: "BP-SSM-001",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Type",
    checkType: "equals",
    expectedValue: "SecureString",
  },
  {
    id: "BP-SSM-002",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Name",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-SSM-003",
    resourceType: "AWS::SSM::Parameter",
    propertyPath: "Type",
    checkType: "awareness",
    expectedValue: true,
  },
];

const vpcRules: RuleSpec[] = [
  {
    id: "BP-SUBNET-001",
    resourceType: "AWS::EC2::Subnet",
    propertyPath: "MapPublicIpOnLaunch",
    checkType: "equals",
    expectedValue: false,
  },
  {
    id: "BP-VPC-001",
    resourceType: "AWS::EC2::VPC",
    propertyPath: "EnableDnsHostnames",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-VPC-002",
    resourceType: "AWS::EC2::VPC",
    propertyPath: "FlowLogs",
    checkType: "exists",
    expectedValue: true,
  },
];

// A1 (2026-04-08) — EFS rules
const efsRules: RuleSpec[] = [
  {
    id: "BP-EFS-001",
    resourceType: "AWS::EFS::FileSystem",
    propertyPath: "Encrypted",
    checkType: "equals",
    expectedValue: true,
  },
  {
    id: "BP-EFS-002",
    resourceType: "AWS::EFS::FileSystem",
    propertyPath: "BackupPolicy.Status",
    checkType: "equals",
    expectedValue: "ENABLED",
  },
  // A1 follow-up (2026-04-08): in-transit encryption. Uses the
  // policy_antipattern check type to catch the Allow+NotAction
  // inversion that would bypass the SecureTransport deny.
  {
    id: "BP-EFS-003",
    resourceType: "AWS::EFS::FileSystem",
    propertyPath: "FileSystemPolicy",
    checkType: "policy_antipattern",
    expectedValue: "allow-plus-not-action",
  },
];

// A8 (2026-04-08) — EventBridge Rule BP rules
const eventsRules: RuleSpec[] = [
  {
    id: "BP-EVENTS-001",
    resourceType: "AWS::Events::Rule",
    propertyPath: "Targets",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EVENTS-002",
    resourceType: "AWS::Events::Rule",
    propertyPath: "Description",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EVENTS-003",
    resourceType: "AWS::Events::Rule",
    propertyPath: "State",
    checkType: "equals",
    expectedValue: "ENABLED",
  },
  {
    id: "BP-EVENTS-004",
    resourceType: "AWS::Events::Rule",
    propertyPath: "ScheduleExpression",
    checkType: "awareness",
    expectedValue:
      "Review schedule frequency + target retry policy before shipping",
  },
  // A9 (2026-04-09): EventBridge custom EventBus rules
  {
    id: "BP-EVENTBUS-001",
    resourceType: "AWS::Events::EventBus",
    propertyPath: "KmsKeyIdentifier",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EVENTBUS-002",
    resourceType: "AWS::Events::EventBus",
    propertyPath: "Description",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EVENTBUS-003",
    resourceType: "AWS::Events::EventBus",
    propertyPath: "DeadLetterConfig.Arn",
    checkType: "exists",
    expectedValue: true,
  },
  // A12+A13 follow-up (2026-04-09): BP coverage for the two new
  // EventBridge outbound-HTTP types. Events::Connection gets a
  // credential-encryption rule (MEDIUM, security) and
  // Events::ApiDestination gets an awareness-level rate-limit rule
  // (INFO, reliability) — not blocking, but surfaces the "300
  // default is wrong for most targets" gotcha at plan time.
  {
    id: "BP-EVENTS-005",
    resourceType: "AWS::Events::Connection",
    propertyPath: "KmsKeyIdentifier",
    checkType: "exists",
    expectedValue: true,
  },
  {
    id: "BP-EVENTS-006",
    resourceType: "AWS::Events::ApiDestination",
    propertyPath: "InvocationRateLimitPerSecond",
    checkType: "exists",
    expectedValue: true,
  },
];

// A11 (2026-04-09) — KMS::Key first-class BP rules
const kmsRules: RuleSpec[] = [
  {
    id: "BP-KMS-001",
    resourceType: "AWS::KMS::Key",
    propertyPath: "EnableKeyRotation",
    checkType: "equals",
    expectedValue: true,
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: 30-day
  // pending-deletion window to keep the recovery path open.
  {
    id: "BP-KMS-002",
    resourceType: "AWS::KMS::Key",
    propertyPath: "PendingWindowInDays",
    checkType: "greater_than",
    expectedValue: 29,
  },
];

// A14 (2026-04-09) — CloudFront::Distribution first-class BP rules
const cloudFrontRules: RuleSpec[] = [
  {
    id: "BP-CF-001",
    resourceType: "AWS::CloudFront::Distribution",
    propertyPath:
      "DistributionConfig.DefaultCacheBehavior.ViewerProtocolPolicy",
    checkType: "equals",
    expectedValue: "redirect-to-https",
  },
  // (f) 2026-04-09 Task 9 — Epic 30 Phase 2 WA expansion: access
  // logging for post-incident forensics.
  {
    id: "BP-CF-002",
    resourceType: "AWS::CloudFront::Distribution",
    propertyPath: "DistributionConfig.Logging.Bucket",
    checkType: "exists",
    expectedValue: true,
  },
  // (f) 2026-04-09 Task 4b/Task 9 companion: OAC SigningBehavior
  // must be "always" or the OAC is decorative. Covers the new
  // AWS::CloudFront::OriginAccessControl resource type.
  {
    id: "BP-OAC-001",
    resourceType: "AWS::CloudFront::OriginAccessControl",
    propertyPath: "OriginAccessControlConfig.SigningBehavior",
    checkType: "equals",
    expectedValue: "always",
  },
];

const asgRules: RuleSpec[] = [
  {
    id: "BP-ASG-001",
    resourceType: "AWS::AutoScaling::AutoScalingGroup",
    propertyPath: "MaxSize",
    checkType: "exists",
    expectedValue: true,
  },
  // ── A5.6: AutoScaling rules (Tier 5). BP-ASG-002 is a simple equals
  // ── check on HealthCheckType (autoFixable). BP-ASG-003 targets the
  // ── launch template's NetworkInterfaces array, which the single-
  // ── field evaluator can't walk, so it's awareness-only.
  {
    id: "BP-ASG-002",
    resourceType: "AWS::AutoScaling::AutoScalingGroup",
    propertyPath: "HealthCheckType",
    checkType: "equals",
    expectedValue: "ELB",
  },
  {
    id: "BP-ASG-003",
    resourceType: "AWS::EC2::LaunchTemplate",
    propertyPath: "LaunchTemplateData.NetworkInterfaces",
    checkType: "awareness",
    expectedValue: true,
  },
];

// ---------------------------------------------------------------------------
// Run test for a single rule spec
// ---------------------------------------------------------------------------

function runRuleTests(spec: RuleSpec): void {
  const isAlwaysFire = ALWAYS_FIRE_TYPES.includes(spec.checkType);

  it(`${spec.id} fires (${spec.checkType}, path=${spec.propertyPath})`, () => {
    const state = firingState(spec);
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(
      findings.length,
      `${spec.id} should fire but got 0 findings. State: ${JSON.stringify(state)}`,
    ).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  if (!isAlwaysFire) {
    it(`${spec.id} does NOT fire when satisfied (${spec.checkType}, path=${spec.propertyPath})`, () => {
      const state = passingState(spec);
      const findings = findingsFor(spec.id, spec.resourceType, state);
      const matching = findings.filter((f) => f.practiceId === spec.id);
      expect(
        matching.length,
        `${spec.id} should NOT fire but got ${matching.length} findings. State: ${JSON.stringify(state)}`,
      ).toBe(0);
    });
  }
}

// ---------------------------------------------------------------------------
// ELBv2 needs special handling for bracket-key notation
// ---------------------------------------------------------------------------

function runElbRuleTests(spec: RuleSpec): void {
  // ELBv2 uses LoadBalancerAttributes[key] notation where key is a string key
  // containing dots (e.g. "deletion_protection.enabled"). getField must split
  // on dots that are OUTSIDE bracket pairs so bracket keys with embedded dots
  // resolve correctly.

  // Extract the bracket key from a path like "LoadBalancerAttributes[foo.bar.baz]"
  const bracketMatch = spec.propertyPath.match(/^([^[]+)\[(.+)\]$/);
  expect(bracketMatch).not.toBeNull();
  const [, containerField, bracketKey] = bracketMatch!;

  it(`${spec.id} fires when attribute is missing (${spec.checkType}, path=${spec.propertyPath})`, () => {
    // No attributes entry — getField returns undefined → rule fires
    const state: Record<string, unknown> = { [containerField!]: [] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length, `${spec.id} should fire`).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} fires when attribute has wrong value (${spec.checkType}, path=${spec.propertyPath})`, () => {
    const state: Record<string, unknown> = {
      [containerField!]: [{ Key: bracketKey, Value: "false" }],
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when satisfied (${spec.checkType}, path=${spec.propertyPath})`, () => {
    // Attribute list contains the expected Key/Value pair — getField must
    // resolve the dotted bracket key to "true" so the rule passes.
    const state: Record<string, unknown> = {
      [containerField!]: [
        { Key: bracketKey, Value: String(spec.expectedValue) },
      ],
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(
      matching.length,
      `${spec.id} should NOT fire but got ${matching.length} findings. State: ${JSON.stringify(state)}`,
    ).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// SM-004 needs special handling for contains with secretsmanager reference
// ---------------------------------------------------------------------------

function runSmContainsTests(spec: RuleSpec): void {
  it(`${spec.id} fires when MasterUserPassword does NOT contain secretsmanager ref`, () => {
    const state = { MasterUserPassword: "plaintext-password-123" };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when MasterUserPassword contains secretsmanager ref`, () => {
    const state = {
      MasterUserPassword:
        "{{resolve:secretsmanager:my-secret:SecretString:password}}",
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// EC2-010 not_contains with array value
// ---------------------------------------------------------------------------

function runNotContainsArrayTests(spec: RuleSpec): void {
  it(`${spec.id} fires when SecurityGroupIds contains "default"`, () => {
    const state = { SecurityGroupIds: ["sg-abc123", "default"] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when SecurityGroupIds does not contain "default"`, () => {
    const state = { SecurityGroupIds: ["sg-abc123", "sg-def456"] };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// APIGW-002 not_contains with string in array
// ---------------------------------------------------------------------------

function runApigwNotContainsTests(spec: RuleSpec): void {
  it(`${spec.id} fires when AllowOrigins contains "*"`, () => {
    const state = {
      CorsConfiguration: { AllowOrigins: ["https://example.com", "*"] },
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.practiceId === spec.id)).toBe(true);
  });

  it(`${spec.id} does NOT fire when AllowOrigins does not contain "*"`, () => {
    const state = {
      CorsConfiguration: { AllowOrigins: ["https://example.com"] },
    };
    const findings = findingsFor(spec.id, spec.resourceType, state);
    const matching = findings.filter((f) => f.practiceId === spec.id);
    expect(matching.length).toBe(0);
  });
}

// ---------------------------------------------------------------------------
// Test suites by service
// ---------------------------------------------------------------------------

describe("BP All Rules Audit", () => {
  describe("S3 (15 rules)", () => {
    for (const spec of s3Rules) {
      runRuleTests(spec);
    }
  });

  describe("EC2 Instance (20 rules)", () => {
    for (const spec of ec2Rules) {
      if (spec.id === "BP-EC2-010") {
        runNotContainsArrayTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("SecurityGroup (5 rules)", () => {
    for (const spec of sgRules) {
      runRuleTests(spec);
    }
  });

  describe("InternetGateway (2 rules)", () => {
    for (const spec of igwRules) {
      runRuleTests(spec);
    }
  });

  describe("NatGateway (3 rules)", () => {
    for (const spec of natRules) {
      runRuleTests(spec);
    }
  });

  describe("Route / Subnet routing (2 rules)", () => {
    for (const spec of rtRules) {
      runRuleTests(spec);
    }
  });

  describe("RDS (13 rules)", () => {
    for (const spec of rdsRules) {
      runRuleTests(spec);
    }
  });

  describe("Lambda (13 rules)", () => {
    for (const spec of lambdaRules) {
      runRuleTests(spec);
    }
  });

  describe("IAM (16 rules)", () => {
    for (const spec of iamRules) {
      runRuleTests(spec);
    }
  });

  describe("DynamoDB (5 rules)", () => {
    for (const spec of dynamodbRules) {
      runRuleTests(spec);
    }
  });

  describe("ECS (9 rules)", () => {
    for (const spec of ecsRules) {
      runRuleTests(spec);
    }
  });

  describe("CloudWatch (5 rules)", () => {
    for (const spec of cloudwatchRules) {
      runRuleTests(spec);
    }
  });

  describe("SQS (9 rules)", () => {
    for (const spec of sqsRules) {
      runRuleTests(spec);
    }
  });

  describe("Secrets Manager (5 rules)", () => {
    for (const spec of smRules) {
      if (spec.id === "BP-SM-004") {
        runSmContainsTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("SNS (7 rules)", () => {
    for (const spec of snsRules) {
      runRuleTests(spec);
    }
  });

  describe("API Gateway (6 rules)", () => {
    for (const spec of apigwRules) {
      if (spec.id === "BP-APIGW-002") {
        runApigwNotContainsTests(spec);
      } else {
        runRuleTests(spec);
      }
    }
  });

  describe("ECR (3 rules)", () => {
    for (const spec of ecrRules) {
      runRuleTests(spec);
    }
  });

  describe("ELBv2 (8 rules)", () => {
    // BP-ELB-001..003 use LoadBalancerAttributes[bracket.key] paths that
    // need the dedicated runElbRuleTests helper. BP-ELB-004..008 (A5.4)
    // are simple property or awareness checks on Listener/LoadBalancer
    // and go through the standard runRuleTests harness.
    const bracketKeyRules = elbRules.filter((r) =>
      r.propertyPath.includes("["),
    );
    const simpleRules = elbRules.filter((r) => !r.propertyPath.includes("["));
    for (const spec of bracketKeyRules) {
      runElbRuleTests(spec);
    }
    for (const spec of simpleRules) {
      runRuleTests(spec);
    }
  });

  describe("Logs (3 rules)", () => {
    for (const spec of logsRules) {
      runRuleTests(spec);
    }
  });

  describe("SSM (3 rules)", () => {
    for (const spec of ssmRules) {
      runRuleTests(spec);
    }
  });

  describe("VPC / Subnet (3 rules)", () => {
    for (const spec of vpcRules) {
      runRuleTests(spec);
    }
  });

  describe("AutoScaling (3 rules)", () => {
    for (const spec of asgRules) {
      runRuleTests(spec);
    }
  });

  describe("EFS (2 rules — A1)", () => {
    for (const spec of efsRules) {
      runRuleTests(spec);
    }
  });

  describe("KMS (1 Key rule — A11)", () => {
    for (const spec of kmsRules) {
      runRuleTests(spec);
    }
  });

  describe("CloudFront (1 Distribution rule — A14)", () => {
    for (const spec of cloudFrontRules) {
      runRuleTests(spec);
    }
  });

  describe("EventBridge (4 Rule rules — A8, 3 EventBus rules — A9, 2 Connection/ApiDestination rules — A12+A13)", () => {
    for (const spec of eventsRules) {
      runRuleTests(spec);
    }

    // Targeted regression test for the exists-semantics fix landed
    // in A8 (see packages/best-practices/src/evaluate.ts comment).
    // BP-EVENTS-001 must fire on `Targets: []` — not just missing
    // Targets. Before the fix, the empty-array case silently
    // passed the `exists` check because `[] !== undefined`.
    it("BP-EVENTS-001 fires on empty Targets array (A8 exists semantics)", () => {
      const findings = findingsFor("BP-EVENTS-001", "AWS::Events::Rule", {
        Targets: [],
      });
      expect(
        findings.some((f) => f.practiceId === "BP-EVENTS-001"),
        "BP-EVENTS-001 must fire on empty Targets array",
      ).toBe(true);
    });

    it("BP-EVENTS-001 passes with one valid Target entry", () => {
      const findings = findingsFor("BP-EVENTS-001", "AWS::Events::Rule", {
        Targets: [
          {
            Id: "lambda-target",
            Arn: "arn:aws:lambda:us-east-1:123456789012:function:test",
          },
        ],
      });
      expect(
        findings.filter((f) => f.practiceId === "BP-EVENTS-001").length,
      ).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Meta-test: verify all 138 rule IDs are covered
  // ---------------------------------------------------------------------------

  describe("Coverage meta-check", () => {
    const allSpecs = [
      ...s3Rules,
      ...ec2Rules,
      ...sgRules,
      ...igwRules,
      ...natRules,
      ...rtRules,
      ...vpcNetworkRules,
      ...rdsRules,
      ...lambdaRules,
      ...iamRules,
      ...dynamodbRules,
      ...ecsRules,
      ...cloudwatchRules,
      ...sqsRules,
      ...smRules,
      ...snsRules,
      ...apigwRules,
      ...ecrRules,
      ...elbRules,
      ...logsRules,
      ...ssmRules,
      ...vpcRules,
      ...asgRules,
      ...efsRules,
      ...eventsRules,
      ...kmsRules,
      ...cloudFrontRules,
    ];

    it("covers exactly 165 rule specs", () => {
      // 131 pre-A5
      // + 6 Tier-1 IAM rules       (BP-IAM-011..016)
      // + 9 Tier-3 policy rules    (BP-S3-018..020, BP-SQS-006..009, BP-SNS-005..006)
      // + 5 Tier-2 ELBv2 rules     (BP-ELB-004..008)
      // + 5 Tier-4 APIGW/Lambda    (BP-APIGW-004..006, BP-LAMBDA-013..014)
      // + 2 Tier-5 AutoScaling     (BP-ASG-002..003)
      //   Notes on ID collisions vs the original gap memo:
      //   - BP-S3-015..017 already taken (replication / intelligent
      //     tiering / access logging) → resource-policy rules start at
      //     BP-S3-018.
      //   - BP-LAMBDA-011/012 already taken (nodejs16.x runtime + code
      //     signing) → Lambda::Permission rules start at BP-LAMBDA-013.
      //   - BP-DYNAMODB-006 already taken (on-demand/auto-scaled
      //     capacity) → the memo's proposed DynamoDB backup-plan rule
      //     was dropped because BP-DYNAMODB-001 (PITR) already covers
      //     the recoverable-backup concern.
      // + 2 A1 rules                 (BP-EFS-001 encrypted, BP-EFS-002 backup)
      // + 1 A1-warmup rule            (BP-IAM-017 elevated *FullAccess —
      //   uses not_contains_pattern, a new check_type added alongside
      //   the rule for regex matching over array-of-strings fields)
      // + 1 A1 follow-up rule         (BP-EFS-003 SecureTransport —
      //   reuses the existing policy_antipattern check with
      //   allow-plus-not-action to catch Deny-inversion bypasses)
      // + 3 A8 EventBridge rules      (BP-EVENTS-001 Targets required,
      //   BP-EVENTS-002 Description hygiene, BP-EVENTS-003 State=ENABLED
      //   default). Together with the A8 Events::Rule resource-type
      //   promotion (plugin + pricing + IAM actions), these give the
      //   new type full BP coverage on par with the established types.
      // + 1 A8 follow-up rule         (BP-LAMBDA-015 X-Ray tracing must
      //   be Active — covers cold-start + EventBridge-invoked paths
      //   that PassThrough mode misses).
      // + 1 A8 awareness rule          (BP-EVENTS-004 schedule
      //   frequency + retry amplification cost awareness). Always
      //   fires to surface the cost lever at plan time.
      // + 3 A9 EventBus rules          (BP-EVENTBUS-001 KMS encryption,
      //   BP-EVENTBUS-002 Description hygiene, BP-EVENTBUS-003 DLQ
      //   for unrouted events). Locks in the secure-by-default
      //   posture for the new first-class type.
      // + 1 A10 SNS Subscription rule  (BP-SNS-007 RedrivePolicy DLQ
      //   required). Closes the silent-drop failure mode on the
      //   newly-promoted first-class AWS::SNS::Subscription type.
      //   Named BP-SNS-007 (not BP-SNS-SUB-001) so it matches the
      //   manifest-schema BP-{SERVICE}-{NNN} pattern.
      // + 1 A11 KMS::Key rule          (BP-KMS-001 EnableKeyRotation
      //   must be true). Enforces the compliance default that every
      //   auditor checks for on the newly-promoted first-class
      //   AWS::KMS::Key type — automatic annual rotation bounds
      //   single-key-version exposure to ~365 days of ciphertext.
      // + 2 A12+A13 EventBridge rules  (BP-EVENTS-005 Connection
      //   KmsKeyIdentifier recommended, BP-EVENTS-006 ApiDestination
      //   InvocationRateLimitPerSecond awareness). Closes the zero-
      //   BP gap the post-A13 `assignee types show` smoke test
      //   surfaced for the two new first-class outbound-HTTP types.
      // + 1 A14 CloudFront rule        (BP-CF-001 ViewerProtocolPolicy
      //   must be redirect-to-https). The canonical CloudFront
      //   security finding — unencrypted HTTP at the edge is a
      //   mandatory gate under PCI-DSS / HIPAA / most enterprise
      //   security baselines.
      // + 9 (f) 2026-04-09 Task 9 Epic 30 Phase 2 WA expansion rules:
      //   BP-S3-007 AbortIncompleteMultipartUpload (cost_optimization),
      //   BP-S3BP-001 wildcard-principal policy_antipattern guard
      //   (security + blocking, non-fixable), BP-DYNAMODB-004
      //   ContributorInsights (performance observability), BP-KMS-002
      //   PendingWindowInDays>=30 (reliability recovery window),
      //   BP-IAM-018 MaxSessionDuration cap (security leak exposure),
      //   BP-CF-002 CloudFront access logging (security forensics),
      //   BP-OAC-001 SigningBehavior=always (security, critical +
      //   blocking + auto-fixable; Task 4b companion for the new OAC
      //   resource type), BP-LAMBDA-008 explicit Timeout (reliability),
      //   BP-APIGW-007 DisableExecuteApiEndpoint (security — default
      //   URL bypasses custom-domain WAF/throttling).
      expect(allSpecs.length).toBe(185);
    });

    it("every spec ID exists in the loaded YAML library", () => {
      const loadedIds = new Set(allPractices.map((bp) => bp.id));
      const missing = allSpecs.filter((s) => !loadedIds.has(s.id));
      expect(
        missing.map((s) => s.id),
        `These rule IDs are in the test specs but not in the YAML library`,
      ).toEqual([]);
    });

    it("every loaded YAML rule has a test spec", () => {
      const specIds = new Set(allSpecs.map((s) => s.id));
      const untested = allPractices.filter((bp) => !specIds.has(bp.id));
      expect(
        untested.map((bp) => bp.id),
        `These YAML rules have no test spec`,
      ).toEqual([]);
    });
  });

  describe("blocking rules safety net", () => {
    it("every blocking rule has a fix mechanism (auto or interactive)", () => {
      const blockingRules = allPractices.filter((r) => r.blocking === true);
      for (const rule of blockingRules) {
        const hasFix =
          rule.desiredStatePatch != null || rule.fixType === "interactive";
        expect(hasFix, `${rule.id} is blocking but has no fix mechanism`).toBe(
          true,
        );
      }
    });
  });
});
