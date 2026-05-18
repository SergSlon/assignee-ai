/**
 * Unit tests for the query_handler node.
 *
 * Covers: empty-result, single-match, multi-match, no-match (unrecognised
 * type), fetcher-throws, no-fetcher injected, and keyword-to-CFN-type
 * inference.
 *
 * Story: feature-query-intent-classifier
 */

import { describe, it, expect, vi } from "vitest";

// query-handler emits `query_executed` audit events via appendAuditRecord.
// Without this mock the test pollutes the operator's real
// `~/.assignee/audit/audit.log` and the 90-day retention floor blocks
// cleanup. Pre-existing oversight unrelated to Wave B-1, surfaced while
// auditing audit-log isolation; chain integrity is exercised in
// `packages/core/src/audit/audit-log.test.ts`.
vi.mock("../../audit/audit-log.js", () => ({
  appendAuditRecord: vi.fn().mockResolvedValue(undefined),
  readAuditLog: vi.fn().mockResolvedValue([]),
  auditLogExists: vi.fn().mockReturnValue(false),
  guardAuditLogTruncation: vi.fn().mockResolvedValue({ ok: true }),
  isAuditEntryWithinRetentionFloor: vi.fn().mockReturnValue(false),
  DEFAULT_AUDIT_LOG_DIR: "/tmp/assignee-test-audit",
  DEFAULT_AUDIT_LOG_FILE: "/tmp/assignee-test-audit/audit.log",
}));

import {
  createQueryHandlerNode,
  inferResourceTypeFromQuery,
  type ManagedResourceFetcher,
} from "./query-handler.js";
import { ExecutionStatus } from "../../schema/graph-state.js";
import type { AgentState } from "../graph-state.js";
import type { ManagedResource } from "../../list-resources/types.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeResource(partial: Partial<ManagedResource> = {}): ManagedResource {
  return {
    resourceType: "AWS::CloudFront::Distribution",
    arn: "arn:aws:cloudfront::112233445566:distribution/E1234567890ABC",
    region: "global",
    createdDate: "2026-05-06T16:35:00Z",
    estimatedMonthlyCost: "$2.40/mo",
    ...partial,
  };
}

function baseState(partial: Partial<AgentState> = {}): AgentState {
  return {
    userIntent: "what's my CloudFront site URL?",
    runId: "test-run-id",
    executionMode: "apply",
    resourceType: "",
    executionStatus: "PENDING",
    ...partial,
  } as AgentState;
}

// ─── inferResourceTypeFromQuery tests ─────────────────────────────────────────

