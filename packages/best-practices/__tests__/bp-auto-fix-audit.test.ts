import { describe, it, expect } from "vitest";
import { evaluateTriggers, loadBestPractices } from "../src/index.js";
import type { EvalContext } from "../src/index.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_ROOT = join(__dirname, "..");
const allPractices = loadBestPractices(BP_ROOT);
const autoFixablePractices = allPractices.filter((p) => p.autoFixable === true);

/**
 * Deep merge helper — recursively merges source into target.
 * Arrays are replaced wholesale (not merged element-by-element).
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      target[key] &&
      typeof target[key] === "object" &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(
        target[key] as Record<string, unknown>,
        value as Record<string, unknown>,
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Test data: for each auto-fixable rule, we define:
 * - id: the BP rule ID
 * - resourceType: the AWS resource type the rule applies to
 * - triggeringState: a desiredState that causes the finding to fire
 */
interface AutoFixTestCase {
  id: string;
  resourceType: string;
  triggeringState: Record<string, unknown>;
}

const testCases: AutoFixTestCase[] = [
  // --- S3 rules ---
  {
    id: "BP-S3-001",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      PublicAccessBlockConfiguration: { BlockPublicAcls: false },
    },
  },
  {
    id: "BP-S3-002",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      PublicAccessBlockConfiguration: { BlockPublicPolicy: false },
    },
  },
  {
    id: "BP-S3-003",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      PublicAccessBlockConfiguration: { IgnorePublicAcls: false },
    },
  },
  {
    id: "BP-S3-004",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      PublicAccessBlockConfiguration: { RestrictPublicBuckets: false },
    },
  },
  {
    id: "BP-S3-005",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      VersioningConfiguration: { Status: "Suspended" },
    },
  },
  {
    id: "BP-S3-006",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      // check_type is "exists" on BucketEncryption — omit to trigger
    },
  },
  {
    id: "BP-S3-008",
    resourceType: "AWS::S3::Bucket",
    triggeringState: {
      OwnershipControls: {
        Rules: [{ ObjectOwnership: "ObjectWriter" }],
      },
    },
  },
  // --- EC2 rules ---
  {
    id: "BP-EC2-001",
    resourceType: "AWS::EC2::Instance",
    triggeringState: {
      MetadataOptions: { HttpTokens: "optional" },
    },
  },
  {
    id: "BP-EC2-002",
    resourceType: "AWS::EC2::Instance",
    triggeringState: {
      BlockDeviceMappings: [{ Ebs: { Encrypted: false } }],
    },
  },
  {
    id: "BP-EC2-003",
    resourceType: "AWS::EC2::Instance",
    triggeringState: {
      BlockDeviceMappings: [{ Ebs: { VolumeType: "gp2" } }],
    },
  },
  {
    id: "BP-EC2-011",
    resourceType: "AWS::EC2::Instance",
    triggeringState: {
      EbsOptimized: false,
    },
  },
  {
    id: "BP-EC2-017",
    resourceType: "AWS::EC2::Instance",
    triggeringState: {
      MetadataOptions: { HttpPutResponseHopLimit: 2 },
    },
  },
  {
    id: "BP-SG-002",
    resourceType: "AWS::EC2::SecurityGroup",
    triggeringState: {
      // check_type: not_equals, expected: "0.0.0.0/0:22"
      // Fires when SecurityGroupIngress === "0.0.0.0/0:22"
      SecurityGroupIngress: "0.0.0.0/0:22",
    },
  },
  // --- RDS rules ---
  {
    id: "BP-RDS-001",
    resourceType: "AWS::RDS::DBInstance",
    triggeringState: {
      PubliclyAccessible: true,
    },
  },
  {
    id: "BP-RDS-002",
    resourceType: "AWS::RDS::DBInstance",
    triggeringState: {
      StorageEncrypted: false,
    },
  },
  {
    id: "BP-RDS-008",
    resourceType: "AWS::RDS::DBInstance",
    triggeringState: {
      EnableIAMDatabaseAuthentication: false,
    },
  },
  {
    id: "BP-RDS-009",
    resourceType: "AWS::RDS::DBInstance",
    triggeringState: {
      CopyTagsToSnapshot: false,
    },
  },
  {
    id: "BP-RDS-010",
    resourceType: "AWS::RDS::DBInstance",
    triggeringState: {
      AutoMinorVersionUpgrade: false,
    },
  },
  // --- ECR rules ---
  {
    id: "BP-ECR-001",
    resourceType: "AWS::ECR::Repository",
    triggeringState: {
      ImageScanningConfiguration: { ScanOnPush: false },
    },
  },
  {
    id: "BP-ECR-002",
    resourceType: "AWS::ECR::Repository",
    triggeringState: {
      ImageTagMutability: "MUTABLE",
    },
  },
  // --- Logs rules ---
  {
    id: "BP-LOGS-001",
    resourceType: "AWS::Logs::LogGroup",
    triggeringState: {
      // check_type is "exists" on RetentionInDays — omit to trigger
    },
  },
  // --- VPC / Subnet rules ---
  {
    id: "BP-SUBNET-001",
    resourceType: "AWS::EC2::Subnet",
    triggeringState: {
      MapPublicIpOnLaunch: true,
    },
  },
  {
    id: "BP-VPC-001",
    resourceType: "AWS::EC2::VPC",
    triggeringState: {
      EnableDnsHostnames: false,
    },
  },
];

