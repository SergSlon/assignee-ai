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

  describe("TableName toCfn auto-generation (Epic 92 Wave 4.b / A-06)", () => {
    const field = dynamodbTablePlugin.commonFields.find(
      (f) => f.name === "TableName",
    )!;
    const AUTO_NAME_PATTERN = /^assignee-dynamodb-table-[0-9a-f]{8}$/;

    it("auto-generates assignee-dynamodb-table-<8hex> on empty input", () => {
      const result = field.toCfn!("");
      expect(typeof result).toBe("string");
      expect(result as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on whitespace-only input", () => {
      expect(field.toCfn!("   ") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("auto-generates on undefined input", () => {
      expect(field.toCfn!(undefined) as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("replaces the literal placeholder 'example-table' (LLM echo guard)", () => {
      expect(field.toCfn!("example-table") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
    });

    it("replaces 'my-table' / 'my-dynamodb-table' / 'my-ddb-table'", () => {
      expect(field.toCfn!("my-table") as string).toMatch(AUTO_NAME_PATTERN);
      expect(field.toCfn!("my-dynamodb-table") as string).toMatch(
        AUTO_NAME_PATTERN,
      );
      expect(field.toCfn!("my-ddb-table") as string).toMatch(AUTO_NAME_PATTERN);
    });

    it("preserves user-specified names unchanged", () => {
      expect(field.toCfn!("orders_v2")).toBe("orders_v2");
      expect(field.toCfn!("user-sessions-prod")).toBe("user-sessions-prod");
    });

    it("returns a different auto-name on each call (crypto.randomBytes)", () => {
      const a = field.toCfn!("");
      const b = field.toCfn!("");
      expect(a).not.toBe(b);
    });

    it("generated names satisfy the TableName validator (round-trip)", () => {
      const validate = field.question.validate!;
      for (let i = 0; i < 5; i++) {
        const name = field.toCfn!("") as string;
        expect(validate(name)).toBeUndefined();
      }
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
    // Epic 92 Wave 4.b (A-06): TableName is now a dynamic getter producing
    // `assignee-dynamodb-table-<8hex>` on each access. Assert the static
    // defaults and the getter shape separately because `toEqual` would fail
    // on the fresh random value.
    expect(dynamodbTablePlugin.defaults.BillingMode).toBe("PAY_PER_REQUEST");
    expect(
      dynamodbTablePlugin.defaults.PointInTimeRecoverySpecification,
    ).toEqual({ PointInTimeRecoveryEnabled: true });
    expect(dynamodbTablePlugin.defaults.SSESpecification).toEqual({
      SSEEnabled: true,
    });
    const defaultName = dynamodbTablePlugin.defaults.TableName;
    expect(typeof defaultName).toBe("string");
    expect(defaultName as string).toMatch(
      /^assignee-dynamodb-table-[0-9a-f]{8}$/,
    );
  });

  it("has configHints for LLM", () => {
    expect(Array.isArray(dynamodbTablePlugin.configHints)).toBe(true);
    expect(dynamodbTablePlugin.configHints!.length).toBeGreaterThan(0);
  });

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

    it("guides LLM to OMIT TableName so Assignee auto-generates (A-06)", () => {
      expect(hints).toMatch(/TableName/);
      expect(hints).toMatch(/OMIT|auto-generate/i);
      expect(hints).toMatch(/assignee-dynamodb-table/);
    });
  });
});
