import { describe, it, expect } from "vitest";
import { rdsDbInstancePlugin } from "./rds-dbinstance.js";

describe("rdsDbInstancePlugin", () => {
  it("has the correct resourceType", () => {
    expect(rdsDbInstancePlugin.resourceType).toBe("AWS::RDS::DBInstance");
  });

  it("commonFields count is ≤10 (AC-6)", () => {
    expect(rdsDbInstancePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("commonFields count is 6", () => {
    expect(rdsDbInstancePlugin.commonFields.length).toBe(6);
  });

  it("all commonField question types are valid QuestionType values", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of rdsDbInstancePlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("DBInstanceClass is enum with db.t3.micro default", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "DBInstanceClass",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("db.t3.micro");
    expect(field?.question.options?.length).toBeGreaterThan(0);
  });

  it("Engine is enum including postgres option", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "Engine",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    const values = field?.question.options?.map((o) => o.value) ?? [];
    expect(values).toContain("postgres");
    expect(values).toContain("mysql");
  });

  it("MasterUsername validate rejects empty string", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUsername",
    );
    expect(field?.question.validate).toBeDefined();
    expect(field?.question.validate?.("")).toBeDefined();
    expect(typeof field?.question.validate?.("")).toBe("string");
  });

  it("MasterUsername validate accepts non-empty string", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MasterUsername",
    );
    expect(field?.question.validate?.("admin")).toBeUndefined();
  });

  it("MultiAZ is a boolean field", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "MultiAZ",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("boolean");
    expect(field?.question.initialValue).toBe(false);
  });

  it("StorageType is enum with gp3 default", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "StorageType",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("enum");
    expect(field?.question.initialValue).toBe("gp3");
  });

  it("Tags field is multi type", () => {
    const field = rdsDbInstancePlugin.commonFields.find(
      (f) => f.name === "Tags",
    );
    expect(field).toBeDefined();
    expect(field?.question.type).toBe("multi");
  });

  it("defaults contain StorageType gp3 and MultiAZ false", () => {
    expect(rdsDbInstancePlugin.defaults["StorageType"]).toBe("gp3");
    expect(rdsDbInstancePlugin.defaults["MultiAZ"]).toBe(false);
  });

  it("advancedFields contains BackupRetentionPeriod and DeletionProtection", () => {
    const names = rdsDbInstancePlugin.advancedFields.map((f) => f.name);
    expect(names).toContain("BackupRetentionPeriod");
    expect(names).toContain("DeletionProtection");
  });
});
