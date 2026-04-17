/**
 * Human-friendly formatting for complex CFN structures.
 * Returns null if no special formatting applies (caller falls back to formatValue).
 */
import { CfnKey } from "../../config/cfn-keys/keys.js";
import { AwsDefault } from "../../config/cfn-keys/defaults.js";

function formatBlockDeviceMappings(value: unknown[]): string | null {
  if (value.length === 0) return null;
  const vol = value[0] as Record<string, unknown>;
  const ebs = vol?.[CfnKey.EBS] as Record<string, unknown> | undefined;
  if (!ebs) return null;
  const parts: string[] = [];
  if (ebs[CfnKey.VOLUME_TYPE]) parts.push(String(ebs[CfnKey.VOLUME_TYPE]));
  if (ebs[CfnKey.VOLUME_SIZE]) parts.push(`${ebs[CfnKey.VOLUME_SIZE]} GB`);
  parts.push(ebs[CfnKey.ENCRYPTED] ? "encrypted" : "unencrypted");
  return parts.join(", ");
}

function formatS3Encryption(value: object): string {
  // ServerSideEncryptionConfiguration → show algorithm
  // S3 encryption — handle both BucketEncryption and ServerSideEncryptionConfiguration
  const json = JSON.stringify(value);
  if (json.includes("aws:kms")) return "SSE-KMS enabled";
  if (json.includes(AwsDefault.ENCRYPTION_AES256))
    return "AES-256 (SSE-S3) enabled";
  return "Encryption enabled";
}

function formatLifecycleConfiguration(value: object): string {
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
      parts.push(`transition to IA after ${rule[CfnKey.TRANSITION_IN_DAYS]}d`);
    }
    if (rule[CfnKey.EXPIRATION_IN_DAYS])
      parts.push(`expire after ${rule[CfnKey.EXPIRATION_IN_DAYS]}d`);
    return parts.length > 0 ? parts.join(", ") : `${rules.length} rule(s)`;
  }
  return "Configured";
}

function formatCorsConfiguration(value: object): string {
  const rules = (value as Record<string, unknown>)[
    CfnKey.CORS_RULES
  ] as unknown[];
  if (Array.isArray(rules)) return `${rules.length} CORS rule(s)`;
  return "Configured";
}

export function formatSpecialValue(key: string, value: unknown): string | null {
  if (key === CfnKey.BLOCK_DEVICE_MAPPINGS && Array.isArray(value)) {
    return formatBlockDeviceMappings(value);
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
  if (
    (key === CfnKey.SERVER_SIDE_ENCRYPTION_CONFIGURATION ||
      key === CfnKey.BUCKET_ENCRYPTION) &&
    typeof value === "object" &&
    value !== null
  ) {
    return formatS3Encryption(value);
  }
  if (
    key === CfnKey.LIFECYCLE_CONFIGURATION &&
    typeof value === "object" &&
    value !== null
  ) {
    return formatLifecycleConfiguration(value);
  }
  if (
    key === CfnKey.CORS_CONFIGURATION &&
    typeof value === "object" &&
    value !== null
  ) {
    return formatCorsConfiguration(value);
  }
  return null;
}
