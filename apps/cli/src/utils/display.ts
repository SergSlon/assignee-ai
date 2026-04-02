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
import { CfnKey } from "@assignee/core";
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
};

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
export function spacePascalCase(key: string): string {
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

/**
 * Formats a desiredState record as a human-readable key-value table.
 * Arrays are joined with commas. Objects render as nested key-value pairs.
 * Booleans render as "Yes"/"No". Strings and numbers render as-is.
 */
export function formatDesiredState(state: Record<string, unknown>): string {
  const entries = Object.entries(state);
  if (entries.length === 0) return "(none)";

  const lines: string[] = [];
  const maxKeyLen = Math.max(
    ...entries.map(([k]) => (FRIENDLY_NAMES[k] ?? spacePascalCase(k)).length),
  );

  for (const [key, value] of entries) {
    const friendlyKey = FRIENDLY_NAMES[key] ?? spacePascalCase(key);
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
    if (json.includes("AES256")) return "AES-256 (SSE-S3) enabled";
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
          (item: Record<string, unknown>) => `${item["Key"]}:${item["Value"]}`,
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
