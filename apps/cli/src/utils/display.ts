/**
 * Terminal display layer for Assignee.ai CLI (Story 1-8, AC9).
 * Owns ALL terminal formatting — no inline chalk in command files.
 *
 * Non-TTY fallback: plain text without ANSI when !process.stdout.isTTY (CI/pipes).
 *
 * This barrel module re-exports everything from the focused sub-modules
 * so that existing imports (`from "../utils/display.js"`) continue to work.
 */

// ── Re-exports from sub-modules (barrel) ────────────────────────────────────

export {
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
} from "./display-findings.js";

export {
  renderPlanBox,
  formatCostLine,
  formatPricingBreakdown,
  formatAppliedFixes,
  formatFixValue,
  formatAutoFixHint,
  regionLabel,
} from "./display-plan.js";

export {
  renderHitlConfirm,
  renderHitlCompoundConfirm,
  renderApplyNowConfirm,
  renderAdvancedConfirm,
  renderOptionPrompt,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
} from "./display-prompts.js";

export {
  renderIntro,
  renderOutro,
  renderError,
  renderApplySuccess,
  renderCompoundSuccess,
  renderSecurityWarnings,
  renderDependencyPlan,
  renderResourceTable,
  renderEmptyList,
  renderStatusSummary,
  renderEmptyStatus,
  startSpinner,
  updateSpinner,
  stopSpinner,
} from "./display-output.js";

export {
  renderDocHelp,
  renderTradeoffHelp,
  fetchDocText,
  synthesizeDocHint,
} from "./display-docs.js";

// Re-export promptFixSelection from its own module (Story 35.4)
export {
  promptFixSelection,
  type FixSelectionResult,
} from "./fix-selection.js";

// ── Types & utilities kept in this file (public API surface) ────────────────

import type { FreeTierNote } from "./free-tier.js";
import type { BPFinding } from "@assignee/best-practices";
import type { AppliedFix } from "../services/graph-state.js";
import { CfnKey, AwsDefault, RESOURCE_TYPES } from "@assignee/core";
import type { PricingBreakdown } from "@assignee/core";

/** Minimal state shape needed for rendering — avoids circular imports with graph.ts */
export interface RenderableState {
  resourceType: string;
  desiredState?: Record<string, unknown>;
  estimatedMonthlyCost?: string;
  runId: string;
  resourceArn?: string;
  executionMode?: string;
  freeTierNote?: FreeTierNote;
  bpFindings?: BPFinding[];
  memoryHints?: string[];
  appliedFixes?: AppliedFix[];
  pricingBreakdown?: PricingBreakdown;
  verbose?: boolean;
  autoFixEnabled?: boolean;
  autoApprove?: boolean;
  adviceHints?: string[];
  sourceDir?: string;
  sourceFileCount?: number;
}

// ── Friendly key names for plan box rendering (Story 18.11) ─────────────────

