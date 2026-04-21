import { randomBytes } from "node:crypto";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * Epic 92 Wave 4.b (finding A-06): "example-table" / "my-table" literals
 * were leaking into real AWS accounts because the LLM echoed the field
 * placeholder. Mirrors the Lambda compound pattern's
 * `assignee-lambda-fn-<hash>` convention:
 *
 *   assignee-dynamodb-table-<8 hex>
 *
 * Generated identifier stays inside DynamoDB's 3-255 char limit and uses
 * only characters allowed by AWS (`[a-zA-Z0-9._-]`). ARN round-trip is
 * preserved because the identifier contains no special characters that
 * would confuse `config/arn-builder.ts`.
 */
const PLACEHOLDER_TABLE_NAMES = new Set([
  "my-table",
  "example-table",
  "my-dynamodb-table",
  "example-dynamodb-table",
  "my-ddb-table",
]);

function generateDynamodbTableName(): string {
  return `assignee-dynamodb-table-${randomBytes(4).toString("hex")}`;
}

/**
 * ResourcePlugin for AWS::DynamoDB::Table.
 * commonFields: TableName, BillingMode, KeySchema (partition key), SortKey, Tags.
 * advancedFields: RCU/WCU (provisioned-only), PITR, deletion protection, SSE.
 */
