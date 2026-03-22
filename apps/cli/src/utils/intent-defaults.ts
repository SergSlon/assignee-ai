/**
 * Intent-aware smart defaults for the option elicitor.
 *
 * Maps keyword patterns in the user's intent string to field default overrides.
 * Uses simple case-insensitive substring matching — no LLM calls required.
 * First matching rule per field wins (no conflicting overrides).
 *
 * @see Story 10.5
 */

import { RESOURCE_TYPES } from "@assignee/core";
import type { ResourceField } from "@assignee/core";

/** A single field default override derived from intent analysis. */
export interface IntentDefaultOverride {
  /** CloudFormation property name, e.g. "InstanceType" */
  fieldName: string;
  /** Default value to inject */
  value: unknown;
  /** Explanation shown as clack hint, e.g. "Selected for web serving — burstable with 2 GiB RAM" */
  reason: string;
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
        fieldName: "InstanceType",
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
      },
    ],
  },
  // EC2 — ML/Compute
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["machine learning", "ml training", "ml model", "deep learning"],
    overrides: [
      {
        fieldName: "InstanceType",
        value: "c5.xlarge",
        reason: "Selected for ML/compute — 4 vCPU, 8 GiB, compute-optimized",
      },
    ],
  },
  // EC2 — Database/Cache
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["database", "db server", "cache", "redis", "memcached"],
    overrides: [
      {
        fieldName: "InstanceType",
        value: "r5.large",
        reason: "Selected for data workloads — 16 GiB memory-optimized",
      },
    ],
  },
  // S3 — Logging
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["logs", "logging", "log storage", "audit trail"],
    overrides: [
      {
        fieldName: "EnableLifecycle",
        value: true,
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: "LifecycleTransitionDays",
        value: "90",
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: "LifecycleExpirationDays",
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
        fieldName: "EnableCors",
        value: true,
        reason: "Pre-configured for static web hosting — CORS enabled",
      },
      {
        fieldName: "PublicAccessBlockConfiguration",
        value: false,
        reason: "Pre-configured for static web hosting — public access allowed",
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
 * @param resourceType - CloudFormation resource type, e.g. "AWS::EC2::Instance"
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
      field.name === "PublicAccessBlockConfiguration" &&
      override.value === false
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
