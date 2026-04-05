import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::ECS::Cluster.
 * The cluster itself is free — costs come from tasks/services running on it.
 */
export const ecsClusterPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.ECS_CLUSTER,
  commonFields: [
    {
      name: CfnKey.CLUSTER_NAME,
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
      name: CfnKey.CONTAINER_INSIGHTS,
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
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:backend",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
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
      name: CfnKey.CAPACITY_PROVIDERS,
      question: {
        type: "multi",
        label: "Capacity providers",
        options: [
          {
            value: AwsDefault.CAPACITY_FARGATE,
            label: "Fargate (serverless)",
            recommended: true,
            fitHint: "No EC2 instances to manage",
          },
          {
            value: AwsDefault.CAPACITY_FARGATE_SPOT,
            label: "Fargate Spot (~70% cheaper, may be interrupted)",
            costHint: "~70% savings vs on-demand Fargate",
            fitHint: "Best for fault-tolerant workloads",
          },
        ],
        hint: "Fargate runs tasks serverlessly. Fargate Spot offers savings for interruption-tolerant workloads. You can use both.",
      },
    },
    {
      name: CfnKey.DEFAULT_CAPACITY_STRATEGY,
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
            {
              CapacityProvider: AwsDefault.CAPACITY_FARGATE_SPOT,
              Weight: 2,
              Base: 0,
            },
            {
              CapacityProvider: AwsDefault.CAPACITY_FARGATE,
              Weight: 1,
              Base: 1,
            },
          ];
        }
        return [
          { CapacityProvider: AwsDefault.CAPACITY_FARGATE, Weight: 1, Base: 0 },
        ];
      },
    },
  ],
  defaults: {
    [CfnKey.CLUSTER_SETTINGS]: [
      { Name: "containerInsights", Value: "enabled" },
    ],
    [CfnKey.CAPACITY_PROVIDERS]: [AwsDefault.CAPACITY_FARGATE],
  },
  configHints: [
    "ClusterSettings should include containerInsights set to 'enabled' for production observability — it collects per-task CPU, memory, and network metrics.",
    "CapacityProviders should default to ['FARGATE'] for serverless operation. Add 'FARGATE_SPOT' only if the user accepts interruption-tolerant workloads for ~70% cost savings.",
    "DefaultCapacityProviderStrategy defines how tasks are placed when no launch type is specified. Use Base:1 on FARGATE to guarantee at least one on-demand task.",
    "ClusterName is optional — if omitted, CloudFormation auto-generates a unique name. If provided, it is immutable (changes trigger replacement).",
    "The ECS Cluster itself is free — all costs come from the tasks/services running inside it (Fargate vCPU/memory or EC2 instances).",
  ],
  companionResources(desiredState: Record<string, unknown>): CfnOutput[] {
    const clusterName = desiredState[CfnKey.CLUSTER_NAME];
    if (typeof clusterName !== "string" || !clusterName) return [];

    const retention =
      typeof desiredState[CfnKey.LOG_RETENTION_IN_DAYS] === "number"
        ? desiredState[CfnKey.LOG_RETENTION_IN_DAYS]
        : 14;

    const sanitized = clusterName.replace(/[^a-zA-Z0-9]/g, "");
    return [
      {
        logicalId: `${sanitized}LogGroup`,
        type: RESOURCE_TYPES.LOGS_LOG_GROUP,
        properties: {
          [CfnKey.LOG_GROUP_NAME]: `/ecs/${clusterName}`,
          [CfnKey.RETENTION_IN_DAYS]: retention,
        },
      },
    ];
  },
};
