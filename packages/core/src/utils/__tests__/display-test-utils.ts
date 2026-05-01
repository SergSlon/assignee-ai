/**
 * Shared test utilities for display.ts split test files.
 * NOT exported from any public barrel — test infrastructure only.
 *
 * Used by:
 *   - display-plan-box.test.ts
 *   - display-plan-box-variants.test.ts
 *   - display-option-prompt.test.ts
 *   - display-interactive.test.ts
 *   - display-output.test.ts
 *   - display-epic35.test.ts
 */

import { vi } from "vitest";
import type { BPFinding } from "@assignee/best-practices";

// Capture stdout/stderr writes
export function captureStream(stream: NodeJS.WriteStream) {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(stream, "write")
    .mockImplementation((chunk: unknown, ..._args: unknown[]) => {
      chunks.push(String(chunk));
      return true;
    });
  return { chunks, spy, restore: () => spy.mockRestore() };
}

export const mockState = {
  resourceType: "AWS::S3::Bucket",
  desiredState: { BucketName: "my-test-bucket" },
  estimatedMonthlyCost: "~$0.02/month",
  runId: "run-display-test-123",
  resourceArn: undefined,
  executionMode: "plan",
};

// ── Realistic BP-style findings for Epic 35 test matrix ──────────────────────
// All include propertyPath and use real S3/EC2 practice IDs.

export const s3PublicAccessFinding: BPFinding = {
  practiceId: "BP-S3-001",
  title: "Block S3 Public Access",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket allows public access",
  remediation: "Enable PublicAccessBlockConfiguration on the bucket",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.BlockPublicAcls",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { BlockPublicAcls: true },
  },
};

export const s3PublicPolicyFinding: BPFinding = {
  practiceId: "BP-S3-001b",
  title: "Block S3 Public Policy",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket allows public policy",
  remediation: "Set BlockPublicPolicy to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.BlockPublicPolicy",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { BlockPublicPolicy: true },
  },
};

export const s3IgnorePublicAclsFinding: BPFinding = {
  practiceId: "BP-S3-001c",
  title: "Ignore Public ACLs",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket does not ignore public ACLs",
  remediation: "Set IgnorePublicAcls to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.IgnorePublicAcls",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { IgnorePublicAcls: true },
  },
};

export const s3RestrictPublicBucketsFinding: BPFinding = {
  practiceId: "BP-S3-001d",
  title: "Restrict Public Buckets",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket does not restrict public buckets",
  remediation: "Set RestrictPublicBuckets to true",
  blocking: true,
  autoFixable: true,
  propertyPath: "PublicAccessBlockConfiguration.RestrictPublicBuckets",
  desiredStatePatch: {
    PublicAccessBlockConfiguration: { RestrictPublicBuckets: true },
  },
};

export const s3EncryptionFinding: BPFinding = {
  practiceId: "BP-S3-006",
  title: "Enable S3 Default Encryption",
  severity: "CRITICAL",
  category: "security",
  message: "S3 bucket lacks default encryption",
  remediation: "Configure ServerSideEncryptionConfiguration with AES256",
  blocking: true,
  autoFixable: true,
  propertyPath: "BucketEncryption.ServerSideEncryptionConfiguration",
  desiredStatePatch: {
    BucketEncryption: {
      ServerSideEncryptionConfiguration: "AES256",
    },
  },
};

export const ec2EbsEncryptionFinding: BPFinding = {
  practiceId: "BP-EC2-003",
  title: "Encrypt EBS Volumes",
  severity: "HIGH",
  category: "security",
  message: "EBS volumes should be encrypted at rest",
  remediation: "Set Ebs.Encrypted to true in BlockDeviceMappings",
  blocking: false,
  autoFixable: true,
  propertyPath: "BlockDeviceMappings[0].Ebs.Encrypted",
  desiredStatePatch: {
    BlockDeviceMappings: [{ Ebs: { Encrypted: true } }],
  },
};

export const s3LifecycleFinding: BPFinding = {
  practiceId: "BP-S3-010",
  title: "Configure S3 Lifecycle Rules",
  severity: "MEDIUM",
  category: "cost",
  message: "S3 bucket has no lifecycle rules for cost management",
  remediation:
    "Add LifecycleConfiguration rules to transition or expire objects",
  blocking: false,
  autoFixable: false,
  propertyPath: "LifecycleConfiguration",
};

export const s3VersioningInfoFinding: BPFinding = {
  practiceId: "BP-S3-010",
  title: "Enable Versioning for Backup",
  severity: "INFO",
  category: "reliability",
  message: "Versioning improves data durability",
  remediation: "Set VersioningConfiguration.Status to Enabled",
  blocking: false,
  autoFixable: false,
  fixType: "info",
  propertyPath: "VersioningConfiguration.Status",
  fixHint: "Consider enabling versioning for data protection",
};

export const manualFindingWithHint: BPFinding = {
  practiceId: "BP-S3-020",
  title: "Configure CORS Policy",
  severity: "INFO",
  category: "security",
  message: "Bucket may need CORS configuration for web access",
  remediation: "raw remediation text that should not appear",
  blocking: false,
  autoFixable: false,
  fixType: "info",
  propertyPath: "",
  fixHint: "Review CORS requirements for your web application",
};
