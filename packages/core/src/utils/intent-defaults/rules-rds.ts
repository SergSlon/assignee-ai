/** RDS DB instance intent rules. */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import type { IntentRule } from "./types.js";

export const RDS_RULES: IntentRule[] = [
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
  // RDS — PostgreSQL
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["postgres", "postgresql"],
    overrides: [
      {
        fieldName: CfnKey.ENGINE,
        value: "postgres",
        reason: "PostgreSQL selected — most popular open-source relational DB",
      },
    ],
  },
  // RDS — MySQL
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["mysql"],
    overrides: [
      {
        fieldName: CfnKey.ENGINE,
        value: "mysql",
        reason: "MySQL selected — widely supported relational DB",
      },
    ],
  },
];
