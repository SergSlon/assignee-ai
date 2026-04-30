/**
 * EFS FileSystem + VPC compound pattern.
 *
 * Bare "create an EFS file system" intents cannot be served by a
 * single-resource plan: EFS is reached by NFS mount from workloads
 * running inside a VPC, and every mount target needs (a) a subnet
 * ID, (b) a security group allowing TCP 2049 from the client, and
 * (c) one mount target per AZ the workload runs in. Without that
 * scaffolding the user has nothing usable.
 *
 * This pattern bundles the minimum viable stack for a first-run
 * EFS experience:
 *   - 1 VPC (10.0.0.0/16)
 *   - 2 private subnets (10.0.3.0/24 + 10.0.4.0/24, multi-AZ)
 *   - 1 private RouteTable
 *   - 2 Subnet ↔ RouteTable associations
 *   - 1 dedicated NFS SecurityGroup (inbound TCP 2049 from VPC CIDR)
 *   - 1 EFS::FileSystem (encrypted, elastic throughput, backups on)
 *   - 2 EFS::MountTarget (one per private subnet)
 *
 * Total: 10 resources (1 + 2 + 1 + 2 + 1 + 1 + 2 = 10). Epic 92 wave
 * 2.b fixed the off-by-one in the prior header — the resourceList
 * has always emitted 10, but the comment said "9 resources". A
 * snapshot test in efs-with-vpc.test.ts now pins the TOC count
 * against `resourceList.length` so future drift is caught.
 *
 * No IGW, no NAT, no public subnets — EFS is an
 * internal service and anything that mounts it already has to be
 * in the same VPC. Skipping the IGW/NAT keeps this pattern within
 * the free tier for the networking layer ($0 for VPC + subnets +
 * route tables). Only the EFS storage bills.
 *
 * The VPC-bearing resourceIds intentionally mirror those in
 * vpc-networking.ts so the compound-provisioner and plan-generator's
 * marker-resolution logic treat the two patterns identically.
 *
 * Why no NAT gateway? EFS is reached by in-VPC NFS traffic only;
 * the file system has no public endpoint. A workload that needs
 * outbound internet access (e.g. to pull container images) should
 * use the full vpc-networking pattern and layer EFS on top — but
 * that path requires explicit user intent ("VPC with EFS"), not
 * the bare "create an EFS" intent this pattern handles.
 *
 * Why only private subnets? Public subnets for EFS would be an
 * anti-pattern: mount targets in public subnets + lax security
 * groups are the canonical "open NFS to the world" misconfiguration.
 * By shipping only private subnets, the pattern steers users toward
 * the correct posture by default.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";
import { markerRef, markerAz } from "../../config/marker-tokens.js";
import type { ArchitecturePattern } from "../types.js";
import { EfsWithVpcResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

const VPC_CIDR = "10.0.0.0/16";

export const efsWithVpcPattern: ArchitecturePattern = {
  patternId: PatternId.EFS_WITH_VPC,
  displayName: "EFS File System (with private VPC)",
  /**
   * Keyword coverage for plain EFS-flavoured intents. Order matters
   * globally — this pattern is registered BEFORE vpc-networking so
   * the "efs" substrings win against the generic "vpc" keywords.
   * Each keyword must be disjoint from vpc-networking's keyword set
   * (which uses "vpc", never "efs"), so the two cannot collide.
   *
   * Note: "efs file system" was intentionally REMOVED from this list
   * (Epic 96 W3.N3 / probe e96.W3.N3). Bare "Create an EFS file
   * system" intents are now intercepted upstream by the
   * `SINGLETON_OVERRIDE_CUES` table in `compound-keywords.ts` and
   * routed to the singleton AWS::EFS::FileSystem — the 10-resource
   * compound is too heavy for users who just want one EFS resource.
   * Keeping "efs file system" as a compound keyword created a routing
   * ambiguity: the keyword matched the bare intent at the registry
   * layer, confusing the picture even though the intent-parser node
   * overrode it upstream via the singleton cue. "efs" alone is a
   * sufficient substring anchor for VPC-qualified compound intents
   * ("Create an EFS file system with a new VPC" still resolves here
   * via the bare "efs" keyword once the VPC qualifiers disqualify the
   * singleton override's negative-phrase check).
   */
  keywords: [
    "efs",
    "elastic file system",
    "nfs file system",
    "create an efs",
    "create a shared file system",
    "shared storage for lambda",
    "shared storage for ec2",
    "nfs mount",
  ],
  /**
   * Epic 92 wave 2.b (finding B-02): skip this pattern when the user
   * explicitly asks for a standalone / bare EFS. The bare EFS
   * resource type (AWS::EFS::FileSystem) is first-class in
   * SUPPORTED_TYPES — advanced users who already have a VPC don't
   * need the 10-resource compound. `existing-vpc` hints the user has
   * a VPC already; `just` / `only` are explicit bail-outs to the
   * single-resource plan.
   */
  negativeKeywords: [
    "standalone",
    "existing-vpc",
    "existing vpc",
    "on its own",
    "just the efs",
    "just the filesystem",
    "just the file system",
    "only the efs",
    "only the filesystem",
    "only the file system",
  ],
  resourceList: [
    {
      resourceType: RESOURCE_TYPES.EC2_VPC,
      resourceId: R.VPC,
      displayName: "VPC",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PRIVATE_SUBNET_1,
      displayName: "Private Subnet (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET,
      resourceId: R.PRIVATE_SUBNET_2,
      displayName: "Private Subnet (AZ-2)",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_ROUTE_TABLE,
      resourceId: R.PRIVATE_ROUTE_TABLE,
      displayName: "Private Route Table",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PRIVATE_SUBNET_1_RT_ASSOC,
      displayName: "Private Subnet 1 ↔ Private RT",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
      resourceId: R.PRIVATE_SUBNET_2_RT_ASSOC,
      displayName: "Private Subnet 2 ↔ Private RT",
    },
    {
      resourceType: RESOURCE_TYPES.EC2_SECURITY_GROUP,
      resourceId: R.NFS_SG,
      displayName: "NFS Security Group",
    },
    {
      resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,
      resourceId: R.EFS_FILE_SYSTEM,
      displayName: "EFS File System",
    },
    {
      resourceType: RESOURCE_TYPES.EFS_MOUNT_TARGET,
      resourceId: R.MOUNT_TARGET_1,
      displayName: "EFS Mount Target (AZ-1)",
    },
    {
      resourceType: RESOURCE_TYPES.EFS_MOUNT_TARGET,
      resourceId: R.MOUNT_TARGET_2,
      displayName: "EFS Mount Target (AZ-2)",
    },
  ],
  dependencyOrder: [
    // Group 0: VPC must exist before anything else
    [R.VPC],
    // Group 1: Subnets + RouteTable + SG + EFS — all depend on VpcId
    // only, so they provision in parallel. EFS does NOT depend on
    // subnets; the MountTargets (not the FileSystem) are what bind
    // EFS to a subnet.
    [
      R.PRIVATE_SUBNET_1,
      R.PRIVATE_SUBNET_2,
      R.PRIVATE_ROUTE_TABLE,
      R.NFS_SG,
      R.EFS_FILE_SYSTEM,
    ],
    // Group 2: Subnet ↔ RT associations — need both subnets + RT
    [R.PRIVATE_SUBNET_1_RT_ASSOC, R.PRIVATE_SUBNET_2_RT_ASSOC],
    // Group 3: Mount targets — need FileSystem + Subnet + SG
    [R.MOUNT_TARGET_1, R.MOUNT_TARGET_2],
  ],
  defaultOptions: {
    [R.VPC]: {
      CidrBlock: VPC_CIDR,
      EnableDnsSupport: true,
      EnableDnsHostnames: true,
    },
    [R.PRIVATE_SUBNET_1]: {
      CidrBlock: "10.0.3.0/24",
      AvailabilityZone: markerAz(0),
      MapPublicIpOnLaunch: false,
      [CfnKey.VPC_ID]: markerRef(R.VPC),
    },
    [R.PRIVATE_SUBNET_2]: {
      CidrBlock: "10.0.4.0/24",
      AvailabilityZone: markerAz(1),
      MapPublicIpOnLaunch: false,
      [CfnKey.VPC_ID]: markerRef(R.VPC),
    },
    [R.PRIVATE_ROUTE_TABLE]: {
      [CfnKey.VPC_ID]: markerRef(R.VPC),
    },
    [R.PRIVATE_SUBNET_1_RT_ASSOC]: {
      [CfnKey.SUBNET_ID]: markerRef(R.PRIVATE_SUBNET_1),
      RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
    },
    [R.PRIVATE_SUBNET_2_RT_ASSOC]: {
      [CfnKey.SUBNET_ID]: markerRef(R.PRIVATE_SUBNET_2),
      RouteTableId: markerRef(R.PRIVATE_ROUTE_TABLE),
    },
    [R.NFS_SG]: {
      [CfnKey.GROUP_DESCRIPTION]:
        "Allow NFS (TCP 2049) from workloads inside the VPC to the EFS mount targets",
      [CfnKey.VPC_ID]: markerRef(R.VPC),
      [CfnKey.SG_INGRESS]: [
        {
          IpProtocol: "tcp",
          FromPort: 2049,
          ToPort: 2049,
          CidrIp: VPC_CIDR,
          Description: "NFS from any workload in the VPC",
        },
      ],
      [CfnKey.SG_EGRESS]: [
        {
          IpProtocol: "-1",
          CidrIp: "0.0.0.0/0",
          Description: "Allow all outbound",
        },
      ],
    },
    [R.EFS_FILE_SYSTEM]: {
      Encrypted: true,
      PerformanceMode: "generalPurpose",
      ThroughputMode: "elastic",
      BackupPolicy: { Status: "ENABLED" },
    },
    [R.MOUNT_TARGET_1]: {
      FileSystemId: markerRef(R.EFS_FILE_SYSTEM),
      [CfnKey.SUBNET_ID]: markerRef(R.PRIVATE_SUBNET_1),
      SecurityGroups: [markerRef(R.NFS_SG)],
    },
    [R.MOUNT_TARGET_2]: {
      FileSystemId: markerRef(R.EFS_FILE_SYSTEM),
      [CfnKey.SUBNET_ID]: markerRef(R.PRIVATE_SUBNET_2),
      SecurityGroups: [markerRef(R.NFS_SG)],
    },
  },
};
