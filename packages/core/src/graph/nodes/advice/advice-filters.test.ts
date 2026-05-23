import { describe, it, expect } from "vitest";
import {
  filterSelfReferentialAdvice,
  filterAdviceContradictingFindings,
} from "./advice-filters.js";

/**
 * Tests for SX-6 — filterSelfReferentialAdvice
 *
 * Probe variations (A-F per spec):
 *   A — "Change the FooName to 'X'" with FooName === X already in plan → filtered
 *   B — "Change the FooName to 'X'" with FooName !== X (genuine recommendation) → kept
 *   C — Advice about a resource/property absent from plan → kept
 *   D — Stale boolean "Enable PointInTimeRecovery" when plan already true → filtered
 *   E — Genuine future-work guidance with no verb pattern → kept
 *   F — Cost-actionable advice with no matching pattern → kept
 */
describe("filterSelfReferentialAdvice", () => {
  // ──────────────────────────────────────────────────────────────────
  // Variation A — "Change the <Prop> to '<X>'" when X already in plan
  // ──────────────────────────────────────────────────────────────────
  describe("Variation A — Change-to with matching plan value (FILTERED)", () => {
    it("suppresses 'Change the TopicName to X' when plan.TopicName === X", () => {
      const plan = { TopicName: "genai-next-events" };
      const lines = [
        "Change the TopicName to 'genai-next-events' to match the user intent.",
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });

    it("suppresses 'Change DisplayName to X' when plan.DisplayName === X", () => {
      const plan = { DisplayName: "my-topic" };
      const lines = [
        `Change DisplayName to 'my-topic' for better readability.`,
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });

    it("suppresses 'Update the BucketName to X' when plan.BucketName === X", () => {
      const plan = { BucketName: "my-artifacts-bucket" };
      const lines = [
        "Update the BucketName to 'my-artifacts-bucket' to match your request.",
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });

    it("suppresses 'Set FunctionName to X' when plan.FunctionName === X", () => {
      const plan = { FunctionName: "data-processor" };
      const lines = [
        `Set FunctionName to 'data-processor' to match the user intent.`,
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation B — "Change the <Prop> to '<X>'" when X differs (KEPT)
  // ──────────────────────────────────────────────────────────────────
  describe("Variation B — Change-to with DIFFERENT plan value (KEPT)", () => {
    it("keeps 'Change the TopicName to X' when plan.TopicName !== X", () => {
      const plan = { TopicName: "old-topic-name" };
      const lines = [
        "Change the TopicName to 'genai-next-events' for better discoverability.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });

    it("keeps 'Change InstanceType to X' when InstanceType differs", () => {
      const plan = { InstanceType: "t3.micro" };
      const lines = [
        "Change the InstanceType to 't3.medium' for better performance.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation C — Advice referencing absent keys (KEPT)
  // ──────────────────────────────────────────────────────────────────
  describe("Variation C — Advice about absent plan properties (KEPT)", () => {
    it("keeps advice when the referenced property is not in the plan", () => {
      const plan = { BucketName: "my-bucket" };
      const lines = [
        "Change the VersioningConfiguration to 'Enabled' to protect against accidental deletion.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });

    it("keeps 'Set KMSMasterKeyID to X' when KMSMasterKeyID absent from plan", () => {
      const plan = { QueueName: "my-queue" };
      const lines = [
        "Set KMSMasterKeyID to 'arn:aws:kms:us-east-1:123456789012:key/abc' for encryption.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation D — Stale boolean "Enable X" when plan already true
  // ──────────────────────────────────────────────────────────────────
  describe("Variation D — Stale 'Enable X' advice already applied (FILTERED)", () => {
    it("suppresses 'Enable PointInTimeRecovery' when plan.PointInTimeRecovery === true", () => {
      const plan = {
        TableName: "orders",
        PointInTimeRecovery: true,
      };
      const lines = [
        "Enable PointInTimeRecovery to protect your DynamoDB table from accidental writes.",
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });

    it("suppresses 'Enable MultiAZ' when plan.MultiAZ === true", () => {
      const plan = { DBInstanceIdentifier: "prod-db", MultiAZ: true };
      const lines = [
        "Enable MultiAZ for high availability of your RDS instance.",
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });

    it("suppresses stale enable advice nested inside a sub-object", () => {
      const plan = {
        TableName: "sessions",
        SSESpecification: { SSEEnabled: true },
      };
      const lines = [
        "Enable SSEEnabled to encrypt the DynamoDB table at rest.",
      ];
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation E — Genuine future-work guidance (KEPT)
  // ──────────────────────────────────────────────────────────────────
  describe("Variation E — Genuine advisory guidance (KEPT)", () => {
    it("preserves 'Consider Multi-AZ for production reliability' — no verb pattern match", () => {
      const plan = { DBInstanceIdentifier: "dev-db", MultiAZ: false };
      const lines = ["Consider enabling Multi-AZ for production reliability."];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });

    it("preserves advice about a property set to false", () => {
      const plan = { VersioningConfiguration: { Status: "Suspended" } };
      const lines = [
        "Enable versioning to recover from accidental object deletions.",
      ];
      // Status is "Suspended" (falsy-ish), so enable-pattern should NOT suppress
      const result = filterSelfReferentialAdvice(lines, plan);
      // "Status" is the key inside the nested object; the plan has it as "Suspended"
      // (not true/enabled), so the filter should KEEP this line
      expect(result).toEqual(lines);
    });

    it("preserves architectural hints with no pattern verbs", () => {
      const plan = { Runtime: "nodejs18.x", MemorySize: 128 };
      const lines = [
        "Increase MemorySize to 512 MB for CPU-intensive workloads.",
        "Consider using Graviton2 (arm64) architecture to reduce Lambda costs by up to 20%.",
      ];
      // "Increase" is not a pattern verb — both lines should be kept
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation F — Cost / IAM actionable advice (KEPT)
  // ──────────────────────────────────────────────────────────────────
  describe("Variation F — Cost / IAM actionable advice (KEPT)", () => {
    it("preserves 'Use Reserved Instances for sustained workloads'", () => {
      const plan = { InstanceType: "t3.medium" };
      const lines = [
        "Use Reserved Instances for sustained workloads to save up to 40% vs On-Demand.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });

    it("preserves 'Ensure pricing:GetProducts IAM grant is present'", () => {
      const plan = { QueueName: "data-pipeline" };
      const lines = [
        "Ensure the pricing:GetProducts IAM grant is present for real-time cost estimates.",
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Mixed input — some filtered, some preserved
  // ──────────────────────────────────────────────────────────────────
  describe("mixed advice lines", () => {
    it("removes only self-referential lines, preserving all others", () => {
      const plan = {
        TopicName: "genai-next-events",
        DisplayName: "genai-next-events",
      };
      const lines = [
        "Change the TopicName to 'genai-next-events' to match the user intent.", // filtered A
        "Change the DisplayName to 'genai-next-events' for better readability.", // filtered A
        "Consider enabling server-side encryption for sensitive event data.", // kept E
        "Use Reserved Instances for sustained workloads to save costs.", // kept F
      ];
      const result = filterSelfReferentialAdvice(lines, plan);
      expect(result).toHaveLength(2);
      expect(result).toContain(
        "Consider enabling server-side encryption for sensitive event data.",
      );
      expect(result).toContain(
        "Use Reserved Instances for sustained workloads to save costs.",
      );
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Edge cases
  // ──────────────────────────────────────────────────────────────────
  describe("edge cases", () => {
    it("returns empty array unchanged", () => {
      expect(filterSelfReferentialAdvice([], { TopicName: "foo" })).toEqual([]);
    });

    it("returns all lines when plan is empty", () => {
      const lines = [
        "Change the TopicName to 'foo' for consistency.",
        "Consider enabling Multi-AZ.",
      ];
      // Plan is empty → no cross-reference possible → all lines kept
      const result = filterSelfReferentialAdvice(lines, {});
      expect(result).toEqual(lines);
    });

    it("handles case-insensitive property key matching", () => {
      // Plan uses camelCase; advice uses PascalCase
      const plan = { topicName: "my-topic" };
      const lines = [
        "Change the TopicName to 'my-topic' to match the user intent.",
      ];
      // Should still suppress — key matching is case-insensitive
      expect(filterSelfReferentialAdvice(lines, plan)).toEqual([]);
    });
  });
});

/**
 * F11 insurance — filterAdviceContradictingFindings
 *
 * Suppresses LLM-generated advice that contradicts emitted BP findings.
 * Today the only finding wired is BP-EC2-015 ("current generation
 * instance type"). Filter drops any advice line that names a
 * previous-gen EC2 instance type (t1.*, t2.*, m1-4.*, c1/c3/c4.*,
 * r3.*, r4.*, i2.*) when that finding fires.
 *
 * @see _backlog/wizard-ux-audit-2026-05-22.md F11
 */
describe("filterAdviceContradictingFindings", () => {
  // ──────────────────────────────────────────────────────────────────
  // Variation A — BP-EC2-015 fired + t2.micro recommended → FILTERED
  // ──────────────────────────────────────────────────────────────────
  describe("BP-EC2-015 fired (previous-gen contradiction)", () => {
    it("drops 'Consider t2.micro' when BP-EC2-015 fires (by practiceId)", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "💰 Consider using t2.micro for cost savings.",
        "🔒 IMDSv2 enforced — instance metadata is protected.",
      ];
      const result = filterAdviceContradictingFindings(lines, findings);
      expect(result).toEqual([
        "🔒 IMDSv2 enforced — instance metadata is protected.",
      ]);
    });

    it("drops 'Switch to m4.large' when BP-EC2-015 fires", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = ["Consider downsizing to m4.large for cost efficiency."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });

    it("matches by title when practiceId is something else", () => {
      const findings = [
        {
          practiceId: "ARBITRARY-ID",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = ["Consider c3.xlarge for compute workloads."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });

    it("filters multiple previous-gen prefixes in one sweep", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "Try t1.micro for free-tier",
        "Or r3.large for memory-bound",
        "Or i2.xlarge for storage-bound",
        "Consider t4g.micro instead", // CURRENT gen → KEPT
      ];
      const result = filterAdviceContradictingFindings(lines, findings);
      expect(result).toEqual(["Consider t4g.micro instead"]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation B — BP-EC2-015 NOT fired → previous-gen advice KEPT
  // ──────────────────────────────────────────────────────────────────
  describe("BP-EC2-015 NOT fired (no contradiction)", () => {
    it("preserves 't2.micro' advice when current-gen finding absent", () => {
      const findings = [
        {
          practiceId: "BP-EC2-001",
          title: "EC2 EBS volumes should be encrypted",
        },
      ];
      const lines = ["💰 Consider using t2.micro for cost savings."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });

    it("preserves all advice with an empty findings array", () => {
      const lines = [
        "Consider t2.micro",
        "Try m4.large",
        "Or t3.micro (current-gen)",
      ];
      expect(filterAdviceContradictingFindings(lines, [])).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation C — Current-gen instance types ALWAYS kept
  // ──────────────────────────────────────────────────────────────────
  describe("Current-gen instance types preserved", () => {
    it("keeps t3.* / t4g.* / m5.* / m6i.* / c5.* / c6i.* / r5.* / r6i.*", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "Consider t3.micro (current-gen burstable)",
        "Try t4g.nano (Graviton, cheapest)",
        "m5.large for general purpose",
        "m6i.xlarge for newer Intel",
        "c5.large for compute",
        "c6i.xlarge for newer compute",
        "r5.large for memory",
        "r6i.xlarge for newer memory",
      ];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation D — Edge cases
  // ──────────────────────────────────────────────────────────────────
  describe("Edge cases", () => {
    it("returns empty array when adviceLines is empty", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      expect(filterAdviceContradictingFindings([], findings)).toEqual([]);
    });

    it("does NOT match prose 'previous generation' without an instance-type token", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "Avoid previous-generation instances for performance reasons.",
      ];
      // Conservative: no explicit token → keep
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });

    it("case-insensitive instance-type matching (T2.MICRO)", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = ["Consider T2.MICRO for cost savings."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });

    it("KEEPS doc-URL fragments containing prefix.<word> (Quinn HIGH-1)", () => {
      // Word-boundary regex: `/c3.html` and `/m4.png` ONLY match when
      // the segment after the dot is a valid instance size (nano,
      // micro, small, medium, large, xlarge, Nxlarge). URL extensions
      // / doc-section refs don't satisfy the size suffix → no match.
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "See https://docs.aws.amazon.com/ec2/latest/c3.html for the deprecation notice.",
        "Refer to section m4.png of the migration runbook.",
        "Topic: t2.json (sample data fixture).",
      ];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });

    it("matches all Nxlarge size variants (c3.2xlarge, m4.16xlarge, r3.8xlarge)", () => {
      const findings = [
        {
          practiceId: "BP-EC2-015",
          title: "EC2 instance should use current generation instance type",
        },
      ];
      const lines = [
        "Consider c3.2xlarge for the compute workload.",
        "Switch to m4.16xlarge for the analytics tier.",
        "Use r3.8xlarge for the in-memory cache.",
      ];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation E — BP-EC2-002 (EBS encryption) cross-check
  // ──────────────────────────────────────────────────────────────────
  describe("BP-EC2-002 fired (EBS-must-be-encrypted contradiction)", () => {
    const ebsFinding = {
      practiceId: "BP-EC2-002",
      title: "EC2 EBS volumes should be encrypted",
    };

    it("drops 'Encrypted: false' snippet when BP-EC2-002 fires", () => {
      const lines = [
        "💰 Use Encrypted: false on root volume to save cost.",
        "🛠 Tag the instance for cost-center routing.",
      ];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual([
        "🛠 Tag the instance for cost-center routing.",
      ]);
    });

    it("drops 'Encrypted=false' (no-space variant)", () => {
      const lines = ["Set Encrypted=false to skip KMS cost overhead."];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual(
        [],
      );
    });

    it('drops JSON-style "Encrypted": false', () => {
      const lines = [`Set "Encrypted": false in BlockDeviceMappings.`];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual(
        [],
      );
    });

    it("drops 'unencrypted EBS' / 'unencrypted volume' / 'unencrypted disk' prose", () => {
      const lines = [
        "Switch to unencrypted EBS volumes for performance.",
        "Use an unencrypted volume to avoid KMS charges.",
        "An unencrypted disk halves the IOPS cost.",
        "Provision unencrypted block storage for ephemeral data.",
      ];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual(
        [],
      );
    });

    it("drops 'disable EBS encryption' / 'skip encryption' / 'turn off encryption'", () => {
      const lines = [
        "Disable EBS encryption to reduce KMS API calls.",
        "Skip encryption on dev environments.",
        "Turn off encryption for ephemeral scratch disks.",
        "Remove encryption to simplify cross-account snapshot sharing.",
      ];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual(
        [],
      );
    });

    it("matches by title fragment ('EBS' + 'encrypt') when practiceId differs", () => {
      const findings = [
        {
          practiceId: "CUSTOM-EBS-1",
          title: "All EBS volumes must be encrypted at rest",
        },
      ];
      const lines = ["Switch to unencrypted EBS for speed."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });

    it("KEEPS legitimate encryption advice when BP-EC2-002 fires", () => {
      // Pro-encryption / topic-mention guidance must NOT be filtered.
      const lines = [
        "Enable EBS encryption at the account level for defense in depth.",
        "Consider AWS KMS customer-managed keys for tighter control.",
        "Encryption is enforced — no action needed.",
      ];
      expect(filterAdviceContradictingFindings(lines, [ebsFinding])).toEqual(
        lines,
      );
    });

    it("KEEPS 'unencrypted EBS' advice when BP-EC2-002 does NOT fire", () => {
      const findings = [
        { practiceId: "BP-EC2-015", title: "current generation" },
      ];
      const lines = ["Switch to unencrypted EBS volumes for performance."];
      // No EBS-encryption finding present → filter doesn't engage on
      // EBS lines (though the current-gen filter would still drop
      // previous-gen tokens if any appeared).
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Variation F — BP-S3-001/002/003/004 (public-access) cross-check
  // ──────────────────────────────────────────────────────────────────
  describe("BP-S3-001..004 fired (S3 public-access contradiction)", () => {
    const acls = {
      practiceId: "BP-S3-001",
      title: "S3 bucket should block public ACLs",
    };
    const policies = {
      practiceId: "BP-S3-002",
      title: "S3 bucket should block public bucket policies",
    };
    const ignore = {
      practiceId: "BP-S3-003",
      title: "S3 bucket should ignore public ACLs",
    };
    const restrict = {
      practiceId: "BP-S3-004",
      title: "S3 bucket should restrict public bucket access",
    };

    it("drops 'public-read' canned ACL recommendation when BP-S3-001 fires", () => {
      const lines = [
        "For static website hosting, set the ACL to public-read.",
        "Apply the bucket policy you already have.",
      ];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual([
        "Apply the bucket policy you already have.",
      ]);
    });

    it("drops 'public-read-write' canned ACL recommendation", () => {
      const lines = ["Grant public-read-write to allow uploads from anywhere."];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual([]);
    });

    it("drops literal 'BlockPublicAcls: false' / '= false' settings", () => {
      const lines = [
        "Set BlockPublicAcls: false to allow read-only public access.",
        "Use BlockPublicPolicy = false for CloudFront origin compatibility.",
        "Set IgnorePublicAcls: false on the bucket.",
        "Configure RestrictPublicBuckets: false to permit website hosting.",
      ];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual([]);
    });

    it('drops JSON-style "BlockPublicAcls": false', () => {
      const lines = [
        `Patch PublicAccessBlockConfiguration with "BlockPublicAcls": false.`,
      ];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual([]);
    });

    it("drops CamelCase canned ACL values (PublicRead, PublicReadWrite) (Quinn HIGH-2)", () => {
      // SDK-style references — `BucketCannedACL.PublicRead` etc. The
      // LLM frequently emits these when paraphrasing Java/JS SDK code.
      const lines = [
        "Use the PublicRead canned ACL for static-site hosting.",
        "Set the bucket ACL to PublicReadWrite to enable uploads.",
        "Apply BucketCannedACL.PublicRead to the bucket.",
      ];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual([]);
    });

    it("fires for any of the four S3 public-access finding IDs", () => {
      const lines = ["Use the public-read canned ACL."];
      expect(filterAdviceContradictingFindings(lines, [policies])).toEqual([]);
      expect(filterAdviceContradictingFindings(lines, [ignore])).toEqual([]);
      expect(filterAdviceContradictingFindings(lines, [restrict])).toEqual([]);
    });

    it("matches by title fragment when practiceId is unrecognised", () => {
      const findings = [
        {
          practiceId: "CUSTOM-S3-1",
          title: "S3 bucket should not allow public access",
        },
      ];
      const lines = ["Apply the public-read canned ACL."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([]);
    });

    it("KEEPS legitimate public-access advice when BP-S3-001 fires", () => {
      // Pro-blocking / topic-mention guidance must NOT be filtered.
      // Specifically covers the "deny / block / disallow / prevent /
      // restrict public-read" lookbehind branch.
      const lines = [
        "Block public access at the account level for defense in depth.",
        "Deny public-read by enabling all four PublicAccessBlock controls.",
        "Disallow public-read access on every new bucket.",
        "Prevent public-read by enforcing organisation SCPs.",
        "Restrict public-read on bucket-level policies.",
        "Public access is already blocked — no action needed.",
        "Review which IAM principals have s3:PutObject on this bucket.",
      ];
      expect(filterAdviceContradictingFindings(lines, [acls])).toEqual(lines);
    });

    it("KEEPS 'public-read' advice when no S3 public-access finding fires", () => {
      const findings = [
        { practiceId: "BP-EC2-015", title: "current generation" },
      ];
      const lines = ["For static website hosting, use the public-read ACL."];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Multi-finding orchestration
  // ──────────────────────────────────────────────────────────────────
  describe("multiple findings firing together", () => {
    it("drops EC2 + EBS + S3 contradicting lines in one sweep", () => {
      const findings = [
        { practiceId: "BP-EC2-015", title: "current generation" },
        { practiceId: "BP-EC2-002", title: "EBS volumes should be encrypted" },
        {
          practiceId: "BP-S3-001",
          title: "S3 bucket should block public ACLs",
        },
      ];
      const lines = [
        "Consider t2.micro for cost savings.", // EC2-015 drops
        "Use unencrypted EBS volumes for raw IOPS.", // EC2-002 drops
        "Set the bucket ACL to public-read for static hosting.", // S3-001 drops
        "Enable VPC flow logs.", // unrelated → kept
      ];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([
        "Enable VPC flow logs.",
      ]);
    });

    it("preserves all lines when all relevant findings are absent", () => {
      const findings = [
        {
          practiceId: "BP-IAM-001",
          title: "IAM policies should use conditions",
        },
      ];
      const lines = [
        "Consider t2.micro.",
        "Use unencrypted EBS volumes.",
        "Set ACL to public-read.",
      ];
      // None of these findings engage the cross-check filter — all kept.
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual(lines);
    });

    it("drops a single line that matches multiple predicates (Quinn MED-2)", () => {
      // One advice line names both a previous-gen instance type AND
      // recommends Encrypted: false. Both predicates fire; the line
      // is filtered exactly once (Array.filter short-circuits via the
      // OR chain — first matching predicate kicks it out).
      const findings = [
        { practiceId: "BP-EC2-015", title: "current generation" },
        { practiceId: "BP-EC2-002", title: "EBS volumes should be encrypted" },
      ];
      const lines = [
        "Use a t2.micro instance with Encrypted: false to save cost.",
        "Keep this advice.",
      ];
      expect(filterAdviceContradictingFindings(lines, findings)).toEqual([
        "Keep this advice.",
      ]);
    });
  });
});