export const FRIENDLY_NAMES: Record<string, string> = {
  [CfnKey.INSTANCE_TYPE]: "Instance Type",
  [CfnKey.IMAGE_ID]: "AMI",
  [CfnKey.KEY_NAME]: "Key Pair",
  [CfnKey.SUBNET_ID]: "Subnet",
  [CfnKey.SECURITY_GROUP_IDS]: "Security Groups",
  [CfnKey.BUCKET_NAME]: "Bucket Name",
  [CfnKey.BUCKET_ENCRYPTION]: "Encryption",
  [CfnKey.PUBLIC_ACCESS_BLOCK]: "Block Public Access",
  [CfnKey.VERSIONING_CONFIGURATION]: "Versioning",
  [CfnKey.DB_INSTANCE_CLASS]: "DB Instance Class",
  [CfnKey.ENGINE]: "Engine",
  [CfnKey.MASTER_USERNAME]: "Master Username",
  [CfnKey.MASTER_USER_PASSWORD]: "Master Password",
  [CfnKey.ALLOCATED_STORAGE]: "Storage (GB)",
  [CfnKey.MULTI_AZ]: "Multi-AZ",
  [CfnKey.STORAGE_TYPE]: "Storage Type",
  [CfnKey.FUNCTION_NAME]: "Function Name",
  [CfnKey.RUNTIME]: "Runtime",
  [CfnKey.HANDLER]: "Handler",
  [CfnKey.MEMORY_SIZE]: "Memory (MB)",
  [CfnKey.TIMEOUT]: "Timeout (s)",
  [CfnKey.ROLE]: "Execution Role",
  [CfnKey.TAGS]: "Tags",
  [CfnKey.DB_NAME]: "Database Name",
  [CfnKey.ENGINE_VERSION]: "Engine Version",
  [CfnKey.DELETION_PROTECTION]: "Deletion Protection",
  [CfnKey.BACKUP_RETENTION_PERIOD]: "Backup Retention (days)",
  [CfnKey.DESCRIPTION]: "Description",
  [CfnKey.RESERVED_CONCURRENT_EXECUTIONS]: "Reserved Concurrency",
  [CfnKey.ENVIRONMENT]: "Environment Variables",
  [CfnKey.IAM_INSTANCE_PROFILE]: "IAM Instance Profile",
  [CfnKey.USER_DATA]: "User Data",
  [CfnKey.KMS_MASTER_KEY_ID_S3]: "KMS Key ID",
  [CfnKey.ENABLE_LIFECYCLE]: "Lifecycle Rules",
  [CfnKey.ENABLE_CORS]: "CORS",
  [CfnKey.ENABLE_REPLICATION]: "Cross-Region Replication",
  [CfnKey.METADATA_OPTIONS]: "Instance Metadata",
  [CfnKey.BLOCK_DEVICE_MAPPINGS]: "Storage",
  [CfnKey.DISABLE_API_TERMINATION]: "Termination Protection",
  [CfnKey.EBS_OPTIMIZED]: "EBS Optimized",
  [CfnKey.ASSOCIATE_PUBLIC_IP]: "Public IP",
  [CfnKey.CREDIT_SPECIFICATION]: "CPU Credits",
  [CfnKey.MONITORING]: "Detailed Monitoring",
  // VPC / Networking
  [CfnKey.CIDR_BLOCK]: "CIDR Block",
  [CfnKey.VPC_ID]: "VPC",
  [CfnKey.ENABLE_DNS_SUPPORT]: "DNS Support",
  [CfnKey.ENABLE_DNS_HOSTNAMES]: "DNS Hostnames",
  [CfnKey.AVAILABILITY_ZONE]: "Availability Zone",
  [CfnKey.MAP_PUBLIC_IP]: "Auto-Assign Public IP",
  // Security Group
  [CfnKey.GROUP_DESCRIPTION]: "Description",
  [CfnKey.SG_INGRESS]: "Inbound Rules",
  [CfnKey.SG_EGRESS]: "Outbound Rules",
  // DynamoDB
  [CfnKey.TABLE_NAME]: "Table Name",
  [CfnKey.BILLING_MODE]: "Billing Mode",
  [CfnKey.KEY_SCHEMA]: "Key Schema",
  [CfnKey.ATTRIBUTE_DEFINITIONS]: "Attributes",
  [CfnKey.PITR_ENABLED]: "Point-in-Time Recovery",
  [CfnKey.DELETION_PROTECTION_ENABLED]: "Deletion Protection",
  [CfnKey.SSE_SPECIFICATION]: "Encryption",
  // SQS
  [CfnKey.QUEUE_NAME]: "Queue Name",
  [CfnKey.FIFO_QUEUE]: "FIFO Queue",
  [CfnKey.VISIBILITY_TIMEOUT]: "Visibility Timeout (s)",
  [CfnKey.MESSAGE_RETENTION]: "Message Retention (s)",
  [CfnKey.DELAY_SECONDS]: "Delivery Delay (s)",
  [CfnKey.REDRIVE_POLICY]: "Dead Letter Queue",
  // SNS
  [CfnKey.TOPIC_NAME]: "Topic Name",
  [CfnKey.FIFO_TOPIC]: "FIFO Topic",
  [CfnKey.DISPLAY_NAME]: "Display Name",
  // CloudWatch
  [CfnKey.ALARM_NAME]: "Alarm Name",
  [CfnKey.METRIC_NAME]: "Metric Name",
  [CfnKey.NAMESPACE]: "Namespace",
  [CfnKey.THRESHOLD]: "Threshold",
  [CfnKey.COMPARISON_OPERATOR]: "Comparison",
  [CfnKey.STATISTIC]: "Statistic",
  [CfnKey.PERIOD]: "Period (s)",
  [CfnKey.EVALUATION_PERIODS]: "Evaluation Periods",
  [CfnKey.TREAT_MISSING_DATA]: "Treat Missing Data",
  [CfnKey.ALARM_ACTIONS]: "Alarm Actions",
  // CloudWatch Logs
  [CfnKey.LOG_GROUP_NAME]: "Log Group Name",
  [CfnKey.RETENTION_IN_DAYS]: "Log Retention (days)",
  [CfnKey.KMS_KEY_ID]: "KMS Key",
  // IAM
  [CfnKey.ROLE_NAME]: "Role Name",
  [CfnKey.ASSUME_ROLE_POLICY]: "Trust Policy",
  [CfnKey.MANAGED_POLICY_ARNS]: "Managed Policies",
  [CfnKey.MAX_SESSION_DURATION]: "Max Session (s)",
  // ELBv2
  // NOTE: CfnKey.TYPE ("Type") is ambiguous — it collides with SSM Parameter
  // Type (String/StringList/SecureString), DynamoDB KeySchema KeyType, and any
  // other resource that has a top-level "Type" property. Type-specific labels
  // live in FRIENDLY_NAMES_BY_TYPE (below) so each resource renders correctly.
  [CfnKey.SCHEME]: "Scheme",
  [CfnKey.SUBNETS]: "Subnets",
  // API Gateway
  [CfnKey.PROTOCOL_TYPE]: "Protocol",
  // Secrets Manager
  [CfnKey.GENERATE_SECRET_STRING]: "Generate Secret String",
  [CfnKey.KMS_MASTER_KEY_ID]: "KMS Key",
  // SSM
  [CfnKey.TIER]: "Tier",
  // RDS additional
  [CfnKey.STORAGE_ENCRYPTED]: "Storage Encryption",
  [CfnKey.PUBLICLY_ACCESSIBLE]: "Publicly Accessible",
  [CfnKey.DB_SUBNET_GROUP_NAME]: "DB Subnet Group",
  [CfnKey.VPC_SECURITY_GROUP_IDS]: "VPC Security Groups",
};

