import { describe, it, expect } from "vitest";
import {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
} from "./iam-policies.js";
import { SUPPORTED_TYPES_ARRAY } from "./resource-types.js";

/**
 * Union helper for tests that care about the combined service-action
 * surface post-(f)2026-04-09 A/B split. Before the split these tests
 * inspected a single `operatorServicesPolicy()` statement; now the
 * actions live in A + B and IAM evaluates the union. The helper keeps
 * the assertions readable and consolidates the split knowledge in one
 * place so adding a third split (should the policies ever outgrow
 * 6144 again) is a one-line change here.
 */
function servicesUnionStatement(): {
  Sid: string;
  Action: string[];
} {
  const a = operatorServicesAPolicy();
  const b = operatorServicesBPolicy();
  const aStmt = a.Statement.find((s) => s.Sid === "ServiceSpecificActionsA")!;
  const bStmt = b.Statement.find((s) => s.Sid === "ServiceSpecificActionsB")!;
  const actions = [
    ...(Array.isArray(aStmt.Action) ? aStmt.Action : [aStmt.Action]),
    ...(Array.isArray(bStmt.Action) ? bStmt.Action : [bStmt.Action]),
  ];
  return { Sid: "ServiceSpecificActionsUnion", Action: actions };
}

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

    it("includes deduplicated service-specific actions (across A+B after the A/B split)", () => {
      // A8 (2026-04-08): ServiceSpecificActions moved off operatorPolicy()
      // into its own policy. (f) 2026-04-09: the services policy was split
      // once more into A + B because it dropped below the 700-byte canary
      // floor after A10-A14 resource type promotions. operatorPolicy() now
      // retains only Bedrock, CCAPI, SDK fallback, XRay, and tagging;
      // operatorServices{A,B}Policy() emit the bulky service-specific
      // actions, one byte-balanced half each. All three attach to the
      // same `assignee-operator` user — the IAM union is unchanged.
      const union = servicesUnionStatement();
      const actions = union.Action;
      expect(actions).toBeInstanceOf(Array);
      const unique = new Set(actions);
      expect(actions.length).toBe(unique.size);
      // Sanity floor — must have meaningful breadth, not 1-2 actions
      expect(actions.length).toBeGreaterThan(50);
      // Cross-check: operatorPolicy() must NOT carry ANY ServiceSpecific*
      // statement — that's the whole point of the splits.
      const corePolicy = operatorPolicy();
      expect(
        corePolicy.Statement.find((s) =>
          s.Sid.startsWith("ServiceSpecificActions"),
        ),
      ).toBeUndefined();
    });

    it("includes S3 versioned-object cleanup actions used by destroy-service (across A+B)", () => {
      // destroy-service.ts calls ListObjectVersions + DeleteObjects(VersionId)
      // to empty versioned buckets before CloudControl DeleteResource runs.
      // Tier C: strengthened — also tolerate the wildcard-collapsed form
      // (`s3:Get*` etc) introduced in Wave 20's collapseToWildcards. The
      // assertion is "the destroy-service grant is reachable", which is
      // satisfied by either the literal action or a covering wildcard,
      // AND by the grant landing in either half of the A/B split.
      const actions = servicesUnionStatement().Action;
      const hasListVersions =
        actions.includes("s3:ListBucketVersions") ||
        actions.includes("s3:List*");
      const hasDeleteVersion =
        actions.includes("s3:DeleteObjectVersion") ||
        actions.includes("s3:Delete*");
      expect(hasListVersions).toBe(true);
      expect(hasDeleteVersion).toBe(true);
    });

    // (f) 2026-04-09 — lock in the A/B split invariants independently
    // from the union assertions, so a regression that silently dumps
    // every action into A (or every action into B) fails loudly.
    it("A/B split distributes actions into two non-empty, disjoint halves", () => {
      const a = operatorServicesAPolicy();
      const b = operatorServicesBPolicy();
      const aStmt = a.Statement.find(
        (s) => s.Sid === "ServiceSpecificActionsA",
      )!;
      const bStmt = b.Statement.find(
        (s) => s.Sid === "ServiceSpecificActionsB",
      )!;
      const aActions = new Set(aStmt.Action);
      const bActions = new Set(bStmt.Action);
      expect(aActions.size).toBeGreaterThan(10);
      expect(bActions.size).toBeGreaterThan(10);
      // Disjoint: no action appears in both halves (else the split is
      // doing nothing and the second policy is wasted bytes).
      for (const action of aActions) {
        expect(bActions.has(action), `${action} leaked into both halves`).toBe(
          false,
        );
      }
    });

    it("A/B split is byte-balanced within ~10% of the midpoint", () => {
      // splitServiceActions() cuts at the first index where the running
      // byte total crosses half of the grand total. That can land up to
      // one action's worth of bytes past the midpoint, so the tolerance
      // is "both halves within ~10% of each other" rather than "equal".
      const a = operatorServicesAPolicy();
      const b = operatorServicesBPolicy();
      const aSize = JSON.stringify(a).length;
      const bSize = JSON.stringify(b).length;
      const ratio = Math.min(aSize, bSize) / Math.max(aSize, bSize);
      expect(ratio).toBeGreaterThan(0.9);
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
    it("ALL THREE operator policies fit inside the 6144-byte AWS managed policy size limit (A8 + A/B splits)", () => {
      // A8 (2026-04-08): pre-split this test asserted operatorPolicy() <
      // 6144. Then both halves of the core/services split had to fit.
      // (f) 2026-04-09: the services half itself dropped below the
      // 700-byte canary floor after A10-A14, so it was split into A + B.
      // All THREE policies (core + servicesA + servicesB) attach to the
      // same `assignee-operator` IAM user; AWS evaluates the union, so
      // behavior is unchanged.
      const corePolicy = operatorPolicy();
      const servicesA = operatorServicesAPolicy();
      const servicesB = operatorServicesBPolicy();
      const coreSize = JSON.stringify(corePolicy).length;
      const servicesASize = JSON.stringify(servicesA).length;
      const servicesBSize = JSON.stringify(servicesB).length;
      expect(coreSize, "operatorPolicy()").toBeLessThan(6144);
      expect(servicesASize, "operatorServicesAPolicy()").toBeLessThan(6144);
      expect(servicesBSize, "operatorServicesBPolicy()").toBeLessThan(6144);
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
    it("Tier S #4: leaves at least 1500 bytes of headroom in ALL THREE operator policies after the A/B split", () => {
      // (f) 2026-04-09: the services policy was split into A + B
      // because the single services policy dropped below the 700-byte
      // canary floor after A10-A14 resource type promotions.
      //
      // The split roughly doubles the effective headroom: each half
      // carries ~50% of the bytes, so the 700-byte floor per policy
      // becomes a ~1500-byte floor per half when the grand total is
      // expressed as a single budget. We raise the floor here so the
      // canary fires LOUDLY before any single half gets close to
      // exhausting the doubled budget.
      //
      // Threshold history:
      //   - A8 split (2026-04-08):                   floor 1024 per half
      //   - A10+A11 (2026-04-09):                    floor 1075
      //   - A12+A13 (2026-04-09):                    floor 865 → 700
      //   - A14 CloudFront (2026-04-09):             floor held at 700
      //   - (f) 2026-04-09 A/B split:                floor raised to 1500
      //
      // When this fails next: either promote "Update" to
      // SAFE_WILDCARD_PREFIXES after a security review of
      // kms:UpdatePrimaryRegion + kms:UpdateCustomKeyStore exposure,
      // or do a THIRD split (Services-A + Services-B + Services-C).
      // Both options are supported by the existing attach machinery —
      // setup.ts just grows another ROLES[0].policies entry.
      const corePolicy = operatorPolicy();
      const servicesA = operatorServicesAPolicy();
      const servicesB = operatorServicesBPolicy();
      const coreSize = JSON.stringify(corePolicy).length;
      const servicesASize = JSON.stringify(servicesA).length;
      const servicesBSize = JSON.stringify(servicesB).length;
      expect(coreSize, "core operator policy size").toBeLessThan(6144 - 700);
      expect(servicesASize, "operator services-A policy size").toBeLessThan(
        6144 - 1500,
      );
      expect(servicesBSize, "operator services-B policy size").toBeLessThan(
        6144 - 1500,
      );
    });

    it("only collapses safe Describe/Get/List wildcards, never Create/Delete/Put (Wave 19 Bug #6 follow-up)", () => {
      // Tier C: strengthened from toBeDefined() — find!() at the call site
      // (f) 2026-04-09: after the A/B split the collapsed wildcards can
      // land in either half; the invariant is that EVERY wildcard across
      // the union uses a safe verb prefix.
      const stmt = servicesUnionStatement();
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

    it("operatorServicesAPolicy is a valid standalone policy with one ServiceSpecificActionsA statement", () => {
      const services = operatorServicesAPolicy();
      expect(services.Version).toBe("2012-10-17");
      expect(services.Statement).toHaveLength(1);
      expect(services.Statement[0]!.Sid).toBe("ServiceSpecificActionsA");
      expect(services.Statement[0]!.Effect).toBe("Allow");
      expect(services.Statement[0]!.Action.length).toBeGreaterThan(10);
      expect(services.Statement[0]!.Resource).toBe("*");
    });

    it("operatorServicesBPolicy is a valid standalone policy with one ServiceSpecificActionsB statement", () => {
      const services = operatorServicesBPolicy();
      expect(services.Version).toBe("2012-10-17");
      expect(services.Statement).toHaveLength(1);
      expect(services.Statement[0]!.Sid).toBe("ServiceSpecificActionsB");
      expect(services.Statement[0]!.Effect).toBe("Allow");
      expect(services.Statement[0]!.Action.length).toBeGreaterThan(10);
      expect(services.Statement[0]!.Resource).toBe("*");
    });

    it("operator core + servicesA + servicesB together cover the full pre-split action set", () => {
      // Round-trip guarantee: union of all three policies must contain
      // every action that was in the pre-A/B-split single-services version.
      // The splits are purely about JSON size — not security posture.
      const core = operatorPolicy();
      const servicesA = operatorServicesAPolicy();
      const servicesB = operatorServicesBPolicy();
      const coreActions = new Set(
        core.Statement.flatMap((s) =>
          Array.isArray(s.Action) ? s.Action : [s.Action],
        ),
      );
      const servicesActions = new Set(
        [...servicesA.Statement, ...servicesB.Statement].flatMap((s) =>
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
      expect(IAM_POLICY_NAMES.operatorServicesA).toBe(
        "AssigneeOperatorServicesAPolicy",
      );
      expect(IAM_POLICY_NAMES.operatorServicesB).toBe(
        "AssigneeOperatorServicesBPolicy",
      );
      expect(IAM_POLICY_NAMES.reader).toBe("AssigneeReaderPolicy");
      expect(IAM_POLICY_NAMES.auditor).toBe("AssigneeAuditorPolicy");
    });
  });
});
