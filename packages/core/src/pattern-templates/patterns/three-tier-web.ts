import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { ResourceDefault, AwsDefault } from "../../config/cfn-keys.js";
import type { ArchitecturePattern } from "../types.js";
import { ThreeTierWebResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

export const threeTierWebPattern: ArchitecturePattern = {
  patternId: PatternId.THREE_TIER_WEB,
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
      resourceId: R.ALB_SG,
      displayName: "ALB Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: R.APP_SG,
      displayName: "Application Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: R.INSTANCE_PROFILE_ROLE,
      displayName: "EC2 Instance Profile Role",
    },
    {
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      resourceId: R.ALB,
      displayName: "Application Load Balancer",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_INSTANCE,
      resourceId: R.EC2_INSTANCE,
      displayName: "EC2 Application Instance",
    },
    {
      resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
      resourceId: R.RDS_INSTANCE,
      displayName: "RDS Database Instance",
    },
  ],
  dependencyOrder: [
    [R.ALB_SG, R.APP_SG, R.INSTANCE_PROFILE_ROLE],
    [R.ALB, R.RDS_INSTANCE],
    [R.EC2_INSTANCE],
  ],
  defaultOptions: {
    [R.RDS_INSTANCE]: {
      Engine: ResourceDefault.RDS_ENGINE_POSTGRES,
      MultiAZ: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
    },
    [R.EC2_INSTANCE]: {
      InstanceType: AwsDefault.INSTANCE_TYPE,
      HttpTokens: "required",
    },
    [R.ALB]: {
      Type: AwsDefault.LB_TYPE_APPLICATION,
      Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
    },
  },
};
