/**
 * RDS Pricing Decomposer — breaks an RDS instance into billable components:
 * compute, storage, Multi-AZ surcharge, and backup costs.
 *
 * @see Story 23.2
 */

import { CfnKey, ResourceDefault, AwsDefault } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";
import { EXTENDED_TIMEOUT_MS } from "../constants.js";
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PricingUnit } from "../units.js";

export const rdsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const instanceClass =
      (desiredState[CfnKey.DB_INSTANCE_CLASS] as string | undefined) ??
      AwsDefault.DB_INSTANCE_CLASS;
    const engine =
      (desiredState[CfnKey.ENGINE] as string | undefined) ??
      AwsDefault.RDS_ENGINE_MYSQL;
    const multiAZ = desiredState[CfnKey.MULTI_AZ] === true;

    // 1. Compute (query the actual deployment option — Multi-AZ price includes standby)
    items.push({
      label: LineItemLabel.COMPUTE,
      quantity: 1,
      unit: PricingUnit.INSTANCE,
      serviceCode: SC.RDS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATABASE_INSTANCE,
          Type: M.TERM_MATCH,
        },
        { Field: F.INSTANCE_TYPE, Value: instanceClass, Type: M.TERM_MATCH },
        {
          Field: F.DATABASE_ENGINE,
          Value: mapEngine(engine),
          Type: M.TERM_MATCH,
        },
        {
          Field: F.DEPLOYMENT_OPTION,
          Value: multiAZ ? FV.MULTI_AZ : FV.SINGLE_AZ,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
      description: multiAZ ? `${instanceClass} (Multi-AZ)` : instanceClass,
      priceUnit: PriceUnit.PER_HOUR,
      timeoutMs: EXTENDED_TIMEOUT_MS,
    });

    // 2. Storage
    const allocatedStorage = Number(
      desiredState[CfnKey.ALLOCATED_STORAGE] ?? 20,
    );
    const storageType = String(
      desiredState[CfnKey.STORAGE_TYPE] ?? ResourceDefault.EBS_VOLUME_TYPE,
    );

    items.push({
      label: LineItemLabel.STORAGE,
      quantity: allocatedStorage,
      unit: PricingUnit.GB,
      serviceCode: SC.RDS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATABASE_STORAGE,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.VOLUME_TYPE,
          Value: mapStorageType(storageType),
          Type: M.TERM_MATCH,
        },
        {
          Field: F.DEPLOYMENT_OPTION,
          Value: multiAZ ? FV.MULTI_AZ : FV.SINGLE_AZ,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
      description: `${allocatedStorage} GB ${storageType}`,
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    // 3. Backup storage (usage-based, depends on retention period)
    const backupRetention = Number(
      desiredState[CfnKey.BACKUP_RETENTION_PERIOD] ?? 7,
    );
    if (backupRetention > 0) {
      items.push({
        label: LineItemLabel.BACKUP,
        quantity: allocatedStorage,
        unit: PricingUnit.GB,
        serviceCode: SC.RDS,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.STORAGE_SNAPSHOT,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: `${backupRetention} days retention`,
        priceUnit: PriceUnit.PER_GB_MONTH,
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