describe("Auto-fix audit: all auto-fixable BP rules have correct desiredStatePatch", () => {
  it(`should have exactly ${testCases.length} auto-fixable rules loaded from YAML`, () => {
    // Verify our test cases cover every auto-fixable rule
    const autoFixIds = autoFixablePractices.map((p) => p.id).sort();
    const testCaseIds = testCases.map((tc) => tc.id).sort();

    // First check: the count of auto-fixable rules matches our test cases
    expect(autoFixablePractices.length).toBe(testCases.length);

    // Second check: every auto-fixable rule ID is covered by a test case
    expect(testCaseIds).toEqual(autoFixIds);
  });

  it.each(testCases)(
    "$id: finding fires with autoFixable=true and desiredStatePatch defined",
    ({ id, resourceType, triggeringState }) => {
      const practice = autoFixablePractices.find((p) => p.id === id);
      expect(practice).toBeDefined();

      const context: EvalContext = {
        resourceType,
        desiredState: triggeringState,
      };

      const findings = evaluateTriggers(context, [practice!]);
      const finding = findings.find((f) => f.practiceId === id);

      expect(finding).toBeDefined();
      expect(finding!.autoFixable).toBe(true);
      expect(finding!.desiredStatePatch).toBeDefined();
      expect(Object.keys(finding!.desiredStatePatch!).length).toBeGreaterThan(
        0,
      );
    },
  );

  it.each(testCases)(
    "$id: desiredStatePatch fixes the finding when applied via deep merge",
    ({ id, resourceType, triggeringState }) => {
      const practice = autoFixablePractices.find((p) => p.id === id);
      expect(practice).toBeDefined();

      // Step 1: get the finding and its patch
      const contextBefore: EvalContext = {
        resourceType,
        desiredState: triggeringState,
      };
      const findingsBefore = evaluateTriggers(contextBefore, [practice!]);
      const finding = findingsBefore.find((f) => f.practiceId === id);
      expect(finding).toBeDefined();

      const patch = finding!.desiredStatePatch!;

      // Step 2: apply the patch via deep merge
      const fixedState = deepMerge(triggeringState, patch);

      // Step 3: re-evaluate — the finding should no longer fire
      const contextAfter: EvalContext = {
        resourceType,
        desiredState: fixedState,
      };
      const findingsAfter = evaluateTriggers(contextAfter, [practice!]);
      const findingAfter = findingsAfter.find((f) => f.practiceId === id);

      expect(findingAfter).toBeUndefined();
    },
  );
});
