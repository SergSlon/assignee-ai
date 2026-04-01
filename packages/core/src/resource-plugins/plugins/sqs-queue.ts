import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE } from "../shared-fields.js";

/**
 * ResourcePlugin for AWS::SQS::Queue.
 * Supports standard and FIFO queues with dead-letter queue configuration.
 */
export const sqsQueuePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SQS_QUEUE,
  commonFields: [
    {
      name: CfnKey.QUEUE_NAME,
      question: {
        type: "string",
        label: "Queue name",
        placeholder: "my-queue (leave blank for auto-generated)",
        hint: "Must be 1-80 chars. FIFO queues get .fifo appended automatically. Leave blank for an auto-generated name.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          let s = String(value);
          // Strip .fifo suffix — AWS appends it automatically for FIFO queues
          if (s.endsWith(".fifo")) s = s.slice(0, -5);
          if (s.length > 80) return "Queue name must be 1-80 characters";
          if (!/^[a-zA-Z0-9_-]+$/.test(s))
            return "Queue name can only contain alphanumeric characters, hyphens, and underscores";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        if (!v) return undefined;
        let s = String(v);
        // Strip .fifo suffix if user included it — AWS adds .fifo automatically for FIFO queues
        if (s.endsWith(".fifo")) {
          s = s.slice(0, -5);
        }
        return s || undefined;
      },
    },
    {
      name: CfnKey.FIFO_QUEUE,
      question: {
        type: "boolean",
        label: "FIFO queue?",
        initialValue: false,
        hint: "FIFO queues guarantee exactly-once processing and strict ordering. Standard queues offer higher throughput with best-effort ordering. FIFO has a higher per-request cost than standard.",
      },
    },
    {
      name: CfnKey.VISIBILITY_TIMEOUT,
      question: {
        type: "string",
        label: "Visibility timeout (seconds)",
        placeholder: "30",
        initialValue: "30",
        hint: "How long a message stays invisible after a consumer receives it. Set to slightly longer than your processing time. Default 30s, max 43200s (12 hours).",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 43200)
            return "Must be 0-43200 seconds";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.MESSAGE_RETENTION,
      question: {
        type: "enum",
        label: "Message retention period",
        options: [
          { value: "60", label: "1 minute" },
          { value: "300", label: "5 minutes" },
          { value: "3600", label: "1 hour" },
          { value: "86400", label: "1 day (default)" },
          { value: "1209600", label: "14 days (maximum)" },
        ],
        initialValue: "86400",
        hint: "How long unprocessed messages are kept before automatic deletion. Longer retention uses more storage.",
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.TAGS,
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
  advancedFields: [
    {
      name: CfnKey.DELAY_SECONDS,
      question: {
        type: "string",
        label: "Delivery delay (seconds)",
        placeholder: "0",
        hint: "Delay before new messages become visible to consumers. 0-900 seconds. Useful for rate limiting or scheduling.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 900)
            return "Must be 0-900 seconds";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.MAX_MESSAGE_SIZE,
      question: {
        type: "enum",
        label: "Maximum message size",
        options: [
          { value: "1024", label: "1 KB" },
          { value: "65536", label: "64 KB" },
          { value: "262144", label: "256 KB (default/max)" },
        ],
        initialValue: "262144",
        hint: "Maximum size of a single message. For larger payloads, use S3 with the Extended Client Library.",
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.KMS_MASTER_KEY_ID,
      question: {
        type: "string",
        label: "KMS Key ID for encryption",
        placeholder: "arn:aws:kms:...",
        hint: "ARN of a KMS key for server-side encryption. Leave blank for no encryption or use 'alias/aws/sqs' for the AWS-managed key.",
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
      name: CfnKey.REDRIVE_POLICY,
      question: {
        type: "string",
        label: "Dead-letter queue ARN",
        placeholder: "arn:aws:sqs:us-east-1:123456789012:my-dlq",
        hint: "ARN of a dead-letter queue for messages that fail processing. Messages move to the DLQ after 3 failed receives.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!s.startsWith("arn:aws:sqs:")) return "Must be an SQS queue ARN";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer || (typeof answer === "string" && !answer.trim()))
          return undefined;
        return { deadLetterTargetArn: String(answer), maxReceiveCount: 3 };
      },
    },
  ],
  defaults: {
    [CfnKey.SQS_MANAGED_SSE]: true,
  },
};
