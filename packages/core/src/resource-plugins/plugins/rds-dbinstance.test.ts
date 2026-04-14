import { describe, it, expect } from "vitest";
import { rdsDbInstancePlugin } from "./rds-dbinstance.js";

describe("rdsDbInstancePlugin", () => {
  // ── Task 4.1 / AC #6: DBName field ────────────────────────────────────

  it("has DBName field in commonFields with correct config", () => {
    // Tier C: strengthened — toMatchObject locks the full shape and the
    // `find!` non-null assertion makes the test fail naturally if the
    // field is missing instead of silently passing the `field?.foo` chain.
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DBName",
    )!;
    expect(field).toMatchObject({
      name: "DBName",
      question: {
        type: "string",
        placeholder: "myapp",
      },
    });
    expect(field.question.hint).toContain("initial database");
  });

  // ── Task 4.2 / AC #7: EngineVersion field ─────────────────────────────

  it("has per-engine EngineVersion fields with showIf conditions", () => {
    const versionFields = rdsDbInstancePlugin.commonFields.filter(
      (f) => f.name === "EngineVersion",
    );
    expect(versionFields.length).toBe(5);
    // Each is filtered by engine
    const engines = versionFields.map((f) => f.question.showIf?.value);
    expect(engines).toContain("postgres");
    expect(engines).toContain("mysql");
    expect(engines).toContain("mariadb");
    expect(engines).toContain("aurora-mysql");
    expect(engines).toContain("aurora-postgresql");
  });

  it("PostgreSQL EngineVersion includes versions 15 and 16", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) =>
        f.name === "EngineVersion" && f.question.showIf?.value === "postgres",
    );
    const values = field!.question.options!.map((o) => o.value);
    expect(values).toContain("15");
    expect(values).toContain("16");
  });

  it("MySQL EngineVersion includes versions 8.0 and 8.4", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "EngineVersion" && f.question.showIf?.value === "mysql",
    );
    const values = field!.question.options!.map((o) => o.value);
    expect(values).toContain("8.0");
    expect(values).toContain("8.4");
  });

  // ── Task 5.1 / AC #8: DeletionProtection in commonFields ──────────────

  it("has DeletionProtection in commonFields, not advancedFields", () => {
    // Tier C: strengthened — assert the field's shape, not just existence.
    // RDS deletion protection is a destruction safeguard so the type
    // (boolean) and required flag matter; if a refactor demoted this to
    // string we'd want CI to catch it.
    const inCommon = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DeletionProtection",
    );
    const inAdvanced = rdsDbInstancePlugin.advancedFields.find(
      (f) => f.name === "DeletionProtection",
    );
    expect(inCommon).toMatchObject({
      name: "DeletionProtection",
      question: { type: "boolean" },
    });
    expect(inAdvanced).toBeUndefined();
  });

  it("DeletionProtection appears after MultiAZ in commonFields", () => {
    const names = rdsDbInstancePlugin.commonFields.map((f) => f.name);
    const multiAzIdx = names.indexOf("MultiAZ");
    const delProtIdx = names.indexOf("DeletionProtection");
    expect(multiAzIdx).toBeGreaterThanOrEqual(0);
    expect(delProtIdx).toBe(multiAzIdx + 1);
  });

  // ── Task 5.2 / AC #10: Memory-optimized instance classes ──────────────

  it("has memory-optimized instance classes in DBInstanceClass options", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DBInstanceClass",
    );
    const values = field!.question.options!.map((o) => o.value);
    expect(values).toContain("db.r5.large");
    expect(values).toContain("db.r6g.large");
    expect(values).toContain("db.r6g.xlarge");
  });

  // ── Task 6.2 / AC #11: MasterUsername placeholder ─────────────────────

  it("has MasterUsername placeholder as 'appuser'", () => {
    // Tier C: strengthened
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUsername",
    )!;
    expect(field).toMatchObject({
      name: "MasterUsername",
      question: { placeholder: "appuser" },
    });
  });

  // ── Story 18.11: Tags field ──────────────────────────────────────────────

  it("Tags field is string type with callable toCfn transform", () => {
    // Tier C: strengthened — assert toCfn is actually a callable function,
    // not just non-undefined (which would pass for any literal).
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!;
    expect(field.question.type).toBe("string");
    expect(typeof field.toCfn).toBe("function");
    // Smoke-test the transform with a real comma-separated tag string
    const result = field.toCfn!("env:prod, owner:platform");
    expect(result).toEqual([
      { Key: "env", Value: "prod" },
      { Key: "owner", Value: "platform" },
    ]);
  });

  // ── Story 18.11: MasterUserPassword field ────────────────────────────────

  it("has MasterUserPassword field in commonFields", () => {
    // Tier C: strengthened
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUserPassword",
    )!;
    expect(field).toMatchObject({
      name: "MasterUserPassword",
      question: {
        type: "string",
        placeholder: "Auto-generated if blank",
      },
    });
  });

  // ── Story 18.11: AllocatedStorage field ──────────────────────────────────

  it("has AllocatedStorage field in commonFields with enum type", () => {
    // Tier C: strengthened
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "AllocatedStorage",
    )!;
    expect(field).toMatchObject({
      name: "AllocatedStorage",
      question: {
        type: "enum",
        initialValue: "20",
      },
    });
    const values = field.question.options!.map((o) => o.value);
    expect(values).toEqual(["20", "50", "100", "200"]);
  });

  // ── Story 18.11: BackupRetentionPeriod validation ────────────────────────

  describe("BackupRetentionPeriod validation", () => {
    const field = rdsDbInstancePlugin.advancedFields.find(
      (f) => f.name === "BackupRetentionPeriod",
    )!;

    it("accepts empty value", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid integer within range", () => {
      expect(field.question.validate?.("7")).toBeUndefined();
      expect(field.question.validate?.("0")).toBeUndefined();
      expect(field.question.validate?.("35")).toBeUndefined();
    });

    it("rejects negative values with range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("-1")).toBe(
        "Backup retention must be an integer between 0 and 35",
      );
    });

    it("rejects values > 35 with range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("36")).toBe(
        "Backup retention must be an integer between 0 and 35",
      );
    });

    it("rejects non-integer values with range error", () => {
      // Tier C: strengthened from toBeDefined()
      expect(field.question.validate?.("7.5")).toBe(
        "Backup retention must be an integer between 0 and 35",
      );
    });

    it("accepts 35 (upper boundary)", () => {
      // Tier C: new boundary test
      expect(field.question.validate?.("35")).toBeUndefined();
    });

    it("accepts 0 (lower boundary — disables backups)", () => {
      // Tier C: 0 is the documented disable-backups value, must remain valid
      expect(field.question.validate?.("0")).toBeUndefined();
    });
  });

  describe("configHints", () => {
    it("has at least 3 configHints (Tier C: was toBeDefined+>0)", () => {
      // Tier C: strengthened — meaningful floor instead of just "exists"
      expect(rdsDbInstancePlugin.configHints).toBeInstanceOf(Array);
      expect(rdsDbInstancePlugin.configHints!.length).toBeGreaterThanOrEqual(3);
    });

    it("includes guidance about MasterUserPassword auto-generation", () => {
      const hints = rdsDbInstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/MasterUserPassword/i);
      expect(hints).toMatch(/OMIT/i);
    });

    it("includes guidance about EngineVersion validity", () => {
      const hints = rdsDbInstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/EngineVersion/i);
      expect(hints).toMatch(/deprecated/i);
    });

    it("includes guidance about PubliclyAccessible and VPC", () => {
      const hints = rdsDbInstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/PubliclyAccessible/i);
      expect(hints).toMatch(/VPCSecurityGroups/i);
    });

    it("includes guidance about observability", () => {
      const hints = rdsDbInstancePlugin.configHints!.join(" ");
      expect(hints).toMatch(/CloudwatchLogsExports/i);
      expect(hints).toMatch(/PerformanceInsights/i);
    });
  });

  describe("companionResources", () => {
    it("returns SG with port 5432 for postgres engine", () => {
      const companions = rdsDbInstancePlugin.companionResources!({
        Engine: "postgres",
        DBInstanceClass: "db.t3.micro",
      });
      expect(companions).toHaveLength(1);
      expect(companions[0]!.type).toBe("AWS::EC2::SecurityGroup");
      const ingress = companions[0]!.properties[
        "SecurityGroupIngress"
      ] as Array<{ FromPort?: number; CidrIp?: string }>;
      expect(ingress.some((r) => r.FromPort === 5432)).toBe(true);
    });

    it("returns SG with port 3306 for mysql engine", () => {
      const companions = rdsDbInstancePlugin.companionResources!({
        Engine: "mysql",
        DBInstanceClass: "db.t3.micro",
      });
      expect(companions).toHaveLength(1);
      const ingress = companions[0]!.properties[
        "SecurityGroupIngress"
      ] as Array<{ FromPort?: number; CidrIp?: string }>;
      expect(ingress.some((r) => r.FromPort === 3306)).toBe(true);
    });

    it("returns empty when VPCSecurityGroups already specified", () => {
      // CCAPI/CFN uses "VPCSecurityGroups" (verified via describe-type),
      // not the legacy SDK-style "VpcSecurityGroupIds".
      const companions = rdsDbInstancePlugin.companionResources!({
        VPCSecurityGroups: ["sg-abc123"],
        Engine: "postgres",
      });
      expect(companions).toHaveLength(0);
    });

    it("SG allows 10.0.0.0/8 (private network)", () => {
      const companions = rdsDbInstancePlugin.companionResources!({
        Engine: "postgres",
        DBInstanceClass: "db.r5.large",
      });
      expect(companions).toHaveLength(1);
      const ingress = companions[0]!.properties[
        "SecurityGroupIngress"
      ] as Array<{ FromPort?: number; CidrIp?: string }>;
      expect(ingress.some((r) => r.CidrIp === "10.0.0.0/8")).toBe(true);
    });
  });
});
