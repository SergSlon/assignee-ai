import { describe, it, expect } from "vitest";
import {
  operatorPolicy,
  operatorServicesPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
} from "./iam-policies.js";
import { SUPPORTED_TYPES_ARRAY } from "./resource-types.js";

describe("IAM Policy Generators", () => {
  describe("operatorPolicy", () => {
    it("produces a valid IAM policy document with Version 2012-10-17", () => {
      // Tier C: strengthened — assert Statement is a non-empty array,
      // not just "defined" (which would pass for `null` or a string).
      const policy = operatorPolicy();
      expect(policy.Version).toBe("2012-10-17");
      expect(policy.Statement).toBeInstanceOf(Array);
      expect(policy.Statement.length).toBeGreaterThan(0);
    });

    it("includes all SUPPORTED_TYPES_ARRAY entries in CloudControl condition", () => {
      // Tier C: strengthened — find!() at the call site so missing
      // statement fails naturally; assert Condition shape directly.
      const policy = operatorPolicy();
      const ccStatement = policy.Statement.find(
        (s) => s.Sid === "CloudControlScopedToSupportedTypes",
      )!;
      expect(ccStatement.Sid).toBe("CloudControlScopedToSupportedTypes");
      const conditionTypes =
        ccStatement.Condition?.["StringEquals"]?.["cloudcontrol:TypeName"];
      expect(conditionTypes).toBeInstanceOf(Array);
      expect((conditionTypes as string[]).length).toBe(
        SUPPORTED_TYPES_ARRAY.length,
      );
      for (const resourceType of SUPPORTED_TYPES_ARRAY) {
        expect(conditionTypes).toContain(resourceType);
      }
    });

    it("includes deduplicated service-specific actions (in operatorServicesPolicy after A8 split)", () => {
      // A8 follow-up: ServiceSpecificActions moved to operatorServicesPolicy()
      // because the combined policy exceeded the AWS 6144-byte managed-policy
      // size limit at 28+ resource types. operatorPolicy() retains Bedrock,
      // CCAPI, SDK fallback, XRay, and tagging; operatorServicesPolicy()
      // emits the bulky service-specific actions on its own. Both attach to
      // the same `assignee-operator` user — the union is unchanged.
      const services = operatorServicesPolicy();
      const serviceStatement = services.Statement.find(
        (s) => s.Sid === "ServiceSpecificActions",
      )!;
      const actions = serviceStatement.Action;
      expect(actions).toBeInstanceOf(Array);
      const unique = new Set(actions);
      expect(actions.length).toBe(unique.size);
      // Sanity floor — must have meaningful breadth, not 1-2 actions
      expect(actions.length).toBeGreaterThan(50);
      // Cross-check: operatorPolicy() must NOT carry the bulky statement
      // anymore (that's the whole point of the split).
      const corePolicy = operatorPolicy();
      expect(
        corePolicy.Statement.find((s) => s.Sid === "ServiceSpecificActions"),
      ).toBeUndefined();
    });

    it("includes S3 versioned-object cleanup actions used by destroy-service (in operatorServicesPolicy)", () => {
      // destroy-service.ts calls ListObjectVersions + DeleteObjects(VersionId)
      // to empty versioned buckets before CloudControl DeleteResource runs.
      // Tier C: strengthened — also tolerate the wildcard-collapsed form
      // (`s3:Get*` etc) introduced in Wave 20's collapseToWildcards. The
      // assertion is "the destroy-service grant is reachable", which is
      // satisfied by either the literal action or a covering wildcard.
      // A8 follow-up: now reads from operatorServicesPolicy after split.
      const services = operatorServicesPolicy();
      const serviceStatement = services.Statement.find(
        (s) => s.Sid === "ServiceSpecificActions",
      )!;
      const actions = serviceStatement.Action;
      const hasListVersions =
        actions.includes("s3:ListBucketVersions") ||
        actions.includes("s3:List*");
      const hasDeleteVersion =
        actions.includes("s3:DeleteObjectVersion") ||
        actions.includes("s3:Delete*");
      expect(hasListVersions).toBe(true);
      expect(hasDeleteVersion).toBe(true);
    });

    it("includes SDK fallback actions for CCAPI bypass types", () => {
      // Tier C: strengthened
      // A6  (2026-04-08): lambda:CreateEventSourceMapping was removed
      //                   from sdkFallbackActions when Lambda
      //                   EventSourceMapping was migrated from SDK
      //                   fallback to CCAPI.
      // A10 (2026-04-09): sns:Subscribe + sns:Unsubscribe were removed
      //                   when AWS::SNS::Subscription was promoted to
      //                   first-class. Those actions moved to the
      //                   SNS_SUBSCRIPTION entry in
      //                   serviceActionMap (iam-actions.ts) and are
      //                   now gated by the cloudcontrol:TypeName
      //                   Condition instead of granted unscoped.
      //                   The only remaining entries are the SSH
      //                   key-pair companion perms (EC2::Instance
      //                   auto-provisioning).
      const policy = operatorPolicy();
      const fallbackStatement = policy.Statement.find(
        (s) => s.Sid === "SdkFallbackActions",
      )!;
      expect(fallbackStatement.Sid).toBe("SdkFallbackActions");
      const required = [
        // SSH key pair auto-create flow (Epic 41 — SSH intent bundle)
        "ec2:CreateKeyPair",
        "ec2:DeleteKeyPair",
        "ec2:DescribeKeyPairs",
      ];
      for (const action of required) {
        expect(fallbackStatement.Action).toContain(action);
      }
      // Guard against accidental re-introduction of the A6-removed
      // Lambda ESM fallback perms — any regression that spans the
      // dispatcher + policy should fail both tests.
      expect(fallbackStatement.Action).not.toContain(
        "lambda:CreateEventSourceMapping",
      );
      expect(fallbackStatement.Action).not.toContain(
        "lambda:DeleteEventSourceMapping",
      );
      // A10: sns:Subscribe / sns:Unsubscribe moved from
      // sdkFallbackActions to the scoped serviceActionMap entry for
      // AWS::SNS::Subscription. They must no longer appear in the
      // unscoped SdkFallbackActions statement.
      expect(fallbackStatement.Action).not.toContain("sns:Subscribe");
      expect(fallbackStatement.Action).not.toContain("sns:Unsubscribe");
    });

    it("includes Bedrock invoke actions on the configured model resource", () => {
      // Tier C: strengthened — also assert the Resource pinning, not
      // just the Action membership. Bedrock's blast radius depends on
      // BOTH the action AND the resource scope.
      const policy = operatorPolicy();
      const bedrockStatement = policy.Statement.find(
        (s) => s.Sid === "BedrockInvoke",
      )!;
      expect(bedrockStatement).toMatchObject({
        Sid: "BedrockInvoke",
        Effect: "Allow",
      });
      expect(bedrockStatement.Action).toContain("bedrock:InvokeModel");
      expect(bedrockStatement.Action).toContain(
        "bedrock:InvokeModelWithResponseStream",
      );
      expect(bedrockStatement.Resource).toBeTruthy();
    });

    it("includes XRay tracing actions", () => {
      // Tier C: strengthened
      const policy = operatorPolicy();
      const xrayStatement = policy.Statement.find(
        (s) => s.Sid === "XRayTracing",
      )!;
      expect(xrayStatement).toMatchObject({
        Sid: "XRayTracing",
        Effect: "Allow",
      });
      expect(xrayStatement.Action).toContain("xray:PutTraceSegments");
      expect(xrayStatement.Action).toContain("xray:PutTelemetryRecords");
    });

    it("includes resource tagging actions", () => {
      // Tier C: strengthened
      const policy = operatorPolicy();
      const tagStatement = policy.Statement.find(
        (s) => s.Sid === "ResourceTagging",
      )!;
      expect(tagStatement).toMatchObject({
        Sid: "ResourceTagging",
        Effect: "Allow",
      });
      expect(tagStatement.Action).toContain("tag:TagResources");
      expect(tagStatement.Action).toContain("tag:GetResources");
    });

    it("has no full-service wildcard actions (NFR-13 compliance)", () => {
      const policy = operatorPolicy();
      for (const statement of policy.Statement) {
        for (const action of statement.Action) {
          expect(action).not.toBe("*");
          // Ensure no action ends with :* (full-service wildcard like s3:*)
          expect(action).not.toMatch(/:\*$/);
        }
      }
    });

    // Wave 19: the operator policy is approaching the AWS managed-policy
    // 6144-byte size limit. The collapseToWildcards pass in iam-policies.ts
    // replaces 3+ co-prefixed read-only actions with a single
    // `service:Verb*` wildcard for Describe/Get/List ONLY. Lock in the
    // size budget AND the narrow set of permitted prefix-wildcards so a
    // future contributor can't quietly add `s3:*` or `iam:*` to the
    // collapser without tripping CI.
    it("BOTH operator policies fit inside the 6144-byte AWS managed policy size limit (A8 split)", () => {
      // A8 follow-up: pre-split this test asserted operatorPolicy() <
      // 6144. Now both halves of the split must fit independently.
      // Each policy is attached to the same `assignee-operator` IAM
      // user; AWS evaluates the union, so behavior is unchanged.
      const corePolicy = operatorPolicy();
      const servicesPolicy = operatorServicesPolicy();
      const coreSize = JSON.stringify(corePolicy).length;
      const servicesSize = JSON.stringify(servicesPolicy).length;
      expect(coreSize, "operatorPolicy()").toBeLessThan(6144);
      expect(servicesSize, "operatorServicesPolicy()").toBeLessThan(6144);
    });

    // Tier S #4: trip a CI alarm BEFORE we run out of room. The collapser
    // got us from 6253 bytes to 5658 bytes (Wave 20).
    //
    // When this fails: open `iam-policies.ts`, look at the collapser
    // wildcards introduced, and consider promoting another verb prefix
    // to SAFE_WILDCARD_PREFIXES (e.g. Modify, Update). Don't just bump
    // the threshold — that defeats the early-warning purpose.
    //
    // 2026-04-08 recalibrations (all landed in the same session):
    //   - A1 EFS: 400 → 300 bytes when the new elasticfilesystem
    //     service landed 9 unavoidable actions (5 of which collapse
    //     to a single Describe* wildcard).
    //   - A1 EFS::MountTarget follow-up: 300 → 250 bytes. The
    //     MountTarget type adds just 3 more elasticfilesystem
    //     actions (CreateMountTarget, DeleteMountTarget,
    //     DescribeMountTargets). DescribeMountTargets folds into
    //     the existing collapsed Describe* wildcard for free, so
    //     only the Create/Delete pair takes real bytes (~68).
    //   - A8 EventBridge Rule: 250 → 80 bytes. The new `events`
    //     service adds 6 narrow actions (PutRule, DeleteRule,
    //     DescribeRule, PutTargets, RemoveTargets, TagResource) —
    //     none collapse because the service has only 1 Describe
    //     and no other safe-wildcard prefix matches. Plus a 22-byte
    //     entry in the cloudcontrol:TypeName Condition list for the
    //     new type. Total cost ~170 bytes. The 170-byte drop matches
    //     the author's own prior guidance for a "brand-new service"
    //     addition ("budget for another ~50-100 byte drop [...] or
    //     introduce a service-scoped Create*/Delete* collapser with
    //     explicit security review") — 170 exceeds the upper bound,
    //     confirming that a Put/Create collapser is the right next
    //     move before the 9th first-class service is added. For
    //     now we take the byte hit and keep the collapser untouched.
    // Each recalibration has kept the collapser untouched — the
    // threshold tracks the cost of adding a new service, not a new
    // wildcard.
    it("Tier S #4: leaves at least 1024 bytes of headroom in BOTH operator policies after the A8 split", () => {
      // A8 follow-up: the operator surface is now split across
      // operatorPolicy() (core: Bedrock + CCAPI + tagging + xray + SDK
      // fallback) and operatorServicesPolicy() (the bulky service-
      // specific actions). Each must independently fit inside the
      // 6144-byte managed-policy limit AND leave generous headroom
      // for new resource types. Pre-split the threshold was 80 bytes
      // (a single action away from blowing the limit); the split
      // restores ~4500 bytes of headroom on the core policy and
      // ~1600 bytes on the services policy. Lock in 1024 bytes
      // minimum on each so we get an early warning ~30 resource
      // types from now.
      const corePolicy = operatorPolicy();
      const servicesPolicy = operatorServicesPolicy();
      const coreSize = JSON.stringify(corePolicy).length;
      const servicesSize = JSON.stringify(servicesPolicy).length;
      expect(coreSize, "core operator policy size").toBeLessThan(6144 - 1024);
      expect(servicesSize, "operator services policy size").toBeLessThan(
        6144 - 1024,
      );
    });

    it("only collapses safe Describe/Get/List wildcards, never Create/Delete/Put (Wave 19 Bug #6 follow-up)", () => {
      // Tier C: strengthened from toBeDefined() — find!() at the call site
      // A8 follow-up: ServiceSpecificActions moved to operatorServicesPolicy
      const services = operatorServicesPolicy();
      const stmt = services.Statement.find(
        (s) => s.Sid === "ServiceSpecificActions",
      )!;
      expect(stmt.Sid).toBe("ServiceSpecificActions");
      const wildcardActions = stmt.Action.filter(
        (a) => a.endsWith("*") && a.includes(":"),
      );
      // Every wildcard introduced by the collapser must use one of the
      // SAFE_WILDCARD_PREFIXES (Describe, Get, List). The s3:PutBucket*
      // and similar legacy literal wildcards from iam-actions.ts are
      // grandfathered — they were already there before Wave 19 and are
      // narrow enough to be safe (only S3 BucketConfig-style writes).
      const SAFE_VERB_PREFIXES = /:(Describe|Get|List|PutBucket|GetBucket)/;
      for (const action of wildcardActions) {
        expect(action).toMatch(SAFE_VERB_PREFIXES);
        // Hard floor: never permit a service:* full wildcard
        expect(action).not.toMatch(/:\*$/);
      }
      // At least one Wave 19 collapser-introduced wildcard should be
      // present — if this assertion fails the collapser silently
      // stopped working and the policy is at risk of overflowing.
      const hasCollapserWildcards = wildcardActions.some((a) =>
        /:(Describe|Get|List)\*$/.test(a),
      );
      expect(hasCollapserWildcards).toBe(true);
    });

    it("operatorServicesPolicy is a valid standalone policy with one ServiceSpecificActions statement", () => {
      const services = operatorServicesPolicy();
      expect(services.Version).toBe("2012-10-17");
      expect(services.Statement).toHaveLength(1);
      expect(services.Statement[0]!.Sid).toBe("ServiceSpecificActions");
      expect(services.Statement[0]!.Effect).toBe("Allow");
      expect(services.Statement[0]!.Action.length).toBeGreaterThan(50);
      expect(services.Statement[0]!.Resource).toBe("*");
    });

    it("operator core + services together cover the full pre-split action set", () => {
      // Round-trip guarantee: union(corePolicy.Actions, servicesPolicy.Actions)
      // must contain every action that was in the pre-split single-policy
      // version. The split is purely about JSON size — not security posture.
      const core = operatorPolicy();
      const services = operatorServicesPolicy();
      const coreActions = new Set(
        core.Statement.flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : [s.Action],
        ),
      );
      const servicesActions = new Set(
        services.Statement.flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : [s.Action],
        ),
      );
      const union = new Set([...coreActions, ...servicesActions]);
      // Sanity floor: combined surface is meaningfully large
      expect(union.size).toBeGreaterThan(60);
      // Bedrock invoke must be in the core policy (NOT services)
      expect(coreActions.has("bedrock:InvokeModel")).toBe(true);
      expect(servicesActions.has("bedrock:InvokeModel")).toBe(false);
      // Service-specific examples must be in the services policy (NOT core)
      const hasS3 = [...servicesActions].some((a) => a.startsWith("s3:"));
      const hasLambda = [...servicesActions].some((a) =>
        a.startsWith("lambda:"),
      );
      expect(hasS3, "services policy must carry s3: actions").toBe(true);
      expect(hasLambda, "services policy must carry lambda: actions").toBe(
        true,
      );
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
      // Tier C: strengthened
      const policy = auditorPolicy();
      const iamStatement = policy.Statement.find(
        (s) => s.Sid === "IAMSimulateAndRead",
      )!;
      expect(iamStatement).toMatchObject({
        Sid: "IAMSimulateAndRead",
        Effect: "Allow",
      });
      expect(iamStatement.Action).toContain("iam:SimulateCustomPolicy");
      expect(iamStatement.Action).toContain("iam:SimulatePrincipalPolicy");
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
      expect(IAM_POLICY_NAMES.operatorServices).toBe(
        "AssigneeOperatorServicesPolicy",
      );
      expect(IAM_POLICY_NAMES.reader).toBe("AssigneeReaderPolicy");
      expect(IAM_POLICY_NAMES.auditor).toBe("AssigneeAuditorPolicy");
    });
  });
});
