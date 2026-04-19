import { describe, it, expect } from "vitest";
import { getRequiredIamActions } from "./iam-actions.js";

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
});
