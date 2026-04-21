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

  // Wave 16: strengthened the validator tests below to assert each
  // returns a non-empty STRING error message rather than just any
  // non-undefined value. The previous `toBeDefined()` would have
  // passed for `0`, `false`, `""` — none of which a wizard prompt
  // could meaningfully display.
  describe("TableName validation", () => {
    const validate = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "TableName",
    )!.question.validate!;

    function expectStringError(value: unknown): void {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }

    it("rejects empty value", () => {
      expectStringError(validate(""));
    });

    it("accepts valid table name", () => {
      expect(validate("my-table_v2")).toBeUndefined();
    });

    it("rejects names with invalid characters", () => {
      expectStringError(validate("my table!"));
    });

    it("rejects names shorter than 3 chars", () => {
      expectStringError(validate("ab"));
    });
  });

  describe("PartitionKey validation", () => {
    const validate = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "PartitionKey",
    )!.question.validate!;

    function expectStringError(value: unknown): void {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }

    it("rejects empty value", () => {
      expectStringError(validate(""));
    });

    it("accepts valid format", () => {
      expect(validate("userId:S")).toBeUndefined();
      expect(validate("count:N")).toBeUndefined();
      expect(validate("data:B")).toBeUndefined();
    });

    it("rejects invalid format", () => {
      expectStringError(validate("userId"));
      expectStringError(validate("userId:X"));
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
    // Wave 16: dropped redundant `toBeDefined()` — `Array.isArray`
    // catches null/meters and non-array shapes.
    expect(Array.isArray(dynamodbTablePlugin.configHints)).toBe(true);
    expect(dynamodbTablePlugin.configHints!.length).toBeGreaterThan(0);
  });

  // Story e92.1.a — configHints guard LLM against the two CCAPI-shape
  // bugs (A-01 ProvisionedThroughput under PAY_PER_REQUEST; A-16
  // AttributeDefinitions omissions). If these hints regress, the
  // sanitizer is the last line of defense — but the prompt should
  // also educate the LLM up front.
  describe("configHints CCAPI-shape guardrails (e92.1.a)", () => {
    const hints = dynamodbTablePlugin.configHints!.join(" ");

    it("warns against ProvisionedThroughput with PAY_PER_REQUEST (A-01)", () => {
      expect(hints).toMatch(/PAY_PER_REQUEST/);
      expect(hints).toMatch(/ProvisionedThroughput/);
      expect(hints).toMatch(/DO NOT include|never|rejects/i);
    });

    it("requires AttributeDefinitions to cover every KeySchema reference (A-16)", () => {
      expect(hints).toMatch(/AttributeDefinitions/);
      expect(hints).toMatch(/KeySchema/);
      expect(hints).toMatch(
        /GlobalSecondaryIndexes|LocalSecondaryIndexes|EVERY/,
      );
    });
  });
});
