import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::Events::ApiDestination.
 *
 * Pairs with AWS::Events::Connection — references a ConnectionArn
 * and adds the HTTP invocation endpoint (URL + method + rate limit)
 * so EventBridge::Rule Targets can POST/GET/PUT/PATCH/DELETE events
 * to an external API. Classic use case: webhook out to Slack,
 * Datadog, Stripe, PagerDuty, or any SaaS partner whose API expects
 * an HTTPS endpoint.
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/Name
 *   - createOnly: /properties/Name
 *   - readOnly: /properties/Arn, /properties/ArnForPolicy
 *   - required: [ConnectionArn, InvocationEndpoint, HttpMethod]
 *   - tagging.taggable = false (NO_TAG_TYPES)
 *   - handlers: create, read, update, delete, list (all present)
 *
 * Pricing: ApiDestinations bill a per-million-invocations rate
 * (run `assignee cost` for live Pricing-MCP rates). The invoked
 * target bears its own outbound cost (Data Transfer Out on the
 * request body). Connection credentials usage is included at no
 * extra charge.
 *
 * @see A13 (2026-04-09)
 */
export const eventsApiDestinationPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EVENTS_API_DESTINATION,
  commonFields: [
    {
      name: "Name",
      required: true,
      question: {
        type: "string",
        label: "API destination name",
        placeholder: "slack-alerts-destination",
        hint: "Required + createOnly. 1-64 chars: alphanumerics, '.', '_', '-'. Cannot be changed after creation. Pick a stable name because Events::Rule Targets that reference this destination use its ARN (built from the name).",
        validate: (value: unknown) => {
          if (!value) return "Name is required";
          const s = String(value);
          if (s.length < 1 || s.length > 64)
            return "Name must be 1-64 characters";
          if (!/^[a-zA-Z0-9._-]+$/.test(s))
            return "Name can only contain alphanumerics, '.', '_', '-'";
          return undefined;
        },
      },
    },
    {
      name: "ConnectionArn",
      required: true,
      question: {
        type: "string",
        label: "Connection ARN",
        placeholder:
          "arn:aws:events:us-east-1:<your-12-digit-account-id>:connection/slack-webhook-connection/abcd-1234",
        hint: "Required. ARN of the Events::Connection that provides the auth credentials for this endpoint. Use a Ref to an Events::Connection logical ID in the same plan, or paste an existing connection ARN. The Connection must already exist (or be created earlier in the same plan).",
        validate: (value: unknown) => {
          if (!value) return "ConnectionArn is required";
          const s = String(value);
          // Partition-aware — covers GovCloud + China partitions.
          if (!/^arn:aws[\w-]*:events:/.test(s))
            return "Must be a valid EventBridge connection ARN (arn:aws*:events:...:connection/...)";
          if (!s.includes(":connection/"))
            return "ConnectionArn must reference a :connection/<name>/<uuid> path";
          return undefined;
        },
      },
    },
    {
      name: "InvocationEndpoint",
      required: true,
      question: {
        type: "string",
        label: "Invocation endpoint (HTTPS URL)",
        placeholder: "https://hooks.slack.com/services/T0/B0/xxx",
        hint: "Required. The HTTPS URL the target service expects. Must be HTTPS (http:// is rejected by the EventBridge service). Can contain {path} placeholders that are substituted from Rule Target HttpParameters at invocation time.",
        validate: (value: unknown) => {
          if (!value) return "InvocationEndpoint is required";
          const s = String(value).trim();
          if (!s.startsWith("https://"))
            return "InvocationEndpoint must be an HTTPS URL";
          if (s.length < 10 || s.length > 2048)
            return "InvocationEndpoint must be 10-2048 characters";
          return undefined;
        },
      },
    },
    {
      name: "HttpMethod",
      required: true,
      question: {
        type: "enum",
        label: "HTTP method",
        hint: "Required. The HTTP verb EventBridge uses when invoking the endpoint. Match the target API's expectations — webhook APIs are almost always POST; REST APIs may need PUT/PATCH/DELETE.",
        options: [
          { value: "POST", label: "POST (common for webhooks)" },
          { value: "PUT", label: "PUT" },
          { value: "PATCH", label: "PATCH" },
          { value: "GET", label: "GET" },
          { value: "DELETE", label: "DELETE" },
          { value: "HEAD", label: "HEAD" },
          { value: "OPTIONS", label: "OPTIONS" },
        ],
        initialValue: "POST",
      },
    },
    {
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Slack #alerts webhook POST endpoint",
        hint: "Human-readable description. Shows up in the EventBridge console and in CloudTrail. Strongly recommended for multi-destination fleets.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 512)
            return "Description must be 512 characters or fewer";
          return undefined;
        },
      },
    },
  ],
  advancedFields: [
    {
      name: "InvocationRateLimitPerSecond",
      question: {
        type: "string",
        label: "Invocation rate limit (per second)",
        placeholder: "300",
        hint: "Optional. Maximum invocations per second EventBridge sends to the endpoint. Protects downstream APIs from thundering-herd on burst traffic. Range: 1-300. Leave blank for the default (300). Set LOWER for APIs with strict rate limits (e.g. Slack's 1/channel/sec for webhooks).",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n))
            return "InvocationRateLimitPerSecond must be an integer";
          if (n < 1 || n > 300)
            return "InvocationRateLimitPerSecond must be between 1 and 300";
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (answer === undefined || answer === "") return undefined;
        const n = Number(answer);
        return Number.isInteger(n) ? n : undefined;
      },
    },
  ],
  defaults: {
    HttpMethod: "POST",
  },
  configHints: [
    "NEVER include Tags — AWS::Events::ApiDestination is not taggable. Omit Tags entirely.",
    "Name is createOnly — renaming replaces the destination, cascading into every Events::Rule Target that references the old ARN. Pick a stable name.",
    "InvocationEndpoint MUST be HTTPS. EventBridge rejects http:// at the service layer — there is no insecure option even for testing.",
    "Match HttpMethod to the target API. Webhooks are almost always POST. REST APIs may need PUT/PATCH/DELETE. EventBridge does not auto-detect or fall back.",
    "InvocationRateLimitPerSecond defaults to 300 — lower it when the target API has tight rate limits (Slack webhooks are 1/sec/channel) or when the downstream is latency-sensitive. Higher values are NOT supported; AWS caps at 300.",
    "Pricing: ApiDestinations bill a per-million-invocations rate — cheap per call, but scheduled fan-out patterns can accumulate quickly. Run `assignee cost` for live Pricing-MCP rates.",
    "The ConnectionArn must point at an already-existing Connection (or one earlier in the same plan). The Connection provides the auth credentials; this destination provides the URL.",
  ],
};
