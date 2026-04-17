/**
 * Intent rules for compute/container and networking services:
 * IAM Roles (Lambda/EC2 trust policies), ECS Cluster, ECR Repository,
 * ELBv2 Load Balancer, API Gateway V2 API.
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import type { IntentRule } from "./types.js";

export const COMPUTE_NETWORK_RULES: IntentRule[] = [
  // IAM Role — Lambda execution
  {
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    keywords: [
      "lambda execution role",
      "lambda role",
      "function execution role",
    ],
    overrides: [
      {
        fieldName: CfnKey.ASSUME_ROLE_POLICY,
        value: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        reason:
          "Lambda execution role — allows Lambda service to assume this role",
      },
    ],
  },
  // IAM Role — EC2 instance profile
  {
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    keywords: ["ec2", "instance profile", "instance role"],
    overrides: [
      {
        fieldName: CfnKey.ASSUME_ROLE_POLICY,
        value: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        reason: "EC2 instance role — allows EC2 service to assume this role",
      },
    ],
  },
  // ECS Cluster — Fargate
  // Targets the user-facing ContainerInsights boolean field; the plugin's
  // toCfn transform emits the ClusterSettings array shape at plan time.
  {
    resourceType: RESOURCE_TYPES.ECS_CLUSTER,
    keywords: ["fargate", "serverless"],
    overrides: [
      {
        fieldName: CfnKey.CONTAINER_INSIGHTS,
        value: true,
        reason: "Container Insights enabled for Fargate observability",
      },
    ],
  },
  // ECR Repository — Docker/container images
  {
    resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
    keywords: ["docker", "container", "image"],
    overrides: [
      {
        fieldName: CfnKey.IMAGE_TAG_MUTABILITY,
        value: "IMMUTABLE",
        reason:
          "Immutable tags prevent overwriting — safer for production deployments",
      },
      {
        fieldName: CfnKey.SCAN_ON_PUSH,
        value: true,
        reason:
          "Scan on push enabled — detect vulnerabilities in container images",
      },
    ],
  },
  // ELBv2 — Application Load Balancer
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    keywords: ["web", "http", "https", "api gateway", "application"],
    overrides: [
      {
        fieldName: CfnKey.TYPE,
        value: "application",
        reason:
          "Application Load Balancer for HTTP/HTTPS traffic with path-based routing",
      },
    ],
  },
  // ELBv2 — Network Load Balancer
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    keywords: ["tcp", "udp", "network", "high performance", "low latency"],
    overrides: [
      {
        fieldName: CfnKey.TYPE,
        value: "network",
        reason: "Network Load Balancer for TCP/UDP with ultra-low latency",
      },
    ],
  },
  // API Gateway V2 — HTTP API
  {
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
    keywords: ["http api", "rest api", "api endpoint"],
    overrides: [
      {
        fieldName: CfnKey.PROTOCOL_TYPE,
        value: "HTTP",
        reason: "HTTP API selected — lower cost and latency than REST API",
      },
    ],
  },
  // API Gateway V2 — WebSocket
  {
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
    keywords: ["websocket", "real-time", "chat", "streaming"],
    overrides: [
      {
        fieldName: CfnKey.PROTOCOL_TYPE,
        value: "WEBSOCKET",
        reason: "WebSocket API for real-time bidirectional communication",
      },
    ],
  },
];
