import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { AwsDefault } from "../../config/cfn-keys.js";
import type { ArchitecturePattern } from "../types.js";
import { ContainerServiceResourceId as R } from "../pattern-resource-ids.js";

export const containerServicePattern: ArchitecturePattern = {
  patternId: "container-service",
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
    [R.ECS_CLUSTER]: {
      CapacityProviders: [
        AwsDefault.CAPACITY_FARGATE,
        AwsDefault.CAPACITY_FARGATE_SPOT,
      ],
    },
    [R.ALB]: {
      Type: AwsDefault.LB_TYPE_APPLICATION,
      Scheme: AwsDefault.LB_SCHEME_INTERNET_FACING,
    },
  },
};
