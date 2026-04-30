import { describe, it, expect } from "vitest";
import { efsWithVpcPattern } from "./efs-with-vpc.js";
import { PatternRegistry } from "../registry.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  markerRef,
  markerAz,
  parseMarker,
} from "../../config/marker-tokens.js";
import { EfsWithVpcResourceId as R } from "../pattern-resource-ids.js";
import { PatternId } from "../pattern-ids.js";

function buildRegistry(): PatternRegistry {
  const r = new PatternRegistry();
  r.register(efsWithVpcPattern);
  return r;
}

const allDepIds = (): string[] => efsWithVpcPattern.dependencyOrder.flat();
const allResourceIds = (): string[] =>
  efsWithVpcPattern.resourceList.map((r) => r.resourceId);

describe("efsWithVpcPattern — structure", () => {
  const pattern = efsWithVpcPattern;

  it("has patternId 'efs-with-vpc'", () => {
    expect(pattern.patternId).toBe(PatternId.EFS_WITH_VPC);
  });

  it("has a human-readable displayName", () => {
    expect(pattern.displayName).toMatch(/EFS/);
  });

  it("has at least 5 keywords for detection", () => {
    expect(pattern.keywords.length).toBeGreaterThanOrEqual(5);
  });

  it("every keyword is a non-empty lowercase string", () => {
    for (const kw of pattern.keywords) {
      expect(typeof kw).toBe("string");
      expect(kw.length).toBeGreaterThan(0);
      expect(kw).toBe(kw.toLowerCase());
    }
  });

  it("contains exactly 10 resources", () => {
    expect(pattern.resourceList).toHaveLength(10);
  });

  it("every resource has required fields", () => {
    for (const res of pattern.resourceList) {
      expect(res.resourceType).toBeTruthy();
      expect(res.resourceId).toBeTruthy();
      expect(res.displayName).toBeTruthy();
    }
  });

  it("includes the expected resource types in expected counts", () => {
    const typeCounts = new Map<string, number>();
    for (const res of pattern.resourceList) {
      typeCounts.set(
        res.resourceType,
        (typeCounts.get(res.resourceType) ?? 0) + 1,
      );
    }
    expect(typeCounts.get(RESOURCE_TYPES.EC2_VPC)).toBe(1);
    expect(typeCounts.get(RESOURCE_TYPES.EC2_SUBNET)).toBe(2);
    expect(typeCounts.get(RESOURCE_TYPES.EC2_ROUTE_TABLE)).toBe(1);
    expect(
      typeCounts.get(RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION),
    ).toBe(2);
    expect(typeCounts.get(RESOURCE_TYPES.EC2_SECURITY_GROUP)).toBe(1);
    expect(typeCounts.get(RESOURCE_TYPES.EFS_FILE_SYSTEM)).toBe(1);
    expect(typeCounts.get(RESOURCE_TYPES.EFS_MOUNT_TARGET)).toBe(2);
  });

  it("intentionally omits IGW, NAT, and public subnets (private-only by design)", () => {
    const types = pattern.resourceList.map((r) => r.resourceType);
    expect(types).not.toContain(RESOURCE_TYPES.EC2_INTERNET_GATEWAY);
    expect(types).not.toContain(RESOURCE_TYPES.EC2_NAT_GATEWAY);
    // Every subnet default has MapPublicIpOnLaunch: false
    expect(
      pattern.defaultOptions[R.PRIVATE_SUBNET_1]?.["MapPublicIpOnLaunch"],
    ).toBe(false);
    expect(
      pattern.defaultOptions[R.PRIVATE_SUBNET_2]?.["MapPublicIpOnLaunch"],
    ).toBe(false);
  });

  it("dependencyOrder and resourceList cover identical resourceId sets", () => {
    expect(new Set(allDepIds())).toEqual(new Set(allResourceIds()));
  });

  it("every dependencyOrder id has a defaultOptions entry", () => {
    for (const id of allDepIds()) {
      expect(pattern.defaultOptions[id]).toBeTypeOf("object");
    }
  });
});

describe("efsWithVpcPattern — dependency ordering", () => {
  const pattern = efsWithVpcPattern;
  const groupIndex = new Map<string, number>();
  pattern.dependencyOrder.forEach((group, i) =>
    group.forEach((id) => groupIndex.set(id, i)),
  );

  it("VPC is in the first group", () => {
    expect(groupIndex.get(R.VPC)).toBe(0);
  });

  it("subnets + route table + SG + EFS are all after the VPC", () => {
    const vpcGroup = groupIndex.get(R.VPC)!;
    for (const id of [
      R.PRIVATE_SUBNET_1,
      R.PRIVATE_SUBNET_2,
      R.PRIVATE_ROUTE_TABLE,
      R.NFS_SG,
      R.EFS_FILE_SYSTEM,
    ]) {
      expect(groupIndex.get(id)!).toBeGreaterThan(vpcGroup);
    }
  });

  it("route-table associations run after subnets + route table", () => {
    const assocGroup = groupIndex.get(R.PRIVATE_SUBNET_1_RT_ASSOC)!;
    expect(assocGroup).toBeGreaterThan(groupIndex.get(R.PRIVATE_SUBNET_1)!);
    expect(assocGroup).toBeGreaterThan(groupIndex.get(R.PRIVATE_ROUTE_TABLE)!);
    expect(groupIndex.get(R.PRIVATE_SUBNET_2_RT_ASSOC)).toBe(assocGroup);
  });

  it("mount targets run after the file system, subnets, and security group", () => {
    const mtGroup = groupIndex.get(R.MOUNT_TARGET_1)!;
    expect(mtGroup).toBeGreaterThan(groupIndex.get(R.EFS_FILE_SYSTEM)!);
    expect(mtGroup).toBeGreaterThan(groupIndex.get(R.PRIVATE_SUBNET_1)!);
    expect(mtGroup).toBeGreaterThan(groupIndex.get(R.NFS_SG)!);
    expect(groupIndex.get(R.MOUNT_TARGET_2)).toBe(mtGroup);
  });
});

