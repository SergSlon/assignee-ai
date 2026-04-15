import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::Events::Rule.
 *
 * EventBridge (CloudWatch Events) rules route events to targets. A rule
 * fires either:
 *   - on a schedule (cron or rate expression) — the "scheduled task" use case
 *   - in response to matched events on an event bus — the "event-driven" use case
 *
 * CCAPI schema (verified 2026-04-08 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/Arn (readOnly)
 *   - createOnly: /properties/Name
 *   - readOnly: /properties/Arn
 *   - No schema-level required fields (but logically either ScheduleExpression
 *     OR EventPattern plus at least one Target are needed — enforced by the
 *     BP rules BP-EVENTS-001 and BP-EVENTS-002).
 *
 * Pricing: custom events published to EventBridge bill a per-million-events
 * rate (run `assignee cost` for live Pricing-MCP rates). Rule evaluation +
 * target invocation from the default bus are included at no extra charge.
 * The overwhelming common case (a single-target scheduled Lambda or a
 * simple event-pattern filter on the default bus) bills nothing for the
 * rule itself; the workload fees (Lambda invocation, SQS message, etc.)
 * dominate.
 */
export const eventsRulePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EVENTS_RULE,
  commonFields: [
    {
      name: "Name",
      question: {
        type: "string",
        label: "Rule name",
        placeholder: "my-rule (leave blank for auto-generated)",
        hint: "Must be 1-64 chars: alphanumeric, '.', '_', '-'. Cannot be changed after creation (createOnly property).",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.length < 1 || s.length > 64)
            return "Rule name must be 1-64 characters";
          if (!/^[a-zA-Z0-9._-]+$/.test(s))
            return "Rule name can only contain alphanumerics, '.', '_', '-'";
          return undefined;
        },
      },
    },
    {
      name: "ScheduleExpression",
      question: {
        type: "string",
        label: "Schedule expression",
        placeholder: "rate(5 minutes) or cron(0 12 * * ? *)",
        hint: "A cron() or rate() expression. rate(N minutes|hours|days) for simple intervals. cron(min hour day month day-of-week year) for specific schedules. Leave blank if this rule matches on an EventPattern instead.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          if (!/^(rate|cron)\(.+\)$/.test(s))
            return "Must be rate(...) or cron(...)";
          // Minimum rate: 1 minute
          const rateMatch = s.match(
            /^rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)$/,
          );
          if (rateMatch) {
            const value = Number(rateMatch[1]);
            const unit = rateMatch[2];
            if (value < 1) return "rate() value must be at least 1";
            if (unit === "minute" && value < 1)
              return "Minimum schedule is rate(1 minute)";
          }
          return undefined;
        },
      },
    },
    {
      name: "EventPattern",
      question: {
        type: "string",
        label: "Event pattern (JSON)",
        placeholder: '{"source":["aws.s3"]}',
        hint: "A JSON event pattern that filters events on the bus. Must match the EventBridge pattern language. Leave blank if this rule uses a ScheduleExpression instead.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object")
              return "Event pattern must be a JSON object";
          } catch {
            return "Event pattern must be valid JSON";
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (!answer || (typeof answer === "string" && !answer.trim()))
          return undefined;
        try {
          // CCAPI accepts either a string or an object — normalize to
          // object so drift comparison and BP inspection work uniformly.
          return JSON.parse(String(answer));
        } catch {
          return undefined;
        }
      },
    },
    {
      name: "State",
      question: {
        type: "enum",
        label: "Initial state",
        options: [
          { value: "ENABLED", label: "ENABLED (rule fires immediately)" },
          { value: "DISABLED", label: "DISABLED (created paused)" },
        ],
        initialValue: "ENABLED",
        hint: "ENABLED means the rule will fire as soon as it matches. DISABLED is useful for dry-running a new rule before turning it on.",
      },
    },
    {
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Nightly cleanup of expired S3 objects",
        hint: "Human-readable description of what the rule does. Strongly recommended — shows up in the EventBridge console and CloudTrail.",
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
      name: "EventBusName",
      question: {
        type: "string",
        label: "Event bus name",
        placeholder: "default",
        initialValue: "default",
        hint: "Name of the event bus this rule listens on. 'default' is the per-account built-in bus. Custom buses (for cross-account or SaaS partner events) bill a per-million-events rate on top of the standard rule pricing — run `assignee cost` for live Pricing-MCP rates.",
      },
    },
    {
      name: "RoleArn",
      question: {
        type: "string",
        label: "Invocation IAM role ARN",
        placeholder: "arn:aws:iam::123456789012:role/my-eventbridge-role",
        hint: "Optional. Required only if targets are cross-account or need to assume a specific role (e.g. Kinesis streams in another account). Most Lambda/SQS/SNS targets don't need this.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (!/^arn:aws[\w-]*:iam::\d{12}:role\//.test(s))
            return "Must be an IAM role ARN";
          return undefined;
        },
      },
    },
  ],
  defaults: {
    State: "ENABLED",
  },
  configHints: [
    "A rule must have EITHER a ScheduleExpression OR an EventPattern — not both, not neither. Schedule for time-triggered rules, EventPattern for reactive rules.",
    "Every rule MUST declare at least one Target. A rule with no targets is a no-op and CloudFormation will fail validation.",
    "ScheduleExpression rate() granularity is minutes: the shortest usable interval is rate(1 minute). For sub-minute polling, use a Lambda with a self-rescheduling invocation instead.",
    "For async targets (Lambda, SQS, Step Functions), set DeadLetterConfig on the Target so failed events are captured instead of silently dropped after the default 185-retry exhaustion.",
    "Target.RetryPolicy defaults to 185 retries over 24 hours — often too many for idempotent handlers and not enough for non-idempotent ones. Tune both MaximumRetryAttempts and MaximumEventAgeInSeconds per target.",
    "Custom event buses bill a per-million-events rate for events published TO the bus, in addition to the per-rule evaluation costs. The 'default' bus has no per-event charge for AWS service events. Run `assignee cost` for live Pricing-MCP rates.",
    "Rule Name is createOnly — renaming a rule requires replacing it. Prefer descriptive names that won't need to change.",
  ],
};
