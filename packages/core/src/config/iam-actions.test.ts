import { describe, it, expect } from "vitest";
import { getRequiredIamActions } from "./iam-actions.js";
import { DESTRUCTIVE_SERVICE_ACTIONS } from "./iam-policies/action-collector.js";
import { operatorPolicy } from "./iam-policies/operator.js";

describe("getRequiredIamActions", () => {
  const BASE_CCAPI_ACTIONS = [
    "cloudcontrol:CreateResource",
    "cloudcontrol:GetResource",
    "cloudcontrol:GetResourceRequestStatus",
    "cloudcontrol:UpdateResource",
    "cloudcontrol:DeleteResource",
    "cloudformation:GetResource",
    "cloudformation:GetResourceRequestStatus",
    "cloudformation:CreateResource",
    "cloudformation:DeleteResource",
    "cloudformation:UpdateResource",
  ];

  it("returns CloudControl base actions + S3-specific actions for AWS::S3::Bucket", () => {
    const actions = getRequiredIamActions("AWS::S3::Bucket");
    // Verify all base CCAPI actions are present
    for (const base of BASE_CCAPI_ACTIONS) {
      expect(actions).toContain(base);
    }
    // Verify key S3-specific actions
    expect(actions).toContain("s3:CreateBucket");
    expect(actions).toContain("s3:DeleteBucket");
    expect(actions).toContain("s3:PutBucket*");
    // destroy-service.ts uses ListObjectVersions + DeleteObjects(VersionId)
    // to empty versioned buckets before CloudControl DeleteResource runs.
    // Without these two actions, destroy emits a scary "not authorized"
    // warning even though the operation succeeds against unversioned buckets.
    expect(actions).toContain("s3:ListBucketVersions");
    expect(actions).toContain("s3:DeleteObjectVersion");
    // Bug S3-001 (2026-05-07): s3:ListBucket is required for ListObjectsV2
    // (non-versioned object enumeration). The s3BucketStrategy pre-delete
    // sweep needs this permission to list all objects in a non-versioned
    // bucket before calling DeleteObjects.
    expect(actions).toContain("s3:ListBucket");
  });

  it("returns CloudControl base actions + Lambda-specific actions for AWS::Lambda::Function", () => {
    const actions = getRequiredIamActions("AWS::Lambda::Function");
    // Verify all base CCAPI actions are present
    for (const base of BASE_CCAPI_ACTIONS) {
      expect(actions).toContain(base);
    }
    // Verify key Lambda-specific actions
    expect(actions).toContain("lambda:CreateFunction");
    expect(actions).toContain("lambda:DeleteFunction");
    expect(actions).toContain("lambda:GetFunction");
    expect(actions).toContain("lambda:TagResource");
    expect(actions).toContain("iam:PassRole");
  });

  it("returns only CloudControl base actions for unknown resource type", () => {
    const actions = getRequiredIamActions("AWS::Unknown::Resource");
    expect(actions).toEqual(BASE_CCAPI_ACTIONS);
  });

  it("returns valid IAM action format strings (service:Action)", () => {
    const allResourceTypes = [
      "AWS::S3::Bucket",
      "AWS::Lambda::Function",
      "AWS::DynamoDB::Table",
      "AWS::SQS::Queue",
      "AWS::SNS::Topic",
      "AWS::EC2::Instance",
      "AWS::RDS::DBInstance",
    ];

    for (const resourceType of allResourceTypes) {
      const actions = getRequiredIamActions(resourceType);
      for (const action of actions) {
        expect(action).toMatch(/^[a-z0-9]+:[A-Za-z*]+$/);
      }
    }
  });

  it("includes iam:PassRole for resource types that need it", () => {
    const lambdaActions = getRequiredIamActions("AWS::Lambda::Function");
    const ec2Actions = getRequiredIamActions("AWS::EC2::Instance");

    expect(lambdaActions).toContain("iam:PassRole");
    expect(ec2Actions).toContain("iam:PassRole");
  });

  it("does not include iam:PassRole for S3 buckets", () => {
    const actions = getRequiredIamActions("AWS::S3::Bucket");
    expect(actions).not.toContain("iam:PassRole");
  });

  // DF-DDB-TTL-IAM-MISSING (live dogfood 2026-05-11): `assignee apply
  // "Create a DDB table ... with TTL on expiresAt"` failed at the
  // post-create UpdateTimeToLive step with "is not authorized to
  // perform: dynamodb:UpdateTimeToLive" — the table was created
  // successfully but TTL never got enabled. Locks the fix.
  it("includes DDB TTL actions (UpdateTimeToLive + DescribeTimeToLive) for AWS::DynamoDB::Table", () => {
    const actions = getRequiredIamActions("AWS::DynamoDB::Table");
    expect(actions).toContain("dynamodb:UpdateTimeToLive");
    expect(actions).toContain("dynamodb:DescribeTimeToLive");
    // The other DDB modifier actions should still be present (regression
    // guard) — UpdateContinuousBackups is the closest analogue and was
    // there from W5.
    expect(actions).toContain("dynamodb:UpdateContinuousBackups");
    expect(actions).toContain("dynamodb:CreateTable");
    expect(actions).toContain("dynamodb:DeleteTable");
  });
});

