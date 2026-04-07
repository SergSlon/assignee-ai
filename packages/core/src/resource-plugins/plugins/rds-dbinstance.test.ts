import { describe, it, expect } from "vitest";
import { rdsDbInstancePlugin } from "./rds-dbinstance.js";

describe("rdsDbInstancePlugin", () => {
  // ── Task 4.1 / AC #6: DBName field ────────────────────────────────────

  it("has DBName field in commonFields with correct config", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DBName",
    );
    expect(field).toBeDefined();
    expect(field!.question.type).toBe("string");
    expect(field!.question.placeholder).toBe("myapp");
    expect(field!.question.hint).toContain("initial database");
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
    const inCommon = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DeletionProtection",
    );
    const inAdvanced = rdsDbInstancePlugin.advancedFields.find(
      (f) => f.name === "DeletionProtection",
    );
    expect(inCommon).toBeDefined();
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
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUsername",
    );
    expect(field).toBeDefined();
    expect(field!.question.placeholder).toBe("appuser");
  });

  // ── Story 18.11: Tags field ──────────────────────────────────────────────

  it("Tags field is string type with toCfn transform", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("string");
    expect(field?.toCfn).toBeDefined();
  });

  // ── Story 18.11: MasterUserPassword field ────────────────────────────────

  it("has MasterUserPassword field in commonFields", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUserPassword",
    );
    expect(field).toBeDefined();
    expect(field!.question.type).toBe("string");
    expect(field!.question.placeholder).toBe("Auto-generated if blank");
  });

  // ── Story 18.11: AllocatedStorage field ──────────────────────────────────

  it("has AllocatedStorage field in commonFields with enum type", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "AllocatedStorage",
    );
    expect(field).toBeDefined();
    expect(field!.question.type).toBe("enum");
    expect(field!.question.initialValue).toBe("20");
    const values = field!.question.options!.map((o) => o.value);
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

    it("rejects negative values", () => {
      expect(field.question.validate?.("-1")).toBeDefined();
    });

    it("rejects values > 35", () => {
      expect(field.question.validate?.("36")).toBeDefined();
    });

    it("rejects non-integer values", () => {
      expect(field.question.validate?.("7.5")).toBeDefined();
    });
  });

  describe("configHints", () => {
    it("has configHints defined", () => {
      expect(rdsDbInstancePlugin.configHints).toBeDefined();
      expect(rdsDbInstancePlugin.configHints!.length).toBeGreaterThan(0);
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
      expect(hints).toMatch(/VpcSecurityGroupIds/i);
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

    it("returns empty when VpcSecurityGroupIds already specified", () => {
      rdsDbInstancePlugin.companionResources!({
        VPCSecurityGroups: ["sg-abc123"],
        Engine: "postgres",
      });
      // VPCSecurityGroups is not the right key; check with VpcSecurityGroupIds
      const companions2 = rdsDbInstancePlugin.companionResources!({
        VpcSecurityGroupIds: ["sg-abc123"],
        Engine: "postgres",
      });
      expect(companions2).toHaveLength(0);
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