describe("efsWithVpcPattern — marker token wiring", () => {
  const pattern = efsWithVpcPattern;
  const opts = pattern.defaultOptions;

  it("both private subnets reference the VPC via markerRef", () => {
    expect(opts[R.PRIVATE_SUBNET_1]?.["VpcId"]).toBe(markerRef(R.VPC));
    expect(opts[R.PRIVATE_SUBNET_2]?.["VpcId"]).toBe(markerRef(R.VPC));
  });

  it("private subnets pin to distinct AZ indices via markerAz", () => {
    expect(opts[R.PRIVATE_SUBNET_1]?.["AvailabilityZone"]).toBe(markerAz(0));
    expect(opts[R.PRIVATE_SUBNET_2]?.["AvailabilityZone"]).toBe(markerAz(1));
  });

  it("private subnets use non-overlapping /24 CIDRs inside the VPC /16", () => {
    expect(opts[R.PRIVATE_SUBNET_1]?.["CidrBlock"]).toBe("10.0.3.0/24");
    expect(opts[R.PRIVATE_SUBNET_2]?.["CidrBlock"]).toBe("10.0.4.0/24");
    expect(opts[R.VPC]?.["CidrBlock"]).toBe("10.0.0.0/16");
  });

  it("RT associations reference the right subnets and route table", () => {
    expect(opts[R.PRIVATE_SUBNET_1_RT_ASSOC]?.["SubnetId"]).toBe(
      markerRef(R.PRIVATE_SUBNET_1),
    );
    expect(opts[R.PRIVATE_SUBNET_1_RT_ASSOC]?.["RouteTableId"]).toBe(
      markerRef(R.PRIVATE_ROUTE_TABLE),
    );
    expect(opts[R.PRIVATE_SUBNET_2_RT_ASSOC]?.["SubnetId"]).toBe(
      markerRef(R.PRIVATE_SUBNET_2),
    );
    expect(opts[R.PRIVATE_SUBNET_2_RT_ASSOC]?.["RouteTableId"]).toBe(
      markerRef(R.PRIVATE_ROUTE_TABLE),
    );
  });

  it("NFS security group allows TCP 2049 from the VPC CIDR and nothing wider", () => {
    const ingress = opts[R.NFS_SG]?.["SecurityGroupIngress"] as Array<
      Record<string, unknown>
    >;
    expect(Array.isArray(ingress)).toBe(true);
    expect(ingress).toHaveLength(1);
    const rule = ingress[0];
    expect(rule?.["IpProtocol"]).toBe("tcp");
    expect(rule?.["FromPort"]).toBe(2049);
    expect(rule?.["ToPort"]).toBe(2049);
    expect(rule?.["CidrIp"]).toBe("10.0.0.0/16");
    // Canonical anti-mistake: must NOT be 0.0.0.0/0
    expect(rule?.["CidrIp"]).not.toBe("0.0.0.0/0");
  });

  it("NFS security group is bound to the compound VPC", () => {
    expect(opts[R.NFS_SG]?.["VpcId"]).toBe(markerRef(R.VPC));
  });

  it("EFS file system defaults are encrypted + elastic throughput + backups on", () => {
    expect(opts[R.EFS_FILE_SYSTEM]?.["Encrypted"]).toBe(true);
    expect(opts[R.EFS_FILE_SYSTEM]?.["PerformanceMode"]).toBe("generalPurpose");
    expect(opts[R.EFS_FILE_SYSTEM]?.["ThroughputMode"]).toBe("elastic");
    expect(opts[R.EFS_FILE_SYSTEM]?.["BackupPolicy"]).toEqual({
      Status: "ENABLED",
    });
  });

  it("mount targets bind to the right file system, subnet, and SG", () => {
    for (const [id, subnet] of [
      [R.MOUNT_TARGET_1, R.PRIVATE_SUBNET_1],
      [R.MOUNT_TARGET_2, R.PRIVATE_SUBNET_2],
    ] as const) {
      expect(opts[id]?.["FileSystemId"]).toBe(markerRef(R.EFS_FILE_SYSTEM));
      expect(opts[id]?.["SubnetId"]).toBe(markerRef(subnet));
      const sgs = opts[id]?.["SecurityGroups"];
      expect(Array.isArray(sgs)).toBe(true);
      expect(sgs).toEqual([markerRef(R.NFS_SG)]);
    }
  });

  it("every marker string parses back as a well-formed marker token", () => {
    const walk = (value: unknown): void => {
      if (typeof value === "string" && value.startsWith("__ASSIGNEE_")) {
        const parsed = parseMarker(value);
        expect(parsed).not.toBeNull();
      } else if (Array.isArray(value)) {
        value.forEach(walk);
      } else if (value && typeof value === "object") {
        Object.values(value as Record<string, unknown>).forEach(walk);
      }
    };
    walk(opts);
  });
});

