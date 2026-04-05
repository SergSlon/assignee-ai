import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  AmiOs,
  SizeLabel,
  WorkloadProfileKey,
} from "../../config/cfn-keys.js";
import {
  QuestionTypeName,
  type ResourcePlugin,
  type CfnOutput,
} from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * Instance type category groupings for two-step selection UX.
 * Each category maps a family key to its display metadata and member instance types.
 *
 * Approximate us-east-1 on-demand prices as of 2026-04. Updated via scripts/update-wizard-prices.ts
 *
 * @see Story 18.12
 */
export const INSTANCE_CATEGORIES = [
  {
    key: WorkloadProfileKey.BURSTABLE,
    label: "Burstable (t3/t4g) — ~$0.008-0.17/hr",
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
        fitHint: SizeLabel.SMALL_PRODUCTION,
      },
      {
        value: "t3.large",
        label: "t3.large  (2 vCPU,  8 GiB) — ~$0.0832/hr",
        fitHint: SizeLabel.MEDIUM_PRODUCTION,
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
    key: WorkloadProfileKey.GENERAL,
    label: "General Purpose (m5/m6i) — ~$0.096-0.38/hr",
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
    key: WorkloadProfileKey.COMPUTE,
    label: "Compute Optimized (c5/c6i) — ~$0.085-0.34/hr",
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
        fitHint: SizeLabel.LATEST_GEN_COMPUTE,
      },
      {
        value: "c6i.xlarge",
        label: "c6i.xlarge  (4 vCPU,  8 GiB) — ~$0.1700/hr",
        fitHint: SizeLabel.LATEST_GEN_COMPUTE,
      },
      {
        value: "c6i.2xlarge",
        label: "c6i.2xlarge (8 vCPU, 16 GiB) — ~$0.3400/hr",
        fitHint: "Latest gen compute-heavy",
      },
    ],
  },
  {
    key: WorkloadProfileKey.MEMORY,
    label: "Memory Optimized (r5/r6i) — ~$0.126-0.50/hr",
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
      name: CfnKey.INSTANCE_TYPE,
      required: true,
      question: {
        type: QuestionTypeName.CATEGORY_SELECT,
        label: "Instance type",
        hint: "t3/t4g: burstable (dev/small prod). m5/m6i: general-purpose. c5/c6i: compute. r5/r6i: memory. t4g (ARM) is ~20% cheaper than t3.",
        categories: INSTANCE_CATEGORIES,
        initialValue: AwsDefault.INSTANCE_TYPE,
      },
    },
    {
      name: CfnKey.IMAGE_ID,
      required: true,
      question: {
        type: "enum",
        label: "AMI",
        hint: "The Amazon Machine Image determines the OS and software. When connected to AWS, real AMI IDs are fetched automatically. Otherwise, pick an OS and the system will resolve the AMI for your region.",
        placeholder: "ami-0abcdef1234567890",
        options: [
          {
            value: AwsDefault.EC2_AMI,
            label: "Amazon Linux 2023 (recommended, free tier eligible)",
          },
          { value: AmiOs.UBUNTU_24, label: "Ubuntu 24.04 LTS" },
          { value: AmiOs.UBUNTU_22, label: "Ubuntu 22.04 LTS" },
          { value: AmiOs.WINDOWS_2022, label: "Windows Server 2022" },
        ],
        initialValue: AwsDefault.EC2_AMI,
        fetcher: "discover-amis",
      },
    },
    {
      name: CfnKey.KEY_NAME,
      question: {
        type: "enum",
        label: "EC2 Key Pair",
        hint: "Required for SSH access. Leave blank to use SSM Session Manager instead (no key needed, more secure).",
        options: [],
        fetcher: "discover-key-pairs",
      },
    },
    {
      name: CfnKey.SUBNET_ID,
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
      name: CfnKey.SECURITY_GROUP_IDS,
      question: {
        type: "multi",
        label: "Security Groups",
        hint: "Firewall rules controlling inbound/outbound traffic. Select existing groups or leave blank to use the VPC default.",
        options: [],
        fetcher: "discover-security-groups",
      },
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
      name: CfnKey.IAM_INSTANCE_PROFILE,
      question: {
        type: "string",
        label: "IAM Instance Profile name",
        hint: "Grants the instance permissions to call AWS services (S3, DynamoDB, etc.). Create a role in IAM first, then attach it here.",
        placeholder: "my-instance-profile",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.startsWith("arn:aws:iam::")) return undefined;
          if (!/^[a-zA-Z0-9+=,.@_-]+$/.test(s))
            return "Must be a valid IAM instance profile name or ARN (arn:aws:iam::...)";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.EBS_VOLUME_TYPE,
      question: {
        type: "enum",
        label: "EBS volume type (gp3/gp2/io1)",
        hint: "This is the STORAGE TYPE, not size. Size is configured in the next field. gp3 is recommended — 20% cheaper than gp2 with better baseline performance (3000 IOPS, 125 MiB/s).",
        options: [
          {
            value: "gp3",
            label: "gp3 (General Purpose SSD v3) — recommended",
            recommended: true,
          },
          { value: "gp2", label: "gp2 (General Purpose SSD v2) — legacy" },
          { value: "io1", label: "io1 (Provisioned IOPS) — high-performance" },
        ],
        initialValue: ResourceDefault.EBS_VOLUME_TYPE,
      },
    },
    {
      name: CfnKey.EBS_VOLUME_SIZE,
      question: {
        type: "string",
        label: "Root volume size (GB)",
        placeholder: "8",
        initialValue: "8",
        hint: "Root EBS volume size in GB. Default 8 GB for Amazon Linux. Increase for data-heavy workloads.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = parseInt(String(value), 10);
          if (isNaN(n) || n < 1 || n > 16384) return "Must be 1-16384 GB";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.EBS_ENCRYPTED,
      question: {
        type: "boolean",
        label: "Encrypt root volume?",
        initialValue: true,
        hint: "Encrypts the root EBS volume at rest. Strongly recommended for security. No performance impact. Uses default AWS KMS key.",
      },
    },
    {
      name: CfnKey.USER_DATA,
      question: {
        type: "string",
        label: "User data script (base64)",
        hint: "Shell script that runs on first boot. Use for installing packages, configuring services, or pulling code. Max 16 KB.",
        placeholder: "#!/bin/bash\\necho hello",
        validate: (value: unknown) => {
          if (!value) return undefined;
          if (String(value).length > 16384)
            return "User data must not exceed 16 KB (16384 characters)";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.MONITORING,
      question: {
        type: "boolean",
        label: "Detailed CloudWatch Monitoring",
        initialValue: false,
        hint: "Enables 1-minute interval metrics (vs default 5-minute). Recommended for production.",
      },
    },
    {
      name: CfnKey.ASSOCIATE_PUBLIC_IP,
      question: {
        type: "boolean",
        label: "Associate Public IP",
        initialValue: false,
        hint: "Assign a public IPv4 address. Only works in public subnets with internet gateway.",
      },
    },
    {
      name: CfnKey.CREDIT_SPECIFICATION,
      question: {
        type: "enum",
        label: "CPU Credit Specification",
        options: [
          {
            value: "standard",
            label: "Standard (stop earning credits at baseline)",
          },
          {
            value: "unlimited",
            label: "Unlimited (can burst beyond baseline, charges apply)",
          },
        ],
        initialValue: "standard",
        hint: "Controls CPU credit behavior for burstable (t3/t4g) instances. Standard pauses bursting when credits run out; Unlimited allows sustained bursting at extra cost.",
        showIf: { field: CfnKey.INSTANCE_TYPE, pattern: "^t[34]" },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string") return undefined;
        return { CpuCredits: answer };
      },
    },
    {
      name: CfnKey.DISABLE_API_TERMINATION,
      question: {
        type: "boolean" as const,
        label: "Enable Termination Protection?",
        initialValue: true,
        hint: "Prevents accidental termination via API or console. Recommended for production. Must be disabled before the instance can be terminated.",
      },
    },
    {
      name: CfnKey.EBS_OPTIMIZED,
      question: {
        type: "boolean" as const,
        label: "EBS-Optimized Instance?",
        initialValue: true,
        hint: "Provides dedicated throughput between EC2 and EBS. Enabled by default on most current-gen instance types at no extra cost.",
      },
    },
  ],
  defaults: {
    [CfnKey.METADATA_OPTIONS]: {
      HttpTokens: "required",
      HttpPutResponseHopLimit: 1,
    },
    [CfnKey.DISABLE_API_TERMINATION]: true,
    [CfnKey.EBS_OPTIMIZED]: true,
    [CfnKey.BLOCK_DEVICE_MAPPINGS]: [
      {
        DeviceName: "/dev/xvda",
        Ebs: { Encrypted: true, VolumeType: ResourceDefault.EBS_VOLUME_TYPE },
      },
    ],
  },
  companionResources(desiredState: Record<string, unknown>): CfnOutput[] {
    // Only create companion SG if no SecurityGroupIds are specified
    const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
    if (Array.isArray(sgIds) && sgIds.length > 0) return [];

    const hasKeyName =
      typeof desiredState[CfnKey.KEY_NAME] === "string" &&
      desiredState[CfnKey.KEY_NAME] !== "";
    const hasPublicIp = desiredState[CfnKey.ASSOCIATE_PUBLIC_IP] === true;

    // Build ingress rules based on configuration signals
    const ingressRules: Record<string, unknown>[] = [];

    if (hasKeyName) {
      // SSH access requested — open port 22
      ingressRules.push({
        IpProtocol: "tcp",
        FromPort: 22,
        ToPort: 22,
        CidrIp: "0.0.0.0/0",
        Description: "SSH access",
      });
    }

    if (hasPublicIp || hasKeyName) {
      // Web traffic — open 80/443
      ingressRules.push(
        {
          IpProtocol: "tcp",
          FromPort: 80,
          ToPort: 80,
          CidrIp: "0.0.0.0/0",
          Description: "HTTP",
        },
        {
          IpProtocol: "tcp",
          FromPort: 443,
          ToPort: 443,
          CidrIp: "0.0.0.0/0",
          Description: "HTTPS",
        },
      );
    }

    if (ingressRules.length === 0) return [];

    const instanceType =
      (desiredState[CfnKey.INSTANCE_TYPE] as string) ?? "instance";
    const sanitized = instanceType.replace(/[^a-zA-Z0-9]/g, "-");
    return [
      {
        logicalId: `${sanitized}SecurityGroup`,
        type: RESOURCE_TYPES.EC2_SECURITY_GROUP,
        properties: {
          [CfnKey.GROUP_DESCRIPTION]: `Security group for EC2 ${instanceType}`,
          SecurityGroupIngress: ingressRules,
          SecurityGroupEgress: [
            {
              IpProtocol: "-1",
              CidrIp: "0.0.0.0/0",
              Description: "Allow all outbound",
            },
          ],
        },
      },
    ];
  },
  configHints: [
    "EC2 ImageId (AMI): ImageId is REQUIRED. The user may provide an OS name like 'amazon-linux-2023' instead of a real AMI ID — keep it as-is, the system resolves it automatically. NEVER use placeholder IDs like ami-0abcdef1234567890.",
    'EC2 KeyName: if the user mentions "SSH", "key pair", or "SSH access", KeyName is REQUIRED — use the value they provide, or if none given set KeyName to "assignee-ssh-key". If the user does NOT mention SSH, OMIT KeyName (SSM Session Manager will be used instead).',
    "EC2 SubnetId: if the user did not provide a subnet, OMIT SubnetId — the default VPC subnet will be used",
    "EC2 SecurityGroupIds: OMIT SecurityGroupIds entirely unless the user provides a specific security group ID (sg-...). NEVER output an empty array or placeholder. The default VPC security group will be used automatically.",
    "EC2 IamInstanceProfile: if the user did not provide an instance profile, OMIT IamInstanceProfile",
    'EC2 IMDSv2: ALWAYS include MetadataOptions: { HttpTokens: "required" } to enforce IMDSv2. This is an AWS security best practice — never omit it.',
    'EC2 EBS Encryption: ALWAYS include BlockDeviceMappings with Ebs.Encrypted: true and VolumeType: "gp3". Example: BlockDeviceMappings: [{ DeviceName: "/dev/xvda", Ebs: { Encrypted: true, VolumeType: "gp3" } }]',
    "EC2 Monitoring: if Monitoring is true, include Monitoring: { Enabled: true }. If false or not set, OMIT the Monitoring property.",
    "EC2 AssociatePublicIpAddress: if true, set via NetworkInterfaces[0].AssociatePublicIpAddress. Only valid in public subnets. If false or not set, OMIT it.",
    "EC2 CreditSpecification: only applies to burstable instance types (t3/t4g). Set CreditSpecification: { CpuCredits: 'standard' | 'unlimited' }. OMIT for non-burstable types.",
    "EC2 DisableApiTermination: ALWAYS set to true unless the user explicitly requests termination protection off. Prevents accidental instance deletion.",
    "EC2 EbsOptimized: ALWAYS set to true. All current-gen instance types support EBS optimization at no extra cost.",
  ],
};
