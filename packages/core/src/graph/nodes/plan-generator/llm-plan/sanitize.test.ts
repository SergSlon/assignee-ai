/**
 * Unit tests for llm-plan/sanitize.ts — in particular, regression
 * coverage for the story e92.1.a-followup wire-up that threads
 * `state.resourceType` through `sanitizeAgainstSchema` into the
 * underlying `sanitizeDesiredState`, so the DDB / ECS / CloudFront
 * CCAPI-shape rules actually fire at plan-generation time.
 *
 * Without the hookup those rules were dormant — sanitizer unit tests
 * passed in isolation while the production path left
 * `ProvisionedThroughput` on a `PAY_PER_REQUEST` DDB intent and the
 * subsequent CCAPI call got rejected. This test asserts the end-to-
 * end wire-up, not just the sanitizer itself.
 */
import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { sanitizeAgainstSchema } from "./sanitize.js";

describe("sanitizeAgainstSchema (llm-plan hookup)", () => {
  // Real-shape DDB schema subset — mirrors the CFN Registry DescribeType
  // output for AWS::DynamoDB::Table (see test-fixtures/mcp-mock-responses
  // /schema-dynamodb-table.ts). Only the properties touched by this test
  // are included; the sanitizer is "strip keys NOT in schema", so listing
  // the keys we care about is sufficient and idiomatic (see the
  // sanitizer's own unit tests for the same minimal-schema pattern).
  const ddbSchema = {
    properties: {
      TableName: { type: "string" },
      KeySchema: { type: "array" },
      AttributeDefinitions: { type: "array" },
      BillingMode: { type: "string" },
      ProvisionedThroughput: {
        type: "object",
        properties: {
          ReadCapacityUnits: { type: "integer" },
          WriteCapacityUnits: { type: "integer" },
        },
      },
    },
  };
  const ddbSchemaKeys = Object.keys(ddbSchema.properties);

  // Real LLM-output shape captured from an actual dogfood run that
  // triggered CCAPI finding A-01: BillingMode=PAY_PER_REQUEST paired
  // with ProvisionedThroughput. The pair is illegal at CCAPI; the
  // sanitizer's DDB rule must strip ProvisionedThroughput — but ONLY
  // if `resourceType` is threaded through the hookup.
  const ddbIntent = (): Record<string, unknown> => ({
    TableName: "assignee-orders",
    KeySchema: [
      { AttributeName: "orderId", KeyType: "HASH" },
      { AttributeName: "createdAt", KeyType: "RANGE" },
    ],
    AttributeDefinitions: [
      { AttributeName: "orderId", AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ],
    BillingMode: "PAY_PER_REQUEST",
    ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
  });

  it("fires the DDB PAY_PER_REQUEST rule when resourceType is threaded through", () => {
    // THE regression test for story e92.1.a-followup: resourceType must
    // flow from the graph state → sanitizeAgainstSchema → sanitizeDesiredState
    // → applyResourceRules → DDB rule → strippedKeys.
    const sanitized = sanitizeAgainstSchema(
      ddbIntent(),
      ddbSchema,
      ddbSchemaKeys,
      "run-e92-1a-followup-ddb",
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );

    expect(sanitized).not.toHaveProperty("ProvisionedThroughput");
    // The valid-against-schema fields must pass through untouched.
    expect(sanitized["TableName"]).toBe("assignee-orders");
    expect(sanitized["BillingMode"]).toBe("PAY_PER_REQUEST");
    expect(sanitized["KeySchema"]).toEqual([
      { AttributeName: "orderId", KeyType: "HASH" },
      { AttributeName: "createdAt", KeyType: "RANGE" },
    ]);
    expect(sanitized["AttributeDefinitions"]).toEqual([
      { AttributeName: "orderId", AttributeType: "S" },
      { AttributeName: "createdAt", AttributeType: "S" },
    ]);
  });

  it("leaves ProvisionedThroughput alone when resourceType is empty (control)", () => {
    // Negative control: proves the rule only fires because of the
    // threaded resourceType, not because of some schema coincidence.
    // An empty string (== graph-state default) must keep the sanitizer
    // on the schema-only fast path.
    const sanitized = sanitizeAgainstSchema(
      ddbIntent(),
      ddbSchema,
      ddbSchemaKeys,
      "run-e92-1a-followup-control",
      "",
    );

    expect(sanitized).toHaveProperty("ProvisionedThroughput");
    expect(sanitized["ProvisionedThroughput"]).toEqual({
      ReadCapacityUnits: 5,
      WriteCapacityUnits: 5,
    });
  });

  it("is a no-op when schemaKeys is empty (preserves prior behaviour)", () => {
    // Even with resourceType threaded, empty schemaKeys must still
    // short-circuit — the sanitizer needs schema metadata to be safe.
    const intent = ddbIntent();
    const sanitized = sanitizeAgainstSchema(
      intent,
      ddbSchema,
      [],
      "run-e92-1a-followup-noop",
      RESOURCE_TYPES.DYNAMODB_TABLE,
    );
    // Identity: no-op returns the input as-is.
    expect(sanitized).toBe(intent);
  });
});