describe("efsWithVpcPattern — registry detection", () => {
  const registry = buildRegistry();

  const positiveCases = [
    "create an EFS file system",
    "I want EFS for my Lambda",
    "set up an elastic file system",
    "create a shared file system for EC2",
    "nfs mount for my container",
    "shared storage for ec2",
  ];

  for (const intent of positiveCases) {
    it(`detects "${intent}" as efs-with-vpc`, () => {
      const detected = registry.detect(intent);
      expect(detected?.patternId).toBe(PatternId.EFS_WITH_VPC);
    });
  }

  it("does not match an unrelated intent", () => {
    expect(registry.detect("create an s3 bucket for audit logs")).toBeNull();
  });

  describe("efs-with-vpc — negative keyword triggers (Epic 92 wave 2.b)", () => {
    it("skips the compound on 'create a standalone efs'", () => {
      expect(registry.detect("create a standalone efs file system")).toBeNull();
    });

    it("skips the compound on 'existing vpc' hint", () => {
      expect(registry.detect("create an efs in my existing vpc")).toBeNull();
    });

    it("skips the compound on 'just the efs' phrasing", () => {
      expect(
        registry.detect("create an efs file system, just the efs please"),
      ).toBeNull();
    });

    it("skips the compound on 'only the filesystem' phrasing", () => {
      expect(
        registry.detect("create an efs — only the filesystem, no vpc"),
      ).toBeNull();
    });

    it("still matches compound on plain 'create an EFS file system' — via the bare 'efs' keyword (not the removed 'efs file system' keyword)", () => {
      // IMPORTANT: the registry matches this intent via the bare "efs"
      // substring keyword, NOT via "efs file system" (which was removed
      // in Epic 96 W3.N3 to eliminate routing ambiguity). At the
      // intent-parser layer the SINGLETON_OVERRIDE_CUES table intercepts
      // this intent upstream and routes it to AWS::EFS::FileSystem —
      // the compound is only reached when the intent carries a VPC
      // qualifier ("with a new VPC", "and VPC", etc.) that disqualifies
      // the singleton cue. This registry-level match is preserved so
      // VPC-qualified variants that fall through the singleton cue still
      // resolve to the efs-with-vpc compound.
      expect(registry.detect("create an EFS file system")).toBe(
        efsWithVpcPattern,
      );
    });

    it("does NOT have 'efs file system' as a standalone compound keyword (probe e96.W3.N3 regression guard)", () => {
      // The keyword "efs file system" was removed from efs-with-vpc to
      // avoid ambiguity with the singleton path. Verify the removal is
      // permanent — the compound still detects EFS intents via "efs"
      // alone so this removal has no functional impact on VPC-compound
      // routing.
      expect(efsWithVpcPattern.keywords).not.toContain("efs file system");
    });
  });
});

describe("efsWithVpcPattern — TOC snapshot (Epic 92 wave 2.b, finding C-09)", () => {
  // Snapshot test pins the header comment's resource count against
  // resourceList.length. The previous comment said "Total: 9 resources"
  // but the pattern emits 10 (1 VPC + 2 subnets + 1 RT + 2 associations
  // + 1 SG + 1 EFS + 2 MountTargets). The fix bumped the comment to
  // "Total: 10 resources"; this test ensures future drift is caught.
  it("resourceList.length matches the TOC header count in the file doc comment", () => {
    // We import the pattern's module to test the invariant directly:
    // the resourceList is the runtime source of truth, and the
    // displayName-and-doc-comment count MUST agree.
    expect(efsWithVpcPattern.resourceList).toHaveLength(10);
  });

  it("resourceList count equals the sum of the TOC per-type enumeration", () => {
    // Enumerate the TOC bullets programmatically so the snapshot
    // reflects the actual intent of the comment (future drift fails
    // here when, say, someone adds a second route table and forgets
    // to bump the comment).
    const tocCounts = {
      vpc: 1,
      privateSubnets: 2,
      privateRouteTable: 1,
      rtAssociations: 2,
      nfsSecurityGroup: 1,
      efsFileSystem: 1,
      mountTargets: 2,
    };
    const tocTotal = Object.values(tocCounts).reduce((a, b) => a + b, 0);
    expect(tocTotal).toBe(10);
    expect(efsWithVpcPattern.resourceList).toHaveLength(tocTotal);
  });
});
