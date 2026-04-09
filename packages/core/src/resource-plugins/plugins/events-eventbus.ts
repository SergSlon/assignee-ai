import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import { ArnPrefix, KMS_ALIAS_PREFIX } from "../../config/aws-arns.js";
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
 * Pricing: $1.00 per million events published to a custom bus.
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
          if (s.startsWith(KMS_ALIAS_PREFIX) || s.startsWith(ArnPrefix.KMS))
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
  ],
  defaults: {},
  configHints: [
    "Name is createOnly + required — pick a stable, descriptive name (e.g. `orders-events`, `inventory-events`). Renaming requires replacing the bus, which loses every rule + subscriber wired to it.",
    "Custom event buses bill $1.00 per million events PUBLISHED to the bus. Rule evaluation + target invocation are billed separately by their own service rates. The default bus has no per-event charge for AWS-service events.",
    "KmsKeyIdentifier: customer-managed KMS keys give you key rotation control + CloudTrail audit on every encrypt/decrypt operation. Use the alias 'alias/aws/events' for the AWS-managed EventBridge key (free, no rotation control).",
    "Cross-account event publishing requires BOTH the Policy field on this bus (Allow events:PutEvents from the source account) AND a matching events:PutEvents permission on the source account's IAM role.",
    "DeadLetterConfig captures events that fail rule processing OR have no matching rule. Wire a same-account SQS queue here so dropped events are recoverable instead of silently lost.",
    "For SaaS partner integration (Stripe, Auth0, etc.), set EventSourceName to the partner-issued source ARN. Without it, the SaaS partner cannot publish to this bus.",
  ],
};
