/**
 * RDS Pricing Decomposer — breaks an RDS instance into billable components:
 * compute, storage, Multi-AZ surcharge, and backup costs.
 *
 * @see Story 23.2
 */

import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

const EXTENDED_TIMEOUT_MS = 8000;

export const rdsPricingDecomposer: PricingDecomposer = {
  resourceType: "AWS::RDS::DBInstance",

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const instanceClass =
      (desiredState["DBInstanceClass"] as string | undefined) ?? "db.t3.micro";
    const engine = (desiredState["Engine"] as string | undefined) ?? "mysql";
    const multiAZ = desiredState["MultiAZ"] === true;

    // 1. Compute (query the actual deployment option — Multi-AZ price includes standby)
    items.push({
      label: "Compute",
      quantity: 1,
      unit: "instance",
      serviceCode: "AmazonRDS",
      filters: [
        {
          Field: "productFamily",
          Value: "Database Instance",
          Type: "TERM_MATCH",
        },
        { Field: "instanceType", Value: instanceClass, Type: "TERM_MATCH" },
        {
          Field: "databaseEngine",
          Value: mapEngine(engine),
          Type: "TERM_MATCH",
        },
        {
          Field: "deploymentOption",
          Value: multiAZ ? "Multi-AZ" : "Single-AZ",
          Type: "TERM_MATCH",
        },
      ],
      kind: "fixed",
      description: multiAZ ? `${instanceClass} (Multi-AZ)` : instanceClass,
      priceUnit: "/hr",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    });

    // 2. Storage
    const allocatedStorage = Number(desiredState["AllocatedStorage"] ?? 20);
    const storageType = String(desiredState["StorageType"] ?? "gp3");

    items.push({
      label: "Storage",
      quantity: allocatedStorage,
      unit: "GB",
      serviceCode: "AmazonRDS",
      filters: [
        {
          Field: "productFamily",
          Value: "Database Storage",
          Type: "TERM_MATCH",
        },
        {
          Field: "volumeType",
          Value: mapStorageType(storageType),
          Type: "TERM_MATCH",
        },
        {
          Field: "deploymentOption",
          Value: multiAZ ? "Multi-AZ" : "Single-AZ",
          Type: "TERM_MATCH",
        },
      ],
      kind: "fixed",
      description: `${allocatedStorage} GB ${storageType}`,
      priceUnit: "/GB-mo",
    });

    // 3. Backup storage (usage-based, depends on retention period)
    const backupRetention = Number(desiredState["BackupRetentionPeriod"] ?? 7);
    if (backupRetention > 0) {
      items.push({
        label: "Backup",
        quantity: allocatedStorage,
        unit: "GB",
        serviceCode: "AmazonRDS",
        filters: [
          {
            Field: "productFamily",
            Value: "Storage Snapshot",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
        description: `${backupRetention} days retention`,
        priceUnit: "/GB-mo",
      });
    }

    return items;
  },
};

function mapEngine(engine: string): string {
  const map: Record<string, string> = {
    mysql: "MySQL",
    postgres: "PostgreSQL",
    mariadb: "MariaDB",
    "oracle-ee": "Oracle",
    "oracle-se2": "Oracle",
    "sqlserver-ee": "SQL Server",
    "sqlserver-se": "SQL Server",
    "sqlserver-ex": "SQL Server",
    "sqlserver-web": "SQL Server",
    "aurora-mysql": "Aurora MySQL",
    "aurora-postgresql": "Aurora PostgreSQL",
  };
  return map[engine] ?? engine;
}

function mapStorageType(storageType: string): string {
  const map: Record<string, string> = {
    gp3: "General Purpose (SSD)",
    gp2: "General Purpose (SSD)",
    io1: "Provisioned IOPS (SSD)",
    io2: "Provisioned IOPS (SSD)",
    standard: "Magnetic",
  };
  return map[storageType] ?? "General Purpose (SSD)";
}
