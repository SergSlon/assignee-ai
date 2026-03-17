import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

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
        validate: (value: unknown) =>
          typeof value === "string" && value.startsWith("arn:aws:iam::")
            ? undefined
            : "Must be a valid IAM role ARN",
      },
    },
    {
      name: "MemorySize",
      question: {
        type: "enum",
        label: "Memory (MB)",
        options: [
          { value: "128", label: "128 MB" },
          { value: "256", label: "256 MB" },
          { value: "512", label: "512 MB" },
          { value: "1024", label: "1024 MB" },
          { value: "2048", label: "2048 MB" },
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
};