/**
 * Per-resource-type label overrides for ambiguous CFN property names.
 *
 * This exists because `FRIENDLY_NAMES` is keyed by raw CFN property name
 * (e.g., "Type"), and many resources share the same property name with
 * different semantics:
 *   - AWS::ElasticLoadBalancingV2::LoadBalancer.Type = application | network
 *   - AWS::ElasticLoadBalancingV2::TargetGroup.TargetType = instance | ip | lambda
 *   - AWS::SSM::Parameter.Type = String | StringList | SecureString
 *   - AWS::DynamoDB::Table.KeySchema[].KeyType = HASH | RANGE
 *
 * When a resource-type-scoped label exists, it wins over the global
 * `FRIENDLY_NAMES` lookup. Nested structures (e.g., DynamoDB KeySchema) keep
 * their raw CFN property names since they render as one-line summaries rather
 * than top-level rows.
 *
 * Resource-type keys are the full CloudFormation type names from
 * `RESOURCE_TYPES` so callers always pass a canonical string.
 */
export const FRIENDLY_NAMES_BY_TYPE: Record<string, Record<string, string>> = {
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: {
    [CfnKey.TYPE]: "Load Balancer Type",
  },
  [RESOURCE_TYPES.SSM_PARAMETER]: {
    // CfnKey.SSM_TYPE === CfnKey.TYPE === "Type" but we use the SSM-specific
    // constant here to document intent at the call site.
    [CfnKey.SSM_TYPE]: "Parameter Type",
    [CfnKey.SSM_VALUE]: "Parameter Value",
  },
  [RESOURCE_TYPES.DYNAMODB_TABLE]: {
    // DynamoDB tables don't have a top-level "Type" field but may surface one
    // via free-form desiredState — make sure we never accidentally label it as
    // "Load Balancer Type".
    [CfnKey.TYPE]: "Type",
  },
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: {
    [CfnKey.TYPE]: "Alarm Type",
  },
};

/**
 * Resolves the display label for a CFN property key, respecting the
 * per-resource-type override map when a resource type is supplied.
 *
 * Lookup order:
 *   1. `FRIENDLY_NAMES_BY_TYPE[resourceType][key]` (per-resource override)
 *   2. `FRIENDLY_NAMES[key]` (unambiguous global label)
 *   3. `spacePascalCase(key)` (fallback — "FooBar" → "Foo Bar")
 */
export function resolveFieldLabel(key: string, resourceType?: string): string {
  if (resourceType) {
    const scoped = FRIENDLY_NAMES_BY_TYPE[resourceType]?.[key];
    if (scoped) return scoped;
  }
  return FRIENDLY_NAMES[key] ?? spacePascalCase(key);
}

/**
 * Fields whose values must NEVER be displayed in plaintext.
 * These are masked with asterisks in all user-facing output (plan box, logs).
 * @see SECURITY-AUDIT.md — SEC-02 Sensitive field exposure
 */
