/**
 * Tests for audit-iam-policies.ts — W13-S4 (full-audit-2026-04-29 M-γ-04)
 *
 * Tests the registry-driven critical-action derivation and scoped-action
 * integrity check added in W13-S4. Key behaviours under test:
 *
 *   (a) isUnscopedWildcard — correctly classifies statements
 *   (b) findScopingViolations — returns violations for unscoped destructive actions
 *   (c) findScopingViolations — passes for actions scoped via Condition
 *   (d) findScopingViolations — passes for actions scoped via non-* Resource
 *   (e) buildMustBeScopedSet — contains all W13-S2 additions
 *       (iam:DeleteRole, iam:DetachRolePolicy, iam:DeleteRolePolicy,
 *        secretsmanager:GetSecretValue)
 *   (f) buildMustBeScopedSet — contains the pre-W13-S2 IAM role mgmt actions
 *   (g) buildMustBeScopedSet — contains RDS snapshot actions
 *   (h) Regression against actual operator policy — no must-be-scoped action
 *       appears in an unscoped statement (ensures W13-S2 scoping is intact)
 *   (i) collectActions — unions actions from all statements including single-string form
 */

import { describe, it, expect } from "vitest";
import {
  isUnscopedWildcard,
  findScopingViolations,
  buildMustBeScopedSet,
  collectActions,
  type PolicyStatement,
  type PolicyDocument,
} from "./audit-iam-policies.js";

// Import live policy generators for regression test (h).
// vitest.config.ts aliases @assignee/core → packages/core/dist/index.js
import {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
} from "@assignee/core";

// ── (a) isUnscopedWildcard ─────────────────────────────────────────────────────

describe("isUnscopedWildcard", () => {
  it("returns true for Resource:* with no Condition", () => {
    const stmt: PolicyStatement = {
      Sid: "ServiceSpecificActionsA",
      Effect: "Allow",
      Action: ["s3:GetObject"],
      Resource: "*",
    };
    expect(isUnscopedWildcard(stmt)).toBe(true);
  });

  it("returns false for Resource:* with a non-empty Condition", () => {
    const stmt: PolicyStatement = {
      Sid: "SecretsManagerGetValueTagScoped",
      Effect: "Allow",
      Action: ["secretsmanager:GetSecretValue"],
      Resource: "*",
      Condition: {
        StringEquals: { "aws:ResourceTag/managed-by": "assignee-ai" },
      },
    };
    expect(isUnscopedWildcard(stmt)).toBe(false);
  });

  it("returns false for a non-* Resource (scoped ARN)", () => {
    const stmt: PolicyStatement = {
      Sid: "IamRoleManagementAssigneeScoped",
      Effect: "Allow",
      Action: ["iam:CreateRole"],
      Resource: "arn:${aws:PartitionId}:iam::${aws:AccountId}:role/assignee-*",
      Condition: {
        StringEquals: { "iam:PassedToService": ["lambda.amazonaws.com"] },
      },
    };
    expect(isUnscopedWildcard(stmt)).toBe(false);
  });

  it("returns false for a non-* Resource with no Condition", () => {
    const stmt: PolicyStatement = {
      Sid: "IamRoleDestructiveAssigneeScoped",
      Effect: "Allow",
      Action: ["iam:DeleteRole"],
      Resource: "arn:${aws:PartitionId}:iam::${aws:AccountId}:role/assignee-*",
    };
    expect(isUnscopedWildcard(stmt)).toBe(false);
  });

  it("returns false when Condition is an empty object (no keys)", () => {
    // An empty Condition object provides no scoping — treat as unscoped.
    // NOTE: the AWS policy engine ignores an empty Condition block, so
    // this is correctly classified as unscoped.
    const stmt: PolicyStatement = {
      Sid: "EmptyCondition",
      Effect: "Allow",
      Action: ["s3:DeleteObject"],
      Resource: "*",
      Condition: {},
    };
    expect(isUnscopedWildcard(stmt)).toBe(true);
  });

  it("handles Resource as an array that includes '*'", () => {
    const stmt: PolicyStatement = {
      Sid: "MultiResource",
      Effect: "Allow",
      Action: ["ec2:DescribeInstances"],
      Resource: ["arn:aws:ec2:us-east-1:123456789012:instance/*", "*"],
    };
    expect(isUnscopedWildcard(stmt)).toBe(true);
  });

  it("handles Resource as an array with no '*'", () => {
    const stmt: PolicyStatement = {
      Sid: "ScopedArray",
      Effect: "Allow",
      Action: ["ec2:DescribeInstances"],
      Resource: [
        "arn:aws:ec2:us-east-1:123456789012:instance/i-1",
        "arn:aws:ec2:us-east-1:123456789012:instance/i-2",
      ],
    };
    expect(isUnscopedWildcard(stmt)).toBe(false);
  });
});

