import { CfnKey, AwsDefault, SizeLabel } from "@/config/cfn-keys.js";
import { isArnOfService } from "@/config/aws-partition.js";
import { DiscoveryCacheKey } from "@/config/discovery-keys.js";
import type { ResourcePlugin } from "../../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../../shared-fields.js";
import { FieldLabel } from "../../field-labels.js";
import { memoryLabel, sortedRuntimes } from "./runtimes.js";
import { validateEnvironmentField, environmentToCfn } from "./env-vars.js";

export const commonFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.FUNCTION_NAME,
    required: true,
    question: {
      type: "string",
      label: "Function name",
      placeholder: "my-function",
      hint: "Unique name for this function within the region. Use lowercase, hyphens, and numbers. Max 64 chars. Cannot be changed after creation.",
      validate: (value: unknown) => {
        if (!value) return "Function name is required";
        const s = String(value);
        if (s.length > 64) return "Function name cannot exceed 64 characters";
        if (!/^[a-zA-Z0-9_-]+$/.test(s))
          return "Function name can only contain letters, numbers, hyphens, and underscores";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.RUNTIME,
    question: {
      type: "enum",
      label: "Runtime",
      hint: "Language and version your code runs on. Node.js has the fastest cold starts. Python is popular for ML/data. Java has slower cold starts but strong enterprise support.",
      options: sortedRuntimes,
      initialValue: AwsDefault.LAMBDA_RUNTIME,
      fetcher: DiscoveryCacheKey.LAMBDA_RUNTIMES,
    },
  },
  {
    name: CfnKey.HANDLER,
    required: true,
    question: {
      type: "string",
      label: "Handler (file.method)",
      placeholder: AwsDefault.LAMBDA_HANDLER,
      initialValue: AwsDefault.LAMBDA_HANDLER,
      hint: "Entry point for your function: file name + exported method. Node.js: 'index.handler'. Python: 'lambda_function.lambda_handler'. Must match your code exactly.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (!s.includes("."))
          return "Handler must be in file.method format (e.g., index.handler)";
        return undefined;
      },
    },
  },
  {
    name: CfnKey.ROLE,
    required: true,
    question: {
      type: "string",
      label: "Execution role ARN",
      placeholder: "arn:aws:iam::123456789012:role/my-role",
      hint: "IAM role that grants the function permissions to access AWS services (S3, DynamoDB, etc.). If omitted, assignee will create a minimal-privilege role for you.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        return typeof value === "string" && isArnOfService(value, "iam")
          ? undefined
          : "Must be a valid IAM role ARN";
      },
    },
  },
  {
    name: CfnKey.MEMORY_SIZE,
    question: {
      type: "enum",
      label: "Memory (MB)",
      hint: "RAM allocated to the function. CPU scales proportionally. More memory = faster execution but higher cost. 128 MB is minimum; 256 MB is a good starting point for APIs.",
      options: [
        { value: "128", label: memoryLabel(128), fitHint: "Lightweight tasks" },
        {
          value: "256",
          label: memoryLabel(256),
          fitHint: "API handlers",
          recommended: true,
        },
        { value: "512", label: memoryLabel(512), fitHint: "Data processing" },
        { value: "1024", label: memoryLabel(1024), fitHint: "Heavy compute" },
        {
          value: "2048",
          label: memoryLabel(2048),
          fitHint: "ML inference, image processing",
        },
      ],
      initialValue: "128",
    },
    toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
  },
  {
    name: CfnKey.TIMEOUT,
    question: {
      type: "string",
      label: "Timeout (seconds, 1-900)",
      placeholder: "30",
      initialValue: "30",
      hint: "Max execution time before the function is killed. API handlers: 10-30s. Background jobs: 60-300s. Max 900s (15 min). Lower values prevent runaway costs.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= 900
          ? undefined
          : "Timeout must be between 1 and 900 seconds";
      },
    },
    toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
  },
  {
    name: CfnKey.ENVIRONMENT,
    question: {
      type: "string",
      label: "Environment Variables",
      placeholder: "KEY1=value1,KEY2=value2",
      hint: "Comma-separated KEY=VALUE pairs. These are injected into the function's runtime environment. Sensitive values should use SSM Parameter Store references instead.",
      validate: validateEnvironmentField,
    },
    toCfn: environmentToCfn,
  },
  {
    name: CfnKey.ARCHITECTURES,
    question: {
      type: "enum",
      label: "CPU Architecture",
      hint: "Instruction set architecture. arm64 (Graviton) is ~20% cheaper and offers better price-performance for most workloads. x86_64 is required for some native dependencies.",
      options: [
        {
          value: AwsDefault.ARCH_X86,
          label: "x86_64 (Intel/AMD)",
          fitHint: "Widest compatibility",
        },
        {
          value: AwsDefault.ARCH_ARM,
          label: "arm64 (Graviton — 20% cheaper)",
          fitHint: SizeLabel.BEST_PRICE_PERFORMANCE,
          recommended: true,
        },
      ],
      initialValue: AwsDefault.ARCH_X86,
    },
    toCfn: (v: unknown) => (v ? [String(v)] : undefined),
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
];