export const dynamodbTablePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
  commonFields: [
    {
      name: CfnKey.TABLE_NAME,
      required: true,
      question: {
        type: "string",
        label: "Table name",
        placeholder:
          "assignee-dynamodb-table-<8hex> (leave blank for auto-generated)",
        hint: "Must be 3-255 characters. Letters, numbers, underscores, hyphens, and periods. Cannot be changed after creation. Leave blank — Assignee auto-generates 'assignee-dynamodb-table-<8hex>'.",
        validate: (value: unknown) => {
          if (!value) return "Table name is required";
          const s = String(value);
          if (s.length < 3 || s.length > 255)
            return "Table name must be 3-255 characters";
          if (!/^[a-zA-Z0-9._-]+$/.test(s))
            return "Table name may only contain letters, numbers, underscores, hyphens, and periods";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        if (v === undefined || v === null) return generateDynamodbTableName();
        const s = String(v).trim();
        if (s === "") return generateDynamodbTableName();
        if (PLACEHOLDER_TABLE_NAMES.has(s.toLowerCase())) {
          return generateDynamodbTableName();
        }
        return s;
      },
    },
    {
      name: CfnKey.BILLING_MODE,
      question: {
        type: "enum",
        label: "Billing mode",
        options: [
          {
            value: AwsDefault.BILLING_PAY_PER_REQUEST,
            label: "On-demand (pay per request)",
            recommended: true,
            fitHint: "Best for unpredictable or new workloads",
          },
          {
            value: AwsDefault.BILLING_PROVISIONED,
            label: "Provisioned (set read/write capacity)",
            fitHint: "Best for steady, predictable traffic",
          },
        ],
        initialValue: AwsDefault.BILLING_PAY_PER_REQUEST,
        hint: "On-demand scales automatically with no capacity planning. Provisioned is cheaper for steady workloads but requires you to set read/write capacity units.",
      },
    },
    {
      name: CfnKey.PARTITION_KEY,
      required: true,
      question: {
        type: "string",
        label: "Partition key (name:type, e.g. userId:S)",
        placeholder: "id:S",
        hint: "Primary key attribute. Type is S (string), N (number), or B (binary). Choose a high-cardinality attribute for even distribution.",
        validate: (value: unknown) => {
          if (!value) return "Partition key is required";
          const s = String(value);
          if (!/^[a-zA-Z0-9_]+:[SNB]$/.test(s))
            return "Format: attributeName:S|N|B (e.g. userId:S)";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer) return undefined;
        const [name, _type] = String(answer).split(":");
        return [{ AttributeName: name, KeyType: "HASH" }];
      },
    },
    {
      name: CfnKey.SORT_KEY,
      question: {
        type: "string",
        label: "Sort key (name:type, optional)",
        placeholder: "createdAt:N",
        hint: "Optional. Enables range queries and composite keys. Type is S (string), N (number), or B (binary). Leave blank for simple primary key.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!/^[a-zA-Z0-9_]+:[SNB]$/.test(s))
            return "Format: attributeName:S|N|B (e.g. createdAt:N)";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:backend",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: CfnKey.READ_CAPACITY_UNITS,
      question: {
        type: "string",
        label: "Read capacity units (RCUs)",
        placeholder: "5",
        initialValue: "5",
        hint: "1 RCU = one strongly consistent 4 KB read/sec. Only applies to provisioned billing mode.",
        showIf: {
          field: CfnKey.BILLING_MODE,
          value: AwsDefault.BILLING_PROVISIONED,
        },
        validate: (value: unknown) => {
          if (!value) return "RCUs required for provisioned mode";
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1)
            return "Must be a positive integer";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.WRITE_CAPACITY_UNITS,
      question: {
        type: "string",
        label: "Write capacity units (WCUs)",
        placeholder: "5",
        initialValue: "5",
        hint: "1 WCU = one 1 KB write/sec. Only applies to provisioned billing mode.",
        showIf: {
          field: CfnKey.BILLING_MODE,
          value: AwsDefault.BILLING_PROVISIONED,
        },
        validate: (value: unknown) => {
          if (!value) return "WCUs required for provisioned mode";
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1)
            return "Must be a positive integer";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.PITR_ENABLED,
      question: {
        type: "boolean",
        label: "Enable point-in-time recovery (PITR)?",
        initialValue: true,
        hint: "Continuous backups with per-second granularity. Allows restore to any point in last 35 days. Adds ~20% to storage cost. Recommended for production.",
      },
    },
    {
      name: CfnKey.DELETION_PROTECTION_ENABLED,
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: true,
        hint: "Prevents accidental table deletion. Must be explicitly disabled before the table can be deleted. Recommended for production.",
      },
    },
    {
      name: CfnKey.SSE_ENABLED,
      question: {
        type: "boolean",
        label: "Enable CMK encryption at rest?",
        initialValue: true,
        hint: "Uses a customer managed KMS key for encryption. DynamoDB always encrypts with AWS-owned keys, but CMK provides key rotation control and audit trails.",
      },
    },
  ],
  defaults: {
    [CfnKey.BILLING_MODE]: AwsDefault.BILLING_PAY_PER_REQUEST,
    [CfnKey.PITR_SPECIFICATION]: { [CfnKey.PITR_ENABLED]: true },
    [CfnKey.SSE_SPECIFICATION]: { [CfnKey.SSE_ENABLED]: true },
    get [CfnKey.TABLE_NAME](): string {
      return generateDynamodbTableName();
    },
  },
  configHints: [
    "BillingMode MUST be either PAY_PER_REQUEST or PROVISIONED — never omit it.",
    "When BillingMode=PAY_PER_REQUEST, DO NOT include ProvisionedThroughput — CCAPI rejects the pair. ProvisionedThroughput is only valid with BillingMode=PROVISIONED.",
    "If PROVISIONED, include ProvisionedThroughput with ReadCapacityUnits and WriteCapacityUnits.",
    "KeySchema requires exactly one HASH key; RANGE key is optional.",
    "AttributeDefinitions MUST include an entry for EVERY attribute name referenced in KeySchema, GlobalSecondaryIndexes.KeySchema, and LocalSecondaryIndexes.KeySchema. Mismatched names (e.g. KeySchema names 'hashKey' but AttributeDefinitions only declares 'Id') cause CCAPI rejection.",
    "Each AttributeDefinition has { AttributeName, AttributeType } where AttributeType is S (string), N (number), or B (binary).",
    "Set PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled to true unless user explicitly opts out.",
    "Only set DeletionProtectionEnabled to true when the user explicitly requests it. Default is false to allow destroy lifecycle.",
    "Set SSESpecification.SSEEnabled to true for CMK encryption unless user explicitly opts out.",
    "TableName: OMIT when the user didn't specify a name. Assignee auto-generates `assignee-dynamodb-table-<8hex>` so placeholders like `my-table`, `example-table`, or `my-ddb-table` never materialize in production.",
  ],
};
