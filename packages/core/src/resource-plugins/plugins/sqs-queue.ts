import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import { KMS_ALIAS_PREFIX } from "../../config/aws-arns.js";
import { isArnOfService } from "../../config/aws-partition.js";
import type { ResourcePlugin } from "../types.js";
import {
  TAGS_VALIDATE,
  TAGS_HINT,
  KMS_ARN_VALIDATION_MSG,
} from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::SQS::Queue.
 *
 * Supports standard and FIFO queues with dead-letter queue configuration.
 *
 * Epic 92 e92.u.c.1 (A-07): the VisibilityTimeout field is wired with the
 * schema-accurate property name "VisibilityTimeout" (NOT the legacy alias
 * `CfnKey.VISIBILITY_TIMEOUT = "VisibilityTimeoutSeconds"` — that alias is
 * stripped by the desired-state-sanitizer because it does not appear in
 * the real AWS::SQS::Queue schema). A default of 30s is registered in
 * plugin.defaults so --no-wizard flows and the secure-defaults-audit
 * direct-spread path always ship a sane value.
 *
 * Follow-ups (out of scope here):
 *   F1 — sqs:GetQueueAttributes readback after CCAPI SUCCESS in
 *        graph/nodes/status-poller.ts so displayed cost/config reflects
 *        the actual queue state.
 *   F2 — retire the CfnKey.VISIBILITY_TIMEOUT alias; it encodes a bug
 *        and is only referenced by the sanitizer tests that assert the
 *        strip.
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
      // Epic 92 e92.u.c.1 A-07: use the schema-accurate key directly
      // (NOT CfnKey.VISIBILITY_TIMEOUT which aliases to the wrong string
      // "VisibilityTimeoutSeconds" and gets stripped by the sanitizer).
      name: "VisibilityTimeout",
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
          if (!isArnOfService(s, "kms") && !s.startsWith(KMS_ALIAS_PREFIX))
            return KMS_ARN_VALIDATION_MSG;
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
          if (!isArnOfService(s, "sqs")) return "Must be an SQS queue ARN";
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
    // Epic 92 e92.u.c.1 A-07: schema-accurate default; survives the
    // desired-state-sanitizer because "VisibilityTimeout" IS a valid
    // AWS::SQS::Queue property.
    VisibilityTimeout: 30,
  },
  configHints: [
    "FifoQueue set to true requires QueueName to end with '.fifo' suffix — CloudFormation will fail without it. ContentBasedDeduplication is only valid on FIFO queues.",
    "VisibilityTimeout should be set to at least 6x the consumer Lambda timeout (if Lambda-triggered) to avoid duplicate processing. Default is 30 seconds.",
    "RedrivePolicy requires a deadLetterTargetArn (ARN of the DLQ) and maxReceiveCount (number of retries before sending to DLQ). The DLQ must be the same type (Standard or FIFO) as the source queue.",
    "SqsManagedSseEnabled provides free server-side encryption. Use KmsMasterKeyId only if you need customer-managed key control — do not set both simultaneously.",
    "ALWAYS set MessageRetentionPeriod explicitly — the default is 4 days (345600 seconds). For DLQs, set a longer retention (e.g., 14 days / 1209600 seconds) to allow time for investigation.",
  ],
};