export const SENSITIVE_FIELDS: Set<string> = new Set([
  CfnKey.MASTER_USER_PASSWORD,
  CfnKey.SECRET_STRING,
  CfnKey.PASSWORD,
  CfnKey.ACCESS_KEY,
  CfnKey.SECRET_ACCESS_KEY,
  CfnKey.SESSION_TOKEN,
]);

/**
 * Converts a PascalCase key to a spaced name (fallback for unknown keys).
 * E.g., "IamInstanceProfile" -> "Iam Instance Profile"
 */
/**
 * Reverse mapping from human-friendly names → CfnKey values.
 * Supports case-insensitive lookup + common aliases (e.g., "size" → "InstanceType").
 * Used by --set to accept human-readable field names.
 */
const REVERSE_FRIENDLY: Map<string, string> = new Map();
for (const [cfnKey, friendlyName] of Object.entries(FRIENDLY_NAMES)) {
  REVERSE_FRIENDLY.set(friendlyName.toLowerCase(), cfnKey);
}
// Common aliases
REVERSE_FRIENDLY.set("size", CfnKey.INSTANCE_TYPE);
REVERSE_FRIENDLY.set("type", CfnKey.INSTANCE_TYPE);
REVERSE_FRIENDLY.set("ami", CfnKey.IMAGE_ID);
REVERSE_FRIENDLY.set("key", CfnKey.KEY_NAME);
REVERSE_FRIENDLY.set("subnet", CfnKey.SUBNET_ID);
REVERSE_FRIENDLY.set("memory", CfnKey.MEMORY_SIZE);
REVERSE_FRIENDLY.set("runtime", CfnKey.RUNTIME);
REVERSE_FRIENDLY.set("engine", CfnKey.ENGINE);
REVERSE_FRIENDLY.set("storage", CfnKey.ALLOCATED_STORAGE);
REVERSE_FRIENDLY.set("name", CfnKey.BUCKET_NAME);
REVERSE_FRIENDLY.set("retention", CfnKey.RETENTION_IN_DAYS);
REVERSE_FRIENDLY.set("port", CfnKey.FROM_PORT);
REVERSE_FRIENDLY.set("protocol", CfnKey.PROTOCOL_TYPE);
REVERSE_FRIENDLY.set("region", CfnKey.AVAILABILITY_ZONE);

/**
 * Resolves a --set key to a CfnKey. Accepts:
 * 1. Exact CfnKey (e.g., "InstanceType") — returned as-is
 * 2. Human-friendly name (e.g., "Instance Type") — resolved via FRIENDLY_NAMES
 * 3. Common alias (e.g., "size") — resolved via aliases
 */
export function resolveSetKey(key: string): string {
  // Already a valid CfnKey (PascalCase)?
  if (/^[A-Z]/.test(key)) return key;
  return REVERSE_FRIENDLY.get(key.toLowerCase()) ?? key;
}

