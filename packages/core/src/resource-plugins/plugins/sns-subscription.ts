import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::SNS::Subscription.
 *
 * An SNS Subscription attaches a consumer (SQS queue, Lambda function,
 * HTTP/HTTPS endpoint, email, SMS, Firehose stream) to an SNS topic.
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - required: [TopicArn, Protocol]
 *   - createOnly: [TopicArn, Protocol, Endpoint] — changing any of
 *     these replaces the subscription
 *   - conditionalCreateOnly: [Region] — cross-region subscriptions
 *   - writeOnly: [Region]
 *   - readOnly: [Arn]
 *   - primaryIdentifier: [/properties/Arn]
 *   - tagging.taggable = false (NOT taggable — NO_TAG_TYPES in
 *     apps/cli/src/utils/tags.ts skips tag injection for this type)
 *   - handlers: create, read, update, delete, list (all present)
 *
 * Update-supported fields (non-createOnly): DeliveryPolicy,
 * FilterPolicy, FilterPolicyScope, RawMessageDelivery, RedrivePolicy,
 * ReplayPolicy, SubscriptionRoleArn.
 *
 * Pricing: SNS subscriptions themselves are free; the topic bills on
 * published messages and the target service (SQS/Lambda/etc.) bills
 * on its own meter. Handled by a free-decomposer entry.
 *
 * @see A10 (2026-04-09) — promoted from CCAPI_FALLBACK_TYPES after
 *      the A8 operator-policy split restored ~1616 bytes of headroom
 *      on the services policy. Retires the SDK SubscribeCommand /
 *      UnsubscribeCommand code paths in sdk-fallback-dispatcher.ts.
 */
