/** EC2 instance intent rules. */

import { CfnKey, ResourceDefault } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import { WorkloadProfileKey as WP } from "../../config/cfn-keys.js";
import type { IntentRule } from "./types.js";

export const EC2_RULES: IntentRule[] = [
  // EC2 — Web server
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["web server", "web app", "web service", "api server"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
  // EC2 — ML/Compute
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["machine learning", "ml training", "ml model", "deep learning"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "c5.xlarge",
        reason: "Selected for ML/compute — 4 vCPU, 8 GiB, compute-optimized",
        categoryHint: WP.COMPUTE,
      },
    ],
  },
  // EC2 — SSH access (intent bundle: key pair + public IP + SG with port 22)
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["ssh"],
    overrides: [
      {
        fieldName: CfnKey.KEY_NAME,
        value: ResourceDefault.SSH_KEY_PLACEHOLDER,
        reason: "SSH bundle: key pair will be auto-created during provisioning",
        autoProvision: true,
      },
      {
        fieldName: CfnKey.ASSOCIATE_PUBLIC_IP,
        value: true,
        reason: "SSH bundle: public IP enabled for SSH reachability",
      },
      {
        fieldName: CfnKey.SECURITY_GROUP_IDS,
        value: [],
        reason:
          "SSH bundle: a security group with inbound port 22 will be auto-created by the companion resource system",
        autoProvision: true,
      },
      {
        fieldName: CfnKey.SUBNET_ID,
        value: ResourceDefault.SUBNET_PLACEHOLDER,
        reason:
          "SSH bundle: subnet will be resolved to the default VPC's first subnet at provisioning time",
        autoProvision: true,
      },
    ],
  },
  // EC2 — Database/Cache
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["database", "db server", "cache", "redis", "memcached"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "r5.large",
        reason: "Selected for data workloads — 16 GiB memory-optimized",
        categoryHint: WP.MEMORY,
      },
    ],
  },
  // EC2 — Batch/compute-heavy
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["batch processing", "data processing", "etl"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "c5.xlarge",
        reason: "Selected for batch/ETL — compute-optimized with 4 vCPU",
        categoryHint: WP.COMPUTE,
      },
    ],
  },
  // EC2 — Dev/test
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["dev", "test", "development", "testing", "sandbox"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.micro",
        reason: "Selected for dev/test — burstable, free tier eligible",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
  // EC2 — Docker/container host
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["docker", "container host", "containers"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.medium",
        reason:
          "Selected for container hosting — 4 GiB for Docker daemon + containers",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
];
