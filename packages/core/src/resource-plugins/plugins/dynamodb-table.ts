import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::DynamoDB::Table.
 * commonFields: TableName, BillingMode, KeySchema (partition key), SortKey, Tags.
 * advancedFields: RCU/WCU (provisioned-only), PITR, deletion protection, SSE.
 */
export const dynamodbTablePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
  commonFields: [
    {
      name: "TableName",
      required: true,
      question: {
        type: "string",
        label: "Table name",
        placeholder: "my-table",
        hint: "Must be 3-255 characters. Letters, numbers, underscores, hyphens, and periods. Cannot be changed after creation.",
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
    },
    {
      name: "BillingMode",
      question: {
        type: "enum",
        label: "Billing mode",
        options: [
          {
            value: "PAY_PER_REQUEST",
            label: "On-demand (pay per request)",
            recommended: true,
            fitHint: "Best for unpredictable or new workloads",
          },
          {
            value: "PROVISIONED",
            label: "Provisioned (set read/write capacity)",
            fitHint: "Best for steady, predictable traffic",
          },
        ],
        initialValue: "PAY_PER_REQUEST",
        hint: "On-demand scales automatically with no capacity planning. Provisioned is cheaper for steady workloads but requires you to set read/write capacity units.",
      },
    },
    {
      name: "PartitionKey",
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
        const [name, type] = String(answer).split(":");
        return [{ AttributeName: name, KeyType: "HASH" }];
      },
    },
    {
      name: "SortKey",
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
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
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
      name: "ReadCapacityUnits",
      question: {
        type: "string",
        label: "Read capacity units (RCUs)",
        placeholder: "5",
        initialValue: "5",
        hint: "1 RCU = one strongly consistent 4 KB read/sec. Only applies to provisioned billing mode.",
        showIf: { field: "BillingMode", value: "PROVISIONED" },
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
      name: "WriteCapacityUnits",
      question: {
        type: "string",
        label: "Write capacity units (WCUs)",
        placeholder: "5",
        initialValue: "5",
        hint: "1 WCU = one 1 KB write/sec. Only applies to provisioned billing mode.",
        showIf: { field: "BillingMode", value: "PROVISIONED" },
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
      name: "PointInTimeRecoveryEnabled",
      question: {
        type: "boolean",
        label: "Enable point-in-time recovery (PITR)?",
        initialValue: true,
        hint: "Continuous backups with per-second granularity. Allows restore to any point in last 35 days. Adds ~20% to storage cost. Recommended for production.",
      },
    },
    {
      name: "DeletionProtectionEnabled",
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: false,
        hint: "Prevents accidental table deletion. Must be explicitly disabled before the table can be deleted. Recommended for production.",
      },
    },
    {
      name: "SSEEnabled",
      question: {
        type: "boolean",
        label: "Enable CMK encryption at rest?",
        initialValue: true,
        hint: "Uses a customer managed KMS key for encryption. DynamoDB always encrypts with AWS-owned keys, but CMK provides key rotation control and audit trails.",
      },
    },
  ],
  defaults: {
    BillingMode: "PAY_PER_REQUEST",
    PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true },
    SSESpecification: { SSEEnabled: true },
  },
  configHints: [
    "BillingMode MUST be either PAY_PER_REQUEST or PROVISIONED — never omit it.",
    "If PROVISIONED, include ProvisionedThroughput with ReadCapacityUnits and WriteCapacityUnits.",
    "KeySchema requires exactly one HASH key; RANGE key is optional.",
    "AttributeDefinitions MUST include all attributes used in KeySchema.",
    "Set PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled to true unless user explicitly opts out.",
    "Only set DeletionProtectionEnabled to true when the user explicitly requests it. Default is false to allow destroy lifecycle.",
    "Set SSESpecification.SSEEnabled to true for CMK encryption unless user explicitly opts out.",
  ],
};
