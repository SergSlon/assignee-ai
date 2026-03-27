import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";

/**
 * ResourcePlugin for AWS::ECS::Cluster.
 * The cluster itself is free — costs come from tasks/services running on it.
 */
export const ecsClusterPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.ECS_CLUSTER,
  commonFields: [
    {
      name: "ClusterName",
      question: {
        type: "string",
        label: "Cluster name",
        placeholder: "my-cluster (leave blank for auto-generated)",
        hint: "Must be 1-255 chars: letters, numbers, hyphens, underscores. Leave blank for an auto-generated name.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.length > 255) return "Cluster name must be 1-255 characters";
          if (!/^[a-zA-Z0-9_-]+$/.test(s))
            return "Cluster name can only contain letters, numbers, hyphens, and underscores";
          return undefined;
        },
      },
    },
    {
      name: "ContainerInsights",
      question: {
        type: "boolean",
        label: "Enable Container Insights?",
        initialValue: true,
        hint: "Collects per-task metrics (CPU, memory, network). Adds minor CloudWatch costs per metric. Recommended for production observability.",
      },
      toCfn: (answer: unknown) =>
        answer
          ? [{ Name: "containerInsights", Value: "enabled" }]
          : [{ Name: "containerInsights", Value: "disabled" }],
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: "CapacityProviders",
      question: {
        type: "multi",
        label: "Capacity providers",
        options: [
          {
            value: "FARGATE",
            label: "Fargate (serverless)",
            recommended: true,
            fitHint: "No EC2 instances to manage",
          },
          {
            value: "FARGATE_SPOT",
            label: "Fargate Spot (~70% cheaper, may be interrupted)",
            costHint: "~70% savings vs on-demand Fargate",
            fitHint: "Best for fault-tolerant workloads",
          },
        ],
        hint: "Fargate runs tasks serverlessly. Fargate Spot offers savings for interruption-tolerant workloads. You can use both.",
      },
    },
    {
      name: "DefaultCapacityProviderStrategy",
      question: {
        type: "enum",
        label: "Default capacity provider strategy",
        options: [
          {
            value: "fargate-only",
            label: "Fargate only (reliable)",
            recommended: true,
          },
          {
            value: "spot-primary",
            label: "Spot primary, Fargate fallback (cost-optimised)",
          },
        ],
        initialValue: "fargate-only",
        hint: "Determines how tasks are placed when no launch type is specified. Spot-primary falls back to Fargate when Spot is unavailable.",
      },
      toCfn: (answer: unknown) => {
        if (answer === "spot-primary") {
          return [
            { CapacityProvider: "FARGATE_SPOT", Weight: 2, Base: 0 },
            { CapacityProvider: "FARGATE", Weight: 1, Base: 1 },
          ];
        }
        return [{ CapacityProvider: "FARGATE", Weight: 1, Base: 0 }];
      },
    },
  ],
  defaults: {
    ClusterSettings: [{ Name: "containerInsights", Value: "enabled" }],
    CapacityProviders: ["FARGATE"],
  },
  companionResources(desiredState: Record<string, unknown>): CfnOutput[] {
    const clusterName = desiredState["ClusterName"];
    if (typeof clusterName !== "string" || !clusterName) return [];

    const retention =
      typeof desiredState["LogRetentionInDays"] === "number"
        ? desiredState["LogRetentionInDays"]
        : 14;

    const sanitized = clusterName.replace(/[^a-zA-Z0-9]/g, "");
    return [
      {
        logicalId: `${sanitized}LogGroup`,
        type: "AWS::Logs::LogGroup",
        properties: {
          LogGroupName: `/ecs/${clusterName}`,
          RetentionInDays: retention,
        },
      },
    ];
  },
};
