import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/**
 * ResourcePlugin for AWS::SNS::Topic.
 * Supports standard and FIFO topics for pub/sub messaging.
 */
export const snsTopicPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SNS_TOPIC,
  commonFields: [
    {
      name: "TopicName",
      question: {
        type: "string",
        label: "Topic name",
        placeholder: "my-topic (leave blank for auto-generated)",
        hint: "Must be 1-256 chars. FIFO topics get .fifo appended automatically. Leave blank for an auto-generated name.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          let s = String(value);
          // Strip .fifo suffix — AWS appends it automatically for FIFO topics
          if (s.endsWith(".fifo")) s = s.slice(0, -5);
          if (s.length > 256) return "Topic name must be 1-256 characters";
          if (!/^[a-zA-Z0-9_-]+$/.test(s))
            return "Topic name can only contain alphanumeric characters, hyphens, and underscores";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        if (!v) return undefined;
        let s = String(v);
        // Strip .fifo suffix if user included it — AWS adds .fifo automatically for FIFO topics
        if (s.endsWith(".fifo")) {
          s = s.slice(0, -5);
        }
        return s || undefined;
      },
    },
    {
      name: "FifoTopic",
      question: {
        type: "boolean",
        label: "FIFO topic?",
        initialValue: false,
        hint: "FIFO topics guarantee strict message ordering and deduplication. Standard topics offer higher throughput with best-effort ordering.",
      },
    },
    {
      name: "DisplayName",
      question: {
        type: "string",
        label: "Display name",
        placeholder: "My Notification Topic",
        hint: "Human-readable name shown in SMS messages. Max 100 characters for SMS.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 100)
            return "Display name must be 100 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: "KmsMasterKeyId",
      question: {
        type: "string",
        label: "KMS Key ID for encryption",
        placeholder: "arn:aws:kms:...",
        hint: "ARN of a KMS key for server-side encryption. Strongly recommended: use 'alias/aws/sns' for the AWS-managed key. Only leave blank if encryption is handled elsewhere.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!s.startsWith("arn:aws:kms:") && !s.startsWith("alias/"))
            return "Must be a KMS key ARN or alias";
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
  advancedFields: [],
  defaults: {},
  configHints: [
    "SNS KmsMasterKeyId: Consider setting to 'alias/aws/sns' for server-side encryption at rest using the AWS-managed SNS key.",
  ],
};