describe("inferResourceTypeFromQuery", () => {
  it("maps 'cloudfront' to AWS::CloudFront::Distribution", () => {
    expect(inferResourceTypeFromQuery("what's my cloudfront URL?")).toBe(
      "AWS::CloudFront::Distribution",
    );
  });

  it("maps 'distribution' to AWS::CloudFront::Distribution", () => {
    expect(inferResourceTypeFromQuery("list my distribution endpoints")).toBe(
      "AWS::CloudFront::Distribution",
    );
  });

  it("maps 's3 bucket' to AWS::S3::Bucket", () => {
    expect(inferResourceTypeFromQuery("list my s3 buckets")).toBe(
      "AWS::S3::Bucket",
    );
  });

  it("maps 'S3' alone to AWS::S3::Bucket", () => {
    expect(inferResourceTypeFromQuery("show me my S3 resources")).toBe(
      "AWS::S3::Bucket",
    );
  });

  it("maps 'lambda' to AWS::Lambda::Function", () => {
    expect(inferResourceTypeFromQuery("list my lambda functions")).toBe(
      "AWS::Lambda::Function",
    );
  });

  it("maps 'vpc' to AWS::EC2::VPC", () => {
    expect(inferResourceTypeFromQuery("what VPCs do I have?")).toBe(
      "AWS::EC2::VPC",
    );
  });

  it("maps 'security group' to AWS::EC2::SecurityGroup", () => {
    expect(inferResourceTypeFromQuery("list my security groups")).toBe(
      "AWS::EC2::SecurityGroup",
    );
  });

  it("returns undefined for unrecognised query", () => {
    expect(inferResourceTypeFromQuery("what's the weather in Dublin?")).toBe(
      undefined,
    );
  });

  it("returns undefined for empty string", () => {
    expect(inferResourceTypeFromQuery("")).toBe(undefined);
  });

  // ─── HIGH 2: false-positive regression tests ─────────────────────────────
  // Before the fix, broad patterns caused incorrect type inference:
  //   - /ec2|instance/i swallowed "rds instance" (should be RDS)
  //   - /kms|key/i matched "API key" / "SSH key"
  //   - /lambda|function/i matched "function" alone
  //   - /sns|topic/i matched "topic" alone
  //   - /efs|file system/i matched "file system" alone

  it("HIGH 2: 'rds instance' maps to AWS::RDS::DBInstance, NOT EC2::Instance", () => {
    // EC2 comes after RDS in the table — more-specific wins.
    expect(inferResourceTypeFromQuery("list my rds instances")).toBe(
      "AWS::RDS::DBInstance",
    );
  });

  it("HIGH 2: 'API key' does NOT map to KMS — bare 'key' is ambiguous", () => {
    // kms pattern only fires on \bkms\b or \bkms key\b — not bare "key"
    expect(inferResourceTypeFromQuery("what's my API key?")).toBe(undefined);
  });

  it("HIGH 2: 'SSH key' does NOT map to KMS", () => {
    expect(inferResourceTypeFromQuery("show me my SSH key")).toBe(undefined);
  });

  it("HIGH 2: bare 'function' does NOT map to Lambda (too generic)", () => {
    // 'function' alone is too ambiguous — should return undefined, not Lambda.
    expect(
      inferResourceTypeFromQuery("what function handles my requests?"),
    ).toBe(undefined);
  });

  it("HIGH 2: bare 'topic' does NOT map to SNS (too generic)", () => {
    expect(inferResourceTypeFromQuery("discuss this topic with me")).toBe(
      undefined,
    );
  });

  it("HIGH 2: bare 'file system' does NOT map to EFS (too generic)", () => {
    expect(inferResourceTypeFromQuery("the local file system")).toBe(undefined);
  });

  it("HIGH 2: bare 'instance' does NOT map to EC2 (too generic)", () => {
    // 'instance' alone is ambiguous (RDS instance, ECS instance, etc.)
    expect(inferResourceTypeFromQuery("that instance was helpful")).toBe(
      undefined,
    );
  });

  it("HIGH 2: 'kms key' maps correctly to AWS::KMS::Key", () => {
    expect(inferResourceTypeFromQuery("list my kms keys")).toBe(
      "AWS::KMS::Key",
    );
  });

  it("maps 'lambda function' to AWS::Lambda::Function (explicit phrase)", () => {
    expect(inferResourceTypeFromQuery("list my lambda functions")).toBe(
      "AWS::Lambda::Function",
    );
  });

  it("maps 'ec2 instance' to AWS::EC2::Instance (explicit phrase)", () => {
    expect(inferResourceTypeFromQuery("show my ec2 instances")).toBe(
      "AWS::EC2::Instance",
    );
  });
});

// ─── createQueryHandlerNode tests ─────────────────────────────────────────────

