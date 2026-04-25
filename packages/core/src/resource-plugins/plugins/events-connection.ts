import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { KMS_ALIAS_PREFIX } from "../../config/aws-arns.js";
import { isArnOfService } from "../../config/aws-partition.js";
import type { ResourcePlugin } from "../types.js";
import { KMS_ARN_VALIDATION_MSG } from "../shared-fields.js";

/**
 * ResourcePlugin for AWS::Events::Connection.
 *
 * An EventBridge Connection stores the authentication credentials
 * (API key, basic auth, or OAuth) that ApiDestination resources use
 * when POSTing events to external HTTPS endpoints. The credentials
 * are auto-stored in a managed Secrets Manager secret on your
 * behalf — the user never sees the secret ARN and cannot reference
 * it directly.
 *
 * CCAPI schema (verified 2026-04-09 via cloudformation:DescribeType):
 *   - primaryIdentifier: /properties/Name
 *   - createOnly: /properties/Name
 *   - readOnly: /properties/Arn, /properties/SecretArn,
 *               /properties/ArnForPolicy + nested association ARNs
 *   - required (schema level): [] — but the create handler rejects
 *     requests without AuthorizationType + AuthParameters.
 *   - tagging.taggable = false (NO_TAG_TYPES in
 *     apps/cli/src/utils/tags.ts skips tag injection).
 *   - handlers: create, read, update, delete, list (all present)
 *
 * AuthorizationType enum values (as of 2026):
 *   - API_KEY          — single-header API key (common case for
 *                        SaaS webhooks: Slack, Datadog, Stripe)
 *   - BASIC            — HTTP Basic auth
 *   - OAUTH_CLIENT_CREDENTIALS — OAuth 2.0 client_credentials flow
 *
 * AuthParameters shape varies by AuthorizationType:
 *   - API_KEY:   { ApiKeyAuthParameters: { ApiKeyName, ApiKeyValue } }
 *   - BASIC:     { BasicAuthParameters: { Username, Password } }
 *   - OAUTH_CLIENT_CREDENTIALS: { OAuthParameters: { AuthorizationEndpoint, HttpMethod, ClientParameters: { ClientID, ClientSecret }, OAuthHttpParameters? } }
 *
 * The plugin surfaces AuthParameters as a raw JSON string field
 * with shape validation. Users paste the JSON from AWS docs for
 * their auth type. A conditional-showIf form with 15+ nested fields
 * was considered and deferred — the JSON blob keeps the wizard
 * honest about the scope while still validating basic structure.
 *
 * @see A12 (2026-04-09)
 */
export const eventsConnectionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EVENTS_CONNECTION,
  commonFields: [
    {
      name: "Name",
      required: true,
      question: {
        type: "string",
        label: "Connection name",
        placeholder: "slack-webhook-connection",
        hint: "Required + createOnly. 1-64 chars: alphanumerics, '.', '_', '-'. Cannot be changed after creation — pick a stable name. Case-sensitive.",
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
      name: "AuthorizationType",
      required: true,
      question: {
        type: "enum",
        label: "Authorization type",
        hint: "Determines the shape of AuthParameters below. API_KEY is the common case for SaaS webhooks (Slack, Datadog, Stripe). BASIC is HTTP Basic auth. OAUTH_CLIENT_CREDENTIALS is for OAuth 2.0 machine-to-machine.",
        options: [
          { value: "API_KEY", label: "API key (header-based)" },
          { value: "BASIC", label: "HTTP Basic auth" },
          {
            value: "OAUTH_CLIENT_CREDENTIALS",
            label: "OAuth 2.0 client credentials",
          },
        ],
        initialValue: "API_KEY",
      },
    },
    {
      name: "AuthParameters",
      required: true,
      // W1-01 (Epic 100): carries credential material (API key, Basic auth
      // password, OAuth client secret). Strip from elicited-options at every
      // persistence boundary via stripSensitiveFromElicited().
      sensitive: true,
      question: {
        type: "string",
        label: "Auth parameters (JSON)",
        placeholder:
          '{"ApiKeyAuthParameters":{"ApiKeyName":"X-Api-Key","ApiKeyValue":"<paste-key-here>"}}',
        hint: 'Required + shape depends on AuthorizationType. API_KEY: {"ApiKeyAuthParameters":{"ApiKeyName":"<header>","ApiKeyValue":"<secret>"}}. BASIC: {"BasicAuthParameters":{"Username":"<u>","Password":"<p>"}}. OAUTH_CLIENT_CREDENTIALS: {"OAuthParameters":{"AuthorizationEndpoint":"<url>","HttpMethod":"POST","ClientParameters":{"ClientID":"<id>","ClientSecret":"<secret>"}}}. The credentials are stored in a managed Secrets Manager secret — you will not see the secret ARN.',
        validate: (value: unknown) => {
          if (!value) return "AuthParameters is required";
          const s = String(value).trim();
          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(s) as Record<string, unknown>;
          } catch {
            return "AuthParameters must be valid JSON";
          }
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            return "AuthParameters must be a JSON object";
          const keys = Object.keys(parsed);
          const validKeys = new Set([
            "ApiKeyAuthParameters",
            "BasicAuthParameters",
            "OAuthParameters",
            "InvocationHttpParameters",
          ]);
          const hasValidKey = keys.some((k) => validKeys.has(k));
          if (!hasValidKey)
            return "AuthParameters must contain one of: ApiKeyAuthParameters, BasicAuthParameters, OAuthParameters (plus optional InvocationHttpParameters)";
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
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Slack #alerts webhook for prod oncall",
        hint: "Human-readable description. Strongly recommended — shows up in the EventBridge console and in CloudTrail for every Connection lookup.",
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
      name: "KmsKeyIdentifier",
      question: {
        type: "string",
        label: "KMS key for credential encryption",
        placeholder: "alias/aws/secretsmanager",
        hint: "Optional. Customer-managed KMS key ARN or alias used to envelope-encrypt the stored auth credentials in the managed Secret. Defaults to the AWS-managed `aws/secretsmanager` key (free). Use a CMK for audit-trail requirements or to meet BP-SM-001 compliance gates.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.startsWith(KMS_ALIAS_PREFIX) || isArnOfService(s, "kms"))
            return undefined;
          return KMS_ARN_VALIDATION_MSG;
        },
      },
    },
  ],
  defaults: {
    AuthorizationType: "API_KEY",
  },
  configHints: [
    "NEVER include Tags — AWS::Events::Connection is not taggable (CCAPI schema reports tagging.taggable=false). Omit Tags entirely.",
    "Name is createOnly — renaming a Connection replaces it, which cascades into every ApiDestination that references the old ConnectionArn. Pick a stable, descriptive name.",
    "AuthParameters credentials are stored in a managed Secrets Manager secret on your behalf. You CANNOT reference the secret ARN directly — EventBridge manages its lifecycle. The secret's KMS envelope encryption is controlled by KmsKeyIdentifier.",
    "For API_KEY auth, the ApiKeyName is the HTTP HEADER the key lands in (e.g. 'X-Api-Key', 'Authorization'), not the key's display name. Check your target API's docs.",
    "OAUTH_CLIENT_CREDENTIALS triggers an outbound call to AuthorizationEndpoint during create — the endpoint must be reachable from the AWS EventBridge service IP range, not from your VPC. Private OAuth servers need EventBridge PrivateLink support (separate resource).",
    "Connections themselves have no per-hour or per-request charge. The cost lands on the ApiDestination that uses the Connection (per-million-invocations billing). Run `assignee cost` for live Pricing-MCP rates.",
  ],
};
