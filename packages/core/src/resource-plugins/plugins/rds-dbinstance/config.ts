import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import { CfnKey, ResourceDefault } from "../../../config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../../types.js";

export const defaults: ResourcePlugin["defaults"] = {
  [CfnKey.STORAGE_TYPE]: ResourceDefault.EBS_VOLUME_TYPE,
  [CfnKey.MULTI_AZ]: false,
  [CfnKey.STORAGE_ENCRYPTED]: true,
};

/**
 * Auto-create a SecurityGroup for DB access when none is specified.
 * Engine-aware port selection (3306 for MySQL-family, 5432 otherwise).
 */
export function companionResources(
  desiredState: Record<string, unknown>,
): CfnOutput[] {
  const vpcSgIds = desiredState[CfnKey.VPC_SECURITY_GROUP_IDS];
  if (Array.isArray(vpcSgIds) && vpcSgIds.length > 0) return [];

  const engine = (desiredState[CfnKey.ENGINE] as string) ?? "postgres";
  const port =
    engine.includes("mysql") ||
    engine.includes("mariadb") ||
    engine.includes("aurora-mysql")
      ? 3306
      : 5432;
  const dbClass =
    (desiredState[CfnKey.DB_INSTANCE_CLASS] as string) ?? "db-instance";
  const sanitized = dbClass.replace(/[^a-zA-Z0-9]/g, "-");

  return [
    {
      logicalId: `${sanitized}SecurityGroup`,
      type: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      properties: {
        [CfnKey.GROUP_DESCRIPTION]: `Security group for RDS ${engine} (port ${port})`,
        SecurityGroupIngress: [
          {
            IpProtocol: "tcp",
            FromPort: port,
            ToPort: port,
            CidrIp: "10.0.0.0/8",
            Description: `${engine} access from private network`,
          },
        ],
        SecurityGroupEgress: [
          {
            IpProtocol: "-1",
            CidrIp: "0.0.0.0/0",
            Description: "Allow all outbound",
          },
        ],
      },
    },
  ];
}

export const configHints: ResourcePlugin["configHints"] = [
  "If the user did not provide a MasterUserPassword, OMIT it — AWS will auto-generate one via Secrets Manager",
  "If the user did not provide a DBName, OMIT it — no initial database will be created",
  "EngineVersion MUST be a valid version number for the selected Engine (e.g., '16' for postgres, '8.4' for mysql). NEVER use deprecated versions.",
  "PubliclyAccessible SHOULD be false for production. If a DBSubnetGroupName is provided, the instance is placed in that VPC subnet group.",
  "VPCSecurityGroups control network access — at least one security group allowing ingress on the database Port is required for connectivity.",
  "EnableCloudwatchLogsExports and PerformanceInsightsEnabled are strongly recommended for production observability. Available log types vary by engine.",
  "StorageEncrypted SHOULD always be true. Encryption at rest is an AWS security best practice with no significant performance impact.",
];