export const advancedFields: ResourcePlugin["advancedFields"] = [
  {
    name: CfnKey.DESCRIPTION,
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
    name: CfnKey.RESERVED_CONCURRENT_EXECUTIONS,
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
  {
    name: CfnKey.EPHEMERAL_STORAGE,
    question: {
      type: "enum",
      label: "Ephemeral storage (/tmp)",
      hint: "Disk space available in /tmp. Default 512 MB is free. Larger sizes incur additional cost. Useful for ML models, large file processing, or caching.",
      options: [
        { value: "512", label: "512 MB (default, free)" },
        { value: "1024", label: "1024 MB" },
        { value: "2048", label: "2048 MB" },
        { value: "4096", label: "4096 MB" },
        { value: "10240", label: "10240 MB (10 GB max)" },
      ],
      initialValue: "512",
    },
    toCfn: (v: unknown) => (v ? { Size: parseInt(String(v), 10) } : undefined),
  },
  {
    name: CfnKey.VPC_SUBNET_IDS,
    question: {
      type: "multi",
      label: "VPC Subnets (for RDS/ElastiCache access)",
      hint: "Place the function inside a VPC to access private resources like RDS or ElastiCache. Select private subnets only — public subnets will not grant internet access without a NAT Gateway.",
      fetcher: "discover-subnets",
    },
    /** toCfn produces the VpcConfig.SubnetIds portion; merged with SecurityGroupIds at assembly. */
    toCfn: (v: unknown) => {
      if (!Array.isArray(v) || v.length === 0) return undefined;
      return { SubnetIds: v.map(String) };
    },
  },
  {
    name: CfnKey.VPC_SECURITY_GROUP_IDS,
    question: {
      type: "multi",
      label: "VPC Security Groups",
      hint: "Security groups control which VPC resources the function can reach. Must allow outbound traffic to the target service ports (e.g., 3306 for MySQL, 6379 for Redis).",
      fetcher: "discover-security-groups",
      showIf: { field: CfnKey.VPC_SUBNET_IDS, value: true },
    },
    /** toCfn produces the VpcConfig.SecurityGroupIds portion; merged with SubnetIds at assembly. */
    toCfn: (v: unknown) => {
      if (!Array.isArray(v) || v.length === 0) return undefined;
      return { SecurityGroupIds: v.map(String) };
    },
  },
  {
    name: CfnKey.LAYERS,
    question: {
      type: "string",
      label: "Lambda Layers (comma-separated ARNs)",
      placeholder: "arn:aws:lambda:us-east-1:123456789012:layer:my-layer:1",
      hint: "Up to 5 Lambda Layers providing shared code or dependencies. Each ARN must include the version number. Total unzipped size of all layers + function must be under 250 MB.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value).trim();
        if (!s) return undefined;
        const arns = s
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean);
        if (arns.length > 5) return "Maximum 5 Lambda Layers allowed";
        for (const arn of arns) {
          if (!isArnOfService(arn, "lambda"))
            return `Invalid layer ARN "${arn}" — must be a Lambda layer ARN (e.g. arn:aws:lambda:<region>:<account>:layer:<name>:<ver>)`;
        }
        return undefined;
      },
    },
    toCfn: (v: unknown) => {
      if (!v || typeof v !== "string" || !v.trim()) return undefined;
      const arns = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      return arns.length > 0 ? arns : undefined;
    },
  },
];