// A1 (M-H-001): CloudFront invalidation actions must appear ONLY in
// the `CloudFrontInvalidationTagScoped` statement, NOT in the unscoped
// ServiceSpecificActionsA/B sweep.
describe("A1 — CloudFront tag-scoped IAM statement", () => {
  it("cloudfront:CreateInvalidation and cloudfront:GetInvalidation are in DESTRUCTIVE_SERVICE_ACTIONS (excluded from unscoped sweep)", () => {
    expect(
      DESTRUCTIVE_SERVICE_ACTIONS.has("cloudfront:CreateInvalidation"),
    ).toBe(true);
    expect(DESTRUCTIVE_SERVICE_ACTIONS.has("cloudfront:GetInvalidation")).toBe(
      true,
    );
  });

  it("operatorPolicy() contains a CloudFrontInvalidationTagScoped statement with tag condition", () => {
    // operatorPolicy() requires supported types — pass an empty array to get the
    // core policy shape (the CloudFront statement is always added).
    const policy = operatorPolicy();
    const cfStatement = policy.Statement.find(
      (s: { Sid?: string }) => s.Sid === "CloudFrontInvalidationTagScoped",
    ) as
      | {
          Sid: string;
          Effect: string;
          Action: string[];
          Resource: string;
          Condition: { StringEquals: Record<string, string> };
        }
      | undefined;

    expect(cfStatement).toBeDefined();
    expect(cfStatement!.Effect).toBe("Allow");
    expect(cfStatement!.Action).toContain("cloudfront:CreateInvalidation");
    expect(cfStatement!.Action).toContain("cloudfront:GetInvalidation");
    expect(cfStatement!.Resource).toMatch(/arn:\*:cloudfront::/);
    expect(
      cfStatement!.Condition.StringEquals["aws:ResourceTag/managed-by"],
    ).toBe("assignee-ai");
  });

  it("the unscoped ServiceSpecificActionsA/B do NOT contain cloudfront:CreateInvalidation or cloudfront:GetInvalidation", () => {
    // Collect all actions from unscoped statements (those without a Condition).
    const policy = operatorPolicy();
    const unscopedActions: string[] = [];
    for (const stmt of policy.Statement as Array<{
      Sid?: string;
      Action?: string | string[];
      Condition?: unknown;
    }>) {
      if (!stmt.Condition && stmt.Action) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        unscopedActions.push(...actions);
      }
    }
    expect(unscopedActions).not.toContain("cloudfront:CreateInvalidation");
    expect(unscopedActions).not.toContain("cloudfront:GetInvalidation");
  });
});
