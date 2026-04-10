import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault, SizeLabel } from "../../config/cfn-keys.js";
import { ArnPrefix } from "../../config/aws-arns.js";
import { DiscoveryCacheKey } from "../../config/discovery-keys.js";
import type { ResourcePlugin, OptionMetadata, CfnOutput } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

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

/** Runtime option definition with optional deprecation flag. */
type RuntimeOption = { value: string; label: string } & OptionMetadata;

/**
 * All Lambda runtime options. Deprecated runtimes (past AWS EOL) are flagged
 * and will be sorted to the bottom of the list with a [DEPRECATED] label suffix.
 */
const runtimeOptions: RuntimeOption[] = [
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
];

/**
 * Sorts runtime options: non-deprecated first (preserving order), deprecated last.
 * Appends " [DEPRECATED]" suffix to deprecated option labels.
 */
function sortedRuntimeOptions(
  options: readonly RuntimeOption[],
): RuntimeOption[] {
  const active = options.filter((o) => !o.deprecated);
  const deprecated = options
    .filter((o) => o.deprecated)
    .map((o) => ({
      ...o,
      label: `${o.label} [DEPRECATED]`,
    }));
  return [...active, ...deprecated];
}

/** Exported for test use. */
export const sortedRuntimes = sortedRuntimeOptions(runtimeOptions);

/**
 * Reserved environment variable prefixes that the Lambda runtime sets
 * automatically. Setting these in Environment.Variables produces silently
 * wrong behavior — CFN accepts them but the runtime will either overwrite
 * them at invocation time or refuse to start the function.
 *
 * Sources:
 *   - https://docs.aws.amazon.com/lambda/latest/dg/configuration-envvars.html#configuration-envvars-runtime
 *   - Item 3b (2026-04-09): these were previously accepted silently by
 *     the wizard and would surface as mystery bugs at runtime.
 */
export const LAMBDA_RESERVED_PREFIXES = [
  "AWS_",
  "LAMBDA_",
  "_X_AMZN_",
] as const;

/**
 * Reserved environment variable exact names (not prefix-matched).
 *
 * `NODE_OPTIONS` is not strictly reserved by the Lambda runtime, but it is
 * a near-universal footgun — users pass common things like `--max-old-space-size`
 * and it conflicts with the runtime's internal V8 flags. Blocking it with a
 * guide message is safer than silently accepting and debugging later.
 */
export const LAMBDA_RESERVED_EXACT = ["_HANDLER", "NODE_OPTIONS"] as const;

/**
 * Result of validating an Environment.Variables input string. Exported
 * so both the `validate` and `toCfn` hooks on the Environment field
 * can share detection logic.
 */
export function checkLambdaEnvVarKey(key: string): string | undefined {
  for (const prefix of LAMBDA_RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      if (prefix === "AWS_") {
        return `"${key}" uses the AWS_ prefix, which the Lambda runtime reserves for itself (e.g. AWS_REGION, AWS_LAMBDA_FUNCTION_NAME). Lambda sets these automatically — remove it or rename your variable.`;
      }
      if (prefix === "LAMBDA_") {
        return `"${key}" uses the LAMBDA_ prefix, which the Lambda runtime reserves (e.g. LAMBDA_TASK_ROOT, LAMBDA_RUNTIME_DIR). Rename your variable.`;
      }
      // _X_AMZN_
      return `"${key}" uses the _X_AMZN_ prefix, which AWS X-Ray and the Lambda runtime use for trace propagation (e.g. _X_AMZN_TRACE_ID). Rename your variable.`;
    }
  }
  for (const exact of LAMBDA_RESERVED_EXACT) {
    if (key === exact) {
      if (exact === "_HANDLER") {
        return `"_HANDLER" is set by the Lambda runtime to your function's handler path — overwriting it will break function startup. Remove it.`;
      }
      // NODE_OPTIONS
      return `"NODE_OPTIONS" is a Node.js runtime footgun — Lambda's Node runtimes already set internal V8 flags, and user-provided NODE_OPTIONS frequently collide with them. If you need a flag like --max-old-space-size, configure MemorySize instead.`;
    }
  }
  return undefined;
}

/**
 * Generates the configHints Runtime string from the options array.
 */
function buildRuntimeHint(options: readonly RuntimeOption[]): string {
  const active = options.filter((o) => !o.deprecated);
  const deprecated = options.filter((o) => o.deprecated);
  const activeList = active.map((o) => o.value).join(", ");
  let hint = `Lambda Runtime MUST be one of: ${activeList}.`;
  if (deprecated.length > 0) {
    const deprecatedList = deprecated.map((o) => o.value).join(", ");
    hint += ` NEVER use deprecated runtimes (${deprecatedList}).`;
  } else {
    hint += " NEVER use deprecated runtimes.";
  }
  return hint;
}

