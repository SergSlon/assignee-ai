/**
 * Application layer for the three-tier-web pattern.
 *
 * Split from three-tier-web.ts (W6d F3). Three tier-specific security
 * groups, the EC2 instance profile role, and the EC2 instance itself.
 */

import { RESOURCE_TYPES } from "../../../config/resource-types.js";
import { CfnKey, AwsDefault, AmiOs } from "../../../config/cfn-keys.js";
import { IamEffect } from "../../../config/iam-effects.js";
import { IamPolicy, AwsServicePrincipal } from "../../../config/aws-arns.js";
import { markerRef } from "../../../config/marker-tokens.js";
import type { ResourceSpec } from "../../types.js";
import { ThreeTierWebResourceId as R } from "../../pattern-resource-ids.js";
import { VPC_CIDR } from "./vpc-layer.js";

export const appLayerResources: ResourceSpec[] = [
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
    resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
    resourceId: R.DB_SG,
    displayName: "Database Security Group",
  },
  {
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    resourceId: R.INSTANCE_PROFILE_ROLE,
    displayName: "EC2 Instance Profile Role",
  },
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    resourceId: R.EC2_INSTANCE,
    displayName: "EC2 Application Instance",
  },
];

export const appLayerDefaults = {
  [R.ALB_SG]: {
    [CfnKey.GROUP_DESCRIPTION]:
      "Public HTTP/HTTPS ingress for the three-tier-web ALB",
    [CfnKey.VPC_ID]: markerRef(R.VPC),
    [CfnKey.SG_INGRESS]: [
      {
        IpProtocol: "tcp",
        FromPort: 80,
        ToPort: 80,
        CidrIp: "0.0.0.0/0",
        Description: "HTTP from anywhere",
      },
      {
        IpProtocol: "tcp",
        FromPort: 443,
        ToPort: 443,
        CidrIp: "0.0.0.0/0",
        Description: "HTTPS from anywhere",
      },
    ],
    [CfnKey.SG_EGRESS]: [
      {
        IpProtocol: "-1",
        CidrIp: "0.0.0.0/0",
        Description: "Allow all outbound",
      },
    ],
  },
  [R.APP_SG]: {
    [CfnKey.GROUP_DESCRIPTION]: "Application tier - HTTP from VPC (ALB to EC2)",
    [CfnKey.VPC_ID]: markerRef(R.VPC),
    [CfnKey.SG_INGRESS]: [
      {
        IpProtocol: "tcp",
        FromPort: 80,
        ToPort: 80,
        CidrIp: VPC_CIDR,
        Description: "HTTP from ALB (via VPC CIDR)",
      },
      {
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        CidrIp: VPC_CIDR,
        Description: "SSH from within VPC",
      },
    ],
    [CfnKey.SG_EGRESS]: [
      {
        IpProtocol: "-1",
        CidrIp: "0.0.0.0/0",
        Description: "Allow all outbound",
      },
    ],
  },
  [R.DB_SG]: {
    [CfnKey.GROUP_DESCRIPTION]:
      "Database tier - PostgreSQL from application tier",
    [CfnKey.VPC_ID]: markerRef(R.VPC),
    [CfnKey.SG_INGRESS]: [
      {
        IpProtocol: "tcp",
        FromPort: 5432,
        ToPort: 5432,
        CidrIp: VPC_CIDR,
        Description: "PostgreSQL from application tier (via VPC CIDR)",
      },
    ],
    [CfnKey.SG_EGRESS]: [
      {
        IpProtocol: "-1",
        CidrIp: "0.0.0.0/0",
        Description: "Allow all outbound",
      },
    ],
  },
  [R.INSTANCE_PROFILE_ROLE]: {
    Path: "/",
    AssumeRolePolicyDocument: {
      Version: IamPolicy.VERSION,
      Statement: [
        {
          Effect: IamEffect.ALLOW,
          Principal: { Service: AwsServicePrincipal.EC2 },
          Action: IamPolicy.ACTION_ASSUME_ROLE,
        },
      ],
    },
  },
  [R.EC2_INSTANCE]: {
    InstanceType: AwsDefault.INSTANCE_TYPE,
    // CCAPI nests HttpTokens inside MetadataOptions (not top-level).
    // Top-level HttpTokens fails with "extraneous key not permitted".
    MetadataOptions: {
      HttpTokens: "required",
      HttpEndpoint: "enabled",
    },
    // OS name — plan-generator resolves to a real AMI ID via SSM
    ImageId: AmiOs.AMAZON_LINUX_2023,
    SubnetId: markerRef(R.PUBLIC_SUBNET_1),
    SecurityGroupIds: [markerRef(R.APP_SG)],
  },
} as const;
