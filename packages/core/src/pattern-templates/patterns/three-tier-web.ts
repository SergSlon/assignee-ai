/**
 * Three-Tier Web Application compound pattern.
 *
 * Embeds a full VPC (public + private subnets, no NAT gateway) so the
 * ALB gets multi-AZ public subnets, EC2 goes in public subnets (with
 * internet access for updates), and RDS goes in private subnets via a
 * DBSubnetGroup. No NAT because RDS doesn't need internet access and
 * the EC2 instance uses public subnets.
 *
 * Resources (22 total):
 *   VPC layer (14):
 *     1 VPC, 2 public subnets, 2 private subnets (multi-AZ),
 *     1 IGW, 1 IGW attachment, 2 route tables (public + private),
 *     1 public Route, 4 SubnetRouteTableAssociations
 *   Application layer (8):
 *     3 SecurityGroups (ALB + App + DB), 1 IAM Instance Profile Role,
 *     1 RDS DBSubnetGroup, 1 ALB, 1 EC2 Instance, 1 RDS DBInstance
 *
 * Cost note: $0 networking (IGW and routes are free, no NAT gateway).
 * ALB bills per-hour + LCU. EC2 bills per instance-hour. RDS bills per
 * instance-hour + storage. All three have free-tier eligible options.
 *
 * @see container-service.ts for the public-only VPC variant.
 * @see efs-with-vpc.ts for the private-only VPC variant.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  AmiOs,
} from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import { IamPolicy, AwsServicePrincipal } from "../../config/aws-arns.js";
import { markerRef, markerAz } from "../../config/marker-tokens.js";
import type { ArchitecturePattern } from "../types.js";
import { ThreeTierWebResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

const EC2_VPC_GATEWAY_ATTACHMENT = RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT;
const EC2_SUBNET_ROUTE_TABLE_ASSOCIATION =
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION;

const VPC_CIDR = "10.0.0.0/16";

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
    // ── VPC topology (public + private, no NAT) ─────────────────────
    {
      resourceType: RESOURCE_TYPES.EC2_VPC,
      resourceId: R.VPC,
      displayName: "VPC",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PUBLIC_SUBNET_1,
      displayName: "Public Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PUBLIC_SUBNET_2,
      displayName: "Public Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PRIVATE_SUBNET_1,
      displayName: "Private Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PRIVATE_SUBNET_2,
      displayName: "Private Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
      resourceId: R.IGW,
      displayName: "Internet Gateway",
    },
    {
      resourceType: EC2_VPC_GATEWAY_ATTACHMENT,
      resourceId: R.IGW_ATTACHMENT,
      displayName: "VPC Gateway Attachment (IGW)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: R.PUBLIC_ROUTE_TABLE,
      displayName: "Public Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: R.PRIVATE_ROUTE_TABLE,
      displayName: "Private Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE,
      resourceId: R.PUBLIC_ROUTE,
      displayName: "Public Route (0.0.0.0/0 → IGW)",
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PUBLIC_SUBNET_1_RT_ASSOC,
      displayName: "Public Subnet 1 ↔ Public RT",
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PUBLIC_SUBNET_2_RT_ASSOC,
      displayName: "Public Subnet 2 ↔ Public RT",
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PRIVATE_SUBNET_1_RT_ASSOC,
      displayName: "Private Subnet 1 ↔ Private RT",
    },
    {
      resourceType: EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PRIVATE_SUBNET_2_RT_ASSOC,
      displayName: "Private Subnet 2 ↔ Private RT",
    },
    // ── Application layer ───────────────────────────────────────────
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
      resourceType: RESOURCE_TYPES.RDS_DB_SUBNET_GROUP,
      resourceId: R.DB_SUBNET_GROUP,
      displayName: "RDS DB Subnet Group",
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
    // Group 0: VPC first
    [R.VPC],
    // Group 1: Subnets + IGW + VPC-independent resources (role)
    [
      R.PUBLIC_SUBNET_1,
      R.PUBLIC_SUBNET_2,
      R.PRIVATE_SUBNET_1,
      R.PRIVATE_SUBNET_2,
      R.IGW,
      R.INSTANCE_PROFILE_ROLE,
    ],
    // Group 2: IGW attachment + route tables + SGs + DB subnet group
    [
      R.IGW_ATTACHMENT,
      R.PUBLIC_ROUTE_TABLE,
      R.PRIVATE_ROUTE_TABLE,
      R.ALB_SG,
      R.APP_SG,
      R.DB_SG,
      R.DB_SUBNET_GROUP,
    ],
    // Group 3: Public route (needs RT + IGW attachment)
    [R.PUBLIC_ROUTE],
    // Group 4: Subnet ↔ RT associations
    [
      R.PUBLIC_SUBNET_1_RT_ASSOC,
      R.PUBLIC_SUBNET_2_RT_ASSOC,
      R.PRIVATE_SUBNET_1_RT_ASSOC,
      R.PRIVATE_SUBNET_2_RT_ASSOC,
    ],
    // Group 5: Compute + DB (need subnets + SGs + DBSubnetGroup)
    [R.ALB, R.EC2_INSTANCE, R.RDS_INSTANCE],
  ],
  defaultOptions: {
    // ── VPC layer ───────────────────────────────────────────────────
    [R.VPC]: {
      CidrBlock: VPC_CIDR,
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    [R.PUBLIC_SUBNET_1]: {
      CidrBlock: "10.0.1.0/24",
      AvailabilityZone: markerAz(0),
      MapPublicIpOnLaunch: true,
      VpcId: markerRef(R.VPC),
    },
    [R.PUBLIC_SUBNET_2]: {
      CidrBlock: "10.0.2.0/24",
      AvailabilityZone: markerAz(1),
      MapPublicIpOnLaunch: true,
      VpcId: markerRef(R.VPC),
    },
    [R.PRIVATE_SUBNET_1]: {
      CidrBlock: "10.0.3.0/24",
      AvailabilityZone: markerAz(0),
      MapPublicIpOnLaunch: false,
      VpcId: markerRef(R.VPC),
    },
    [R.PRIVATE_SUBNET_2]: {
      CidrBlock: "10.0.4.0/24",
      AvailabilityZone: markerAz(1),
      MapPublicIpOnLaunch: false,
      VpcId: markerRef(R.VPC),
    },
    [R.IGW]: {},
    [R.IGW_ATTACHMENT]: {
      VpcId: markerRef(R.VPC),
      InternetGatewayId: markerRef(R.IGW),
    },
    [R.PUBLIC_ROUTE_TABLE]: {
      VpcId: markerRef(R.VPC),
    },
    [R.PRIVATE_ROUTE_TABLE]: {
      VpcId: markerRef(R.VPC),
    },
    [R.PUBLIC_ROUTE]: {
      RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
      DestinationCidrBlock: "0.0.0.0/0",
      GatewayId: markerRef(R.IGW),
    },
    [R.PUBLIC_SUBNET_1_RT_ASSOC]: {
      SubnetId: markerRef(R.PUBLIC_SUBNET_1),
      RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
    },
    [R.PUBLIC_SUBNET_2_RT_ASSOC]: {
      SubnetId: markerRef(R.PUBLIC_SUBNET_2),
      RouteTableId: markerRef(R.PUBLIC_ROUTE_TABLE),
    },
    [R.PRIVATE_SUBNET_1_RT_ASSOC]: {
      SubnetId: markerRef(R.PRIVATE_SUBNET_1),
      RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
    },
    [R.PRIVATE_SUBNET_2_RT_ASSOC]: {
      SubnetId: markerRef(R.PRIVATE_SUBNET_2),
      RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
    },
    // ── Application layer ───────────────────────────────────────────
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
      [CfnKey.GROUP_DESCRIPTION]:
        "Application tier - HTTP from VPC (ALB to EC2)",
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
    [R.DB_SUBNET_GROUP]: {
      [CfnKey.DB_SUBNET_GROUP_DESCRIPTION]:
        "Private subnets for three-tier-web RDS instance",
      SubnetIds: [markerRef(R.PRIVATE_SUBNET_1), markerRef(R.PRIVATE_SUBNET_2)],
    },
    [R.ALB]: {
      Type: AwsDefault.LB_TYPE_APPLICATION,
      Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
      Subnets: [markerRef(R.PUBLIC_SUBNET_1), markerRef(R.PUBLIC_SUBNET_2)],
      SecurityGroups: [markerRef(R.ALB_SG)],
    },
    [R.EC2_INSTANCE]: {
      InstanceType: AwsDefault.INSTANCE_TYPE,
      HttpTokens: "required",
      // OS name — plan-generator resolves to a real AMI ID via SSM
      ImageId: AmiOs.AMAZON_LINUX_2023,
      SubnetId: markerRef(R.PUBLIC_SUBNET_1),
      SecurityGroupIds: [markerRef(R.APP_SG)],
    },
    [R.RDS_INSTANCE]: {
      Engine: ResourceDefault.RDS_ENGINE_POSTGRES,
      MultiAZ: false,
      StorageEncrypted: true,
      BackupRetentionPeriod: 7,
      [CfnKey.DB_SUBNET_GROUP_NAME]: markerRef(R.DB_SUBNET_GROUP),
      [CfnKey.VPC_SECURITY_GROUP_IDS]: [markerRef(R.DB_SG)],
    },
  },
};
