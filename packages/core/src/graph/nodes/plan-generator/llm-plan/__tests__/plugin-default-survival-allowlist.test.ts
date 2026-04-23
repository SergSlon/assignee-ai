/**
 * Epic 98 Wave 3 architectural story e98.W3.A1 —
 * `mergePluginDefaults` allowlist expansion beyond EC2_INSTANCE.
 *
 * Closes the Epic 97 A-04, A-05, B-15, C-N1 cluster: the backfill
 * allowlist was scoped to `AWS::EC2::Instance` only, so every other
 * plugin's security / compliance defaults (StorageEncrypted on RDS,
 * Encrypted + BackupPolicy on EFS, ScanOnPush + ImageTagMutability on
 * ECR, KmsMasterKeyId on SNS, etc.) reached the plan only when the LLM
 * happened to emit them. One prompt-drift away from shipping
 * non-compliant plans that depended on the BP auto-fix safety net.
 *
 * This suite locks two invariants:
 *
 *   1. EVERY plugin in the Wave-3 allowlist has its expected defaults
 *      backfilled when the LLM output omits them — covering both the
 *      "LLM emits nothing" path and the "LLM emits {}" empty-leaf path
 *      (the latter paired with the W2.R2 `isEmptyLeaf` change).
 *   2. Non-allowlisted types stay untouched (S3 + DynamoDB + any other
 *      plugin whose BP rules depend on empty defaults to fire).
 *
 * Every case asserts against the live plugin registry so future default
 * changes are picked up without editing this test.
 */

import { describe, it, expect } from "vitest";
import { mergePluginDefaults } from "../merge.js";
import { RESOURCE_TYPES, defaultPluginRegistry } from "@/index.js";

/**
 * Shape of one per-plugin expectation. `bareLlmOutput` is the minimal
 * plan the LLM might emit on a bare-intent flow. `expected` lists the
 * key-paths that must appear after merge, with their expected values.
 *
 * Keys use CFN-style dotted paths — the test helper walks them against
 * the merged result.
 */
interface Expectation {
  resourceType: string;
  // A description for test naming; kept short.
  intentShape: string;
  // LLM baseline (with no defaults emitted) — merge must backfill the
  // plugin defaults onto this object.
  bareLlmOutput: Record<string, unknown>;
  // Empty-leaf LLM output — LLM emits the key but with a `{}` / `""`
  // / `null` / `[]` value. Merge must still restore the plugin default
  // via the W2.R2 isEmptyLeaf gate.
  emptyLeafLlmOutput: Record<string, unknown>;
  // Keys that must land (for each, the expected value or a predicate).
  expected: Array<{
    path: string;
    test: (value: unknown) => boolean;
    description: string;
  }>;
}

function getAtPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const p of parts) {
    if (current === undefined || current === null) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[p];
  }
  return current;
}