export const snsSubscriptionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION,
  commonFields: [
    {
      name: CfnKey.TOPIC_ARN,
      required: true,
      question: {
        type: "string",
        label: "Topic ARN",
        placeholder: "arn:aws:sns:us-east-1:123456789012:my-topic",
        hint: "Required + createOnly. ARN of the SNS topic to subscribe to. Use a Ref to an SNS::Topic logical ID in the same plan, or paste an existing topic ARN. Changing this replaces the subscription.",
        validate: (value: unknown) => {
          if (!value) return "Topic ARN is required";
          const s = String(value);
          // Partition-aware: arn:aws:sns, arn:aws-us-gov:sns, arn:aws-cn:sns
          if (!/^arn:aws[\w-]*:sns:/.test(s))
            return "Must be a valid SNS topic ARN (arn:aws*:sns:...)";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.PROTOCOL,
      required: true,
      question: {
        type: "enum",
        label: "Protocol",
        hint: "Required + createOnly. Determines how SNS delivers messages to subscribers. 'sqs' and 'lambda' are the common programmatic choices; 'https' for webhook endpoints; 'email'/'email-json' for human notification; 'sms' for phone numbers; 'firehose' for streaming to S3/Redshift.",
        options: [
          { value: "sqs", label: "SQS queue" },
          { value: "lambda", label: "Lambda function" },
          { value: "https", label: "HTTPS endpoint" },
          { value: "http", label: "HTTP endpoint" },
          { value: "email", label: "Email (plain text)" },
          { value: "email-json", label: "Email (JSON payload)" },
          { value: "sms", label: "SMS (phone number)" },
          { value: "firehose", label: "Kinesis Data Firehose" },
          { value: "application", label: "Mobile push (application endpoint)" },
        ],
        // e98.W5.N2 (D-13) — no default Protocol. The previous
        // `initialValue: "sqs"` + `defaults.Protocol=sqs` combination
        // silently clamped the protocol to SQS when the endpoint was a
        // phone number, Lambda ARN, or email address, producing plans
        // that looked correct but sent every message to the wrong
        // consumer class. Intent-parser infers Protocol from the
        // Endpoint shape (E.164 phone → sms, Lambda ARN → lambda, etc.);
        // if inference fails the wizard / LLM must explicitly elicit
        // the value so users see the dispatch choice surface instead
        // of silently defaulting.
      },
    },
    {
      name: CfnKey.ENDPOINT,
      required: true,
      question: {
        type: "string",
        label: "Endpoint",
        placeholder: "arn:aws:sqs:us-east-1:123456789012:my-queue",
        hint: "Required + createOnly. Format depends on the Protocol: SQS queue ARN, Lambda function ARN, Firehose delivery stream ARN, HTTPS URL, email address, or E.164 phone number. Changing this replaces the subscription.",
        validate: (value: unknown) => {
          if (!value) return "Endpoint is required";
          const s = String(value).trim();
          if (s.length === 0) return "Endpoint cannot be empty";
          return undefined;
        },
      },
    },
    {
      name: "RawMessageDelivery",
      question: {
        type: "boolean",
        label: "Raw message delivery?",
        initialValue: false,
        hint: "When true (SQS + HTTP/HTTPS only), SNS strips the JSON envelope and delivers only the message body. Strongly recommended for SQS subscriptions — otherwise consumers have to parse the envelope to get at the payload.",
      },
    },
    {
      name: "RedrivePolicy",
      question: {
        type: "string",
        label: "RedrivePolicy DLQ (SQS ARN)",
        placeholder:
          '{"deadLetterTargetArn":"arn:aws:sqs:us-east-1:123456789012:my-dlq"}',
        hint: 'Optional but strongly recommended: JSON {"deadLetterTargetArn":"<sqs-arn>"}. Messages that SNS cannot deliver after exhausting the retry policy are forwarded to this dead-letter queue instead of being silently dropped. Closes the #1 SNS failure mode.',
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s) as Record<string, unknown>;
            if (!parsed || typeof parsed !== "object")
              return "RedrivePolicy must be a JSON object";
            if (
              !("deadLetterTargetArn" in parsed) ||
              typeof parsed["deadLetterTargetArn"] !== "string"
            )
              return 'RedrivePolicy must contain deadLetterTargetArn: "<sqs-arn>"';
            const dlqArn = parsed["deadLetterTargetArn"];
            if (!/^arn:aws[\w-]*:sqs:/.test(dlqArn))
              return "deadLetterTargetArn must be a valid SQS queue ARN";
          } catch {
            return "RedrivePolicy must be valid JSON";
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
  advancedFields: [
    {
      name: "FilterPolicy",
      question: {
        type: "string",
        label: "FilterPolicy (JSON)",
        placeholder: '{"eventType":["order.placed","order.paid"]}',
        hint: "Optional. JSON filter that lets SNS drop messages the subscriber isn't interested in BEFORE delivery. Keys match message attributes (default) or message body (when FilterPolicyScope=MessageBody). Values are arrays of allowed values or SNS matching operators.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object")
              return "FilterPolicy must be a JSON object";
          } catch {
            return "FilterPolicy must be valid JSON";
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
      name: "FilterPolicyScope",
      question: {
        type: "enum",
        label: "FilterPolicy scope",
        hint: "Scope of FilterPolicy matching. MessageAttributes (default) matches against publish-time attributes; MessageBody matches against JSON keys inside the message payload itself.",
        options: [
          { value: "MessageAttributes", label: "Message attributes (default)" },
          { value: "MessageBody", label: "Message body" },
        ],
      },
    },
    {
      name: "DeliveryPolicy",
      question: {
        type: "string",
        label: "DeliveryPolicy (JSON)",
        placeholder:
          '{"healthyRetryPolicy":{"numRetries":5,"backoffFunction":"exponential"}}',
        hint: "Optional. JSON retry policy for HTTP/HTTPS endpoints. Overrides the topic-level default. Ignored for SQS/Lambda/Firehose subscriptions.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object")
              return "DeliveryPolicy must be a JSON object";
          } catch {
            return "DeliveryPolicy must be valid JSON";
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
      name: "SubscriptionRoleArn",
      question: {
        type: "string",
        label: "Subscription role ARN (Firehose only)",
        placeholder: "arn:aws:iam::123456789012:role/sns-firehose-delivery",
        hint: "ONLY for firehose protocol. ARN of an IAM role SNS assumes to deliver events to the Firehose stream. Ignored for every other protocol.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          // Partition-aware match so GovCloud / China users aren't
          // rejected (feedback_partition_aware_arn_matching).
          if (!/^arn:aws[\w-]*:iam::/.test(s))
            return "SubscriptionRoleArn must be a valid IAM role ARN";
          return undefined;
        },
      },
    },
  ],
  defaults: {
    // e98.W5.N2 (D-13) — removed Protocol: "sqs" default. See the
    // commentary on the Protocol field above. Endpoint shape drives
    // protocol inference in the intent-parser; elicitation owns the
    // fallback when inference can't determine the type.
    RawMessageDelivery: false,
  },
  configHints: [
    "NEVER include Tags — AWS::SNS::Subscription is not taggable (CCAPI schema reports tagging.taggable=false). Omit Tags entirely.",
    "TopicArn + Protocol + Endpoint are all createOnly — changing any of them triggers subscription replacement (the old subscription is deleted and a new one is created).",
    "For SQS subscriptions, set RawMessageDelivery=true so consumers receive the raw message body instead of the JSON envelope. Otherwise every consumer has to parse `{Type, MessageId, TopicArn, Message, ...}` to get at the payload.",
    "Always attach a RedrivePolicy pointing at a dead-letter SQS queue — without one, messages that SNS cannot deliver after the retry policy exhausts are SILENTLY DROPPED. This is the #1 SNS failure mode and the only thing that catches it.",
    "For cross-account subscriptions, the subscription enters PendingConfirmation and requires an out-of-band ConfirmSubscription call from the subscriber account before it becomes Active.",
    "SubscriptionRoleArn is required ONLY for firehose protocol — it's the role SNS assumes to write to the Firehose delivery stream. Ignored for sqs/lambda/http/https/email/sms.",
  ],
};