/**
 * ResourcePlugin for AWS::Lambda::Function.
 */
export const lambdaFunctionPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
  commonFields: [
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
          if (!value) return undefined; // Optional field
          return typeof value === "string" && value.startsWith(ArnPrefix.IAM)
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
          if (!value) return undefined; // Optional field
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
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          if (!s) return undefined;
          const pairs = s
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          const seenKeys = new Set<string>();
          for (const pair of pairs) {
            const eqIdx = pair.indexOf("=");
            if (eqIdx <= 0)
              return `Invalid pair "${pair}" — must be KEY=VALUE format`;
            const key = pair.slice(0, eqIdx).trim();
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key))
              return `Invalid key "${key}" — must start with a letter or underscore and contain only alphanumerics/underscores`;
            if (seenKeys.has(key))
              return `Duplicate key "${key}" — each environment variable name must be unique (case-sensitive).`;
            seenKeys.add(key);
            const reservedError = checkLambdaEnvVarKey(key);
            if (reservedError) return reservedError;
          }
          return undefined;
        },
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
  ],
  advancedFields: [
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
      toCfn: (v: unknown) =>
        v ? { Size: parseInt(String(v), 10) } : undefined,
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
            if (!arn.startsWith("arn:aws:lambda:"))
              return `Invalid layer ARN "${arn}" — must start with arn:aws:lambda:`;
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
  ],
  defaults: {
    [CfnKey.MEMORY_SIZE]: 128,
    [CfnKey.TIMEOUT]: 30,
    [CfnKey.RUNTIME]: AwsDefault.LAMBDA_RUNTIME,
    [CfnKey.HANDLER]: AwsDefault.LAMBDA_HANDLER,
    [CfnKey.ARCHITECTURES]: [AwsDefault.ARCH_X86],
    [CfnKey.EPHEMERAL_STORAGE]: { Size: 512 },
    // A8 follow-up: default to Active X-Ray tracing so BP-LAMBDA-015
    // (TracingConfig.Mode=Active) passes on fresh plans without
    // requiring the autoFix pass. The AWSXRayDaemonWriteAccess
    // actions are already covered by the PowerUserAccess
    // PermissionsBoundary shipped with the Lambda-bearing compound
    // patterns, so enabling tracing at the plan default level is
    // a zero-friction observability gain.
    TracingConfig: { Mode: "Active" },
    // Story E2E.3: Placeholder Code for noWizard/MCP mode.
    // Lambda cannot be created without Code; repairer injects this when LLM omits it.
    [CfnKey.CODE]: {
      ZipFile:
        "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });",
    },
  },
  configHints: [
    buildRuntimeHint(runtimeOptions),
    "Lambda Role: if the user did not provide a specific IAM role ARN, OMIT the Role property — do NOT invent placeholder ARNs",
    "Environment: must be a CloudFormation Environment object with a Variables map, e.g. { Variables: { KEY: 'value' } }. Parse comma-separated KEY=VALUE input.",
    "Architectures: must be an array with exactly one element — either ['x86_64'] or ['arm64']. arm64 (Graviton) is ~20% cheaper.",
    "EphemeralStorage: must be an object { Size: <number> } where Size is one of 512, 1024, 2048, 4096, 10240 MB. Default 512 MB is free.",
    "VpcConfig: if VpcSubnetIds are provided, emit a single VpcConfig object combining SubnetIds and SecurityGroupIds arrays. Do NOT set VpcConfig without subnets.",
    "Layers: must be an array of full Lambda Layer ARNs including version number. Max 5 layers.",
  ],
  companionResources(desiredState: Record<string, unknown>): CfnOutput[] {
    const functionName = desiredState[CfnKey.FUNCTION_NAME];
    if (typeof functionName !== "string" || !functionName) return [];

    const retention =
      typeof desiredState[CfnKey.LOG_RETENTION_IN_DAYS] === "number"
        ? desiredState[CfnKey.LOG_RETENTION_IN_DAYS]
        : 14;

    const sanitized = functionName.replace(/[^a-zA-Z0-9]/g, "");
    return [
      {
        logicalId: `${sanitized}LogGroup`,
        type: RESOURCE_TYPES.LOGS_LOG_GROUP,
        properties: {
          [CfnKey.LOG_GROUP_NAME]: `/aws/lambda/${functionName}`,
          [CfnKey.RETENTION_IN_DAYS]: retention,
        },
      },
    ];
  },
};
