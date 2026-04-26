import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::EFS::MountTarget.
 *
 * Attaches an EFS file system to a subnet + security group so
 * EC2/Lambda/ECS workloads in that subnet can mount the file system
 * at runtime via NFSv4. One mount target per AZ is required — so a
 * multi-AZ EFS usage pattern needs one MountTarget per Subnet in
 * different AZs.
 *
 * CCAPI schema (verified 2026-04-08 via cloudformation:DescribeType):
 *   - Required: FileSystemId, SecurityGroups, SubnetId
 *   - createOnly: FileSystemId, SubnetId, IpAddress, Ipv6Address, IpAddressType
 *   - readOnly: Id (fsmt-xxxxxxxx)
 *   - SecurityGroups is mutable (modifyable via UpdateResource)
 *
 * Pricing: EFS MountTargets are free — users only pay for the
 * underlying EFS storage + NFS data transfer.
 *
 * @see A1 follow-up — EFS MountTarget first-class support
 */
export const efsMountTargetPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.EFS_MOUNT_TARGET,
  commonFields: [
    {
      name: "FileSystemId",
      required: true,
      question: {
        type: "enum",
        label: "EFS file system ID",
        placeholder: "fs-0123456789abcdef0",
        hint: "The ID of the EFS::FileSystem resource this mount target attaches to. Cannot be changed after creation.",
        fetcher: "discover-efs-file-systems",
        validate: (value: unknown) => {
          if (!value) return "FileSystemId is required";
          const s = String(value);
          if (!/^fs-[a-f0-9]+$/.test(s))
            return "Must be a valid EFS file system ID (fs-xxxxxxxx)";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.SUBNET_ID,
      required: true,
      question: {
        type: "enum",
        label: "Subnet ID",
        placeholder: "subnet-0123456789abcdef0",
        hint: "The subnet this mount target lives in. One mount target per AZ is required for multi-AZ access; EC2/Lambda/ECS workloads in the same subnet (or peered subnet in the same AZ) can mount via NFSv4. Cannot be changed after creation.",
        fetcher: "discover-subnets",
        validate: (value: unknown) => {
          if (!value) return "SubnetId is required";
          const s = String(value);
          if (!/^subnet-[a-f0-9]+$/.test(s))
            return "Must be a valid subnet ID (subnet-xxxxxxxx)";
          return undefined;
        },
      },
    },
    {
      name: "SecurityGroups",
      required: true,
      question: {
        type: "string",
        label: "Security Group IDs (comma-separated)",
        placeholder: "sg-0123456789abcdef0, sg-0abc...",
        hint: "Security groups that control inbound NFS (TCP 2049) access to the mount target. Must allow TCP 2049 from the client workload's security group. Can be modified after creation.",
        validate: (value: unknown) => {
          if (!value) return "At least one SecurityGroup is required";
          const parts = String(value)
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean);
          if (parts.length === 0)
            return "At least one SecurityGroup is required";
          for (const p of parts) {
            if (!/^sg-[a-f0-9]+$/.test(p))
              return `Invalid security group ID "${p}" — expected sg-xxxxxxxx`;
          }
          return undefined;
        },
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        return answer
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
      },
    },
  ],
  advancedFields: [
    {
      name: "IpAddress",
      question: {
        type: "string",
        label: "IPv4 address (optional)",
        placeholder: "10.0.1.42",
        initialValue: "",
        hint: "Optional. Leave blank to let AWS auto-assign an IP from the subnet CIDR. Specify only if you need a fixed address for DNS or firewall pinning. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value).trim();
          if (!/^\d+\.\d+\.\d+\.\d+$/.test(s))
            return `Invalid IPv4 address "${s}"`;
          return undefined;
        },
      },
    },
  ],
  defaults: {},
  configHints: [
    "AWS::EFS::MountTarget has NO Tags property — tagging is done on the parent EFS::FileSystem via FileSystemTags, not on individual mount targets.",
    "FileSystemId, SubnetId, IpAddress, Ipv6Address, and IpAddressType are createOnly — any update triggers a replace.",
    "One mount target per AZ is required for multi-AZ access. A workload in a subnet without a mount target in the same AZ cannot reach the file system even if IAM + security groups allow it.",
    "SecurityGroups must allow TCP 2049 (NFS) from the client workload's security group or CIDR — without that, mounts hang at connect time with no clear error.",
  ],
};
