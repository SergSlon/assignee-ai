import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::RDS::DBInstance.
 */
export const rdsDbInstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
  commonFields: [
    {
      name: "DBInstanceClass",
      question: {
        type: "enum",
        label: "DB instance class",
        options: [
          {
            value: "db.t3.micro",
            label: "db.t3.micro  (2 vCPU,  1 GiB) — ~$0.017/hr",
          },
          {
            value: "db.t3.small",
            label: "db.t3.small  (2 vCPU,  2 GiB) — ~$0.034/hr",
          },
          {
            value: "db.t3.medium",
            label: "db.t3.medium (2 vCPU,  4 GiB) — ~$0.068/hr",
          },
          {
            value: "db.m5.large",
            label: "db.m5.large  (2 vCPU,  8 GiB) — ~$0.171/hr",
          },
        ],
        initialValue: "db.t3.micro",
      },
    },
    {
      name: "Engine",
      question: {
        type: "enum",
        label: "Database engine",
        options: [
          { value: "mysql", label: "MySQL" },
          { value: "postgres", label: "PostgreSQL" },
          { value: "mariadb", label: "MariaDB" },
          { value: "aurora-mysql", label: "Aurora MySQL" },
          { value: "aurora-postgresql", label: "Aurora PostgreSQL" },
        ],
        initialValue: "postgres",
      },
    },
    {
      name: "MasterUsername",
      question: {
        type: "string",
        label: "Master username",
        placeholder: "admin",
        validate: (value: unknown) =>
          typeof value === "string" && value.length > 0
            ? undefined
            : "Master username is required",
      },
    },
    {
      name: "MultiAZ",
      question: {
        type: "boolean",
        label: "Enable Multi-AZ deployment?",
        initialValue: false,
      },
    },
    {
      name: "StorageType",
      question: {
        type: "enum",
        label: "Storage type",
        options: [
          {
            value: "gp3",
            label: "gp3 (General Purpose SSD v3) — ~$0.115/GB-month",
          },
          {
            value: "gp2",
            label: "gp2 (General Purpose SSD v2) — ~$0.115/GB-month",
          },
          {
            value: "io1",
            label:
              "io1 (Provisioned IOPS SSD)   — ~$0.125/GB-month + $0.10/IOPS",
          },
        ],
        initialValue: "gp3",
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
      },
    },
  ],
  advancedFields: [
    {
      name: "BackupRetentionPeriod",
      question: {
        type: "string",
        label: "Backup retention period (days)",
        placeholder: "7",
      },
    },
    {
      name: "DeletionProtection",
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: false,
      },
    },
  ],
  defaults: {
    StorageType: "gp3",
    MultiAZ: false,
  },
};
