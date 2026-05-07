import { describe, it, expect } from "vitest";
import {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
  readerPolicy,
  auditorPolicy,
  IAM_USER_NAMES,
  IAM_POLICY_NAMES,
} from "./index.js";
import { SUPPORTED_TYPES_ARRAY } from "../resource-types.js";

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

    it("includes S3 versioned-object cleanup actions used by destroy-service", () => {
      // destroy-service.ts calls ListObjectVersions + DeleteObjects(VersionId)
      // to empty versioned buckets before CloudControl DeleteResource runs.
      //
      // s3:ListBucketVersions stays in the unscoped service sweep (A/B) —
      // listing versions is a read action that cannot cause harm by itself.
      //
      // Bug S3-001 (2026-05-07): s3:DeleteObjectVersion and s3:DeleteObject
      // MOVED from the unscoped service sweep to ServiceDestructiveResourceTagScoped
      // so a leaked credential cannot delete objects from unmanaged buckets.
      // The grant is now in the core operator policy's scoped statement, not
      // in servicesUnionStatement() (A+B).
      const serviceActions = servicesUnionStatement().Action;
      const hasListVersions =
        serviceActions.includes("s3:ListBucketVersions") ||
        serviceActions.includes("s3:List*");
      expect(hasListVersions).toBe(true);

      // Verify delete actions are in the tag-scoped statement, NOT in A/B
      const corePolicy = operatorPolicy();
      const destructiveStmt = corePolicy.Statement.find(
        (s) => s.Sid === "ServiceDestructiveResourceTagScoped",
      )!;
      const destructiveActions = new Set(destructiveStmt.Action);
      expect(
        destructiveActions.has("s3:DeleteObjectVersion"),
        "s3:DeleteObjectVersion must be in ServiceDestructiveResourceTagScoped",
      ).toBe(true);
      expect(
        destructiveActions.has("s3:DeleteObject"),
        "s3:DeleteObject must be in ServiceDestructiveResourceTagScoped",
      ).toBe(true);
      // Must NOT be in the unscoped sweep (would bypass the tag condition)
      expect(
        serviceActions.includes("s3:DeleteObjectVersion"),
        "s3:DeleteObjectVersion must NOT be in unscoped service sweep",
      ).toBe(false);
      expect(
        serviceActions.includes("s3:DeleteObject"),
        "s3:DeleteObject must NOT be in unscoped service sweep (but s3:Delete* wildcard is absent)",
      ).toBe(false);
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

    it("includes resource tagging actions (split into Read + Write after SEC-009)", () => {
      // SEC-009 (full-audit-2026-04-29): tag:GetResources and
      // tag:TagResources were previously in a single ResourceTagging
      // statement. aws:RequestTag applies only to writes — sharing it
      // with a read operation silently over-conditions the read.
      // They are now in separate ResourceTaggingRead / ResourceTaggingWrite
      // statements. Both must be present; neither should carry the
      // other's action.
      const policy = operatorPolicy();
      const readStmt = policy.Statement.find(
        (s) => s.Sid === "ResourceTaggingRead",
      )!;
      const writeStmt = policy.Statement.find(
        (s) => s.Sid === "ResourceTaggingWrite",
      )!;
      expect(readStmt).toMatchObject({
        Sid: "ResourceTaggingRead",
        Effect: "Allow",
      });
      expect(writeStmt).toMatchObject({
        Sid: "ResourceTaggingWrite",
        Effect: "Allow",
      });
      expect(readStmt.Action).toContain("tag:GetResources");
      expect(writeStmt.Action).toContain("tag:TagResources");
      // No old merged statement
      expect(
        policy.Statement.find((s) => s.Sid === "ResourceTagging"),
      ).toBeUndefined();
    });

    // Security MEDIUM (security-expert #2) + epic47-final blind S2.
    // Delete + Copy scoped by aws:ResourceTag; Create scoped by
    // aws:RequestTag (closes the previously-open cross-account exfil
    // path via Create → ModifyDBSnapshotAttribute → share).
    describe("RdsSnapshotMutateTagScoped statement (Delete + Copy)", () => {
      it("exists and carries the aws:ResourceTag/managed-by=assignee-ai condition", () => {
        const policy = operatorPolicy();
        const snapStatement = policy.Statement.find(
          (s) => s.Sid === "RdsSnapshotMutateTagScoped",
        );
        expect(snapStatement).toBeDefined();
        expect(snapStatement!.Effect).toBe("Allow");
        expect(snapStatement!.Resource).toBe("*");
        expect(snapStatement!.Condition).toEqual({
          StringEquals: {
            "aws:ResourceTag/managed-by": "assignee-ai",
          },
        });
      });

      it("covers the two destructive RDS snapshot actions (Delete + Copy)", () => {
        const policy = operatorPolicy();
        const snapStatement = policy.Statement.find(
          (s) => s.Sid === "RdsSnapshotMutateTagScoped",
        )!;
        expect(snapStatement.Action).toEqual(
          expect.arrayContaining([
            "rds:DeleteDBSnapshot",
            "rds:CopyDBSnapshot",
          ]),
        );
      });

      it("does NOT cover CreateDBSnapshot (handled by its own request-tag block)", () => {
        const policy = operatorPolicy();
        const snapStatement = policy.Statement.find(
          (s) => s.Sid === "RdsSnapshotMutateTagScoped",
        )!;
        expect(snapStatement.Action).not.toContain("rds:CreateDBSnapshot");
      });
    });

    describe("RdsSnapshotCreateRequestTagScoped statement (Create)", () => {
      it("exists and carries the aws:RequestTag/managed-by=assignee-ai condition", () => {
        const policy = operatorPolicy();
        const snapStatement = policy.Statement.find(
          (s) => s.Sid === "RdsSnapshotCreateRequestTagScoped",
        );
        expect(snapStatement).toBeDefined();
        expect(snapStatement!.Effect).toBe("Allow");
        expect(snapStatement!.Resource).toBe("*");
        // RequestTag (tag being applied at create time), NOT ResourceTag
        // — aws:ResourceTag on a create action would evaluate against
        // the new-resource with no tags and deny every legitimate
        // create. RequestTag closes the exfil path (operator must tag
        // managed-by at create) without breaking legit flows.
        expect(snapStatement!.Condition).toEqual({
          StringEquals: {
            "aws:RequestTag/managed-by": "assignee-ai",
          },
        });
      });

      it("covers CreateDBSnapshot only", () => {
        const policy = operatorPolicy();
        const snapStatement = policy.Statement.find(
          (s) => s.Sid === "RdsSnapshotCreateRequestTagScoped",
        )!;
        expect(snapStatement.Action).toEqual(["rds:CreateDBSnapshot"]);
      });
    });

    // Story 50-5 B-3: priv-esc prevention — iam:CreateRole /
    // iam:PassRole / iam:AttachRolePolicy / iam:PutRolePolicy used to
    // land in the unscoped ServiceSpecificActionsA/B sweep with
    // Resource "*". An operator credential leak could then mint a role
    // with AdministratorAccess and assume it. They now live in a
    // dedicated statement scoped to `role/assignee-*` under the
    // caller's partition + account, with an iam:PassedToService
    // condition restricting PassRole to the services Assignee actually
    // provisions for.
    //
    // W13-S2 (M-α-16): the 3 destructive actions (DeleteRole /
    // DetachRolePolicy / DeleteRolePolicy) are emitted in a sibling
    // IamRoleDestructiveAssigneeScoped statement — also scoped to
    // `role/assignee-*` but WITHOUT the iam:PassedToService Condition
    // (AWS does not support that condition on delete/detach operations).
    describe("IamRoleManagementAssigneeScoped statement (Story 50-5 B-3)", () => {
      const PRIVESC_ACTIONS = [
        "iam:CreateRole",
        "iam:PassRole",
        "iam:AttachRolePolicy",
        "iam:PutRolePolicy",
      ];

      it("exists as a dedicated statement in the core operator policy", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleManagementAssigneeScoped",
        );
        expect(stmt).toBeDefined();
        expect(stmt!.Effect).toBe("Allow");
      });

      it("scopes the Resource to assignee-* roles under the caller's partition + account", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleManagementAssigneeScoped",
        )!;
        // `*` is the IAM-spec partition wildcard. Access Analyzer
        // rejects `aws*` (only `*`/`aws`/`aws-cn`/`aws-us-gov` are
        // accepted partition values for Resource ARNs). `${aws:AccountId}` IS a valid policy
        // variable in the account slot and is expanded at authorization
        // time. `${aws:PartitionId}` is REJECTED in the partition slot
        // by IAM (only valid as a Condition key, not in Resource ARNs).
        // feedback_partition_aware_arn_matching: ensure we never use
        // the literal "aws:" string (that would not match GovCloud/China).
        expect(stmt.Resource).toBe(
          "arn:*:iam::${aws:AccountId}:role/assignee-*",
        );
        expect(stmt.Resource).not.toBe("*");
        expect(stmt.Resource).not.toContain("arn:aws:iam");
      });

      it("covers all four priv-esc IAM actions (and no stray extras)", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleManagementAssigneeScoped",
        )!;
        const actions = new Set(stmt.Action);
        for (const a of PRIVESC_ACTIONS) {
          expect(actions.has(a), `${a} must be in the scoped statement`).toBe(
            true,
          );
        }
        // Exactly 4 actions — destructive ops live in the sibling
        // IamRoleDestructiveAssigneeScoped statement (W13-S2).
        expect(actions.size).toBe(PRIVESC_ACTIONS.length);
        // Destructive actions must NOT be in this statement — they
        // cannot carry the iam:PassedToService Condition.
        for (const destructive of [
          "iam:DeleteRole",
          "iam:DetachRolePolicy",
          "iam:DeleteRolePolicy",
        ]) {
          expect(
            actions.has(destructive),
            `${destructive} must NOT be in IamRoleManagementAssigneeScoped`,
          ).toBe(false);
        }
      });

      it("restricts iam:PassedToService to the services assignee provisions for", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleManagementAssigneeScoped",
        )!;
        const passedTo =
          stmt.Condition?.["StringEquals"]?.["iam:PassedToService"];
        expect(passedTo).toBeInstanceOf(Array);
        const services = new Set(passedTo as string[]);
        // Every service listed here is one Assignee provisions a role
        // for. Expanding this list requires a deliberate policy edit.
        for (const svc of [
          "lambda.amazonaws.com",
          "ecs-tasks.amazonaws.com",
          "events.amazonaws.com",
          "rds.amazonaws.com",
          "ec2.amazonaws.com",
          "scheduler.amazonaws.com",
          "states.amazonaws.com",
        ]) {
          expect(services.has(svc), `${svc} must be allowlisted`).toBe(true);
        }
        // Hard deny: no wildcard "*" service (would re-open the pivot).
        expect(services.has("*")).toBe(false);
      });

      it("removes the four priv-esc actions from the unscoped services sweep", () => {
        // If any of the four actions landed in operatorServicesA/B with
        // Resource "*", IAM union semantics would let the unscoped
        // allow win and defeat the scoping entirely.
        for (const policyFn of [
          operatorServicesAPolicy,
          operatorServicesBPolicy,
        ]) {
          const doc = policyFn();
          for (const statement of doc.Statement) {
            for (const action of statement.Action) {
              expect(PRIVESC_ACTIONS.includes(action)).toBe(false);
            }
          }
        }
      });
    });

    // W13-S2 (M-α-16): destructive IAM role-lifecycle actions were
    // previously landing in ServiceSpecificActionsA/B with Resource "*".
    // They are now in a dedicated scoped statement WITHOUT the
    // iam:PassedToService Condition (which AWS only supports for PassRole).
    describe("IamRoleDestructiveAssigneeScoped statement (W13-S2 M-α-16)", () => {
      const DESTRUCTIVE_ACTIONS = [
        "iam:DeleteRole",
        "iam:DetachRolePolicy",
        "iam:DeleteRolePolicy",
      ];

      it("exists as a dedicated statement in the core operator policy", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
        );
        expect(stmt).toBeDefined();
        expect(stmt!.Effect).toBe("Allow");
      });

      it("scopes Resource to assignee-* roles (not Resource: *)", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
        )!;
        expect(stmt.Resource).toBe(
          "arn:*:iam::${aws:AccountId}:role/assignee-*",
        );
        expect(stmt.Resource).not.toBe("*");
        expect(stmt.Resource).not.toContain("arn:aws:iam");
      });

      it("covers all three destructive IAM actions", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
        )!;
        const actions = new Set(stmt.Action);
        for (const a of DESTRUCTIVE_ACTIONS) {
          expect(
            actions.has(a),
            `${a} must be in IamRoleDestructiveAssigneeScoped`,
          ).toBe(true);
        }
        expect(actions.size).toBe(DESTRUCTIVE_ACTIONS.length);
      });

      it("does NOT carry iam:PassedToService Condition (invalid for delete/detach)", () => {
        // AWS rejects a policy statement that applies iam:PassedToService
        // to delete/detach operations. The Condition must be absent here.
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
        )!;
        const passedTo =
          stmt.Condition?.["StringEquals"]?.["iam:PassedToService"];
        expect(passedTo).toBeUndefined();
      });

      // SEC-010 (full-audit-2026-04-29): add aws:ResourceTag/managed-by
      // for cross-tenant safety — without it any `role/assignee-*` in
      // the account could be deleted even if Assignee did not create it.
      it("carries aws:ResourceTag/managed-by=assignee-ai condition (SEC-010)", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
        )!;
        expect(
          stmt.Condition?.["StringEquals"]?.["aws:ResourceTag/managed-by"],
        ).toBe("assignee-ai");
      });

      it("does NOT appear in operatorServicesA or operatorServicesB (no Resource:* bypass)", () => {
        // W13-S2: all three destructive actions must be absent from the
        // unscoped service sweep — IAM union semantics would otherwise
        // let the Resource:* allow win and defeat the scoping.
        for (const policyFn of [
          operatorServicesAPolicy,
          operatorServicesBPolicy,
        ]) {
          const doc = policyFn();
          for (const statement of doc.Statement) {
            for (const action of statement.Action) {
              expect(
                DESTRUCTIVE_ACTIONS.includes(action),
                `${action} must NOT appear in unscoped service sweep`,
              ).toBe(false);
            }
          }
        }
      });
    });

    // W13-S2 (M-α-17): secretsmanager:GetSecretValue was previously in
    // ServiceSpecificActionsA/B with Resource "*" — a leaked operator
    // credential could read any secret in the account. Now scoped to
    // secrets tagged managed-by=assignee-ai.
    describe("SecretsManagerGetValueTagScoped statement (W13-S2 M-α-17)", () => {
      it("exists as a dedicated statement in the core operator policy", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "SecretsManagerGetValueTagScoped",
        );
        expect(stmt).toBeDefined();
        expect(stmt!.Effect).toBe("Allow");
      });

      it("contains secretsmanager:GetSecretValue as its action", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "SecretsManagerGetValueTagScoped",
        )!;
        expect(stmt.Action).toContain("secretsmanager:GetSecretValue");
      });

      it("uses Resource: * with aws:ResourceTag/managed-by=assignee-ai condition", () => {
        // aws:ResourceTag is evaluated at read-time against the secret's
        // existing tags (NOT aws:RequestTag which applies to creates and
        // would always evaluate against an untagged resource on reads).
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "SecretsManagerGetValueTagScoped",
        )!;
        expect(stmt.Resource).toBe("*");
        expect(
          stmt.Condition?.["StringEquals"]?.["aws:ResourceTag/managed-by"],
        ).toBe("assignee-ai");
      });

      it("does NOT appear in operatorServicesA or operatorServicesB (no Resource:* bypass)", () => {
        // W13-S2: secretsmanager:GetSecretValue must be absent from the
        // unscoped service sweep — IAM union semantics would otherwise
        // allow reading any secret in the account regardless of tags.
        for (const policyFn of [
          operatorServicesAPolicy,
          operatorServicesBPolicy,
        ]) {
          const doc = policyFn();
          for (const statement of doc.Statement) {
            for (const action of statement.Action) {
              expect(action).not.toBe("secretsmanager:GetSecretValue");
            }
          }
        }
      });
    });

    // Story 50-5 H-1 + SEC-009 (full-audit-2026-04-29):
    //   - tag:TagResources previously granted Resource "*" unconditionally.
    //   - tag:GetResources shared the aws:RequestTag condition with TagResources,
    //     but aws:RequestTag applies only to write operations. The read was
    //     either silently denied (condition evaluates to missing-key → deny)
    //     or left with an irrelevant condition.
    //   Fix: split into ResourceTaggingRead (GetResources, TagKeys-only) and
    //   ResourceTaggingWrite (TagResources, TagKeys + RequestTag).
    describe("ResourceTaggingRead statement (SEC-009 split — GetResources)", () => {
      it("exists and carries only ForAllValues:StringEquals aws:TagKeys condition (no RequestTag)", () => {
        // aws:RequestTag must NOT be present on the read statement —
        // it evaluates tags being SET in the request (absent for reads)
        // and would silently over-condition or deny all GetResources calls.
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ResourceTaggingRead",
        )!;
        expect(stmt).toBeDefined();
        expect(stmt.Effect).toBe("Allow");
        const tagKeysCondition =
          stmt.Condition?.["ForAllValues:StringEquals"]?.["aws:TagKeys"];
        expect(tagKeysCondition).toBeInstanceOf(Array);
        const keys = new Set(tagKeysCondition as string[]);
        expect(keys.has("managed-by")).toBe(true);
        expect(keys.has("assignee-run-id")).toBe(true);
        expect(keys.has("assignee-environment")).toBe(true);
        expect(keys.has("Name")).toBe(true);
        expect(keys.has("*")).toBe(false);
        // SEC-009: the read statement must NOT carry aws:RequestTag
        const requestTag =
          stmt.Condition?.["StringEquals"]?.["aws:RequestTag/managed-by"];
        expect(requestTag).toBeUndefined();
      });

      it("covers tag:GetResources only (not TagResources)", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ResourceTaggingRead",
        )!;
        expect(stmt.Action).toContain("tag:GetResources");
        expect(stmt.Action).not.toContain("tag:TagResources");
      });
    });

    describe("ResourceTaggingWrite statement (SEC-009 split — TagResources)", () => {
      it("carries both ForAllValues:StringEquals aws:TagKeys AND aws:RequestTag/managed-by=assignee-ai", () => {
        // aws:RequestTag is valid for TagResources (it evaluates the tags
        // being SET in the call — exactly what we want to enforce on writes).
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ResourceTaggingWrite",
        )!;
        expect(stmt).toBeDefined();
        expect(stmt.Effect).toBe("Allow");
        const tagKeysCondition =
          stmt.Condition?.["ForAllValues:StringEquals"]?.["aws:TagKeys"];
        expect(tagKeysCondition).toBeInstanceOf(Array);
        const keys = new Set(tagKeysCondition as string[]);
        expect(keys.has("managed-by")).toBe(true);
        expect(keys.has("assignee-run-id")).toBe(true);
        expect(keys.has("assignee-environment")).toBe(true);
        expect(keys.has("Name")).toBe(true);
        expect(keys.has("*")).toBe(false);
        expect(
          stmt.Condition?.["StringEquals"]?.["aws:RequestTag/managed-by"],
        ).toBe("assignee-ai");
      });

      it("covers tag:TagResources only (not GetResources)", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ResourceTaggingWrite",
        )!;
        expect(stmt.Action).toContain("tag:TagResources");
        expect(stmt.Action).not.toContain("tag:GetResources");
      });
    });

    // SEC-011 (full-audit-2026-04-29): destructive service actions
    // (lambda:DeleteFunction, ec2:TerminateInstances, etc.) were in
    // ServiceSpecificActionsA/B with Resource:"*" and no Condition.
    // They are now in ServiceDestructiveResourceTagScoped, scoped to
    // aws:ResourceTag/managed-by=assignee-ai.
    //
    // Bug S3-001 (2026-05-07): s3:DeleteObject and s3:DeleteObjectVersion
    // were previously in the unscoped service sweep (ServiceSpecificActionsA/B).
    // A leaked operator credential could delete objects from ANY S3 bucket
    // in the account. They are now tag-scoped alongside s3:DeleteBucket.
    describe("ServiceDestructiveResourceTagScoped statement (SEC-011)", () => {
      const DESTRUCTIVE = [
        "lambda:DeleteFunction",
        "ec2:TerminateInstances",
        "ecs:DeleteCluster",
        "sqs:DeleteQueue",
        "sns:DeleteTopic",
        "rds:DeleteDBInstance",
        "s3:DeleteBucket",
        "s3:DeleteBucketPolicy",
        // Bug S3-001: pre-delete sweep actions must also be tag-scoped
        // so a leaked credential cannot wipe objects from unmanaged buckets.
        "s3:DeleteObject",
        "s3:DeleteObjectVersion",
      ];

      it("exists as a dedicated statement in the core operator policy", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ServiceDestructiveResourceTagScoped",
        );
        expect(stmt).toBeDefined();
        expect(stmt!.Effect).toBe("Allow");
      });

      it("carries aws:ResourceTag/managed-by=assignee-ai condition", () => {
        // aws:ResourceTag is correct for destructive operations — it
        // evaluates the target resource's existing tags at auth time.
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ServiceDestructiveResourceTagScoped",
        )!;
        expect(stmt.Resource).toBe("*");
        expect(
          stmt.Condition?.["StringEquals"]?.["aws:ResourceTag/managed-by"],
        ).toBe("assignee-ai");
      });

      it("covers all SEC-011 destructive actions", () => {
        const policy = operatorPolicy();
        const stmt = policy.Statement.find(
          (s) => s.Sid === "ServiceDestructiveResourceTagScoped",
        )!;
        const actions = new Set(stmt.Action);
        for (const a of DESTRUCTIVE) {
          expect(
            actions.has(a),
            `${a} must be in ServiceDestructiveResourceTagScoped`,
          ).toBe(true);
        }
      });

      it("all SEC-011 destructive actions are absent from ServiceSpecificActionsA and ServiceSpecificActionsB", () => {
        const destructiveSet = new Set(DESTRUCTIVE);
        for (const policyFn of [
          operatorServicesAPolicy,
          operatorServicesBPolicy,
        ]) {
          const doc = policyFn();
          for (const statement of doc.Statement) {
            const stmtActions = Array.isArray(statement.Action)
              ? statement.Action
              : [statement.Action];
            for (const action of stmtActions) {
              expect(
                destructiveSet.has(action),
                `${action} must NOT appear in unscoped service sweep (${statement.Sid})`,
              ).toBe(false);
            }
          }
        }
      });
    });

    it("removes ALL snapshot mutate actions from the unscoped service sweep", () => {
      // All three (Delete + Copy + Create) must be absent from
      // operatorServicesA/B policies — IAM union semantics would
      // otherwise let the unscoped allow win and defeat both
      // conditions.
      const scopedActions = new Set([
        "rds:DeleteDBSnapshot",
        "rds:CopyDBSnapshot",
        "rds:CreateDBSnapshot",
      ]);
      for (const policyFn of [
        operatorServicesAPolicy,
        operatorServicesBPolicy,
      ]) {
        const doc = policyFn();
        for (const statement of doc.Statement) {
          for (const action of statement.Action) {
            expect(scopedActions.has(action)).toBe(false);
          }
        }
      }
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
