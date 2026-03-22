import { describe, it, expect } from "vitest";
import {
  operatorPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
} from "./iam-policies.js";
import { SUPPORTED_TYPES_ARRAY } from "./resource-types.js";

describe("IAM Policy Generators", () => {
  describe("operatorPolicy", () => {
    it("produces a valid IAM policy document with Version 2012-10-17", () => {
      const policy = operatorPolicy();
      expect(policy.Version).toBe("2012-10-17");
      expect(policy.Statement).toBeDefined();
      expect(policy.Statement.length).toBeGreaterThan(0);
    });

    it("includes all SUPPORTED_TYPES_ARRAY entries in CloudControl condition", () => {
      const policy = operatorPolicy();
      const ccStatement = policy.Statement.find(
        (s) => s.Sid === "CloudControlScopedToSupportedTypes",
      );
      expect(ccStatement).toBeDefined();
      const conditionTypes =
        ccStatement!.Condition?.["StringEquals"]?.["cloudcontrol:TypeName"];
      expect(conditionTypes).toBeDefined();
      for (const resourceType of SUPPORTED_TYPES_ARRAY) {
        expect(conditionTypes).toContain(resourceType);
      }
    });

    it("includes deduplicated service-specific actions", () => {
      const policy = operatorPolicy();
      const serviceStatement = policy.Statement.find(
        (s) => s.Sid === "ServiceSpecificActions",
      );
      expect(serviceStatement).toBeDefined();
      // Check for deduplication
      const actions = serviceStatement!.Action;
      const unique = new Set(actions);
      expect(actions.length).toBe(unique.size);
    });

    it("includes SDK fallback actions for CCAPI bypass types", () => {
      const policy = operatorPolicy();
      const fallbackStatement = policy.Statement.find(
        (s) => s.Sid === "SdkFallbackActions",
      );
      expect(fallbackStatement).toBeDefined();
      expect(fallbackStatement!.Action).toContain(
        "lambda:CreateEventSourceMapping",
      );
      expect(fallbackStatement!.Action).toContain("sns:Subscribe");
      expect(fallbackStatement!.Action).toContain("sns:Unsubscribe");
    });

    it("includes Bedrock invoke actions", () => {
      const policy = operatorPolicy();
      const bedrockStatement = policy.Statement.find(
        (s) => s.Sid === "BedrockInvoke",
      );
      expect(bedrockStatement).toBeDefined();
      expect(bedrockStatement!.Action).toContain("bedrock:InvokeModel");
    });

    it("includes XRay tracing actions", () => {
      const policy = operatorPolicy();
      const xrayStatement = policy.Statement.find(
        (s) => s.Sid === "XRayTracing",
      );
      expect(xrayStatement).toBeDefined();
      expect(xrayStatement!.Action).toContain("xray:PutTraceSegments");
    });

    it("includes resource tagging actions", () => {
      const policy = operatorPolicy();
      const tagStatement = policy.Statement.find(
        (s) => s.Sid === "ResourceTagging",
      );
      expect(tagStatement).toBeDefined();
      expect(tagStatement!.Action).toContain("tag:TagResources");
      expect(tagStatement!.Action).toContain("tag:GetResources");
    });

    it("has no wildcard actions (NFR-13 compliance)", () => {
      const policy = operatorPolicy();
      for (const statement of policy.Statement) {
        for (const action of statement.Action) {
          expect(action).not.toBe("*");
          // Ensure no action ends with :* (wildcard within a service)
          expect(action).not.toMatch(/:\*$/);
        }
      }
    });

    it("accepts a custom model ARN for Bedrock scoping", () => {
      const customArn =
        "arn:aws:bedrock:us-east-1::foundation-model/amazon.nova-lite-v1:0";
      const policy = operatorPolicy(customArn);
      const bedrockStatement = policy.Statement.find(
        (s) => s.Sid === "BedrockInvoke",
      );
      expect(bedrockStatement!.Resource).toBe(customArn);
    });
  });

  describe("readerPolicy", () => {
    it("produces a valid IAM policy document with Version 2012-10-17", () => {
      const policy = readerPolicy();
      expect(policy.Version).toBe("2012-10-17");
      expect(policy.Statement.length).toBeGreaterThan(0);
    });

    it("contains expected SIDs", () => {
      const policy = readerPolicy();
      const sids = policy.Statement.map((s) => s.Sid);
      expect(sids).toContain("CloudFormationSchemaRead");
      expect(sids).toContain("PricingRead");
      expect(sids).toContain("CostExplorerRead");
    });

    it("has no wildcard actions (NFR-13 compliance)", () => {
      const policy = readerPolicy();
      for (const statement of policy.Statement) {
        for (const action of statement.Action) {
          expect(action).not.toBe("*");
          expect(action).not.toMatch(/:\*$/);
        }
      }
    });
  });

  describe("auditorPolicy", () => {
    it("produces a valid IAM policy document with Version 2012-10-17", () => {
      const policy = auditorPolicy();
      expect(policy.Version).toBe("2012-10-17");
      expect(policy.Statement.length).toBeGreaterThan(0);
    });

    it("contains expected SIDs", () => {
      const policy = auditorPolicy();
      const sids = policy.Statement.map((s) => s.Sid);
      expect(sids).toContain("IAMSimulateAndRead");
      expect(sids).toContain("SecurityHubRead");
      expect(sids).toContain("GuardDutyRead");
      expect(sids).toContain("InspectorRead");
      expect(sids).toContain("IAMAccessAnalyzerRead");
    });

    it("includes IAM simulate actions", () => {
      const policy = auditorPolicy();
      const iamStatement = policy.Statement.find(
        (s) => s.Sid === "IAMSimulateAndRead",
      );
      expect(iamStatement).toBeDefined();
      expect(iamStatement!.Action).toContain("iam:SimulateCustomPolicy");
      expect(iamStatement!.Action).toContain("iam:SimulatePrincipalPolicy");
    });

    it("has no wildcard actions (NFR-13 compliance)", () => {
      const policy = auditorPolicy();
      for (const statement of policy.Statement) {
        for (const action of statement.Action) {
          expect(action).not.toBe("*");
          expect(action).not.toMatch(/:\*$/);
        }
      }
    });
  });

  describe("IAM_USER_NAMES", () => {
    it("has correct user names", () => {
      expect(IAM_USER_NAMES.operator).toBe("assignee-operator");
      expect(IAM_USER_NAMES.reader).toBe("assignee-reader");
      expect(IAM_USER_NAMES.auditor).toBe("assignee-auditor");
    });
  });

  describe("IAM_POLICY_NAMES", () => {
    it("has correct policy names", () => {
      expect(IAM_POLICY_NAMES.operator).toBe("AssigneeOperatorPolicy");
      expect(IAM_POLICY_NAMES.reader).toBe("AssigneeReaderPolicy");
      expect(IAM_POLICY_NAMES.auditor).toBe("AssigneeAuditorPolicy");
    });
  });
});
