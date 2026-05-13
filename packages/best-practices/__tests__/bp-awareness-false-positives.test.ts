/**
 * DF-A1+E3 regression suite — BP awareness → equals conversion.
 *
 * Three rules formerly typed `check_type: awareness` unconditionally fired
 * for every plan of the matched resource type, even when the user's plan
 * ALREADY had the recommended state. This produced false-positive findings
 * that eroded trust in the BP engine.
 *
 * Fix: converted to `check_type: equals` so the rule-runner consults
 * desiredState via `fieldValue === expectedValue`. The check PASSES (no
 * finding) when the field matches expected; FAILS (finding fires) when absent
 * or set to a different value. Absent field → undefined, and
 * `undefined === <any-string>` is false → rule fires (correct behaviour —
 * AWS defaults to the bad state when the property is omitted).
 *
 * Rules fixed:
 *   BP-DYNAMODB-005 — BillingMode must equal PAY_PER_REQUEST to pass
 *   BP-RDS-014      — MultiAZ must equal true to pass
 *   BP-SSM-003      — Type must equal "SecureString" to pass
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { evaluateTriggers } from "../src/evaluate.js";
import type { EvalContext } from "../src/evaluate.js";
import type { BestPractice } from "../src/types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

function loadBp(relPath: string): BestPractice {
  const raw = readFileSync(resolve(__dirname, relPath), "utf-8");
  return parseYaml(raw) as BestPractice;
}

// ---------------------------------------------------------------------------
// BP-DYNAMODB-005 — DynamoDB auto-scaling / on-demand billing
// ---------------------------------------------------------------------------

describe("BP-DYNAMODB-005 YAML manifest", () => {
  it("declares check_type: equals (no longer awareness)", () => {
    const bp = loadBp("../dynamodb/BP-DYNAMODB-005.yaml");
    expect(bp.check_type).toBe("equals");
  });

  it('declares expected_value: "PAY_PER_REQUEST"', () => {
    const bp = loadBp("../dynamodb/BP-DYNAMODB-005.yaml");
    expect(bp.expected_value).toBe("PAY_PER_REQUEST");
  });
});

describe("BP-DYNAMODB-005 evaluateTriggers — negative fixtures (must NOT fire)", () => {
  const bp = loadBp("../dynamodb/BP-DYNAMODB-005.yaml");
  const practices = [bp];

  it("does NOT fire when BillingMode is PAY_PER_REQUEST (on-demand — the recommended state)", () => {
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "UserSessions",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        Tags: [{ Key: "Env", Value: "prod" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-005"),
    ).toBeUndefined();
  });
});

describe("BP-DYNAMODB-005 evaluateTriggers — positive fixtures (must fire)", () => {
  const bp = loadBp("../dynamodb/BP-DYNAMODB-005.yaml");
  const practices = [bp];

  it("DOES fire when BillingMode is PROVISIONED (auto-scaling absent)", () => {
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "OrdersTable",
        BillingMode: "PROVISIONED",
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        AttributeDefinitions: [
          { AttributeName: "orderId", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-005"),
    ).toBeDefined();
  });

  it("DOES fire when BillingMode is absent (DDB default = PROVISIONED, no auto-scaling)", () => {
    // When BillingMode is omitted, DynamoDB defaults to PROVISIONED. The
    // equals evaluator sees undefined === "PAY_PER_REQUEST" → false →
    // rule fails → finding fires. This is the correct behaviour.
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "LegacyTable",
        ProvisionedThroughput: {
          ReadCapacityUnits: 10,
          WriteCapacityUnits: 10,
        },
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        Tags: [{ Key: "Team", Value: "platform" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-005"),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BP-DYNAMODB-006 — same class as BP-DYNAMODB-005; Wave 3 conversion
// from check_type:awareness → check_type:equals so PAY_PER_REQUEST plans
// no longer false-positive. Live verify on commit 0341d856 still showed
// this INFO-severity rule firing on PAY_PER_REQUEST plans with the
// "Switch to PAY_PER_REQUEST billing mode" remediation (useless when
// already on-demand) — DF-BP-006-PAY-PER-REQUEST.
// ---------------------------------------------------------------------------

describe("BP-DYNAMODB-006 YAML manifest", () => {
  it("declares check_type: equals (no longer awareness)", () => {
    const bp = loadBp("../dynamodb/BP-DYNAMODB-006.yaml");
    expect(bp.check_type).toBe("equals");
  });

  it('declares expected_value: "PAY_PER_REQUEST"', () => {
    const bp = loadBp("../dynamodb/BP-DYNAMODB-006.yaml");
    expect(bp.expected_value).toBe("PAY_PER_REQUEST");
  });
});

describe("BP-DYNAMODB-006 evaluateTriggers — negative fixtures (must NOT fire)", () => {
  const bp = loadBp("../dynamodb/BP-DYNAMODB-006.yaml");
  const practices = [bp];

  it("does NOT fire when BillingMode is PAY_PER_REQUEST (on-demand — the recommended state)", () => {
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "UserSessions",
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [{ AttributeName: "pk", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-006"),
    ).toBeUndefined();
  });
});

describe("BP-DYNAMODB-006 evaluateTriggers — positive fixtures (must fire)", () => {
  const bp = loadBp("../dynamodb/BP-DYNAMODB-006.yaml");
  const practices = [bp];

  it("DOES fire when BillingMode is PROVISIONED (the multi-day-metrics caveat still applies — INFO severity)", () => {
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "OrdersTable",
        BillingMode: "PROVISIONED",
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
        AttributeDefinitions: [
          { AttributeName: "orderId", AttributeType: "S" },
        ],
        KeySchema: [{ AttributeName: "orderId", KeyType: "HASH" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-006"),
    ).toBeDefined();
  });

  it("DOES fire when BillingMode is absent (default = PROVISIONED)", () => {
    const context: EvalContext = {
      resourceType: "AWS::DynamoDB::Table",
      desiredState: {
        TableName: "LegacyTable",
        ProvisionedThroughput: {
          ReadCapacityUnits: 10,
          WriteCapacityUnits: 10,
        },
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(
      findings.find((f) => f.practiceId === "BP-DYNAMODB-006"),
    ).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BP-RDS-014 — RDS Multi-AZ
// ---------------------------------------------------------------------------

describe("BP-RDS-014 YAML manifest", () => {
  it("declares check_type: equals (no longer awareness)", () => {
    const bp = loadBp("../rds/BP-RDS-014.yaml");
    expect(bp.check_type).toBe("equals");
  });

  it("declares expected_value: true", () => {
    const bp = loadBp("../rds/BP-RDS-014.yaml");
    expect(bp.expected_value).toBe(true);
  });
});

describe("BP-RDS-014 evaluateTriggers — negative fixtures (must NOT fire)", () => {
  const bp = loadBp("../rds/BP-RDS-014.yaml");
  const practices = [bp];

  it("does NOT fire when MultiAZ is true (Multi-AZ already enabled)", () => {
    const context: EvalContext = {
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        DBInstanceIdentifier: "prod-postgres",
        DBInstanceClass: "db.r6g.large",
        Engine: "postgres",
        EngineVersion: "15.4",
        MultiAZ: true,
        StorageType: "gp3",
        AllocatedStorage: 100,
        MasterUsername: "adminuser",
        DBName: "appdb",
        VPCSecurityGroups: ["sg-0abc123456def789a"],
        DBSubnetGroupName: "prod-db-subnet-group",
        BackupRetentionPeriod: 7,
        Tags: [{ Key: "Env", Value: "prod" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-RDS-014")).toBeUndefined();
  });
});

describe("BP-RDS-014 evaluateTriggers — positive fixtures (must fire)", () => {
  const bp = loadBp("../rds/BP-RDS-014.yaml");
  const practices = [bp];

  it("DOES fire when MultiAZ is false (single-AZ, no failover)", () => {
    const context: EvalContext = {
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        DBInstanceIdentifier: "staging-mysql",
        DBInstanceClass: "db.t3.medium",
        Engine: "mysql",
        EngineVersion: "8.0.35",
        MultiAZ: false,
        StorageType: "gp2",
        AllocatedStorage: 50,
        MasterUsername: "root",
        DBName: "staging",
        VPCSecurityGroups: ["sg-0def456789abc012b"],
        DBSubnetGroupName: "staging-db-subnet-group",
        BackupRetentionPeriod: 1,
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-RDS-014")).toBeDefined();
  });

  it("DOES fire when MultiAZ is absent (default = single-AZ)", () => {
    // When MultiAZ is omitted, RDS defaults to single-AZ. The equals
    // evaluator sees undefined === true → false → rule fails → finding fires.
    const context: EvalContext = {
      resourceType: "AWS::RDS::DBInstance",
      desiredState: {
        DBInstanceIdentifier: "dev-aurora",
        DBInstanceClass: "db.t3.small",
        Engine: "aurora-postgresql",
        EngineVersion: "15.4",
        StorageType: "aurora",
        MasterUsername: "devadmin",
        DBSubnetGroupName: "dev-subnet-group",
        VPCSecurityGroups: ["sg-0aaa111222bbb333c"],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-RDS-014")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// BP-SSM-003 — SSM Parameter SecureString type
// ---------------------------------------------------------------------------

describe("BP-SSM-003 YAML manifest", () => {
  it("declares check_type: equals (no longer awareness)", () => {
    const bp = loadBp("../ssm/BP-SSM-003.yaml");
    expect(bp.check_type).toBe("equals");
  });

  it('declares expected_value: "SecureString"', () => {
    const bp = loadBp("../ssm/BP-SSM-003.yaml");
    expect(bp.expected_value).toBe("SecureString");
  });
});

describe("BP-SSM-003 evaluateTriggers — negative fixtures (must NOT fire)", () => {
  const bp = loadBp("../ssm/BP-SSM-003.yaml");
  const practices = [bp];

  it("does NOT fire when Type is SecureString (KMS-encrypted, the recommended state)", () => {
    const context: EvalContext = {
      resourceType: "AWS::SSM::Parameter",
      desiredState: {
        Name: "/prod/db/password",
        Type: "SecureString",
        Value: "{{resolve:secretsmanager:prod/db:SecretString:password}}",
        Description: "Production DB master password",
        KeyId: "alias/aws/ssm",
        Tags: [
          { Key: "Env", Value: "prod" },
          { Key: "Sensitive", Value: "true" },
        ],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-SSM-003")).toBeUndefined();
  });
});

describe("BP-SSM-003 evaluateTriggers — positive fixtures (must fire)", () => {
  const bp = loadBp("../ssm/BP-SSM-003.yaml");
  const practices = [bp];

  it('DOES fire when Type is "String" (plaintext — passwords exposed in API responses)', () => {
    const context: EvalContext = {
      resourceType: "AWS::SSM::Parameter",
      desiredState: {
        Name: "/prod/api/token",
        Type: "String",
        Value: "s3cr3t-api-k3y",
        Description: "Third-party API key",
        Tags: [{ Key: "Env", Value: "prod" }],
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-SSM-003")).toBeDefined();
  });

  it('DOES fire when Type is "StringList" (also plaintext)', () => {
    const context: EvalContext = {
      resourceType: "AWS::SSM::Parameter",
      desiredState: {
        Name: "/prod/allowed/ips",
        Type: "StringList",
        Value: "10.0.0.1,10.0.0.2",
        Description: "Allowed IP list",
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-SSM-003")).toBeDefined();
  });

  it("DOES fire when Type is absent (no type = plaintext default)", () => {
    // When Type is omitted, CFN defaults to String (plaintext). The
    // equals evaluator sees undefined === "SecureString" → false →
    // rule fails → finding fires.
    const context: EvalContext = {
      resourceType: "AWS::SSM::Parameter",
      desiredState: {
        Name: "/config/feature-flag",
        Value: "true",
        Description: "Feature flag toggle",
      },
    };
    const findings = evaluateTriggers(context, practices);
    expect(findings.find((f) => f.practiceId === "BP-SSM-003")).toBeDefined();
  });
});
