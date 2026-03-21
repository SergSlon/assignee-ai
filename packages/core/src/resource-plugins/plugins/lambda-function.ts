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
      question: {
        type: "string",
        label: "Function name",
        placeholder: "my-function",
      },
    },
    {
      name: "Runtime",
      question: {
        type: "enum",
        label: "Runtime",
        options: [
          { value: "nodejs22.x", label: "Node.js 22.x" },
          { value: "nodejs20.x", label: "Node.js 20.x" },
          { value: "python3.13", label: "Python 3.13" },
          { value: "python3.12", label: "Python 3.12" },
          { value: "java21", label: "Java 21" },
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
      },
    },
    {
      name: "Role",
      question: {
        type: "string",
        label: "Execution role ARN",
        placeholder: "arn:aws:iam::123456789012:role/my-role",
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
        options: [
          { value: "128", label: memoryLabel(128) },
          { value: "256", label: memoryLabel(256) },
          { value: "512", label: memoryLabel(512) },
          { value: "1024", label: memoryLabel(1024) },
          { value: "2048", label: memoryLabel(2048) },
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
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
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
      },
    },
    {
      name: "ReservedConcurrentExecutions",
      question: {
        type: "string",
        label: "Reserved concurrent executions (-1 = unreserved)",
        placeholder: "-1",
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
