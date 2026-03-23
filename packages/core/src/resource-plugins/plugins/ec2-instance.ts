import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * Instance type category groupings for two-step selection UX.
 * Each category maps a family key to its display metadata and member instance types.
 * @see Story 18.12
 */
export const INSTANCE_CATEGORIES = [
  {
    key: "burstable",
    label: "Burstable (t3/t4g) — $0.008-0.17/hr",
    description:
      "Variable CPU with burst credits. Best for dev/test and intermittent workloads. t4g (ARM) is ~20% cheaper.",
    options: [
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
    ],
  },
  {
    key: "general",
    label: "General Purpose (m5/m6i) — $0.096-0.38/hr",
    description:
      "Balanced CPU/memory ratio. Best for production app servers and mid-size databases.",
    options: [
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
    ],
  },
  {
    key: "compute",
    label: "Compute Optimized (c5/c6i) — $0.085-0.34/hr",
    description:
      "High-performance CPUs. Best for batch processing, ML inference, and compute-heavy workloads.",
    options: [
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
    ],
  },
  {
    key: "memory",
    label: "Memory Optimized (r5/r6i) — $0.126-0.50/hr",
    description:
      "High memory-to-CPU ratio. Best for in-memory databases, caches, and real-time analytics.",
    options: [
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
  },
] as const;

export const ec2InstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EC2_INSTANCE,
  commonFields: [
    {
      name: "InstanceType",
      question: {
        type: "categorySelect",
        label: "Instance type",
        hint: "t3/t4g: burstable (dev/small prod). m5/m6i: general-purpose. c5/c6i: compute. r5/r6i: memory. t4g (ARM) is ~20% cheaper than t3.",
        categories: INSTANCE_CATEGORIES,
        initialValue: "t3.micro",
      },
    },
    {
      name: "ImageId",
      required: true,
      question: {
        type: "enum",
        label: "AMI",
        hint: "The Amazon Machine Image determines the OS and software. Common choices: Amazon Linux 2023 (free tier), Ubuntu 22.04/24.04, Windows Server 2022.",
        placeholder: "ami-0abcdef1234567890",
        options: [],
        fetcher: "discover-amis",
        validate: (value: unknown) => {
          if (!value || String(value).trim() === "")
            return "AMI ID is required to launch an EC2 instance. Use 'ami-' followed by the ID (e.g., ami-0c55b159cbfafe1f0).";
          const s = String(value).trim();
          if (!s.startsWith("ami-"))
            return "Must be a valid AMI ID starting with 'ami-'";
          return undefined;
        },
      },
    },
    {
      name: "KeyName",
      question: {
        type: "enum",
        label: "EC2 Key Pair",
        hint: "Required for SSH access. Leave blank to use SSM Session Manager instead (no key needed, more secure).",
        options: [],
        fetcher: "discover-key-pairs",
      },
    },
    {
      name: "SubnetId",
      question: {
        type: "enum",
        label: "Subnet",
        hint: "Determines which VPC and availability zone the instance launches in. Public subnets get internet access; private subnets are isolated.",
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
        hint: "Firewall rules controlling inbound/outbound traffic. Select existing groups or leave blank to use the VPC default.",
        options: [],
        fetcher: "discover-security-groups",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization. Example: Environment:production, Team:backend, Project:api. Tags are free and highly recommended.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
      },
    },
  ],
  advancedFields: [
    {
      name: "IamInstanceProfile",
      question: {
        type: "string",
        label: "IAM Instance Profile name",
        hint: "Grants the instance permissions to call AWS services (S3, DynamoDB, etc.). Create a role in IAM first, then attach it here.",
        placeholder: "my-instance-profile",
      },
    },
    {
      name: "UserData",
      question: {
        type: "string",
        label: "User data script (base64)",
        hint: "Shell script that runs on first boot. Use for installing packages, configuring services, or pulling code. Max 16 KB.",
        placeholder: "#!/bin/bash\\necho hello",
      },
    },
  ],
  defaults: {},
  configHints: [
    "EC2 ImageId (AMI): ImageId is REQUIRED. If the user did not provide a specific AMI ID, use a recent Amazon Linux 2023 AMI for the target region (e.g., resolve via SSM parameter /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64). NEVER use placeholder IDs like ami-0abcdef1234567890.",
    "EC2 KeyName: if the user did not provide a key pair, OMIT KeyName — SSM Session Manager will be used instead",
    "EC2 SubnetId: if the user did not provide a subnet, OMIT SubnetId — the default VPC subnet will be used",
    "EC2 SecurityGroupIds: if the user did not provide security groups, OMIT SecurityGroupIds — the default VPC security group will be used",
    "EC2 IamInstanceProfile: if the user did not provide an instance profile, OMIT IamInstanceProfile",
  ],
};
