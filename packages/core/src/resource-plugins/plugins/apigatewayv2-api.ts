import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::ApiGatewayV2::Api (HTTP API / WebSocket API).
 * commonFields contains 6 properties (≤10).
 * CorsConfiguration sub-fields use showIf conditional on EnableCors.
 */
export const apiGatewayV2Plugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
  commonFields: [
    {
      name: CfnKey.NAME,
      required: true,
      question: {
        type: "string",
        label: "API name",
        placeholder: "my-http-api",
        hint: "A descriptive name for this API. Used in the AWS console and API endpoint URL. Must be unique within your account/region.",
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return "API name is required";
          const s = String(value);
          if (s.length > 128) return "API name must be 128 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.PROTOCOL_TYPE,
      question: {
        type: "enum",
        label: "Protocol type",
        options: [
          {
            value: AwsDefault.PROTOCOL_HTTP,
            label: "HTTP (recommended — simpler, cheaper)",
          },
          {
            value: AwsDefault.PROTOCOL_WEBSOCKET,
            label: "WebSocket (bidirectional, real-time)",
          },
        ],
        initialValue: AwsDefault.PROTOCOL_HTTP,
        hint: "HTTP API is simpler and cheaper than REST API (~70% lower cost). Choose WebSocket for real-time bidirectional communication (chat, live updates, gaming).",
      },
    },
    {
      name: CfnKey.DESCRIPTION,
      question: {
        type: "string",
        label: FieldLabel.DESCRIPTION,
        placeholder: "Backend API for my application",
        hint: "Optional description of what this API does. Helps with documentation and team clarity.",
      },
    },
    {
      name: CfnKey.ENABLE_CORS,
      question: {
        type: "boolean",
        label: "Enable CORS?",
        initialValue: false,
        hint: "Required if a web browser needs to call this API directly. Configures Cross-Origin Resource Sharing headers. Not needed for server-to-server or mobile-native calls.",
      },
    },
    {
      name: CfnKey.CORS_ALLOW_ORIGINS,
      question: {
        type: "string",
        label: "Allowed origins (comma-separated)",
        placeholder: "https://example.com, https://app.example.com",
        hint: "Which domains can make cross-origin requests. Use specific domains in production — avoid '*' (wildcard) for security. Example: https://myapp.com",
        showIf: { field: CfnKey.ENABLE_CORS, value: true },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    {
      name: CfnKey.CORS_ALLOW_METHODS,
      question: {
        type: "string",
        label: "Allowed HTTP methods (comma-separated)",
        placeholder: "GET, POST, PUT, DELETE, OPTIONS",
        initialValue: "GET, POST, OPTIONS",
        hint: "HTTP methods permitted for CORS requests. Common: GET, POST, PUT, DELETE, OPTIONS. OPTIONS is needed for preflight requests.",
        showIf: { field: CfnKey.ENABLE_CORS, value: true },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    {
      name: CfnKey.CORS_ALLOW_HEADERS,
      question: {
        type: "string",
        label: "Allowed headers (comma-separated)",
        placeholder: "Content-Type, Authorization",
        initialValue: "Content-Type, Authorization",
        hint: "Request headers permitted for CORS requests. Common: Content-Type, Authorization, X-Api-Key.",
        showIf: { field: CfnKey.ENABLE_CORS, value: true },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      },
    },
    {
      name: CfnKey.DISABLE_EXECUTE_API,
      question: {
        type: "boolean",
        label: "Disable default execute-api endpoint?",
        initialValue: false,
        hint: "When true, the default https://{api-id}.execute-api.{region}.amazonaws.com endpoint is disabled. Use this when you have a custom domain and want to prevent direct API access.",
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
      name: CfnKey.ROUTE_SELECTION_EXPRESSION,
      question: {
        type: "string",
        label: "Route selection expression",
        placeholder: "$request.method $request.path",
        initialValue: "$request.method $request.path",
        hint: "Expression used to select the route for incoming requests. For HTTP APIs, the default '$request.method $request.path' works for most cases. For WebSocket APIs, use '$request.body.action' to route based on message content.",
      },
    },
    {
      name: CfnKey.VERSION,
      question: {
        type: "string",
        label: "API version",
        placeholder: "1.0",
        hint: "Optional version identifier for this API. Useful for tracking API iterations. Not used for routing — purely informational.",
      },
    },
  ],
  defaults: {
    [CfnKey.PROTOCOL_TYPE]: AwsDefault.PROTOCOL_HTTP,
  },
  configHints: [
    "HTTP API is simpler and ~70% cheaper than REST API (API Gateway v1). Use HTTP API unless you need REST API features like request validation, caching, or usage plans.",
    "CORS AllowOrigins should be restricted to specific domains in production — never use '*' (wildcard) as it allows any website to call your API.",
    "Route selection expression format: for HTTP APIs use '$request.method $request.path'; for WebSocket APIs use '$request.body.action'.",
    "Access logging should be enabled via a companion CloudWatch LogGroup. Create an AWS::Logs::LogGroup and reference its ARN in the Stage's AccessLogSettings.",
  ],
};
