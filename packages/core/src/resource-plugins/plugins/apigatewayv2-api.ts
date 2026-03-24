import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::ApiGatewayV2::Api (HTTP API / WebSocket API).
 * commonFields contains 6 properties (≤10).
 * CorsConfiguration sub-fields use showIf conditional on EnableCors.
 */
export const apiGatewayV2Plugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
  commonFields: [
    {
      name: "Name",
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
      name: "ProtocolType",
      question: {
        type: "enum",
        label: "Protocol type",
        options: [
          { value: "HTTP", label: "HTTP (recommended — simpler, cheaper)" },
          {
            value: "WEBSOCKET",
            label: "WebSocket (bidirectional, real-time)",
          },
        ],
        initialValue: "HTTP",
        hint: "HTTP API is simpler and cheaper than REST API (~70% lower cost). Choose WebSocket for real-time bidirectional communication (chat, live updates, gaming).",
      },
    },
    {
      name: "Description",
      question: {
        type: "string",
        label: "Description",
        placeholder: "Backend API for my application",
        hint: "Optional description of what this API does. Helps with documentation and team clarity.",
      },
    },
    {
      name: "EnableCors",
      question: {
        type: "boolean",
        label: "Enable CORS?",
        initialValue: false,
        hint: "Required if a web browser needs to call this API directly. Configures Cross-Origin Resource Sharing headers. Not needed for server-to-server or mobile-native calls.",
      },
    },
    {
      name: "CorsAllowOrigins",
      question: {
        type: "string",
        label: "Allowed origins (comma-separated)",
        placeholder: "https://example.com, https://app.example.com",
        hint: "Which domains can make cross-origin requests. Use specific domains in production — avoid '*' (wildcard) for security. Example: https://myapp.com",
        showIf: { field: "EnableCors", value: true },
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
      name: "CorsAllowMethods",
      question: {
        type: "string",
        label: "Allowed HTTP methods (comma-separated)",
        placeholder: "GET, POST, PUT, DELETE, OPTIONS",
        initialValue: "GET, POST, OPTIONS",
        hint: "HTTP methods permitted for CORS requests. Common: GET, POST, PUT, DELETE, OPTIONS. OPTIONS is needed for preflight requests.",
        showIf: { field: "EnableCors", value: true },
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
      name: "CorsAllowHeaders",
      question: {
        type: "string",
        label: "Allowed headers (comma-separated)",
        placeholder: "Content-Type, Authorization",
        initialValue: "Content-Type, Authorization",
        hint: "Request headers permitted for CORS requests. Common: Content-Type, Authorization, X-Api-Key.",
        showIf: { field: "EnableCors", value: true },
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
      name: "DisableExecuteApiEndpoint",
      question: {
        type: "boolean",
        label: "Disable default execute-api endpoint?",
        initialValue: false,
        hint: "When true, the default https://{api-id}.execute-api.{region}.amazonaws.com endpoint is disabled. Use this when you have a custom domain and want to prevent direct API access.",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization. Example: Environment:production, Team:backend, Project:api. Tags are free and highly recommended.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags: Record<string, string> = {};
        answer
          .split(",")
          .filter((p) => p.includes(":"))
          .forEach((pair) => {
            const [key, ...rest] = pair.trim().split(":");
            if (key) tags[key.trim()] = rest.join(":").trim();
          });
        return Object.keys(tags).length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: "RouteSelectionExpression",
      question: {
        type: "string",
        label: "Route selection expression",
        placeholder: "$request.method $request.path",
        initialValue: "$request.method $request.path",
        hint: "Expression used to select the route for incoming requests. For HTTP APIs, the default '$request.method $request.path' works for most cases. For WebSocket APIs, use '$request.body.action' to route based on message content.",
      },
    },
    {
      name: "Version",
      question: {
        type: "string",
        label: "API version",
        placeholder: "1.0",
        hint: "Optional version identifier for this API. Useful for tracking API iterations. Not used for routing — purely informational.",
      },
    },
  ],
  defaults: {
    ProtocolType: "HTTP",
  },
  configHints: [
    "HTTP API is simpler and ~70% cheaper than REST API (API Gateway v1). Use HTTP API unless you need REST API features like request validation, caching, or usage plans.",
    "CORS AllowOrigins should be restricted to specific domains in production — never use '*' (wildcard) as it allows any website to call your API.",
    "Route selection expression format: for HTTP APIs use '$request.method $request.path'; for WebSocket APIs use '$request.body.action'.",
    "Access logging should be enabled via a companion CloudWatch LogGroup. Create an AWS::Logs::LogGroup and reference its ARN in the Stage's AccessLogSettings.",
  ],
};
