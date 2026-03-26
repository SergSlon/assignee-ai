import { describe, it, expect } from "vitest";
import { dynamodbTablePlugin } from "./dynamodb-table.js";

describe("dynamodbTablePlugin", () => {
  it("has the correct resource type", () => {
    expect(dynamodbTablePlugin.resourceType).toBe("AWS::DynamoDB::Table");
  });

  it("has ≤10 common fields", () => {
    expect(dynamodbTablePlugin.commonFields.length).toBeLessThanOrEqual(10);
  });

  it("marks TableName as required", () => {
    const field = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "TableName",
    );
    expect(field?.required).toBe(true);
  });

  it("marks PartitionKey as required", () => {
    const field = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "PartitionKey",
    );
    expect(field?.required).toBe(true);
  });

  describe("TableName validation", () => {
    const validate = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "TableName",
    )!.question.validate!;

    it("rejects empty value", () => {
      expect(validate("")).toBeDefined();
    });

    it("accepts valid table name", () => {
      expect(validate("my-table_v2")).toBeUndefined();
    });

    it("rejects names with invalid characters", () => {
      expect(validate("my table!")).toBeDefined();
    });

    it("rejects names shorter than 3 chars", () => {
      expect(validate("ab")).toBeDefined();
    });
  });

  describe("PartitionKey validation", () => {
    const validate = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "PartitionKey",
    )!.question.validate!;

    it("rejects empty value", () => {
      expect(validate("")).toBeDefined();
    });

    it("accepts valid format", () => {
      expect(validate("userId:S")).toBeUndefined();
      expect(validate("count:N")).toBeUndefined();
      expect(validate("data:B")).toBeUndefined();
    });

    it("rejects invalid format", () => {
      expect(validate("userId")).toBeDefined();
      expect(validate("userId:X")).toBeDefined();
    });
  });

  describe("PartitionKey toCfn", () => {
    const toCfn = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "PartitionKey",
    )!.toCfn!;

    it("transforms to KeySchema format", () => {
      expect(toCfn("userId:S")).toEqual([
        { AttributeName: "userId", KeyType: "HASH" },
      ]);
    });

    it("returns undefined for empty", () => {
      expect(toCfn("")).toBeUndefined();
    });
  });

  describe("Tags toCfn", () => {
    const toCfn = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "Tags",
    )!.toCfn!;

    it("parses comma-separated tags", () => {
      expect(toCfn("env:prod, team:backend")).toEqual([
        { Key: "env", Value: "prod" },
        { Key: "team", Value: "backend" },
      ]);
    });

    it("returns undefined for empty", () => {
      expect(toCfn("")).toBeUndefined();
    });
  });

  describe("advanced fields showIf", () => {
    it("shows RCU/WCU only for PROVISIONED billing", () => {
      const rcu = dynamodbTablePlugin.advancedFields.find(
        (f) => f.name === "ReadCapacityUnits",
      );
      const wcu = dynamodbTablePlugin.advancedFields.find(
        (f) => f.name === "WriteCapacityUnits",
      );
      expect(rcu?.question.showIf).toEqual({
        field: "BillingMode",
        value: "PROVISIONED",
      });
      expect(wcu?.question.showIf).toEqual({
        field: "BillingMode",
        value: "PROVISIONED",
      });
    });
  });

  it("has secure defaults", () => {
    expect(dynamodbTablePlugin.defaults).toEqual({
      BillingMode: "PAY_PER_REQUEST",
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
      SSESpecification: { SSEEnabled: true },
    });
  });

  it("has configHints for LLM", () => {
    expect(dynamodbTablePlugin.configHints).toBeDefined();
    expect(dynamodbTablePlugin.configHints!.length).toBeGreaterThan(0);
  });
});
