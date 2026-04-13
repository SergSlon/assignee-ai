/**
 * Container Service (ECS Fargate) compound pattern.
 *
 * Embeds a public-only VPC (same topology as vpcPublicOnlyPattern) so the
 * ALB has multi-AZ subnets and the ECS security group is scoped to the
 * pattern's own VPC. Without the embedded VPC, CCAPI rejects the ALB
 * create for missing Subnets — the pattern was previously describe.skip'd
 * in E2E for this reason.
 *
 * Resources (15 total):
 *   VPC layer (9):
 *     1 VPC, 2 public subnets (multi-AZ), 1 IGW, 1 IGW attachment,
 *     1 public RouteTable, 1 public Route, 2 SubnetRouteTableAssociations
 *   Container layer (6):
 *     1 ALB SecurityGroup, 1 ECR Repository, 1 IAM Task Role,
 *     1 ECS SecurityGroup, 1 ECS Cluster, 1 ALB
 *
 * Cost note: $0 networking (IGW + routes are free). ECS Fargate bills
 * per-task vCPU/memory; ALB bills per-hour + LCU. ECR bills per-GB
 * stored. No NAT gateway.
 *
 * The VPC resource IDs intentionally mirror those in vpc-networking.ts
 * so the compound-provisioner and plan-generator's marker-resolution
 * logic treat the two patterns identically (same approach as efs-with-vpc).
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import { IamPolicy, AwsServicePrincipal } from "../../config/aws-arns.js";
import { markerRef, markerAz } from "../../config/marker-tokens.js";
import type { ArchitecturePattern } from "../types.js";
import { ContainerServiceResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

const EC2_VPC_GATEWAY_ATTACHMENT = RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT;
const EC2_SUBNET_ROUTE_TABLE_ASSOCIATION =
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION;

const VPC_CIDR = "10.0.0.0/16";

export const containerServicePattern: ArchitecturePattern = {
  patternId: PatternId.CONTAINER_SERVICE,
  displayName: "Container Service (ECS Fargate)",
  keywords: [
    "container service",
    "ecs fargate",
    "fargate service",
    "docker service",
    "containerized app",
    "ecs with load balancer",
  ],
  resourceList: [
    // ── VPC topology (public-only, mirrors vpcPublicOnlyPattern) ────
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
    // ── Container-service resources ─────────────────────────────────
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: R.ALB_SG,
      displayName: "ALB Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
      resourceId: R.ECR_REPO,
      displayName: "ECR Container Repository",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: R.TASK_ROLE,
      displayName: "ECS Task IAM Role",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: R.ECS_SG,
      displayName: "ECS Service Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.ECS_CLUSTER,
      resourceId: R.ECS_CLUSTER,
      displayName: "ECS Cluster",
    },
    {
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      resourceId: R.ALB,
      displayName: "Application Load Balancer",
    },
  ],
  dependencyOrder: [
    // Group 0: VPC first
    [R.VPC],
    // Group 1: Subnets + IGW + VPC-independent container resources
    [
      R.PUBLIC_SUBNET_1,
      R.PUBLIC_SUBNET_2,
      R.IGW,
      R.ECR_REPO,
      R.TASK_ROLE,
      R.ECS_CLUSTER,
    ],
    // Group 2: IGW attachment + route table + SGs (need VpcId)
    [R.IGW_ATTACHMENT, R.PUBLIC_ROUTE_TABLE, R.ALB_SG, R.ECS_SG],
    // Group 3: Public route (needs RT + IGW attachment)
    [R.PUBLIC_ROUTE],
    // Group 4: Subnet ↔ RT associations
    [R.PUBLIC_SUBNET_1_RT_ASSOC, R.PUBLIC_SUBNET_2_RT_ASSOC],
    // Group 5: ALB (needs subnets + ALB_SG)
    [R.ALB],
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
    [R.IGW]: {},
    [R.IGW_ATTACHMENT]: {
      VpcId: markerRef(R.VPC),
      InternetGatewayId: markerRef(R.IGW),
    },
    [R.PUBLIC_ROUTE_TABLE]: {
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
    // ── Container layer ─────────────────────────────────────────────
    [R.ALB_SG]: {
      [CfnKey.GROUP_DESCRIPTION]:
        "Public HTTP/HTTPS ingress for the container-service ALB",
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
    [R.ECR_REPO]: {
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: "IMMUTABLE",
    },
    [R.TASK_ROLE]: {
      Path: "/",
      AssumeRolePolicyDocument: {
        Version: IamPolicy.VERSION,
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Principal: { Service: AwsServicePrincipal.ECS_TASKS },
            Action: IamPolicy.ACTION_ASSUME_ROLE,
          },
        ],
      },
    },
    [R.ECS_SG]: {
      [CfnKey.GROUP_DESCRIPTION]:
        "ECS Fargate service traffic - container-service compound pattern",
      [CfnKey.VPC_ID]: markerRef(R.VPC),
      [CfnKey.SG_INGRESS]: [
        {
          IpProtocol: "tcp",
          FromPort: 80,
          ToPort: 80,
          CidrIp: VPC_CIDR,
          Description: "HTTP from VPC (ALB to ECS)",
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
    [R.ECS_CLUSTER]: {
      CapacityProviders: [
        AwsDefault.CAPACITY_FARGATE,
        AwsDefault.CAPACITY_FARGATE_SPOT,
      ],
      ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
    },
    [R.ALB]: {
      Type: AwsDefault.LB_TYPE_APPLICATION,
      Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
      Subnets: [markerRef(R.PUBLIC_SUBNET_1), markerRef(R.PUBLIC_SUBNET_2)],
      SecurityGroups: [markerRef(R.ALB_SG)],
    },
  },
};
