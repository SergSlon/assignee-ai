/**
 * IAM actions for networking / VPC resource types:
 * VPC, Subnet, SecurityGroup, ELBv2, InternetGateway, RouteTable, Route,
 * NatGateway, ApiGatewayV2 API.
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const NETWORK_ACTIONS: Record<string, string[]> = {
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: [
    "ec2:CreateSecurityGroup",
    "ec2:DeleteSecurityGroup",
    "ec2:AuthorizeSecurityGroupIngress",
    "ec2:AuthorizeSecurityGroupEgress",
    "ec2:RevokeSecurityGroupIngress",
    "ec2:RevokeSecurityGroupEgress",
    "ec2:UpdateSecurityGroupRuleDescriptionsIngress",
    "ec2:CreateTags",
    "ec2:DescribeSecurityGroups",
    "ec2:DescribeVpcs",
  ],
  [RESOURCE_TYPES.EC2_VPC]: [
    "ec2:CreateVpc",
    "ec2:DeleteVpc",
    "ec2:ModifyVpcAttribute",
    "ec2:DescribeVpcs",
    "ec2:CreateTags",
  ],
  [RESOURCE_TYPES.EC2_SUBNET]: [
    "ec2:CreateSubnet",
    "ec2:DeleteSubnet",
    "ec2:DescribeSubnets",
    "ec2:ModifySubnetAttribute",
    "ec2:CreateTags",
    "ec2:DescribeAvailabilityZones",
  ],
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: [
    "elasticloadbalancing:CreateLoadBalancer",
    "elasticloadbalancing:DeleteLoadBalancer",
    "elasticloadbalancing:DescribeLoadBalancers",
    "elasticloadbalancing:ModifyLoadBalancerAttributes",
    "elasticloadbalancing:AddTags",
    "ec2:DescribeSubnets",
    "ec2:DescribeSecurityGroups",
  ],
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: [
    "ec2:CreateInternetGateway",
    "ec2:DeleteInternetGateway",
    "ec2:DescribeInternetGateways",
    "ec2:AttachInternetGateway",
    "ec2:DetachInternetGateway",
    "ec2:CreateTags",
  ],
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: [
    "ec2:CreateRouteTable",
    "ec2:DeleteRouteTable",
    "ec2:DescribeRouteTables",
    "ec2:AssociateRouteTable",
    "ec2:DisassociateRouteTable",
    "ec2:CreateTags",
  ],
  [RESOURCE_TYPES.EC2_ROUTE]: [
    "ec2:CreateRoute",
    "ec2:DeleteRoute",
    "ec2:ReplaceRoute",
    "ec2:DescribeRouteTables",
  ],
  [RESOURCE_TYPES.EC2_NAT_GATEWAY]: [
    "ec2:CreateNatGateway",
    "ec2:DeleteNatGateway",
    "ec2:DescribeNatGateways",
    "ec2:CreateTags",
    "ec2:AllocateAddress",
    "ec2:ReleaseAddress",
    // Wave 19 Bug #5: EIP-reuse pre-hook calls DescribeAddresses before
    // allocating a new EIP.
    "ec2:DescribeAddresses",
  ],
  [RESOURCE_TYPES.APIGATEWAYV2_API]: [
    "apigateway:CreateApi",
    "apigateway:DeleteApi",
    "apigateway:GetApi",
    "apigateway:UpdateApi",
    "apigateway:CreateRoute",
    "apigateway:CreateIntegration",
    "apigateway:CreateStage",
    "apigateway:CreateDeployment",
    "apigateway:TagResource",
  ],
};
