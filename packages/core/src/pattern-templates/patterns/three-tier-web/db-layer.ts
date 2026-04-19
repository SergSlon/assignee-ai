/**
 * Database layer for the three-tier-web pattern.
 *
 * Split from three-tier-web.ts (W6d F3). DBSubnetGroup + RDS instance.
 */

import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { CfnKey, ResourceDefault } from "@/config/cfn-keys.js";
import { markerRef } from "@/config/marker-tokens.js";
import { RDS_PLACEHOLDER_PASSWORD } from "@/config/placeholder-passwords.js";
import type { ResourceSpec } from "../../types.js";
import { ThreeTierWebResourceId as R } from "../../pattern-resource-ids.js";

export const dbLayerResources: ResourceSpec[] = [
  {
    resourceType: RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
    resourceId: R.DB_SUBNET_GROUP,
    displayName: "RDS DB Subnet Group",
  },
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    resourceId: R.RDS_INSTANCE,
    displayName: "RDS Database Instance",
  },
];

export const dbLayerDefaults = {
  [R.DB_SUBNET_GROUP]: {
    [CfnKey.DB_SUBNET_GROUP_DESCRIPTION]:
      "Private subnets for three-tier-web RDS instance",
    SubnetIds: [markerRef(R.PRIVATE_SUBNET_1), markerRef(R.PRIVATE_SUBNET_2)],
  },
  [R.RDS_INSTANCE]: {
    Engine: ResourceDefault.RDS_ENGINE_POSTGRES,
    MasterUsername: "appuser",
    // Placeholder password — user MUST override via --set before apply.
    // The CLI's default apply path hard-rejects any plan whose
    // MasterUserPassword is still this sentinel (see
    // detectSentinelPassword in apps/cli/src/nodes/preflight-guard.ts),
    // which closes the "forgot to --set" foot-gun. Direct-apply paths
    // that bypass preflight (e.g. a future cached-plan feature) would
    // not be protected, so plan-time rejection is the guarantee —
    // not a universal one. Sourced from the shared constant so the
    // guard and the template can never drift.
    MasterUserPassword: RDS_PLACEHOLDER_PASSWORD,
    DBInstanceClass: "db.t3.micro",
    AllocatedStorage: "20",
    MultiAZ: false,
    StorageEncrypted: true,
    BackupRetentionPeriod: 7,
    [CfnKey.DB_SUBNET_GROUP_NAME]: markerRef(R.DB_SUBNET_GROUP),
    [CfnKey.VPC_SECURITY_GROUP_IDS]: [markerRef(R.DB_SG)],
  },
} as const;
