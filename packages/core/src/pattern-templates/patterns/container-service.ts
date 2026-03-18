import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ArchitecturePattern } from "../types.js";

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
      resourceId: "ecr-repo",
      displayName: "ECR Container Repository",
    },
    {
      resourceType: RESOURCE_TYPES.IAM_ROLE,
      resourceId: "task-role",
      displayName: "ECS Task IAM Role",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: "ecs-sg",
      displayName: "ECS Service Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.ECS_CLUSTER,
      resourceId: "ecs-cluster",
      displayName: "ECS Cluster",
    },
    {
      resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
      resourceId: "alb",
      displayName: "Application Load Balancer",
    },
  ],
  dependencyOrder: [
    ["ecr-repo", "task-role", "ecs-sg"],
    ["ecs-cluster", "alb"],
  ],
  defaultOptions: {
    "ecs-cluster": { CapacityProviders: ["FARGATE", "FARGATE_SPOT"] },
    alb: { Type: "application", Scheme: "internet-facing" },
  },
};