export function spacePascalCase(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Formats a desiredState record as a human-readable key-value table.
 * Arrays are joined with commas. Objects render as nested key-value pairs.
 * Booleans render as "Yes"/"No". Strings and numbers render as-is.
 *
 * When `resourceType` is provided, per-resource label overrides from
 * `FRIENDLY_NAMES_BY_TYPE` take precedence over the global `FRIENDLY_NAMES`
 * map. This is required so ambiguous CFN property names like `Type` render
 * correctly per resource (e.g. SSM Parameter "Parameter Type" vs ELBv2
 * "Load Balancer Type").
 */
export function formatDesiredState(
  state: Record<string, unknown>,
  resourceType?: string,
): string {
  const entries = Object.entries(state);
  if (entries.length === 0) return "(none)";

  const lines: string[] = [];
  const maxKeyLen = Math.max(
    ...entries.map(([k]) => resolveFieldLabel(k, resourceType).length),
  );

  for (const [key, value] of entries) {
    const friendlyKey = resolveFieldLabel(key, resourceType);
    const padded = friendlyKey.padEnd(maxKeyLen);
    // Mask sensitive fields — never display passwords/secrets in plaintext
    if (SENSITIVE_FIELDS.has(key) && value !== undefined && value !== null) {
      lines.push(`  ${padded}   ********`);
      continue;
    }
    const formatted = formatSpecialValue(key, value) ?? formatValue(value);
    lines.push(`  ${padded}   ${formatted}`);
  }

  return lines.join("\n");
}

/**
 * Human-friendly formatting for complex CFN structures.
 * Returns null if no special formatting applies.
 */
export function formatSpecialValue(key: string, value: unknown): string | null {
  if (
    key === CfnKey.BLOCK_DEVICE_MAPPINGS &&
    Array.isArray(value) &&
    value.length > 0
  ) {
    const vol = value[0] as Record<string, unknown>;
    const ebs = vol?.[CfnKey.EBS] as Record<string, unknown> | undefined;
    if (!ebs) return null;
    const parts: string[] = [];
    if (ebs[CfnKey.VOLUME_TYPE]) parts.push(String(ebs[CfnKey.VOLUME_TYPE]));
    if (ebs[CfnKey.VOLUME_SIZE]) parts.push(`${ebs[CfnKey.VOLUME_SIZE]} GB`);
    parts.push(ebs[CfnKey.ENCRYPTED] ? "encrypted" : "unencrypted");
    return parts.join(", ");
  }
  if (
    key === CfnKey.METADATA_OPTIONS &&
    typeof value === "object" &&
    value !== null
  ) {
    const opts = value as Record<string, unknown>;
    return opts[CfnKey.HTTP_TOKENS] === "required"
      ? "IMDSv2 required"
      : "IMDSv1 allowed";
  }
  // ServerSideEncryptionConfiguration → show algorithm
  // S3 encryption — handle both BucketEncryption and ServerSideEncryptionConfiguration
  if (
    (key === CfnKey.SERVER_SIDE_ENCRYPTION_CONFIGURATION ||
      key === CfnKey.BUCKET_ENCRYPTION) &&
    typeof value === "object" &&
    value !== null
  ) {
    // Walk nested structure to find SSEAlgorithm
    const json = JSON.stringify(value);
    if (json.includes("aws:kms")) return "SSE-KMS enabled";
    if (json.includes(AwsDefault.ENCRYPTION_AES256))
      return "AES-256 (SSE-S3) enabled";
    return "Encryption enabled";
  }
  // LifecycleConfiguration → summarize rules
  if (
    key === CfnKey.LIFECYCLE_CONFIGURATION &&
    typeof value === "object" &&
    value !== null
  ) {
    const rules = (value as Record<string, unknown>)[CfnKey.RULES] as unknown[];
    if (Array.isArray(rules) && rules.length > 0) {
      const rule = rules[0] as Record<string, unknown>;
      const parts: string[] = [];
      if (
        rule[CfnKey.TRANSITIONS] &&
        Array.isArray(rule[CfnKey.TRANSITIONS]) &&
        (rule[CfnKey.TRANSITIONS] as Record<string, unknown>[]).length > 0
      ) {
        const t = (rule[CfnKey.TRANSITIONS] as Record<string, unknown>[])[0];
        const days = t?.[CfnKey.TRANSITION_IN_DAYS];
        parts.push(days ? `transition to IA after ${days}d` : "transition");
      } else if (rule[CfnKey.TRANSITION_IN_DAYS]) {
        parts.push(
          `transition to IA after ${rule[CfnKey.TRANSITION_IN_DAYS]}d`,
        );
      }
      if (rule[CfnKey.EXPIRATION_IN_DAYS])
        parts.push(`expire after ${rule[CfnKey.EXPIRATION_IN_DAYS]}d`);
      return parts.length > 0 ? parts.join(", ") : `${rules.length} rule(s)`;
    }
    return "Configured";
  }
  // CorsConfiguration → show rule count
  if (
    key === CfnKey.CORS_CONFIGURATION &&
    typeof value === "object" &&
    value !== null
  ) {
    const rules = (value as Record<string, unknown>)[
      CfnKey.CORS_RULES
    ] as unknown[];
    if (Array.isArray(rules)) return `${rules.length} CORS rule(s)`;
    return "Configured";
  }
  return null;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (Array.isArray(value)) {
    // Arrays of objects (e.g., Tags [{Key, Value}]) — show as Key:Value pairs
    if (
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null &&
      "Key" in value[0]
    ) {
      return value
        .map(
          (item: Record<string, unknown>) =>
            `${item[CfnKey.TAG_KEY]}:${item[CfnKey.TAG_VALUE]}`,
        )
        .join(", ");
    }
    return value.map((item) => formatValue(item)).join(", ");
  }
  if (typeof value === "object") {
    // Nested objects — show key: value pairs inline
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);
    // For deeply nested configs (e.g., encryption), summarize instead of dumping
    if (entries.length > 4) {
      return `${entries.length} properties configured`;
    }
    return entries.map(([k, v]) => `${k}: ${formatValue(v)}`).join(", ");
  }
  return String(value);
}
