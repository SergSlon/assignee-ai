/**
 * Intent-aware smart defaults for the option elicitor.
 *
 * Maps keyword patterns in the user's intent string to field default overrides.
 * Uses simple case-insensitive substring matching — no LLM calls required.
 * First matching rule per field wins (no conflicting overrides).
 *
 * @see Story 10.5
 */

import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import type { ResourceField } from "@assignee/core";

/** A single field default override derived from intent analysis. */
export interface IntentDefaultOverride {
  /** CloudFormation property name, e.g. "InstanceType" */
  fieldName: string;
  /** Default value to inject */
  value: unknown;
  /** Explanation shown as clack hint, e.g. "Selected for web serving — burstable with 2 GiB RAM" */
  reason: string;
  /**
   * Tells the categorySelect renderer which category to pre-select,
   * skipping the category step. E.g., "burstable", "compute", "memory".
   * @see Story 18.12
   */
  categoryHint?: string;
}

/** Internal rule definition for keyword-to-override mapping. */
interface IntentRule {
  resourceType: string;
  keywords: string[];
  overrides: IntentDefaultOverride[];
}

const INTENT_RULES: IntentRule[] = [
  // EC2 — Web server
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["web server", "web app", "web service", "api server"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
        categoryHint: "burstable",
      },
    ],
  },
  // EC2 — ML/Compute
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["machine learning", "ml training", "ml model", "deep learning"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "c5.xlarge",
        reason: "Selected for ML/compute — 4 vCPU, 8 GiB, compute-optimized",
        categoryHint: "compute",
      },
    ],
  },
  // EC2 — Database/Cache
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["database", "db server", "cache", "redis", "memcached"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "r5.large",
        reason: "Selected for data workloads — 16 GiB memory-optimized",
        categoryHint: "memory",
      },
    ],
  },
  // S3 — Logging
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["logs", "logging", "log storage", "audit trail"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: CfnKey.LIFECYCLE_TRANSITION_DAYS,
        value: "90",
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: CfnKey.LIFECYCLE_EXPIRATION_DAYS,
        value: "365",
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
    ],
  },
  // S3 — Static website
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: [
      "static website",
      "web hosting",
      "static site",
      "frontend hosting",
    ],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_CORS,
        value: true,
        reason: "Pre-configured for static web hosting — CORS enabled",
      },
      {
        fieldName: CfnKey.PUBLIC_ACCESS_BLOCK,
        value: false,
        reason: "Pre-configured for static web hosting — public access allowed",
      },
    ],
  },
  // Lambda — API handler
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["api handler", "api endpoint"],
    overrides: [
      {
        fieldName: CfnKey.MEMORY_SIZE,
        value: "512",
        reason:
          "Selected for API handling — 512 MB provides proportional CPU for fast response times",
      },
      {
        fieldName: CfnKey.TIMEOUT,
        value: "30",
        reason:
          "Selected for API handling — 30s timeout suits synchronous HTTP requests",
      },
    ],
  },
  // Lambda — Background job / worker
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["background job", "worker"],
    overrides: [
      {
        fieldName: CfnKey.TIMEOUT,
        value: "300",
        reason:
          "Selected for background processing — 300s timeout for long-running tasks",
      },
    ],
  },
  // RDS — Production database
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["production", "prod db", "production database"],
    overrides: [
      {
        fieldName: CfnKey.MULTI_AZ,
        value: true,
        reason:
          "Selected for production — Multi-AZ provides high availability with automatic failover",
      },
      {
        fieldName: CfnKey.BACKUP_RETENTION_PERIOD,
        value: "7",
        reason:
          "Selected for production — 7-day backup retention for point-in-time recovery",
      },
      {
        fieldName: CfnKey.DELETION_PROTECTION,
        value: true,
        reason:
          "Selected for production — deletion protection prevents accidental data loss",
      },
    ],
  },
  // RDS — Dev database
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["dev database", "dev db"],
    overrides: [
      {
        fieldName: CfnKey.MULTI_AZ,
        value: false,
        reason:
          "Selected for development — single-AZ reduces cost for non-critical environments",
      },
    ],
  },
];

/**
 * Analyzes the user intent string and returns field default overrides
 * for the given resource type. Uses case-insensitive substring matching.
 * First matching rule per field wins — no conflicting overrides.
 *
 * @param userIntent  - The user's natural-language intent string
 * @param resourceType - CloudFormation resource type, e.g. RESOURCE_TYPES.EC2_INSTANCE
 * @returns Array of field overrides (empty if no keywords match)
 */
export function getIntentDefaults(
  userIntent: string,
  resourceType: string,
): IntentDefaultOverride[] {
  if (!userIntent || !resourceType) return [];

  const intentLower = userIntent.toLowerCase();
  const claimedFields = new Set<string>();
  const overrides: IntentDefaultOverride[] = [];

  for (const rule of INTENT_RULES) {
    if (rule.resourceType !== resourceType) continue;

    const matches = rule.keywords.some((kw) => intentLower.includes(kw));
    if (!matches) continue;

    for (const override of rule.overrides) {
      // First match per field wins
      if (claimedFields.has(override.fieldName)) continue;
      claimedFields.add(override.fieldName);
      overrides.push(override);
    }
  }

  return overrides;
}

/**
 * Applies intent-derived default overrides to resource fields.
 * Modifies initialValue and appends reason hint to each matching field.
 * Pure function — no mutations to input arrays.
 */
export function applyIntentOverrides(
  fields: ResourceField[],
  overrides: IntentDefaultOverride[],
): ResourceField[] {
  if (overrides.length === 0) return fields;

  const overrideMap = new Map(overrides.map((o) => [o.fieldName, o]));

  return fields.map((field) => {
    const override = overrideMap.get(field.name);
    if (!override) return field;

    const intentHint = `Pre-selected based on your intent: ${override.reason}`;
    const existingHint = field.question.hint;
    const combinedHint = existingHint
      ? `${existingHint}\n${intentHint}`
      : intentHint;

    // Special warning for PublicAccessBlock=false
    const finalHint =
      field.name === CfnKey.PUBLIC_ACCESS_BLOCK && override.value === false
        ? `${combinedHint}\nWarning: Public access will be enabled. Ensure this bucket does not contain sensitive data.`
        : combinedHint;

    return {
      ...field,
      question: {
        ...field.question,
        initialValue: override.value,
        hint: finalHint,
      },
    };
  });
}
