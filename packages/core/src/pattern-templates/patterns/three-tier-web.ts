import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { ResourceDefault } from "../../config/cfn-keys.js";
import type { ArchitecturePattern } from "../types.js";

export const threeTierWebPattern: ArchitecturePattern = {
  patternId: "three-tier-web",
  displayName: "Three-Tier Web Application",
  keywords: [
    "three tier",
    "3 tier",
    "three-tier",
    "web application with database",
    "alb ec2 rds",
    "load balanced web app",
    "traditional web stack",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: "alb-sg",
      displayName: "ALB Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: "app-sg",
      displayName: "Application Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: "instance-profile-role",
      displayName: "EC2 Instance Profile Role",
    },
    {
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      resourceId: "alb",
      displayName: "Application Load Balancer",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      resourceId: "ec2-instance",
      displayName: "EC2 Application Instance",
    },
    {
      resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
      resourceId: "rds-instance",
      displayName: "RDS Database Instance",
    },
  ],
  dependencyOrder: [
    ["alb-sg", "app-sg", "instance-profile-role"],
    ["alb", "rds-instance"],
    ["ec2-instance"],
  ],
  defaultOptions: {
    "rds-instance": {
      Engine: ResourceDefault.RDS_ENGINE_POSTGRES,
      MultiAZ: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
    },
    "ec2-instance": { InstanceType: "t3.micro", HttpTokens: "required" },
    alb: { Type: "application", Scheme: "internet-facing" },
  },
};
