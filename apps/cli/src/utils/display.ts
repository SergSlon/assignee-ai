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
  InstanceType: "Instance Type",
  ImageId: "AMI",
  KeyName: "Key Pair",
  SubnetId: "Subnet",
  SecurityGroupIds: "Security Groups",
  BucketName: "Bucket Name",
  BucketEncryption: "Encryption",
  PublicAccessBlockConfiguration: "Block Public Access",
  VersioningConfiguration: "Versioning",
  DBInstanceClass: "DB Instance Class",
  Engine: "Engine",
  MasterUsername: "Master Username",
  MasterUserPassword: "Master Password",
  AllocatedStorage: "Storage (GB)",
  MultiAZ: "Multi-AZ",
  StorageType: "Storage Type",
  FunctionName: "Function Name",
  Runtime: "Runtime",
  Handler: "Handler",
  MemorySize: "Memory (MB)",
  Timeout: "Timeout (s)",
  Role: "Execution Role",
  Tags: "Tags",
  DBName: "Database Name",
  EngineVersion: "Engine Version",
  DeletionProtection: "Deletion Protection",
  BackupRetentionPeriod: "Backup Retention (days)",
  Description: "Description",
  ReservedConcurrentExecutions: "Reserved Concurrency",
  Environment: "Environment Variables",
  IamInstanceProfile: "IAM Instance Profile",
  UserData: "User Data",
  KMSMasterKeyID: "KMS Key ID",
  EnableLifecycle: "Lifecycle Rules",
  EnableCors: "CORS",
  EnableReplication: "Cross-Region Replication",
  MetadataOptions: "Instance Metadata",
  BlockDeviceMappings: "Storage",
};

/**
 * Fields whose values must NEVER be displayed in plaintext.
 * These are masked with asterisks in all user-facing output (plan box, logs).
 * @see SECURITY-AUDIT.md — SEC-02 Sensitive field exposure
 */
export const SENSITIVE_FIELDS = new Set([
  "MasterUserPassword",
  "SecretString",
  "Password",
  "AccessKey",
  "SecretAccessKey",
  "SessionToken",
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
    key === "BlockDeviceMappings" &&
    Array.isArray(value) &&
    value.length > 0
  ) {
    const vol = value[0] as Record<string, unknown>;
    const ebs = vol?.["Ebs"] as Record<string, unknown> | undefined;
    if (!ebs) return null;
    const parts: string[] = [];
    if (ebs["VolumeType"]) parts.push(String(ebs["VolumeType"]));
    if (ebs["VolumeSize"]) parts.push(`${ebs["VolumeSize"]} GB`);
    parts.push(ebs["Encrypted"] ? "encrypted" : "unencrypted");
    return parts.join(", ");
  }
  if (
    key === "MetadataOptions" &&
    typeof value === "object" &&
    value !== null
  ) {
    const opts = value as Record<string, unknown>;
    return opts["HttpTokens"] === "required"
      ? "IMDSv2 required"
      : "IMDSv1 allowed";
  }
  // ServerSideEncryptionConfiguration → show algorithm
  // S3 encryption — handle both BucketEncryption and ServerSideEncryptionConfiguration
  if (
    (key === "ServerSideEncryptionConfiguration" ||
      key === "BucketEncryption") &&
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
    key === "LifecycleConfiguration" &&
    typeof value === "object" &&
    value !== null
  ) {
    const rules = (value as Record<string, unknown>)["Rules"] as unknown[];
    if (Array.isArray(rules) && rules.length > 0) {
      const rule = rules[0] as Record<string, unknown>;
      const parts: string[] = [];
      if (
        rule["Transitions"] &&
        Array.isArray(rule["Transitions"]) &&
        (rule["Transitions"] as Record<string, unknown>[]).length > 0
      ) {
        const t = (rule["Transitions"] as Record<string, unknown>[])[0];
        const days = t?.["TransitionInDays"];
        parts.push(days ? `transition to IA after ${days}d` : "transition");
      } else if (rule["TransitionInDays"]) {
        parts.push(`transition to IA after ${rule["TransitionInDays"]}d`);
      }
      if (rule["ExpirationInDays"])
        parts.push(`expire after ${rule["ExpirationInDays"]}d`);
      return parts.length > 0 ? parts.join(", ") : `${rules.length} rule(s)`;
    }
    return "Configured";
  }
  // CorsConfiguration → show rule count
  if (
    key === "CorsConfiguration" &&
    typeof value === "object" &&
    value !== null
  ) {
    const rules = (value as Record<string, unknown>)["CorsRules"] as unknown[];
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
