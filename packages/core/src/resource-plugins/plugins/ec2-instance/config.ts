import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { CfnKey, ResourceDefault } from "@/config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../../types.js";

export const defaults: ResourcePlugin["defaults"] = {
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
};

/**
 * Auto-creates a companion SecurityGroup when the user didn't specify one
 * and the configuration signals need network ingress (SSH keypair or
 * public IP). Idempotent — returns [] when SecurityGroupIds already set.
 */
export function companionResources(
  desiredState: Record<string, unknown>,
): CfnOutput[] {
  const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
  if (Array.isArray(sgIds) && sgIds.length > 0) return [];

  const hasKeyName =
    typeof desiredState[CfnKey.KEY_NAME] === "string" &&
    desiredState[CfnKey.KEY_NAME] !== "";
  const hasPublicIp = desiredState[CfnKey.ASSOCIATE_PUBLIC_IP] === true;

  const ingressRules: Record<string, unknown>[] = [];

  if (hasKeyName) {
    ingressRules.push({
      IpProtocol: "tcp",
      FromPort: 22,
      ToPort: 22,
      CidrIp: "0.0.0.0/0",
      Description: "SSH access",
    });
  }

  if (hasPublicIp || hasKeyName) {
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
}

export const configHints: ResourcePlugin["configHints"] = [
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
];
