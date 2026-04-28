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
 * ResourcePlugin for AWS::Events::EventBus.
 *
 * A custom EventBridge event bus. The default account-level bus
 * (`default`) is built-in and free; custom buses are created on
 * demand for cross-account event publishing, SaaS partner event
 * ingestion, or topical isolation (e.g. one bus per business
 * domain so an outage in the orders domain doesn't take down the
 * inventory domain's event flow).
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/Name
 *   - required: Name
 *   - createOnly: Name
 *   - readOnly: Arn
 *   - optional: EventSourceName, Tags, Description, KmsKeyIdentifier,
 *     Policy, DeadLetterConfig, LogConfig
 *
 * Pricing: custom buses bill a per-million-events rate for events
 * published TO the bus (run `assignee cost` for live Pricing-MCP rates).
 * The default bus has no per-event charge for AWS-service events.
 * Cross-account event delivery is billed to the publishing account
 * at the standard rate.
 *
 * @see A9 (2026-04-09) — first new resource type added after the
 *      operator-policy split (d5eec4f) restored the headroom that
 *      had been blocking type expansion since A8.
 */
export const eventsEventBusPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EVENTS_EVENT_BUS,
  commonFields: [
    {
      name: "Name",
      required: true,
      question: {
        type: "string",
        label: "Event bus name",
        placeholder: "orders-events",
        hint: "Required + createOnly. Must be 1-256 chars: alphanumeric, '.', '_', '-'. Must NOT be 'default' (that's the built-in account bus). Cannot be changed after creation — pick a stable name.",
        validate: (value: unknown) => {
          if (!value) return "Name is required";
          const s = String(value);
          if (s.length < 1 || s.length > 256)
            return "Name must be 1-256 characters";
          if (!/^[a-zA-Z0-9._-]+$/.test(s))
            return "Name can only contain alphanumerics, '.', '_', '-'";
          if (s === "default")
            return "'default' is the built-in account event bus and cannot be created";
          return undefined;
        },
      },
    },
    {
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Production order events for the orders domain",
        hint: "Human-readable description. Strongly recommended — appears in the EventBridge console next to the bus name and saves real triage time.",
      },
    },
    {
      name: "KmsKeyIdentifier",
      question: {
        type: "string",
        label: "KMS Key ID for at-rest encryption",
        placeholder: "alias/aws/events",
        hint: "Optional. EventBridge encrypts events at rest with the AWS-owned key by default; specify a customer-managed KMS key ARN or alias for tighter access control + audit trail. Use 'alias/aws/events' for the AWS-managed EventBridge key (free, account-scoped).",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.startsWith(KMS_ALIAS_PREFIX) || isArnOfService(s, "kms"))
            return undefined;
          return KMS_ARN_VALIDATION_MSG;
        },
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:platform",
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
      name: "EventSourceName",
      question: {
        type: "string",
        label: "SaaS partner event source name",
        placeholder: "aws.partner/example.com/SaasProduct/12345",
        hint: "Optional. Set ONLY when receiving events from a SaaS partner via the EventBridge SaaS partner integration. Format: aws.partner/<vendor>/<product>/<id>. Leave blank for normal account-owned buses.",
      },
    },
    {
      name: "Policy",
      question: {
        type: "string",
        label: "Resource policy (JSON)",
        placeholder: '{"Version":"2012-10-17","Statement":[...]}',
        hint: "Optional. JSON resource policy controlling which accounts/services can publish to this bus. Required for cross-account event publishing. Must be valid IAM policy JSON.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object")
              return "Policy must be a JSON object";
          } catch {
            return "Policy must be valid JSON";
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer || (typeof answer === "string" && !answer.trim()))
          return undefined;
        try {
          return JSON.parse(String(answer));
        } catch {
          return undefined;
        }
      },
    },
    {
      // A9 hygiene (2026-04-09): BP-EVENTBUS-003 requires
      // DeadLetterConfig.Arn to exist, but the A9 plugin forgot to
      // expose the field — there was no way for a wizard user to
      // satisfy the rule. This advanced field takes an SQS queue
      // ARN and emits the nested `{ Arn: "<sqs-arn>" }` structure
      // CCAPI expects.
      name: "DeadLetterConfig",
      question: {
        type: "string",
        label: "Dead-letter queue SQS ARN",
        placeholder:
          "arn:aws:sqs:us-east-1:<your-12-digit-account-id>:eventbus-dlq",
        hint: "Strongly recommended. SQS queue ARN that captures events EventBridge cannot deliver to any rule target. Without a DLQ, undeliverable events are silently dropped — wire a same-account SQS queue here so failures are recoverable. The bus service principal needs sqs:SendMessage on the DLQ via a queue policy.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          // Partition-aware — covers GovCloud / China partitions.
          if (!/^arn:aws[\w-]*:sqs:/.test(s))
            return "DeadLetterConfig must be a valid SQS queue ARN";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return { Arn: answer.trim() };
      },
    },
    {
      // A9 hygiene (2026-04-09): LogConfig is in the CCAPI schema
      // but the original A9 plugin missed it. Accepts an enum-style
      // IncludeDetail level so the wizard is constrained; the toCfn
      // adapter wraps it into the nested `{ IncludeDetail: "..." }`
      // object CloudFormation expects.
      name: "LogConfig",
      question: {
        type: "enum",
        label: "EventBus log detail",
        hint: "Optional. Controls how much information EventBridge writes to the service's own observability logs when events fail delivery. NONE (default) is the free tier — FULL adds detail at the standard CloudWatch Logs rate.",
        options: [
          { value: "NONE", label: "None (default)" },
          { value: "FULL", label: "Full — includes trace + payload detail" },
        ],
      },
      toCfn: (answer: unknown) => {
        if (!answer || answer === "NONE") return undefined;
        return { IncludeDetail: String(answer) };
      },
    },
  ],
  defaults: {},
  configHints: [
    "Name is createOnly + required — pick a stable, descriptive name (e.g. `orders-events`, `inventory-events`). Renaming requires replacing the bus, which loses every rule + subscriber wired to it.",
    "Custom event buses bill a per-million-events rate for events PUBLISHED to the bus. Rule evaluation + target invocation are billed separately by their own service rates. The default bus has no per-event charge for AWS-service events. Run `assignee cost` for live Pricing-MCP rates.",
    "KmsKeyIdentifier: customer-managed KMS keys give you key rotation control + CloudTrail audit on every encrypt/decrypt operation. Use the alias 'alias/aws/events' for the AWS-managed EventBridge key (no rotation control, no extra charge).",
    "Cross-account event publishing requires BOTH the Policy field on this bus (Allow events:PutEvents from the source account) AND a matching events:PutEvents permission on the source account's IAM role.",
    "DeadLetterConfig captures events that fail rule processing OR have no matching rule. Wire a same-account SQS queue here so dropped events are recoverable instead of silently lost.",
    "For SaaS partner integration (Stripe, Auth0, etc.), set EventSourceName to the partner-issued source ARN. Without it, the SaaS partner cannot publish to this bus.",
  ],
};
