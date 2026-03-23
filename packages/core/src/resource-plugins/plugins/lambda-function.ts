import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/** Lambda duration pricing rate ($/GB-second) — stable since 2014. Exported for test use. */
export const LAMBDA_USD_PER_GB_SECOND = 0.0000166667;

/**
 * Computes the cost per 100ms for a given Lambda memory size.
 * Formula: (memoryMb / 1024 GB) × $USD_PER_GB_SECOND/GB-s × 0.1s
 */
function memoryLabel(memoryMb: number): string {
  const costPer100ms = (memoryMb / 1024) * LAMBDA_USD_PER_GB_SECOND * 0.1;
  const decimals = Math.ceil(-Math.log10(costPer100ms)) + 1;
  const mb = String(memoryMb).padStart(4);
  return `${mb} MB — ~$${costPer100ms.toFixed(decimals)}/100ms`;
}

/**
 * ResourcePlugin for AWS::Lambda::Function.
 */
export const lambdaFunctionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
  commonFields: [
    {
      name: "FunctionName",
      required: true,
      question: {
        type: "string",
        label: "Function name",
        placeholder: "my-function",
        hint: "Unique name for this function within the region. Use lowercase, hyphens, and numbers. Max 64 chars. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional
          const s = String(value);
          if (s.length > 64) return "Function name cannot exceed 64 characters";
          if (!/^[a-zA-Z0-9_-]+$/.test(s))
            return "Function name can only contain letters, numbers, hyphens, and underscores";
          return undefined;
        },
      },
    },
    {
      name: "Runtime",
      question: {
        type: "enum",
        label: "Runtime",
        hint: "Language and version your code runs on. Node.js has the fastest cold starts. Python is popular for ML/data. Java has slower cold starts but strong enterprise support.",
        options: [
          {
            value: "nodejs22.x",
            label: "Node.js 22.x",
            fitHint: "Latest LTS, best cold start",
            recommended: true,
          },
          {
            value: "nodejs20.x",
            label: "Node.js 20.x",
            fitHint: "Stable LTS",
          },
          {
            value: "python3.13",
            label: "Python 3.13",
            fitHint: "Latest, ML/data workloads",
          },
          {
            value: "python3.12",
            label: "Python 3.12",
            fitHint: "Stable, wide library support",
          },
          {
            value: "java21",
            label: "Java 21",
            fitHint: "Enterprise, slower cold start",
          },
          {
            value: "dotnet8",
            label: ".NET 8",
            fitHint: "Cross-platform, enterprise",
          },
          {
            value: "ruby3.3",
            label: "Ruby 3.3",
            fitHint: "Scripting, web apps",
          },
          {
            value: "provided.al2023",
            label: "Custom runtime (Go/Rust/C++)",
            fitHint: "Bring your own runtime",
          },
        ],
        initialValue: "nodejs22.x",
      },
    },
    {
      name: "Handler",
      question: {
        type: "string",
        label: "Handler (file.method)",
        placeholder: "index.handler",
        hint: "Entry point for your function: file name + exported method. Node.js: 'index.handler'. Python: 'lambda_function.lambda_handler'. Must match your code exactly.",
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional
          const s = String(value);
          if (!s.includes("."))
            return "Handler must be in file.method format (e.g., index.handler)";
          return undefined;
        },
      },
    },
    {
      name: "Role",
      required: true,
      question: {
        type: "string",
        label: "Execution role ARN",
        placeholder: "arn:aws:iam::123456789012:role/my-role",
        hint: "IAM role that grants the function permissions to access AWS services (S3, DynamoDB, etc.). If omitted, assignee will create a minimal-privilege role for you.",
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional field
          return typeof value === "string" && value.startsWith("arn:aws:iam::")
            ? undefined
            : "Must be a valid IAM role ARN";
        },
      },
    },
    {
      name: "MemorySize",
      question: {
        type: "enum",
        label: "Memory (MB)",
        hint: "RAM allocated to the function. CPU scales proportionally. More memory = faster execution but higher cost. 128 MB is minimum; 256 MB is a good starting point for APIs.",
        options: [
          {
            value: "128",
            label: memoryLabel(128),
            fitHint: "Lightweight tasks",
          },
          {
            value: "256",
            label: memoryLabel(256),
            fitHint: "API handlers",
            recommended: true,
          },
          {
            value: "512",
            label: memoryLabel(512),
            fitHint: "Data processing",
          },
          {
            value: "1024",
            label: memoryLabel(1024),
            fitHint: "Heavy compute",
          },
          {
            value: "2048",
            label: memoryLabel(2048),
            fitHint: "ML inference, image processing",
          },
        ],
        initialValue: "128",
      },
    },
    {
      name: "Timeout",
      question: {
        type: "string",
        label: "Timeout (seconds, 1-900)",
        placeholder: "30",
        initialValue: "30",
        hint: "Max execution time before the function is killed. API handlers: 10-30s. Background jobs: 60-300s. Max 900s (15 min). Lower values prevent runaway costs.",
        validate: (value: unknown) => {
          if (!value) return undefined; // Optional field
          const n = Number(value);
          return Number.isInteger(n) && n >= 1 && n <= 900
            ? undefined
            : "Timeout must be between 1 and 900 seconds";
        },
      },
    },
    {
      name: "Environment",
      question: {
        type: "string",
        label: "Environment variables",
        placeholder: "DB_HOST=localhost,API_KEY=xxx",
        hint: "Comma-separated KEY=VALUE pairs. These are injected into the function's runtime environment. Sensitive values should use SSM Parameter Store references instead.",
      },
      toCfn: (value: unknown) => {
        if (!value || typeof value !== "string" || !value.trim()) {
          return undefined;
        }
        const vars: Record<string, string> = {};
        for (const pair of value.split(",")) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx > 0) {
            vars[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
          }
        }
        return Object.keys(vars).length > 0 ? { Variables: vars } : undefined;
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
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [
    {
      name: "Description",
      question: {
        type: "string",
        label: "Function description",
        placeholder: "Brief description of what this function does",
        hint: "Free-text description shown in the AWS console. Helps teammates understand the function's purpose. Max 256 chars. No cost or security impact.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.length > 256) return "Max 256 characters";
          return undefined;
        },
      },
    },
    {
      name: "ReservedConcurrentExecutions",
      question: {
        type: "string",
        label: "Reserved concurrent executions (-1 = unreserved)",
        placeholder: "-1",
        hint: "Limits how many instances run simultaneously. -1 = unreserved (uses shared account pool). Set a limit to prevent one function from starving others. Reduces risk of runaway costs.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < -1)
            return "Must be -1 (unreserved) or 0+";
          return undefined;
        },
      },
    },
  ],
  defaults: {
    MemorySize: 128,
    Timeout: 30,
  },
  configHints: [
    "Lambda Runtime MUST be one of: nodejs22.x, nodejs20.x, python3.13, python3.12, java21, dotnet8, ruby3.3, provided.al2023. NEVER use deprecated runtimes (python3.8, python3.9, nodejs18.x, nodejs16.x, etc.)",
    "Lambda Role: if the user did not provide a specific IAM role ARN, OMIT the Role property — do NOT invent placeholder ARNs",
  ],
};
