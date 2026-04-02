/**
 * Drift detection types — pure data shapes for comparing desired vs actual state.
 *
 * @see Story 28.1 — Drift Detector Service
 */

import { z } from "zod";
import { CfnKey } from "../config/cfn-keys.js";

// ── Enums ────────────────────────────────────────────────────────────────

export const DriftStatus = {
  IN_SYNC: "IN_SYNC",
  DRIFTED: "DRIFTED",
  DELETED: "DELETED",
  ERROR: "ERROR",
  BASELINE_MISSING: "BASELINE_MISSING",
} as const;

export type DriftStatusType = (typeof DriftStatus)[keyof typeof DriftStatus];

export const ChangeType = {
  MODIFIED: "MODIFIED",
  ADDED_EXTERNALLY: "ADDED_EXTERNALLY",
  REMOVED: "REMOVED",
} as const;

export type ChangeTypeValue = (typeof ChangeType)[keyof typeof ChangeType];

// ── Interfaces ───────────────────────────────────────────────────────────

export interface DriftedField {
  /** Dot-notation path (e.g., "Encryption.SSEAlgorithm") */
  path: string;
  /** Value from the provision log / checkpoint */
  desiredValue: unknown;
  /** Value from CloudControl GetResource */
  actualValue: unknown;
  /** Type of change */
  changeType: ChangeTypeValue;
}

export interface DriftResult {
  /** CloudFormation resource type (e.g., RESOURCE_TYPES.S3_BUCKET) */
  resourceType: string;
  /** Resource identifier (e.g., ARN or physical ID) */
  resourceId: string;
  /** Overall drift status */
  status: DriftStatusType;
  /** Field-level drift details (empty when IN_SYNC, DELETED, ERROR, or BASELINE_MISSING) */
  driftedFields: DriftedField[];
  /** Actual state from GetResource (undefined on error/deleted) */
  actualState?: Record<string, unknown>;
  /** Desired state from provision log or checkpoint */
  desiredState?: Record<string, unknown>;
  /** ISO timestamp of when the check was performed */
  checkedAt: string;
  /** Error message when status is ERROR */
  errorMessage?: string;
}

// ── Auto-populated field ignore list ─────────────────────────────────────

/** Fields auto-populated by AWS that should be excluded from drift comparison. */
export const AUTO_POPULATED_FIELDS: Record<string, Set<string>> = {
  _global: new Set([
    "Arn",
    "Id",
    CfnKey.CREATION_DATE,
    CfnKey.LAST_MODIFIED_DATE,
    CfnKey.LAST_MODIFIED_TIME,
    CfnKey.OWNER_ID,
    CfnKey.ACCOUNT_ID,
    CfnKey.DOMAIN_NAME_CFN,
    CfnKey.REGIONAL_DOMAIN_NAME,
    CfnKey.DUAL_STACK_DOMAIN_NAME,
    CfnKey.WEBSITE_URL,
  ]),
};

/**
 * Check if a field should be excluded from drift comparison.
 * Checks both global ignore list and per-resource-type ignore list.
 */
export function isAutoPopulatedField(
  resourceType: string,
  fieldPath: string,
): boolean {
  const topLevelKey = fieldPath.split(".")[0]!;
  const global = AUTO_POPULATED_FIELDS["_global"]!;
  const perType = AUTO_POPULATED_FIELDS[resourceType];

  return global.has(topLevelKey) || (perType?.has(topLevelKey) ?? false);
}

// ── Zod Schemas (for validation) ─────────────────────────────────────────

export const DriftedFieldSchema = z.object({
  path: z.string(),
  desiredValue: z.unknown(),
  actualValue: z.unknown(),
  changeType: z.enum([
    ChangeType.MODIFIED,
    ChangeType.ADDED_EXTERNALLY,
    ChangeType.REMOVED,
  ]),
});

export const DriftResultSchema = z.object({
  resourceType: z.string(),
  resourceId: z.string(),
  status: z.enum([
    DriftStatus.IN_SYNC,
    DriftStatus.DRIFTED,
    DriftStatus.DELETED,
    DriftStatus.ERROR,
    DriftStatus.BASELINE_MISSING,
  ]),
  driftedFields: z.array(DriftedFieldSchema),
  actualState: z.record(z.unknown()).optional(),
  desiredState: z.record(z.unknown()).optional(),
  checkedAt: z.string().datetime(),
  errorMessage: z.string().optional(),
});