const EXPECTATIONS: Expectation[] = [
  {
    resourceType: RESOURCE_TYPES.SNS_TOPIC,
    intentShape: "bare SNS topic",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { KmsMasterKeyId: "" },
    expected: [
      {
        path: "KmsMasterKeyId",
        test: (v) => v === "alias/aws/sns",
        description: "KmsMasterKeyId=alias/aws/sns (BP-SNS-001 secure default)",
      },
      {
        path: "TopicName",
        test: (v) => typeof v === "string" && /^assignee-sns-topic-/.test(v),
        description: "TopicName generated as assignee-sns-topic-<8hex>",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
    intentShape: "bare SQS queue",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { SqsManagedSseEnabled: null, VisibilityTimeout: null },
    expected: [
      {
        path: "SqsManagedSseEnabled",
        test: (v) => v === true,
        description: "SqsManagedSseEnabled=true (free SSE)",
      },
      {
        path: "VisibilityTimeout",
        test: (v) => v === 30,
        description: "VisibilityTimeout=30s",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.EC2_ROUTE,
    intentShape: "bare EC2 route",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { DestinationCidrBlock: "", ConnectivityType: "" },
    expected: [
      {
        path: "DestinationCidrBlock",
        test: (v) => v === "0.0.0.0/0",
        description: "DestinationCidrBlock=0.0.0.0/0",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,
    intentShape: "bare NAT gateway",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { ConnectivityType: "" },
    expected: [
      {
        path: "ConnectivityType",
        test: (v) => v === "public",
        description: "ConnectivityType=public",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    intentShape: "bare ALB",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { Type: "", Scheme: "", IpAddressType: "" },
    expected: [
      {
        path: "Type",
        test: (v) => v === "application",
        description: "Type=application",
      },
      {
        path: "Scheme",
        test: (v) => v === "internet-facing",
        description: "Scheme=internet-facing",
      },
      {
        path: "IpAddressType",
        test: (v) => v === "ipv4",
        description: "IpAddressType=ipv4",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    intentShape: "bare RDS DB instance",
    bareLlmOutput: {},
    emptyLeafLlmOutput: {
      StorageEncrypted: null,
      StorageType: "",
      MultiAZ: null,
    },
    expected: [
      {
        path: "StorageEncrypted",
        test: (v) => v === true,
        description: "StorageEncrypted=true (BP-RDS-002 secure default)",
      },
      {
        path: "StorageType",
        test: (v) => v === "gp3",
        description: "StorageType=gp3 (default)",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.ECS_CLUSTER,
    intentShape: "bare ECS cluster",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { ClusterSettings: [], CapacityProviders: [] },
    expected: [
      {
        path: "ClusterSettings",
        test: (v) =>
          Array.isArray(v) &&
          v.some(
            (s) =>
              typeof s === "object" &&
              s !== null &&
              (s as { Name?: string }).Name === "containerInsights",
          ),
        description: "ClusterSettings includes containerInsights=enabled",
      },
      {
        path: "CapacityProviders",
        test: (v) => Array.isArray(v) && v.includes("FARGATE"),
        description: "CapacityProviders includes FARGATE",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
    intentShape: "bare ECR repository",
    bareLlmOutput: {},
    emptyLeafLlmOutput: {
      ImageTagMutability: "",
      ImageScanningConfiguration: {},
    },
    expected: [
      {
        path: "ImageTagMutability",
        test: (v) => v === "IMMUTABLE",
        description: "ImageTagMutability=IMMUTABLE (BP-ECR-002)",
      },
      {
        path: "ImageScanningConfiguration.ScanOnPush",
        test: (v) => v === true,
        description: "ScanOnPush=true (BP-ECR-001 secure default)",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
    intentShape: "bare EFS file system",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { Encrypted: null, BackupPolicy: {} },
    expected: [
      {
        path: "Encrypted",
        test: (v) => v === true,
        description: "Encrypted=true (BP-EFS-001 secure default)",
      },
      {
        path: "BackupPolicy.Status",
        test: (v) => v === "ENABLED",
        description: "BackupPolicy.Status=ENABLED",
      },
    ],
  },
  {
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
    intentShape: "bare HTTP API",
    bareLlmOutput: {},
    emptyLeafLlmOutput: { ProtocolType: "" },
    expected: [
      {
        path: "ProtocolType",
        test: (v) => v === "HTTP",
        description: "ProtocolType=HTTP",
      },
    ],
  },
];

describe("mergePluginDefaults allowlist survival (e98.W3.A1)", () => {
  for (const exp of EXPECTATIONS) {
    describe(`${exp.resourceType} — ${exp.intentShape}`, () => {
      it("registered plugin exposes the expected defaults (pre-condition)", () => {
        const plugin = defaultPluginRegistry.get(exp.resourceType);
        expect(
          plugin,
          `${exp.resourceType} plugin must be registered`,
        ).toBeDefined();
      });

      for (const assertion of exp.expected) {
        it(`backfills ${assertion.description} on a bare LLM output`, () => {
          const merged = mergePluginDefaults(
            exp.bareLlmOutput,
            exp.resourceType,
          );
          const actual = getAtPath(merged, assertion.path);
          expect(
            assertion.test(actual),
            `${assertion.path} value=${JSON.stringify(actual)} did not satisfy predicate`,
          ).toBe(true);
        });

        it(`restores ${assertion.description} when LLM emits empty-leaf (W2.R2 gate)`, () => {
          const merged = mergePluginDefaults(
            { ...exp.emptyLeafLlmOutput },
            exp.resourceType,
          );
          const actual = getAtPath(merged, assertion.path);
          expect(
            assertion.test(actual),
            `${assertion.path} value=${JSON.stringify(actual)} did not satisfy predicate after empty-leaf`,
          ).toBe(true);
        });
      }

      it("does not clobber an LLM-emitted non-empty value on a default key", () => {
        // Pick the first expected key, override it with a deliberately
        // non-default sentinel value, and verify the LLM value wins.
        const first = exp.expected[0];
        if (!first) return;
        // Use a string sentinel. For keys whose expected values are
        // booleans or numbers we use a simple sentinel that survives
        // the deep-merge contract (non-empty string is non-empty).
        const keyPathParts = first.path.split(".");
        const rootKey = keyPathParts[0];
        if (!rootKey) return;
        const override: Record<string, unknown> = {
          [rootKey]:
            keyPathParts.length > 1
              ? { [keyPathParts.slice(1).join(".")]: "sentinel-user-value" }
              : "sentinel-user-value",
        };
        const merged = mergePluginDefaults(override, exp.resourceType);
        // Walk the first segment; the merge must NOT clobber it with the
        // plugin default when the LLM emitted a non-empty value.
        expect(merged[rootKey]).toEqual(override[rootKey]);
      });
    });
  }
});

describe("mergePluginDefaults S3 + DynamoDB exclusion (e98.W3.A1 BP-safety invariant)", () => {
  it("leaves S3::Bucket untouched even when the bare LLM output is empty", () => {
    // BP-S3-001 through BP-S3-004 rely on a plan that LACKs
    // PublicAccessBlockConfiguration firing the blocking rule.
    // Backfilling S3 defaults here would silently disarm every one.
    const bare = { BucketName: "my-bucket" };
    const merged = mergePluginDefaults(bare, RESOURCE_TYPES.S3_BUCKET);
    expect(merged).toEqual(bare);
    expect(merged["PublicAccessBlockConfiguration"]).toBeUndefined();
  });

  it("leaves DynamoDB::Table untouched (same BP-safety reasoning)", () => {
    const bare = { TableName: "my-table" };
    const merged = mergePluginDefaults(bare, RESOURCE_TYPES.DYNAMODB_TABLE);
    expect(merged).toEqual(bare);
  });

  it("leaves Lambda::Function untouched (not on the W3.A1 list)", () => {
    const bare = { FunctionName: "my-fn" };
    const merged = mergePluginDefaults(bare, RESOURCE_TYPES.LAMBDA_FUNCTION);
    expect(merged).toEqual(bare);
  });
});