describe("createQueryHandlerNode", () => {
  it("returns QUERY_INTENT with matched resources (single match)", async () => {
    const cf = makeResource();
    const fetcher: ManagedResourceFetcher = vi.fn().mockResolvedValue([cf]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "what's my CloudFront site URL?",
    });
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.queryResult?.resources).toHaveLength(1);
    expect(result.queryResult?.resources[0]?.arn).toBe(cf.arn);
    expect(result.queryResult?.isEmpty).toBe(false);
    expect(result.queryResult?.naturalQuestion).toBe(
      "what's my CloudFront site URL?",
    );
    expect(result.queryResult?.resourceType).toBe(
      "AWS::CloudFront::Distribution",
    );
  });

  it("returns QUERY_INTENT with multiple resources (multi-match)", async () => {
    const cf1 = makeResource({
      arn: "arn:aws:cloudfront::111:distribution/E1",
    });
    const cf2 = makeResource({
      arn: "arn:aws:cloudfront::111:distribution/E2",
    });
    const fetcher: ManagedResourceFetcher = vi
      .fn()
      .mockResolvedValue([cf1, cf2]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "what are my cloudfront distributions?",
    });
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.queryResult?.resources).toHaveLength(2);
    expect(result.queryResult?.isEmpty).toBe(false);
  });

  it("returns QUERY_INTENT with isEmpty=true when no resources found", async () => {
    const fetcher: ManagedResourceFetcher = vi.fn().mockResolvedValue([]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "list my S3 buckets",
    });
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.queryResult?.isEmpty).toBe(true);
    expect(result.queryResult?.resources).toHaveLength(0);
  });

  it("returns QUERY_INTENT with all resources when query type is unrecognised", async () => {
    // "what's the weather" → no type match → fetcher called with undefined → returns all resources
    const s3 = makeResource({
      resourceType: "AWS::S3::Bucket",
      arn: "arn:aws:s3:::my-bucket",
      region: "us-east-1",
    });
    const fetcher: ManagedResourceFetcher = vi.fn().mockResolvedValue([s3]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "what managed resources do I have?",
    });
    const result = await node(state);

    // No specific type → fetcher called with undefined
    expect(fetcher).toHaveBeenCalledWith(undefined);
    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.queryResult?.resourceType).toBeUndefined();
    expect(result.queryResult?.resources).toHaveLength(1);
  });

  it("returns FAILED with helpful message when fetcher throws", async () => {
    const fetcher: ManagedResourceFetcher = vi
      .fn()
      .mockRejectedValue(
        new Error("AccessDeniedException: insufficient perms"),
      );
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "list my S3 buckets",
    });
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.FAILED);
    expect(result.errorMessage).toContain("AccessDeniedException");
    expect(result.errorMessage).toContain("assignee admin list");
    expect(result.queryResult).toBeUndefined();
  });

  it("surfaces helpful message when no fetcher injected", async () => {
    const node = createQueryHandlerNode(); // no fetcher
    const state = baseState({ userIntent: "list my resources" });
    const result = await node(state);

    expect(result.executionStatus).toBe(ExecutionStatus.QUERY_INTENT);
    expect(result.errorMessage).toContain("assignee admin list");
    expect(result.queryResult?.isEmpty).toBe(true);
  });

  it("uses state.resourceType when already set by intent-parser", async () => {
    // The intent-parser may have extracted a resourceType before routing to
    // query-handler (e.g. when the kind classifier returned both a kind AND a type)
    const fetcher: ManagedResourceFetcher = vi.fn().mockResolvedValue([]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "show me my S3",
      resourceType: "AWS::S3::Bucket", // pre-classified
    });
    const result = await node(state);

    // fetcher should be called with the pre-classified type, NOT keyword-inferred
    expect(fetcher).toHaveBeenCalledWith("AWS::S3::Bucket");
    expect(result.queryResult?.resourceType).toBe("AWS::S3::Bucket");
  });

  it("falls back to keyword inference when state.resourceType is empty", async () => {
    const fetcher: ManagedResourceFetcher = vi.fn().mockResolvedValue([]);
    const node = createQueryHandlerNode(fetcher);

    const state = baseState({
      userIntent: "list my lambda functions",
      resourceType: "", // empty — must fall back to keyword inference
    });
    const result = await node(state);

    expect(fetcher).toHaveBeenCalledWith("AWS::Lambda::Function");
    expect(result.queryResult?.resourceType).toBe("AWS::Lambda::Function");
  });
});
