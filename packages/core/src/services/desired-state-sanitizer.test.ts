import { describe, it, expect } from "vitest";
import { sanitizeDesiredState } from "./desired-state-sanitizer.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";

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
      // e96.W2.R5 — codifies the class of bug the story fixed at the
      // plugin layer: the CFN schema's sub-key is `CPUCredits` (uppercase
      // CPU). If any future caller emits the lowercase `CpuCredits`
      // variant, the sanitizer MUST strip it so CCAPI doesn't see two
      // siblings. This test locks in the contract that the plugin side
      // uses the canonical `CPUCredits` (see ec2-instance/fields.ts
      // + ec2-instance.ts), and the sanitizer stays a safety net for
      // stray LLM / hand-authored desiredStates with the bad casing.
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
          CpuCredits: "standard", // wrong casing — extraneous, stripped
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

  // ────────────────────────────────────────────────────────────
  // Resource-aware CCAPI-shape rules (Story e92.1.a)
  // ────────────────────────────────────────────────────────────
  describe("DynamoDB CCAPI-shape rules (A-01, A-09, A-16)", () => {
    // Minimal real-shape DDB schema capture derived from
    // `aws dynamodb describe-table --table-name <t>` + CFN registry
    // properties. Only the fields the sanitizer inspects are declared;
    // extraneous-key stripping tests live elsewhere in this file.
    const ddbSchema = {
      properties: {
        TableName: { type: "string" },
        BillingMode: { type: "string" },
        KeySchema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              AttributeName: { type: "string" },
              KeyType: { type: "string" },
            },
          },
        },
        AttributeDefinitions: {
          type: "array",
          items: {
            type: "object",
            properties: {
              AttributeName: { type: "string" },
              AttributeType: { type: "string" },
            },
          },
        },
        GlobalSecondaryIndexes: { type: "array" },
        LocalSecondaryIndexes: { type: "array" },
        ProvisionedThroughput: {
          type: "object",
          properties: {
            ReadCapacityUnits: { type: "integer" },
            WriteCapacityUnits: { type: "integer" },
          },
        },
      },
    };

    it("drops ProvisionedThroughput when BillingMode=PAY_PER_REQUEST (A-01)", () => {
      // Real CCAPI reproduction: LLM emits both simultaneously; apply fails.
      const desiredState = {
        TableName: "orders",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      expect(sanitized).not.toHaveProperty("ProvisionedThroughput");
      expect(strippedKeys).toContain("ProvisionedThroughput");
      // Other fields preserved.
      expect(sanitized["BillingMode"]).toBe("PAY_PER_REQUEST");
      expect(sanitized["TableName"]).toBe("orders");
    });

    it("preserves ProvisionedThroughput when BillingMode=PROVISIONED", () => {
      const desiredState = {
        TableName: "orders",
        BillingMode: "PROVISIONED",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
        ProvisionedThroughput: {
          ReadCapacityUnits: 5,
          WriteCapacityUnits: 5,
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      expect(sanitized).toHaveProperty("ProvisionedThroughput");
      expect(sanitized["ProvisionedThroughput"]).toEqual({
        ReadCapacityUnits: 5,
        WriteCapacityUnits: 5,
      });
      expect(strippedKeys).not.toContain("ProvisionedThroughput");
    });

    it("no-op when ProvisionedThroughput absent under PAY_PER_REQUEST", () => {
      const desiredState = {
        TableName: "orders",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "id", KeyType: "HASH" }],
        AttributeDefinitions: [{ AttributeName: "id", AttributeType: "S" }],
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      expect(sanitized).not.toHaveProperty("ProvisionedThroughput");
      // Only the no-ops from existing rules — nothing new added.
      expect(strippedKeys).toEqual([]);
    });

    it("seeds AttributeDefinitions from KeySchema when LLM omitted them (A-16)", () => {
      // Real repro: LLM wrote KeySchema referring to 'hashKey' but
      // gave AttributeDefinitions only declaring 'Id' — CCAPI rejects.
      // Here we test the fully-missing case: KeySchema names an attr,
      // AttributeDefinitions is absent → seed a default-S entry.
      const desiredState = {
        TableName: "orders",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "hashKey", KeyType: "HASH" }],
      };

      const { sanitized } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      expect(sanitized["AttributeDefinitions"]).toEqual([
        { AttributeName: "hashKey", AttributeType: "S" },
      ]);
    });

    it("appends missing KeySchema attrs to existing AttributeDefinitions (A-16 partial)", () => {
      // LLM gave one attr but KeySchema references another — sanitizer
      // fills the gap rather than dropping/rewriting the user's entry.
      const desiredState = {
        TableName: "orders",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "hashKey", KeyType: "HASH" },
          { AttributeName: "sortKey", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "hashKey", AttributeType: "S" },
        ],
      };

      const { sanitized } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      const defs = sanitized["AttributeDefinitions"] as Array<
        Record<string, unknown>
      >;
      expect(defs).toHaveLength(2);
      expect(defs).toContainEqual({
        AttributeName: "hashKey",
        AttributeType: "S",
      });
      expect(defs).toContainEqual({
        AttributeName: "sortKey",
        AttributeType: "S",
      });
    });

    it("preserves user-declared AttributeType when seeding from GSI KeySchema", () => {
      // Real GSI case: LLM gave AttributeDefinitions[N] but a GSI references
      // the same attr with a typed declaration — we must not downgrade N→S.
      const desiredState = {
        TableName: "metrics",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [{ AttributeName: "pk", KeyType: "HASH" }],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "ts", AttributeType: "N" },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: "byTs",
            KeySchema: [{ AttributeName: "ts", KeyType: "HASH" }],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };

      const { sanitized } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      const defs = sanitized["AttributeDefinitions"] as Array<
        Record<string, unknown>
      >;
      expect(defs).toHaveLength(2);
      expect(defs).toContainEqual({ AttributeName: "pk", AttributeType: "S" });
      expect(defs).toContainEqual({ AttributeName: "ts", AttributeType: "N" });
    });

    it("seeds LSI attribute into AttributeDefinitions too", () => {
      const desiredState = {
        TableName: "orders",
        BillingMode: "PAY_PER_REQUEST",
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        LocalSecondaryIndexes: [
          {
            IndexName: "byStatus",
            KeySchema: [
              { AttributeName: "pk", KeyType: "HASH" },
              { AttributeName: "status", KeyType: "RANGE" },
            ],
            Projection: { ProjectionType: "ALL" },
          },
        ],
      };

      const { sanitized } = sanitizeDesiredState(
        desiredState,
        ddbSchema,
        RESOURCE_TYPES.DYNAMODB_TABLE,
      );

      const defs = sanitized["AttributeDefinitions"] as Array<
        Record<string, unknown>
      >;
      const names = defs.map((d) => d["AttributeName"]);
      expect(names).toContain("status");
    });
  });

  describe("ECS Cluster CCAPI-shape rules (C-03)", () => {
    // Minimal ECS cluster schema matching CFN registry.
    const ecsSchema = {
      properties: {
        ClusterName: { type: "string" },
        ClusterSettings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              Name: { type: "string" },
              Value: { type: "string" },
            },
          },
        },
      },
    };

    it("coerces key-as-name ClusterSettings to {Name,Value}", () => {
      const desiredState = {
        ClusterName: "prod-cluster",
        ClusterSettings: [{ containerInsights: "enabled" }],
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        ecsSchema,
        RESOURCE_TYPES.ECS_CLUSTER,
      );

      expect(sanitized["ClusterSettings"]).toEqual([
        { Name: "containerInsights", Value: "enabled" },
      ]);
      expect(coercedKeys).toContainEqual({
        path: "ClusterSettings[0]",
        from: "key-as-name",
        to: "{Name,Value}",
      });
    });

    it("passes through canonical {Name,Value} ClusterSettings unchanged", () => {
      const desiredState = {
        ClusterName: "prod-cluster",
        ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        ecsSchema,
        RESOURCE_TYPES.ECS_CLUSTER,
      );

      expect(sanitized["ClusterSettings"]).toEqual([
        { Name: "containerInsights", Value: "enabled" },
      ]);
      expect(coercedKeys).toEqual([]);
    });

    it("handles multiple key-as-name entries", () => {
      const desiredState = {
        ClusterName: "prod-cluster",
        ClusterSettings: [
          { containerInsights: "enabled" },
          { execCommand: "disabled" },
        ],
      };

      const { sanitized } = sanitizeDesiredState(
        desiredState,
        ecsSchema,
        RESOURCE_TYPES.ECS_CLUSTER,
      );

      expect(sanitized["ClusterSettings"]).toEqual([
        { Name: "containerInsights", Value: "enabled" },
        { Name: "execCommand", Value: "disabled" },
      ]);
    });

    it("no-op when ClusterSettings is absent", () => {
      const desiredState = { ClusterName: "prod-cluster" };
      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        ecsSchema,
        RESOURCE_TYPES.ECS_CLUSTER,
      );
      expect(sanitized).toEqual({ ClusterName: "prod-cluster" });
      expect(coercedKeys).toEqual([]);
    });
  });

  describe("CloudFront CCAPI-shape rules (C-04, C-15)", () => {
    // Minimal CF schema — the real registry schema declares Origins as
    // an "object" with nested Items (array of Origin objects). For the
    // sanitizer we only need the DistributionConfig passthrough shape.
    const cfSchema = {
      properties: {
        DistributionConfig: { type: "object" },
      },
    };

    it("canonicalises Origins bare array to {Items,Quantity} (C-15)", () => {
      const desiredState = {
        DistributionConfig: {
          CallerReference: "ref",
          Enabled: true,
          Origins: [
            {
              Id: "origin-1",
              DomainName: "example.com",
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
          DefaultCacheBehavior: { TargetOriginId: "origin-1" },
        },
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origins = (
        sanitized["DistributionConfig"] as Record<string, unknown>
      )["Origins"];
      expect(origins).toMatchObject({
        Items: expect.any(Array),
        Quantity: 1,
      });
      expect(coercedKeys).toContainEqual({
        path: "DistributionConfig.Origins",
        from: "array",
        to: "{Items,Quantity}",
      });
    });

    it("canonicalises CacheBehaviors + CustomErrorResponses too (C-15)", () => {
      const desiredState = {
        DistributionConfig: {
          CallerReference: "ref",
          Enabled: true,
          Origins: { Quantity: 1, Items: [] },
          CacheBehaviors: [
            {
              PathPattern: "/api/*",
              TargetOriginId: "api",
              ViewerProtocolPolicy: "https-only",
            },
          ],
          CustomErrorResponses: [
            {
              ErrorCode: 404,
              ResponseCode: "200",
              ResponsePagePath: "/index.html",
            },
          ],
          DefaultCacheBehavior: { TargetOriginId: "s3" },
        },
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const cfg = sanitized["DistributionConfig"] as Record<string, unknown>;
      expect(cfg["CacheBehaviors"]).toMatchObject({
        Items: expect.any(Array),
        Quantity: 1,
      });
      expect(cfg["CustomErrorResponses"]).toMatchObject({
        Items: expect.any(Array),
        Quantity: 1,
      });
      const paths = coercedKeys.map((c) => c.path);
      expect(paths).toContain("DistributionConfig.CacheBehaviors");
      expect(paths).toContain("DistributionConfig.CustomErrorResponses");
    });

    it("repairs mismatched Quantity to Items.length (C-15)", () => {
      const desiredState = {
        DistributionConfig: {
          Origins: {
            Quantity: 1, // lying — Items.length is 2
            Items: [
              { Id: "a", DomainName: "a.example.com" },
              { Id: "b", DomainName: "b.example.com" },
            ],
          },
        },
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origins = (
        sanitized["DistributionConfig"] as Record<string, unknown>
      )["Origins"] as Record<string, unknown>;
      expect(origins["Quantity"]).toBe(2);
      expect(coercedKeys).toContainEqual({
        path: "DistributionConfig.Origins.Quantity",
        from: "mismatched",
        to: "Items.length",
      });
    });

    it("keeps S3OriginConfig and drops CustomOriginConfig for S3 domains (C-04)", () => {
      const desiredState = {
        DistributionConfig: {
          Origins: [
            {
              Id: "s3-origin",
              DomainName: "my-bucket.s3.us-east-1.amazonaws.com",
              S3OriginConfig: {
                OriginAccessIdentity:
                  "origin-access-identity/cloudfront/E123ABC",
              },
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origin = (
        (sanitized["DistributionConfig"] as Record<string, unknown>)[
          "Origins"
        ] as Record<string, unknown>
      )["Items"] as Array<Record<string, unknown>>;
      expect(origin[0]).toHaveProperty("S3OriginConfig");
      expect(origin[0]).not.toHaveProperty("CustomOriginConfig");
      expect(strippedKeys).toContain(
        "DistributionConfig.Origins.Items[0].CustomOriginConfig",
      );
    });

    it("keeps CustomOriginConfig and drops S3OriginConfig for non-S3 domains (C-04)", () => {
      const desiredState = {
        DistributionConfig: {
          Origins: [
            {
              Id: "alb-origin",
              DomainName: "api.example.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
              CustomOriginConfig: {
                HTTPPort: 80,
                HTTPSPort: 443,
                OriginProtocolPolicy: "https-only",
              },
            },
          ],
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origin = (
        (sanitized["DistributionConfig"] as Record<string, unknown>)[
          "Origins"
        ] as Record<string, unknown>
      )["Items"] as Array<Record<string, unknown>>;
      expect(origin[0]).toHaveProperty("CustomOriginConfig");
      expect(origin[0]).not.toHaveProperty("S3OriginConfig");
      expect(strippedKeys).toContain(
        "DistributionConfig.Origins.Items[0].S3OriginConfig",
      );
    });

    it("strips empty-string OriginAccessIdentity placeholder (C-04)", () => {
      const desiredState = {
        DistributionConfig: {
          Origins: [
            {
              Id: "s3-origin",
              DomainName: "bucket.s3.us-east-1.amazonaws.com",
              S3OriginConfig: { OriginAccessIdentity: "" },
            },
          ],
        },
      };

      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origin = (
        (sanitized["DistributionConfig"] as Record<string, unknown>)[
          "Origins"
        ] as Record<string, unknown>
      )["Items"] as Array<Record<string, unknown>>;
      const s3 = origin[0]!["S3OriginConfig"] as Record<string, unknown>;
      expect(s3).not.toHaveProperty("OriginAccessIdentity");
      expect(strippedKeys).toContain(
        "DistributionConfig.Origins.Items[0].S3OriginConfig.OriginAccessIdentity",
      );
    });

    it("defaults CustomOriginConfig on a non-S3 origin missing both configs (C-04)", () => {
      const desiredState = {
        DistributionConfig: {
          Origins: [
            {
              Id: "api-origin",
              DomainName: "api.example.com",
            },
          ],
        },
      };

      const { sanitized, coercedKeys } = sanitizeDesiredState(
        desiredState,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );

      const origin = (
        (sanitized["DistributionConfig"] as Record<string, unknown>)[
          "Origins"
        ] as Record<string, unknown>
      )["Items"] as Array<Record<string, unknown>>;
      expect(origin[0]).toHaveProperty("CustomOriginConfig");
      const custom = origin[0]!["CustomOriginConfig"] as Record<
        string,
        unknown
      >;
      expect(custom["OriginProtocolPolicy"]).toBe("https-only");
      expect(coercedKeys).toContainEqual({
        path: "DistributionConfig.Origins.Items[0].CustomOriginConfig",
        from: "absent",
        to: "default",
      });
    });

    it("no-op when DistributionConfig is absent or non-object", () => {
      // Edge: LLM gave the wrong top-level shape. Sanitizer must not crash.
      const ds1 = { DistributionConfig: null };
      const { sanitized: s1 } = sanitizeDesiredState(
        ds1 as unknown as Record<string, unknown>,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );
      expect(s1).toEqual({ DistributionConfig: null });

      const ds2 = {};
      const { sanitized: s2 } = sanitizeDesiredState(
        ds2,
        cfSchema,
        RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
      );
      expect(s2).toEqual({});
    });
  });

  describe("resource-aware rules do not fire without resourceType", () => {
    // Backward-compat invariant: existing callers passing only (state, schema)
    // must see zero behaviour change.
    it("leaves DDB ProvisionedThroughput alone when no resourceType supplied", () => {
      const schema = {
        properties: {
          BillingMode: { type: "string" },
          ProvisionedThroughput: { type: "object" },
        },
      };
      const desiredState = {
        BillingMode: "PAY_PER_REQUEST",
        ProvisionedThroughput: { ReadCapacityUnits: 5, WriteCapacityUnits: 5 },
      };
      const { sanitized, strippedKeys } = sanitizeDesiredState(
        desiredState,
        schema,
        // no resourceType
      );
      expect(sanitized).toHaveProperty("ProvisionedThroughput");
      expect(strippedKeys).toEqual([]);
    });
  });
});
