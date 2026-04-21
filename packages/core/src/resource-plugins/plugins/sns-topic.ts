import { randomBytes } from "node:crypto";
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
 * Epic 92 Wave 4.b (finding A-15): placeholder-sounding literal names like
 * "my-sns-topic" or "my-topic" were leaking into real AWS accounts when the
 * LLM echoed the field placeholder. Mirrors the Lambda compound pattern's
 * `assignee-lambda-fn-<hash>` convention:
 *
 *   assignee-sns-topic-<8 hex>
 *
 * Generated identifier uses only `[a-zA-Z0-9_-]` (SNS-allowed), fits within
 * the 256-char limit, and has no special characters that would confuse
 * `config/arn-builder.ts` on destroy round-trip.
 */
const PLACEHOLDER_TOPIC_NAMES = new Set([
  "my-topic",
  "my-sns-topic",
  "example-topic",
  "example-sns-topic",
]);

function generateSnsTopicName(): string {
  return `assignee-sns-topic-${randomBytes(4).toString("hex")}`;
}

/**
 * ResourcePlugin for AWS::SNS::Topic.
 * Supports standard and FIFO topics for pub/sub messaging.
 */
export const snsTopicPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SNS_TOPIC,
  commonFields: [
    {
      name: CfnKey.TOPIC_NAME,
      question: {
        type: "string",
        label: "Topic name",
        placeholder:
          "assignee-sns-topic-<8hex> (leave blank for auto-generated)",
        hint: "Must be 1-256 chars. FIFO topics get .fifo appended automatically. Leave blank — Assignee auto-generates 'assignee-sns-topic-<8hex>'.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          let s = String(value);
          if (s.endsWith(".fifo")) s = s.slice(0, -5);
          if (s.length > 256) return "Topic name must be 1-256 characters";
          if (!/^[a-zA-Z0-9_-]+$/.test(s))
            return "Topic name can only contain alphanumeric characters, hyphens, and underscores";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        if (v === undefined || v === null) return generateSnsTopicName();
        let s = String(v).trim();
        if (s === "") return generateSnsTopicName();
        if (s.endsWith(".fifo")) {
          s = s.slice(0, -5);
        }
        if (PLACEHOLDER_TOPIC_NAMES.has(s.toLowerCase())) {
          return generateSnsTopicName();
        }
        return s || generateSnsTopicName();
      },
    },
    {
      name: CfnKey.FIFO_TOPIC,
      question: {
        type: "boolean",
        label: "FIFO topic?",
        initialValue: false,
        hint: "FIFO topics guarantee strict message ordering and deduplication. Standard topics offer higher throughput with best-effort ordering.",
      },
    },
    {
      name: CfnKey.DISPLAY_NAME,
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
      name: CfnKey.KMS_MASTER_KEY_ID,
      question: {
        type: "string",
        label: "KMS Key ID for encryption",
        placeholder: "arn:aws:kms:...",
        hint: "ARN of a KMS key for server-side encryption. Strongly recommended: use 'alias/aws/sns' for the AWS-managed key. Only leave blank if encryption is handled elsewhere.",
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
      name: CfnKey.CONTENT_BASED_DEDUP,
      question: {
        type: "boolean",
        label: "Enable content-based deduplication?",
        initialValue: false,
        hint: "When enabled, SNS computes a SHA-256 hash of the message body and treats messages with the same hash as duplicates within the 5-minute deduplication window. FIFO topics only — ignored on standard topics.",
        showIf: { field: CfnKey.FIFO_TOPIC, value: true },
      },
    },
  ],
  defaults: {
    // Getter — every access returns a fresh `assignee-sns-topic-<8hex>` so
    // a long-lived MCP server does not reuse the same seed across plans.
    get [CfnKey.TOPIC_NAME](): string {
      return generateSnsTopicName();
    },
  },
  configHints: [
    "SNS KmsMasterKeyId: Consider setting to 'alias/aws/sns' for server-side encryption at rest using the AWS-managed SNS key.",
    "FifoTopic MUST be set to true if the TopicName ends with .fifo. Standard and FIFO topics cannot be converted after creation.",
    "ContentBasedDeduplication can only be enabled on FIFO topics — setting it on a standard topic causes a CloudFormation error.",
    "Subscription configuration (protocol, endpoint) requires a separate AWS::SNS::Subscription resource — do NOT put subscription properties on the Topic itself.",
    "DisplayName is used as the 'from' line in SMS messages and is limited to 100 characters for SMS delivery.",
    "TopicName: OMIT when the user didn't specify a name. Assignee auto-generates `assignee-sns-topic-<8hex>` so placeholders like `my-topic`, `my-sns-topic`, or `example-topic` never materialize into a real AWS account.",
  ],
};
