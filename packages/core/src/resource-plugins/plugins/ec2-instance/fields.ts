import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  AmiOs,
} from "../../../config/cfn-keys.js";
import { QuestionTypeName, type ResourcePlugin } from "../../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../../shared-fields.js";
import { FieldLabel } from "../../field-labels.js";
import { isArnOfService } from "../../../config/aws-partition.js";
import { INSTANCE_CATEGORIES } from "../../instance-type-registry.js";
import { classifyUserData, encodeUserData } from "./user-data.js";

export const commonFields: ResourcePlugin["commonFields"] = [
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
      hint: "Firewall rules controlling inbound/outbound traffic. Select existing groups or leave blank \u2014 for SSH, a security group with port 22 will be auto-created.",
      options: [],
      fetcher: "discover-security-groups",
    },
  },
];

export const advancedFields: ResourcePlugin["advancedFields"] = [
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
        // Accept any partition (aws, aws-us-gov, aws-cn, aws-iso, aws-iso-b, aws-iso-e/f)
        if (isArnOfService(s, "iam")) return undefined;
        if (!/^[a-zA-Z0-9+=,.@_-]+$/.test(s))
          return "Must be a valid IAM instance profile name or ARN (e.g. arn:aws:iam::...)";
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
      label: "User data script",
      hint: "Shell script that runs on first boot (auto-encoded — paste raw script text, not base64). Use for installing packages, configuring services, or pulling code. Max 16 KB.",
      placeholder: "#!/bin/bash\\necho hello",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const s = String(value);
        if (s.length > 16384)
          return "User data must not exceed 16 KB (16384 characters)";
        if (classifyUserData(s) === "double-base64") {
          return "It looks like you already base64-encoded this — paste the raw script text, Assignee handles encoding automatically.";
        }
        return undefined;
      },
    },
    toCfn: (answer: unknown) => {
      if (typeof answer !== "string" || answer.length === 0) return undefined;
      // encodeUserData throws on double-base64 — validate should have caught
      // that already, but guard here too in case UserData arrived via --set
      // or LLM-parsed desiredState rather than the wizard.
      return encodeUserData(answer);
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
];
