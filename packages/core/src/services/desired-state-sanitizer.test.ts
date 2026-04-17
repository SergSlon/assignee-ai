import { describe, it, expect } from "vitest";
import { sanitizeDesiredState } from "./desired-state-sanitizer.js";

describe("sanitizeDesiredState", () => {
  describe("extraneous key stripping", () => {
    it("strips top-level keys not in schema", () => {
      const schema = {
        properties: {
          BucketName: { type: "string" },
          VersioningConfiguration: { type: "object" },
        },
      };
      const desiredState = {
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
        FakeProperty: "should-be-removed",
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).toEqual({
        BucketName: "my-bucket",
        VersioningConfiguration: { Status: "Enabled" },
      });
      expect(strippedKeys).toEqual(["FakeProperty"]);
    });

    it("strips DynamoDB extraneous keys (PointInTimeRecoveryEnabled, SSEEnabled)", () => {
      const schema = {
        properties: {
          TableName: { type: "string" },
          KeySchema: { type: "array" },
          BillingMode: { type: "string" },
        },
      };
      const desiredState = {
        TableName: "my-table",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        BillingMode: "PAY_PER_REQUEST",
        PointInTimeRecoveryEnabled: true,
        SSEEnabled: true,
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).not.toHaveProperty("PointInTimeRecoveryEnabled");
      expect(sanitized).not.toHaveProperty("SSEEnabled");
      expect(strippedKeys).toContain("PointInTimeRecoveryEnabled");
      expect(strippedKeys).toContain("SSEEnabled");
    });

    it("strips SQS extraneous key (VisibilityTimeoutSeconds)", () => {
      const schema = {
        properties: {
          QueueName: { type: "string" },
          VisibilityTimeout: { type: "integer" },
        },
      };
      const desiredState = {
        QueueName: "my-queue",
        VisibilityTimeout: 30,
        VisibilityTimeoutSeconds: 30,
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).not.toHaveProperty("VisibilityTimeoutSeconds");
      expect(strippedKeys).toEqual(["VisibilityTimeoutSeconds"]);
    });

    it("strips ECS extraneous key (ContainerInsights)", () => {
      const schema = {
        properties: {
          ClusterName: { type: "string" },
          ClusterSettings: { type: "array" },
        },
      };
      const desiredState = {
        ClusterName: "my-cluster",
        ContainerInsights: "enabled",
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).not.toHaveProperty("ContainerInsights");
      expect(strippedKeys).toEqual(["ContainerInsights"]);
    });

    it("strips ELBv2 extraneous key (DeletionProtection)", () => {
      const schema = {
        properties: {
          Name: { type: "string" },
          Type: { type: "string" },
          LoadBalancerAttributes: { type: "array" },
        },
      };
      const desiredState = {
        Name: "my-lb",
        Type: "application",
        DeletionProtection: true,
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).not.toHaveProperty("DeletionProtection");
      expect(strippedKeys).toEqual(["DeletionProtection"]);
    });
  });

  describe("nested object stripping", () => {
    it("strips nested extraneous keys (EC2 CreditSpecification.CpuCredits)", () => {
      const schema = {
        properties: {
          InstanceType: { type: "string" },
          CreditSpecification: {
            type: "object",
            properties: {
              CPUCredits: { type: "string" },
            },
          },
        },
      };
      const desiredState = {
        InstanceType: "t3.micro",
        CreditSpecification: {
          CPUCredits: "standard",
          CpuCredits: "standard", // wrong casing — extraneous
          ExtraField: "bad",
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(
        (sanitized as { CreditSpecification: unknown }).CreditSpecification,
      ).toEqual({
        CPUCredits: "standard",
      });
      expect(strippedKeys).toContain("CreditSpecification.CpuCredits");
      expect(strippedKeys).toContain("CreditSpecification.ExtraField");
    });

    it("handles deeply nested objects", () => {
      const schema = {
        properties: {
          Level1: {
            type: "object",
            properties: {
              Level2: {
                type: "object",
                properties: {
                  ValidKey: { type: "string" },
                },
              },
            },
          },
        },
      };
      const desiredState = {
        Level1: {
          Level2: {
            ValidKey: "ok",
            BadKey: "remove",
          },
          ExtraL1: "remove",
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(
        (sanitized as { Level1: { Level2: unknown } }).Level1.Level2,
      ).toEqual({ ValidKey: "ok" });
      expect(strippedKeys).toContain("Level1.ExtraL1");
      expect(strippedKeys).toContain("Level1.Level2.BadKey");
    });
  });

  describe("type coercion", () => {
    it("coerces string to integer (SQS MaximumMessageSize)", () => {
      const schema = {
        properties: {
          QueueName: { type: "string" },
          MaximumMessageSize: { type: "integer" },
          MessageRetentionPeriod: { type: "integer" },
        },
      };
      const desiredState = {
        QueueName: "my-queue",
        MaximumMessageSize: "262144",
        MessageRetentionPeriod: "345600",
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized["MaximumMessageSize"]).toBe(262144);
      expect(sanitized["MessageRetentionPeriod"]).toBe(345600);
      expect(coercedKeys).toHaveLength(2);
      expect(coercedKeys[0]).toEqual({
        path: "MaximumMessageSize",
        from: "string",
        to: "integer",
      });
    });

    it("coerces string to number", () => {
      const schema = {
        properties: {
          Threshold: { type: "number" },
        },
      };
      const desiredState = { Threshold: "80.5" };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized["Threshold"]).toBe(80.5);
      expect(coercedKeys[0]).toEqual({
        path: "Threshold",
        from: "string",
        to: "number",
      });
    });

    it("coerces string to boolean", () => {
      const schema = {
        properties: {
          Enabled: { type: "boolean" },
        },
      };
      const desiredState = { Enabled: "true" };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized["Enabled"]).toBe(true);
      expect(coercedKeys[0]).toEqual({
        path: "Enabled",
        from: "string",
        to: "boolean",
      });
    });

    it("does not coerce non-numeric strings to integer", () => {
      const schema = {
        properties: {
          Port: { type: "integer" },
        },
      };
      const desiredState = { Port: "not-a-number" };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized["Port"]).toBe("not-a-number"); // left as-is
      expect(coercedKeys).toHaveLength(0);
    });

    it("coerces NatGateway MaxDrainDurationSeconds string to integer", () => {
      const schema = {
        properties: {
          SubnetId: { type: "string" },
          ConnectivityType: { type: "string" },
          MaxDrainDurationSeconds: { type: "integer" },
        },
      };
      const desiredState = {
        SubnetId: "subnet-abc",
        ConnectivityType: "public",
        MaxDrainDurationSeconds: "350",
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized["MaxDrainDurationSeconds"]).toBe(350);
      expect(coercedKeys).toHaveLength(1);
    });
  });

  describe("no-op cases", () => {
    it("returns unchanged desiredState when schema is undefined", () => {
      const desiredState = { Key: "value" };
      const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
        desiredState,
        undefined,
      );

      expect(sanitized).toEqual(desiredState);
      expect(strippedKeys).toHaveLength(0);
      expect(coercedKeys).toHaveLength(0);
    });

    it("returns unchanged desiredState when schema has no properties", () => {
      const desiredState = { Key: "value" };
      const { sanitized } = sanitizeDesiredState(desiredState, {});

      expect(sanitized).toEqual(desiredState);
    });

    it("returns unchanged desiredState when all keys are valid", () => {
      const schema = {
        properties: {
          BucketName: { type: "string" },
          Tags: { type: "array" },
        },
      };
      const desiredState = {
        BucketName: "my-bucket",
        Tags: [{ Key: "env", Value: "test" }],
      };

      const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).toEqual(desiredState);
      expect(strippedKeys).toHaveLength(0);
      expect(coercedKeys).toHaveLength(0);
    });
  });

  describe("array item sanitization", () => {
    it("sanitizes objects inside arrays", () => {
      const schema = {
        properties: {
          Tags: {
            type: "array",
            items: {
              type: "object",
              properties: {
                Key: { type: "string" },
                Value: { type: "string" },
              },
            },
          },
        },
      };
      const desiredState = {
        Tags: [
          { Key: "env", Value: "test", Extra: "bad" },
          { Key: "name", Value: "ok" },
        ],
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect((sanitized as { Tags: unknown }).Tags).toEqual([
        { Key: "env", Value: "test" },
        { Key: "name", Value: "ok" },
      ]);
      expect(strippedKeys).toContain("Tags[0].Extra");
    });
  });

  describe("combined stripping and coercion", () => {
    it("handles both extraneous keys and type coercion in same object", () => {
      const schema = {
        properties: {
          QueueName: { type: "string" },
          MaximumMessageSize: { type: "integer" },
          MessageRetentionPeriod: { type: "integer" },
        },
      };
      const desiredState = {
        QueueName: "test-queue",
        MaximumMessageSize: "262144",
        MessageRetentionPeriod: "345600",
        VisibilityTimeoutSeconds: 30,
      };

      const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
      );

      expect(sanitized).toEqual({
        QueueName: "test-queue",
        MaximumMessageSize: 262144,
        MessageRetentionPeriod: 345600,
      });
      expect(strippedKeys).toEqual(["VisibilityTimeoutSeconds"]);
      expect(coercedKeys).toHaveLength(2);
    });
  });
});
