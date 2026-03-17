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
      resourceType: "AWS::ECR::Repository",
      resourceId: "ecr-repo",
      displayName: "ECR Container Repository",
    },
    {
      resourceType: "AWS::IAM::Role",
      resourceId: "task-role",
      displayName: "ECS Task IAM Role",
    },
    {
      resourceType: "AWS::EC2::SecurityGroup",
      resourceId: "ecs-sg",
      displayName: "ECS Service Security Group",
    },
    {
      resourceType: "AWS::ECS::Cluster",
      resourceId: "ecs-cluster",
      displayName: "ECS Cluster",
    },
    {
      resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
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
