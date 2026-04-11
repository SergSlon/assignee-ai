import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  AmiOs,
} from "../../config/cfn-keys.js";
import {
  QuestionTypeName,
  type ResourcePlugin,
  type CfnOutput,
} from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

// Story 46.4 (2026-04-12): the INSTANCE_CATEGORIES constant moved to its
// own module at `../instance-type-registry.ts` so future config-driven
// overrides can replace or augment the list without editing the plugin.
// Re-exported here for any external consumer that imports it from the
// plugin module directly.
export { INSTANCE_CATEGORIES } from "../instance-type-registry.js";
import { INSTANCE_CATEGORIES } from "../instance-type-registry.js";

/**
 * Plaintext markers that indicate the input is NOT already base64-encoded.
 * If a string starts with any of these, it must be plaintext (shebang,
 * cloud-init, or MIME multipart) and we should auto-encode it before
 * sending to CloudFormation.
 *
 * Item 3a (2026-04-09): CloudFormation's `AWS::EC2::Instance.UserData`
 * expects a base64-encoded string. Raw plaintext passes through but
 * cloud-init / the EC2 boot process silently fails to execute it,
 * producing an instance that starts successfully but never ran the
 * user's script. Detection here encodes plaintext so the user's
 * script actually runs.
 */
const USER_DATA_PLAINTEXT_MARKERS = [
  "#!", // bash / sh shebang
  "#cloud-config", // cloud-init YAML
  "Content-Type:", // multipart MIME (cloud-init multi-user-data)
] as const;

/**
 * Valid base64 characters: A-Z, a-z, 0-9, +, /, with optional = padding.
 * A string is "base64-shaped" if every non-whitespace character matches
 * this alphabet and the total length (stripped) is a multiple of 4.
 */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * Decide whether a UserData input string is plaintext (needs encoding)
 * or already base64-encoded (pass through).
 *
 * Returns:
 *   - "plaintext"    — needs encoding (shebang / cloud-init / MIME / non-base64 chars / too-short)
 *   - "base64"       — valid base64, decode produces bytes we can't identify
 *   - "double-base64" — valid base64 whose decoded output is itself plaintext.
 *                       This is almost always a user error (they base64-encoded
 *                       the script themselves and we'd double-encode it).
 */
export function classifyUserData(
  input: string,
): "plaintext" | "base64" | "double-base64" {
  const trimmed = input.trim();
  if (trimmed.length === 0) return "plaintext";

  // Fast-path: any known plaintext marker at the start
  for (const marker of USER_DATA_PLAINTEXT_MARKERS) {
    if (trimmed.startsWith(marker)) return "plaintext";
  }

  // Strip whitespace (base64 tolerates newlines) and check alphabet
  const stripped = trimmed.replace(/\s+/g, "");
  if (stripped.length === 0) return "plaintext";
  if (stripped.length % 4 !== 0) return "plaintext";
  if (!BASE64_RE.test(stripped)) return "plaintext";

  // It parses as base64. Decode and see if the result is itself plaintext —
  // that's the double-encoding user-error case.
  let decoded: string;
  try {
    decoded = Buffer.from(stripped, "base64").toString("utf8");
  } catch {
    return "plaintext";
  }
  for (const marker of USER_DATA_PLAINTEXT_MARKERS) {
    if (decoded.startsWith(marker)) return "double-base64";
  }
  // Valid base64, decoded content is opaque bytes (binary blob, e.g. gzip) —
  // trust the user and pass through.
  return "base64";
}

/**
 * Encode a UserData string for CloudFormation. If already base64, returns
 * the stripped value unchanged. If plaintext, base64-encodes it. If
 * double-base64 is detected, throws a user-facing error with a hint.
 */
export function encodeUserData(input: string): string {
  const classification = classifyUserData(input);
  if (classification === "double-base64") {
    throw new Error(
      "UserData looks like it's already base64-encoded AND the decoded content is itself a shell script or cloud-init config. " +
        "It looks like you already base64-encoded this — pass the raw script text, Assignee handles encoding automatically.",
    );
  }
  if (classification === "base64") {
    return input.trim().replace(/\s+/g, "");
  }
  // plaintext → encode
  return Buffer.from(input, "utf8").toString("base64");
}

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
        hint: "Firewall rules controlling inbound/outbound traffic. Select existing groups or leave blank \u2014 for SSH, a security group with port 22 will be auto-created.",
        options: [],
        fetcher: "discover-security-groups",
      },
    },
  ],
  advancedFields: [
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
        // encodeUserData throws on double-base64 — validate should have
        // caught that already, but guard here too in case UserData
        // arrived via --set or LLM-parsed desiredState rather than the
        // wizard.
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