// ── (b) findScopingViolations — violations detected ───────────────────────────

describe("findScopingViolations — detects unscoped destructive actions", () => {
  it("reports violation when iam:DeleteRole is in unscoped Resource:* statement", () => {
    const mustBeScoped = new Set(["iam:DeleteRole", "iam:DetachRolePolicy"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "ServiceSpecificActionsA",
        Effect: "Allow",
        Action: ["s3:GetObject", "iam:DeleteRole"],
        Resource: "*",
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("iam:DeleteRole");
    expect(violations[0]).toContain("ServiceSpecificActionsA");
  });

  it("reports all matching actions across multiple statements", () => {
    const mustBeScoped = new Set([
      "iam:DeleteRole",
      "secretsmanager:GetSecretValue",
    ]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "StmtA",
        Effect: "Allow",
        Action: ["iam:DeleteRole"],
        Resource: "*",
      },
      {
        Sid: "StmtB",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: "*",
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(2);
    expect(violations.some((v) => v.includes("iam:DeleteRole"))).toBe(true);
    expect(
      violations.some((v) => v.includes("secretsmanager:GetSecretValue")),
    ).toBe(true);
  });

  it("reports violation for string Action (not array)", () => {
    const mustBeScoped = new Set(["rds:DeleteDBSnapshot"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "RdsBad",
        Effect: "Allow",
        Action: "rds:DeleteDBSnapshot", // single string, not array
        Resource: "*",
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("rds:DeleteDBSnapshot");
  });

  it("includes <no-sid> in violation message when Sid is absent", () => {
    const mustBeScoped = new Set(["iam:CreateRole"]);
    const stmts: PolicyStatement[] = [
      {
        Effect: "Allow",
        Action: ["iam:CreateRole"],
        Resource: "*",
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations[0]).toContain("<no-sid>");
  });
});

// ── (c) findScopingViolations — passes for Condition-scoped ───────────────────

describe("findScopingViolations — passes for condition-scoped statements", () => {
  it("does not flag secretsmanager:GetSecretValue when guarded by aws:ResourceTag Condition", () => {
    const mustBeScoped = new Set(["secretsmanager:GetSecretValue"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "SecretsManagerGetValueTagScoped",
        Effect: "Allow",
        Action: ["secretsmanager:GetSecretValue"],
        Resource: "*",
        Condition: {
          StringEquals: { "aws:ResourceTag/managed-by": "assignee-ai" },
        },
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(0);
  });

  it("does not flag rds:DeleteDBSnapshot with ResourceTag condition", () => {
    const mustBeScoped = new Set(["rds:DeleteDBSnapshot"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "RdsSnapshotMutateTagScoped",
        Effect: "Allow",
        Action: ["rds:DeleteDBSnapshot", "rds:CopyDBSnapshot"],
        Resource: "*",
        Condition: {
          StringEquals: { "aws:ResourceTag/managed-by": "assignee-ai" },
        },
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(0);
  });
});

// ── (d) findScopingViolations — passes for scoped-ARN resource ────────────────

describe("findScopingViolations — passes for scoped-ARN resource", () => {
  it("does not flag iam:DeleteRole scoped to role/assignee-* ARN", () => {
    const mustBeScoped = new Set(["iam:DeleteRole"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "IamRoleDestructiveAssigneeScoped",
        Effect: "Allow",
        Action: [
          "iam:DeleteRole",
          "iam:DetachRolePolicy",
          "iam:DeleteRolePolicy",
        ],
        Resource:
          "arn:${aws:PartitionId}:iam::${aws:AccountId}:role/assignee-*",
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(0);
  });

  it("does not flag iam:CreateRole scoped to role/assignee-* ARN + PassedToService condition", () => {
    const mustBeScoped = new Set(["iam:CreateRole", "iam:PassRole"]);
    const stmts: PolicyStatement[] = [
      {
        Sid: "IamRoleManagementAssigneeScoped",
        Effect: "Allow",
        Action: [
          "iam:AttachRolePolicy",
          "iam:CreateRole",
          "iam:PassRole",
          "iam:PutRolePolicy",
        ],
        Resource:
          "arn:${aws:PartitionId}:iam::${aws:AccountId}:role/assignee-*",
        Condition: {
          StringEquals: {
            "iam:PassedToService": ["lambda.amazonaws.com"],
          },
        },
      },
    ];
    const violations = findScopingViolations(stmts, mustBeScoped);
    expect(violations).toHaveLength(0);
  });
});

// ── (e) buildMustBeScopedSet — W13-S2 additions ───────────────────────────────

describe("buildMustBeScopedSet — W13-S2 additions", () => {
  it("contains iam:DeleteRole (W13-S2 addition)", () => {
    const set = buildMustBeScopedSet();
    expect(set.has("iam:DeleteRole")).toBe(true);
  });

  it("contains iam:DetachRolePolicy (W13-S2 addition)", () => {
    const set = buildMustBeScopedSet();
    expect(set.has("iam:DetachRolePolicy")).toBe(true);
  });

  it("contains iam:DeleteRolePolicy (W13-S2 addition)", () => {
    const set = buildMustBeScopedSet();
    expect(set.has("iam:DeleteRolePolicy")).toBe(true);
  });

  it("contains secretsmanager:GetSecretValue (W13-S2 addition)", () => {
    const set = buildMustBeScopedSet();
    expect(set.has("secretsmanager:GetSecretValue")).toBe(true);
  });
});

// ── (f) buildMustBeScopedSet — pre-W13-S2 IAM role management actions ─────────

describe("buildMustBeScopedSet — pre-W13-S2 IAM role management actions", () => {
  it("contains iam:CreateRole", () => {
    expect(buildMustBeScopedSet().has("iam:CreateRole")).toBe(true);
  });

  it("contains iam:PassRole", () => {
    expect(buildMustBeScopedSet().has("iam:PassRole")).toBe(true);
  });

  it("contains iam:AttachRolePolicy", () => {
    expect(buildMustBeScopedSet().has("iam:AttachRolePolicy")).toBe(true);
  });

  it("contains iam:PutRolePolicy", () => {
    expect(buildMustBeScopedSet().has("iam:PutRolePolicy")).toBe(true);
  });
});

// ── (g) buildMustBeScopedSet — RDS snapshot actions ───────────────────────────

describe("buildMustBeScopedSet — RDS snapshot actions", () => {
  it("contains rds:DeleteDBSnapshot", () => {
    expect(buildMustBeScopedSet().has("rds:DeleteDBSnapshot")).toBe(true);
  });

  it("contains rds:CopyDBSnapshot", () => {
    expect(buildMustBeScopedSet().has("rds:CopyDBSnapshot")).toBe(true);
  });

  it("contains rds:CreateDBSnapshot", () => {
    expect(buildMustBeScopedSet().has("rds:CreateDBSnapshot")).toBe(true);
  });

  it("has at least 10 actions total (comprehensive coverage)", () => {
    expect(buildMustBeScopedSet().size).toBeGreaterThanOrEqual(10);
  });
});

// ── (h) Regression — actual operator policy ───────────────────────────────────
//
// This is the key regression test: no must-be-scoped action should appear
// in any unscoped statement across the combined operator policy surface
// (core + servicesA + servicesB). If W13-S2's scoped statements were
// accidentally reverted (or a new resource type added one of these actions
// to the unscoped sweep), this test will catch it.

describe("Regression: actual operator policy scoping (W13-S4)", () => {
  it("no must-be-scoped action appears unscoped in the combined operator policy", () => {
    const op = operatorPolicy();
    const opA = operatorServicesAPolicy();
    const opB = operatorServicesBPolicy();

    const allStatements = [
      ...op.Statement,
      ...opA.Statement,
      ...opB.Statement,
    ] as PolicyStatement[];

    const mustBeScoped = buildMustBeScopedSet();
    const violations = findScopingViolations(allStatements, mustBeScoped);

    // If this fails, a destructive or sensitive action is accessible via
    // Resource:* with no Condition — a leaked operator credential would
    // have unlimited reach. Each violation line names the action and Sid.
    expect(violations, violations.join("\n")).toHaveLength(0);
  });

  it("all W13-S2 IAM destructive actions are absent from ServiceSpecificActionsA and ServiceSpecificActionsB", () => {
    const w13s2Actions = new Set([
      "iam:DeleteRole",
      "iam:DetachRolePolicy",
      "iam:DeleteRolePolicy",
    ]);

    for (const policyFn of [operatorServicesAPolicy, operatorServicesBPolicy]) {
      const doc = policyFn();
      for (const stmt of doc.Statement) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        for (const action of actions) {
          expect(
            w13s2Actions.has(action),
            `${action} must NOT appear in unscoped service sweep (${stmt.Sid})`,
          ).toBe(false);
        }
      }
    }
  });

  it("secretsmanager:GetSecretValue is absent from ServiceSpecificActionsA and ServiceSpecificActionsB", () => {
    for (const policyFn of [operatorServicesAPolicy, operatorServicesBPolicy]) {
      const doc = policyFn();
      for (const stmt of doc.Statement) {
        const actions = Array.isArray(stmt.Action)
          ? stmt.Action
          : [stmt.Action];
        for (const action of actions) {
          expect(action).not.toBe("secretsmanager:GetSecretValue");
        }
      }
    }
  });

  it("IamRoleDestructiveAssigneeScoped statement exists and uses scoped ARN (W13-S2)", () => {
    const op = operatorPolicy();
    const stmt = op.Statement.find(
      (s) => s.Sid === "IamRoleDestructiveAssigneeScoped",
    ) as PolicyStatement | undefined;
    expect(stmt).toBeDefined();
    expect(stmt!.Resource).not.toBe("*");
    const resource = Array.isArray(stmt!.Resource)
      ? stmt!.Resource
      : [stmt!.Resource];
    expect(resource.some((r) => r.includes("role/assignee-*"))).toBe(true);
  });

  it("SecretsManagerGetValueTagScoped statement exists and has aws:ResourceTag Condition (W13-S2)", () => {
    const op = operatorPolicy();
    const stmt = op.Statement.find(
      (s) => s.Sid === "SecretsManagerGetValueTagScoped",
    ) as PolicyStatement | undefined;
    expect(stmt).toBeDefined();
    expect(stmt!.Resource).toBe("*");
    // Must have a Condition that scopes it (so isUnscopedWildcard returns false)
    expect(stmt!.Condition).toBeDefined();
    expect(Object.keys(stmt!.Condition!).length).toBeGreaterThan(0);
    // The condition must use aws:ResourceTag/managed-by
    const stringEquals = (stmt!.Condition as Record<string, unknown>)[
      "StringEquals"
    ] as Record<string, string> | undefined;
    expect(stringEquals?.["aws:ResourceTag/managed-by"]).toBe("assignee-ai");
  });
});

// ── (i) collectActions ────────────────────────────────────────────────────────

describe("collectActions", () => {
  it("collects actions from all statements into a flat set", () => {
    const doc: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "A",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: "*",
        },
        {
          Sid: "B",
          Effect: "Allow",
          Action: ["ec2:DescribeInstances"],
          Resource: "*",
        },
      ],
    };
    const result = collectActions(doc);
    expect(result.has("s3:GetObject")).toBe(true);
    expect(result.has("s3:PutObject")).toBe(true);
    expect(result.has("ec2:DescribeInstances")).toBe(true);
    expect(result.size).toBe(3);
  });

  it("handles string Action (not array)", () => {
    const doc: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "Single",
          Effect: "Allow",
          Action: "bedrock:InvokeModel",
          Resource: "*",
        },
      ],
    };
    const result = collectActions(doc);
    expect(result.has("bedrock:InvokeModel")).toBe(true);
    expect(result.size).toBe(1);
  });

  it("deduplicates actions that appear in multiple statements", () => {
    const doc: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "StmtA",
          Effect: "Allow",
          Action: ["s3:GetObject"],
          Resource: "*",
        },
        {
          Sid: "StmtB",
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject"],
          Resource: "*",
        },
      ],
    };
    const result = collectActions(doc);
    expect(result.size).toBe(2); // not 3 — duplicate removed
  });

  it("returns empty set for policy with no statements", () => {
    const doc: PolicyDocument = {
      Version: "2012-10-17",
      Statement: [],
    };
    expect(collectActions(doc).size).toBe(0);
  });
});
