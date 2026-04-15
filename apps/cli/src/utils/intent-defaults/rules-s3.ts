/** S3 bucket intent rules. */

import { CfnKey, RESOURCE_TYPES } from "@assignee/core";
import type { IntentRule } from "./types.js";

export const S3_RULES: IntentRule[] = [
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
  // S3 — Backup/archive
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["backup", "archive", "cold storage"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for backup — lifecycle transitions to reduce cost",
      },
      {
        fieldName: CfnKey.LIFECYCLE_TRANSITION_DAYS,
        value: "30",
        reason:
          "Pre-configured for backup — move to Infrequent Access after 30 days",
      },
    ],
  },
  // S3 — Data lake
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["data lake", "analytics", "data warehouse"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for data lake — intelligent tiering for mixed access patterns",
      },
    ],
  },
];
