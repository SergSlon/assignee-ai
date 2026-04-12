import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import { IamEffect } from "../../config/iam-effects.js";
import { IamPolicy, AwsServicePrincipal } from "../../config/aws-arns.js";
import type { ArchitecturePattern } from "../types.js";
import { ContainerServiceResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

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
    [R.ECR_REPO, R.TASK_ROLE, R.ECS_SG],
    [R.ECS_CLUSTER, R.ALB],
  ],
  defaultOptions: {
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
        "ECS Fargate service traffic — container-service compound pattern",
    },
    [R.ECS_CLUSTER]: {
      CapacityProviders: [
        AwsDefault.CAPACITY_FARGATE,
        AwsDefault.CAPACITY_FARGATE_SPOT,
      ],
    },
    [R.ALB]: {
      Type: AwsDefault.LB_TYPE_APPLICATION,
      Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
      // NOTE: ALB requires Subnets spanning 2+ AZs but this pattern
      // has no VPC resource. A full container-service pattern needs
      // VPC + public subnets (same redesign as three-tier-web). Until
      // then, this pattern is incomplete for apply — the E2E test is
      // describe.skip'd. Plan-only display works.
    },
  },
};
