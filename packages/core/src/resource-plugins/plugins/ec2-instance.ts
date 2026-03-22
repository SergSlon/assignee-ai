import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

export const ec2InstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INSTANCE,
  commonFields: [
    {
      name: "InstanceType",
      question: {
        type: "enum",
        label: "Instance type",
        options: [
          // ── Burstable (t3) ──
          {
            value: "t3.micro",
            label: "t3.micro  (2 vCPU,  1 GiB) — ~$0.0104/hr",
            fitHint: "Dev/test, free tier eligible",
          },
          {
            value: "t3.small",
            label: "t3.small  (2 vCPU,  2 GiB) — ~$0.0208/hr",
            fitHint: "Light workloads",
            recommended: true,
          },
          {
            value: "t3.medium",
            label: "t3.medium (2 vCPU,  4 GiB) — ~$0.0416/hr",
            fitHint: "Small production",
          },
          {
            value: "t3.large",
            label: "t3.large  (2 vCPU,  8 GiB) — ~$0.0832/hr",
            fitHint: "Medium production",
          },
          {
            value: "t3.xlarge",
            label: "t3.xlarge (4 vCPU, 16 GiB) — ~$0.1664/hr",
            fitHint: "Large burstable",
          },
          // ── Burstable ARM (t4g) ──
          {
            value: "t4g.micro",
            label: "t4g.micro  (2 vCPU,  1 GiB) — ~$0.0084/hr",
            fitHint: "Dev/test, Graviton ARM",
          },
          {
            value: "t4g.small",
            label: "t4g.small  (2 vCPU,  2 GiB) — ~$0.0168/hr",
            fitHint: "Light workloads, 20% cheaper than t3",
          },
          {
            value: "t4g.medium",
            label: "t4g.medium (2 vCPU,  4 GiB) — ~$0.0336/hr",
            fitHint: "ARM-compatible production",
          },
          {
            value: "t4g.large",
            label: "t4g.large  (2 vCPU,  8 GiB) — ~$0.0672/hr",
            fitHint: "Medium ARM production",
          },
          {
            value: "t4g.xlarge",
            label: "t4g.xlarge (4 vCPU, 16 GiB) — ~$0.1344/hr",
            fitHint: "Large ARM burstable",
          },
          // ── General-purpose (m5) ──
          {
            value: "m5.large",
            label: "m5.large   (2 vCPU,  8 GiB) — ~$0.0960/hr",
            fitHint: "General-purpose production",
          },
          {
            value: "m5.xlarge",
            label: "m5.xlarge  (4 vCPU, 16 GiB) — ~$0.1920/hr",
            fitHint: "Compute-intensive",
          },
          {
            value: "m5.2xlarge",
            label: "m5.2xlarge (8 vCPU, 32 GiB) — ~$0.3840/hr",
            fitHint: "High-performance",
          },
          // ── General-purpose latest (m6i) ──
          {
            value: "m6i.large",
            label: "m6i.large   (2 vCPU,  8 GiB) — ~$0.0960/hr",
            fitHint: "Latest gen general-purpose",
          },
          {
            value: "m6i.xlarge",
            label: "m6i.xlarge  (4 vCPU, 16 GiB) — ~$0.1920/hr",
            fitHint: "Latest gen, higher throughput",
          },
          {
            value: "m6i.2xlarge",
            label: "m6i.2xlarge (8 vCPU, 32 GiB) — ~$0.3840/hr",
            fitHint: "Latest gen high-performance",
          },
          // ── Compute-optimized (c5) ──
          {
            value: "c5.large",
            label: "c5.large   (2 vCPU,  4 GiB) — ~$0.0850/hr",
            fitHint: "Compute-heavy, batch processing",
          },
          {
            value: "c5.xlarge",
            label: "c5.xlarge  (4 vCPU,  8 GiB) — ~$0.1700/hr",
            fitHint: "High-performance compute",
          },
          {
            value: "c5.2xlarge",
            label: "c5.2xlarge (8 vCPU, 16 GiB) — ~$0.3400/hr",
            fitHint: "Compute-intensive workloads",
          },
          // ── Compute-optimized latest (c6i) ──
          {
            value: "c6i.large",
            label: "c6i.large   (2 vCPU,  4 GiB) — ~$0.0850/hr",
            fitHint: "Latest gen compute",
          },
          {
            value: "c6i.xlarge",
            label: "c6i.xlarge  (4 vCPU,  8 GiB) — ~$0.1700/hr",
            fitHint: "Latest gen compute",
          },
          {
            value: "c6i.2xlarge",
            label: "c6i.2xlarge (8 vCPU, 16 GiB) — ~$0.3400/hr",
            fitHint: "Latest gen compute-heavy",
          },
          // ── Memory-optimized (r5) ──
          {
            value: "r5.large",
            label: "r5.large   (2 vCPU, 16 GiB) — ~$0.1260/hr",
            fitHint: "Memory-intensive, caches",
          },
          {
            value: "r5.xlarge",
            label: "r5.xlarge  (4 vCPU, 32 GiB) — ~$0.2520/hr",
            fitHint: "In-memory databases",
          },
          {
            value: "r5.2xlarge",
            label: "r5.2xlarge (8 vCPU, 64 GiB) — ~$0.5040/hr",
            fitHint: "Large in-memory workloads",
          },
          // ── Memory-optimized latest (r6i) ──
          {
            value: "r6i.large",
            label: "r6i.large   (2 vCPU, 16 GiB) — ~$0.1260/hr",
            fitHint: "Latest gen memory-optimized",
          },
          {
            value: "r6i.xlarge",
            label: "r6i.xlarge  (4 vCPU, 32 GiB) — ~$0.2520/hr",
            fitHint: "Latest gen in-memory",
          },
          {
            value: "r6i.2xlarge",
            label: "r6i.2xlarge (8 vCPU, 64 GiB) — ~$0.5040/hr",
            fitHint: "Latest gen memory-heavy",
          },
        ],
        initialValue: "t3.micro",
      },
    },
    {
      name: "ImageId",
      question: {
        type: "enum",
        label: "AMI",
        placeholder: "ami-0abcdef1234567890",
        options: [],
        fetcher: "discover-amis",
      },
    },
    {
      name: "KeyName",
      question: {
        type: "enum",
        label: "EC2 Key Pair",
        options: [],
        fetcher: "discover-key-pairs",
      },
    },
    {
      name: "SubnetId",
      question: {
        type: "enum",
        label: "Subnet",
        placeholder: "subnet-0abc1234",
        options: [],
        fetcher: "discover-subnets",
      },
    },
    {
      name: "SecurityGroupIds",
      question: {
        type: "multi",
        label: "Security Groups",
        options: [],
        fetcher: "discover-security-groups",
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        options: [],
      },
    },
  ],
  advancedFields: [
    {
      name: "IamInstanceProfile",
      question: {
        type: "string",
        label: "IAM Instance Profile name",
        placeholder: "my-instance-profile",
      },
    },
    {
      name: "UserData",
      question: {
        type: "string",
        label: "User data script (base64)",
        placeholder: "#!/bin/bash\\necho hello",
      },
    },
  ],
  defaults: {},
};
