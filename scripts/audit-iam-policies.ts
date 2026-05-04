/**
 * Audit script: compares code-generated IAM policies (source of truth) against
 * what each command actually calls, and flags any missing permissions.
 *
 * Run with: pnpx tsx scripts/audit-iam-policies.ts
 *
 * W13-S4 (M-γ-04): critical-action lists are now DERIVED from the actual
 * policy-generator exports rather than maintained as parallel hardcoded arrays.
 * This prevents the class of drift where new scoped actions (e.g.
 * iam:DeleteRole / secretsmanager:GetSecretValue added in W13-S2) are missed
 * because the audit script was never updated.
 *
 * Registry-driven derivation strategy:
 *   1. Import the live action-set constants from action-collector.ts and
 *      operator.ts (the single source of truth for which actions are scoped).
 *   2. Build the "critical" list for each role from those constants — no
 *      hardcoded action strings.
 *   3. Add a "scoped-action integrity" check: every action in the must-be-scoped
 *      sets must NOT appear in any statement with Resource "*" AND no Condition.
 *      Fail the audit (exit 1) if a destructive/sensitive action leaks into an
 *      unscoped grant.
 */

import {
  operatorPolicy,
  operatorServicesAPolicy,
  operatorServicesBPolicy,
  readerPolicy,
  auditorPolicy,
  SUPPORTED_TYPES_ARRAY,
  getRequiredIamActions,
} from "../packages/core/dist/index.js";

// W13-S4: import action-set constants from the iam-policies sub-barrel.
// These are NOT re-exported through the main dist/index.js barrel (they're
// internal implementation details), so we import directly from the sub-path.
import {
  PRIV_ESC_SCOPED_IAM_ACTIONS,
  TAG_SCOPED_SECRETS_ACTIONS,
  TAG_SCOPED_RDS_SNAPSHOT_ACTIONS,
  REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS,
  DESTRUCTIVE_SERVICE_ACTIONS,
} from "../packages/core/dist/config/iam-policies/action-collector.js";
import {
  IAM_ROLE_MANAGEMENT_ACTIONS,
  IAM_ROLE_DESTRUCTIVE_ACTIONS,
} from "../packages/core/dist/config/iam-policies/operator.js";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface PolicyStatement {
  Sid?: string;
  Effect: string;
  Action: string | string[];
  Resource: string | string[];
  Condition?: Record<string, unknown>;
}

export interface PolicyDocument {
  Version: string;
  Statement: PolicyStatement[];
}

// ── Helpers (exported for testing) ────────────────────────────────────────────

export function collectActions(doc: PolicyDocument): Set<string> {
  const s = new Set<string>();
  for (const st of doc.Statement) {
    const actions = Array.isArray(st.Action) ? st.Action : [st.Action];
    for (const a of actions) s.add(a);
  }
  return s;
}

/**
 * Checks whether a statement grants unscoped access:
 *   - Resource is "*" (or contains "*")
 *   - No Condition block
 *
 * A statement with Resource: "*" AND a Condition is still considered
 * "scoped" for audit purposes (e.g. SecretsManagerGetValueTagScoped uses
 * Resource "*" with aws:ResourceTag — the condition IS the scope).
 */
export function isUnscopedWildcard(stmt: PolicyStatement): boolean {
  const resource = Array.isArray(stmt.Resource)
    ? stmt.Resource
    : [stmt.Resource];
  const hasWildcard = resource.some((r) => r === "*");
  const hasCondition =
    stmt.Condition != null && Object.keys(stmt.Condition).length > 0;
  return hasWildcard && !hasCondition;
}

/**
 * Checks whether all actions in `mustBeScoped` are absent from any statement
 * that is unscoped (Resource:"*" with no Condition).
 *
 * Returns an array of violation strings — empty array means PASS.
 * Each violation is: "<action> in Sid:<sid> — Resource:* with no Condition"
 */
export function findScopingViolations(
  statements: PolicyStatement[],
  mustBeScoped: Set<string>,
): string[] {
  const violations: string[] = [];
  for (const stmt of statements) {
    if (!isUnscopedWildcard(stmt)) continue;
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    for (const action of actions) {
      if (mustBeScoped.has(action)) {
        violations.push(
          `${action} in Sid:${stmt.Sid ?? "<no-sid>"} — Resource:* with no Condition`,
        );
      }
    }
  }
  return violations;
}

/**
 * Returns the registry-derived set of actions that MUST be scoped
 * (must NOT appear in any statement with Resource:"*" AND no Condition).
 *
 * Derived from the action-set constants in action-collector.ts and operator.ts
 * — the single source of truth.  Adding a new scoped action to those constants
 * automatically extends this set.
 */
export function buildMustBeScopedSet(): Set<string> {
  return new Set<string>([
    ...PRIV_ESC_SCOPED_IAM_ACTIONS, // iam:CreateRole/PassRole/AttachRolePolicy/PutRolePolicy/DeleteRole/DetachRolePolicy/DeleteRolePolicy
    ...IAM_ROLE_MANAGEMENT_ACTIONS, // subset of above — deduplicated by Set
    ...IAM_ROLE_DESTRUCTIVE_ACTIONS, // iam:DeleteRole/DetachRolePolicy/DeleteRolePolicy
    ...TAG_SCOPED_SECRETS_ACTIONS, // secretsmanager:GetSecretValue
    ...TAG_SCOPED_RDS_SNAPSHOT_ACTIONS, // rds:DeleteDBSnapshot/CopyDBSnapshot
    ...REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS, // rds:CreateDBSnapshot
    ...DESTRUCTIVE_SERVICE_ACTIONS, // SEC-011: lambda:DeleteFunction/ec2:TerminateInstances/etc.
  ]);
}

/**
 * F024: Actions that must NEVER appear in the operator policy at all.
 * These are privilege-escalation or account-management actions that the
 * operator role has no legitimate need for.  If a policy generator
 * accidentally adds one, the audit fails.
 *
 * NOTE: This is intentionally conservative.  Add entries here only for
 * actions that are universally unsafe in an operator context, not for
 * actions that are scoped via conditions (those go into buildMustBeScopedSet).
 */
export const BANNED_OPERATOR_ACTIONS: readonly string[] = [
  "iam:CreateUser",
  "iam:DeleteUser",
  "iam:CreateAccessKey",
  "iam:DeleteAccessKey",
  "iam:UpdateAccessKey",
  "iam:CreateLoginProfile",
  "iam:DeleteLoginProfile",
  "iam:UpdateLoginProfile",
  "iam:AddUserToGroup",
  "iam:RemoveUserFromGroup",
  "iam:CreateGroup",
  "iam:DeleteGroup",
  "iam:CreateAccountAlias",
  "iam:DeleteAccountAlias",
  "account:CloseAccount",
  "organizations:LeaveOrganization",
] as const;

/**
 * F024: Check that none of the banned operator actions appear in any statement
 * of the provided policy documents.  Returns an array of violation strings.
 *
 * Unlike `findScopingViolations` (positive check: must NOT be unscoped),
 * this is a negative check: must NOT be present at all.
 */
export function findBannedActions(
  statements: PolicyStatement[],
  banned: readonly string[],
): string[] {
  const bannedSet = new Set(banned);
  const violations: string[] = [];
  for (const stmt of statements) {
    const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
    for (const action of actions) {
      if (bannedSet.has(action)) {
        violations.push(
          `${action} in Sid:${stmt.Sid ?? "<no-sid>"} — banned action must not appear in operator policy`,
        );
      }
    }
  }
  return violations;
}

// ── Main audit (only runs when executed directly, not when imported) ───────────
//
// Guarding with `isMainModule` prevents process.exit(1) from firing when
// the test suite imports the exported helper functions.
// ESM pattern: compare import.meta.url to the resolved entry-point URL.

const isMainModule =
  typeof process !== "undefined" &&
  typeof process.argv[1] === "string" &&
  // tsx resolves the entry-point in process.argv[1]; match by file name suffix
  // rather than exact path so the check works with both `npx tsx` and `node`.
  (process.argv[1].endsWith("audit-iam-policies.ts") ||
    process.argv[1].endsWith("audit-iam-policies.js"));

if (isMainModule) {
  // ── Policy documents ─────────────────────────────────────────────────────────

  const op = operatorPolicy() as PolicyDocument;
  const opA = operatorServicesAPolicy() as PolicyDocument;
  const opB = operatorServicesBPolicy() as PolicyDocument;
  const rd = readerPolicy() as PolicyDocument;
  const au = auditorPolicy() as PolicyDocument;

  // ── Action sets ──────────────────────────────────────────────────────────────

  const opActions = collectActions(op);
  const opAllActions = new Set([
    ...opActions,
    ...collectActions(opA),
    ...collectActions(opB),
  ]);
  const rdActions = collectActions(rd);
  const auActions = collectActions(au);

  // ── Banner ───────────────────────────────────────────────────────────────────

  console.log("=".repeat(60));
  console.log("IAM POLICY AUDIT");
  console.log("=".repeat(60));
  console.log(
    `Operator: ${opAllActions.size} actions, ${op.Statement.length + opA.Statement.length + opB.Statement.length} statements (core + A + B)`,
  );
  console.log(
    `Reader:   ${rdActions.size} actions, ${rd.Statement.length} statements`,
  );
  console.log(
    `Auditor:  ${auActions.size} actions, ${au.Statement.length} statements`,
  );
  console.log("");

  // ── Per-resource-type coverage ───────────────────────────────────────────────

  console.log("--- Per-resource-type coverage (operator policy) ---");
  let missingTotal = 0;
  for (const type of SUPPORTED_TYPES_ARRAY) {
    const required = getRequiredIamActions(type);
    const missing: string[] = [];
    for (const act of required) {
      if (!opAllActions.has(act)) missing.push(act);
    }
    if (missing.length > 0) {
      console.log(`  ❌ ${type}: MISSING ${missing.length}`);
      for (const m of missing) console.log(`      - ${m}`);
      missingTotal += missing.length;
    } else {
      console.log(`  ✓ ${type}: ${required.length} actions covered`);
    }
  }
  console.log("");

  // ── Critical command action coverage (registry-driven) ───────────────────────
  //
  // W13-S4: these lists are derived from live policy-generator exports.
  // No hardcoded action strings for role-lifecycle or secrets actions — those
  // come from the same constants the policy generators consume.
  console.log("--- Critical command action coverage (registry-driven) ---");

  // Core operator invariants — CCAPI, Bedrock, tagging, SDK fallback.
  // These are structural (not resource-type-specific) so a small literal list
  // is intentional here; they do not drift with resource type additions.
  const criticalCoreCCAPI = [
    "bedrock:InvokeModel",
    "cloudcontrol:CreateResource",
    "cloudcontrol:DeleteResource",
    "cloudcontrol:GetResource",
    "cloudcontrol:UpdateResource",
    "tag:GetResources",
    "tag:TagResources",
    "ec2:CreateKeyPair",
    "ec2:DescribeKeyPairs",
    "ec2:DeleteKeyPair",
    // Note: cloudformation:DescribeType is READER-only (schema service uses reader creds)
  ];

  // IAM role-lifecycle: derived from the actual policy constants (W13-S4).
  // PRIV_ESC_SCOPED_IAM_ACTIONS = IAM_ROLE_MANAGEMENT_ACTIONS
  //   (CreateRole, PassRole, AttachRolePolicy, PutRolePolicy)
  // IAM_ROLE_DESTRUCTIVE_ACTIONS = DeleteRole, DetachRolePolicy, DeleteRolePolicy
  // Both sets were previously partial or absent in the hardcoded list.
  const criticalIamActions = [
    ...PRIV_ESC_SCOPED_IAM_ACTIONS,
    ...IAM_ROLE_MANAGEMENT_ACTIONS,
    ...IAM_ROLE_DESTRUCTIVE_ACTIONS,
  ];
  // Deduplicate (PRIV_ESC_SCOPED_IAM_ACTIONS ⊇ IAM_ROLE_MANAGEMENT_ACTIONS)
  const criticalForOperator = [
    ...criticalCoreCCAPI,
    ...[...new Set(criticalIamActions)],
    // Secrets: GetSecretValue must be present (tag-scoped, but present)
    ...[...TAG_SCOPED_SECRETS_ACTIONS],
    // RDS snapshot actions must be present (tag-scoped, but present)
    ...[...TAG_SCOPED_RDS_SNAPSHOT_ACTIONS],
    ...[...REQUEST_TAG_SCOPED_SNAPSHOT_ACTIONS],
  ];

  let criticalMissing = 0;
  for (const action of [...new Set(criticalForOperator)]) {
    const ok = opAllActions.has(action);
    console.log(`  ${ok ? "✓" : "❌"} operator: ${action}`);
    if (!ok) criticalMissing++;
  }
  console.log("");

  // Reader critical actions — schema + pricing + CE + EC2 reads.
  // These are structural reader grants; kept as literals because they don't
  // track a registry constant (reader has no analog to PRIV_ESC_SCOPED_IAM_ACTIONS).
  const criticalForReader = [
    "cloudformation:DescribeType",
    "cloudformation:ListTypes",
    "pricing:GetProducts",
    "pricing:DescribeServices",
    "ce:GetCostAndUsage",
    "ec2:DescribeInstances",
    "ec2:DescribeKeyPairs",
  ];
  for (const action of criticalForReader) {
    const ok = rdActions.has(action);
    console.log(`  ${ok ? "✓" : "❌"} reader:   ${action}`);
    if (!ok) criticalMissing++;
  }
  console.log("");

  // Auditor critical actions — IAM simulate + security service reads.
  const criticalForAuditor = [
    "iam:SimulatePrincipalPolicy",
    "iam:ListAttachedUserPolicies",
    "securityhub:GetFindings",
    "guardduty:ListFindings",
    "inspector2:ListFindings",
    "access-analyzer:ListFindings",
  ];
  for (const action of criticalForAuditor) {
    const ok = auActions.has(action);
    console.log(`  ${ok ? "✓" : "❌"} auditor:  ${action}`);
    if (!ok) criticalMissing++;
  }
  console.log("");

  // ── Scoped-action integrity check (W13-S4) ────────────────────────────────────
  //
  // Every action in these sets MUST be granted only via a scoped statement
  // (non-"*" Resource OR a Condition block). If any of them appears in an
  // unscoped "Resource: *" statement without a Condition, a leaked operator
  // credential would have unlimited reach for that action.
  //
  // Definition of "unscoped": Resource is "*" AND no Condition block.
  // A statement with Resource "*" + Condition (e.g. SecretsManagerGetValueTagScoped
  // using aws:ResourceTag) is intentionally scoped via condition — that passes.
  console.log(
    "--- Scoped-action integrity (no destructive action with Resource:* + no Condition) ---",
  );

  const mustBeScopedActions = buildMustBeScopedSet();
  const allStatements = [...op.Statement, ...opA.Statement, ...opB.Statement];
  const violations = findScopingViolations(allStatements, mustBeScopedActions);
  const scopingViolations = violations.length;

  for (const v of violations) {
    console.log(`  ❌ ${v}`);
  }

  if (scopingViolations === 0) {
    console.log(
      `  ✓ All ${mustBeScopedActions.size} must-be-scoped actions are absent from unscoped Resource:* grants`,
    );
  }
  console.log("");

  // F024: Banned-action check — ensure no operator policy statement contains
  // actions that the operator role must never have under any circumstance.
  console.log(
    "--- Banned-action check (operator must never have user/account management actions) ---",
  );
  const bannedViolations = findBannedActions(
    allStatements,
    BANNED_OPERATOR_ACTIONS,
  );
  const bannedViolationCount = bannedViolations.length;
  for (const v of bannedViolations) {
    console.log(`  ❌ ${v}`);
  }
  if (bannedViolationCount === 0) {
    console.log(
      `  ✓ All ${BANNED_OPERATOR_ACTIONS.length} banned actions are absent from the operator policy`,
    );
  }
  console.log("");

  // Cross-contamination check: auditor and reader should NOT have write actions
  console.log("--- Least privilege: no write actions in reader/auditor ---");
  // F027: Replace the old write-verb prefix approach (which misses iam:PassRole,
  // kms:Encrypt, sts:AssumeRole, etc.) with an inverted read-verb allowlist.
  // Any action whose verb does NOT start with a known read verb is flagged.
  // This is conservative-by-default: borderline verbs (Simulate, BatchGet…)
  // are explicitly included in READ_VERBS so they don't trigger false positives.
  // Actions are split on ":" to extract the verb; the service prefix is discarded.
  const READ_VERBS = [
    "Get",
    "List",
    "Describe",
    "Search",
    "Query",
    "Select",
    "Batch",
    "Read",
    "View",
    "Lookup",
    "Discover",
    "Test",
    "Validate",
    "Simulate",
    "Check",
    "Preview",
    "Scan",
    "Head",
    "Download",
    "Export",
    "Generate",
  ];
  function findWriteActions(actions: Set<string>, label: string): void {
    const writes: string[] = [];
    for (const act of actions) {
      // Split on the first ":" to isolate the verb portion.
      const colonIdx = act.indexOf(":");
      const verb = colonIdx !== -1 ? act.slice(colonIdx + 1) : act;
      const isRead = READ_VERBS.some((rv) => verb.startsWith(rv));
      if (!isRead) {
        writes.push(act);
      }
    }
    if (writes.length > 0) {
      console.log(`  ❌ ${label}: ${writes.length} non-read actions found!`);
      for (const w of writes) console.log(`      - ${w}`);
    } else {
      console.log(`  ✓ ${label}: zero non-read actions (read-only verified)`);
    }
  }
  findWriteActions(rdActions, "reader");
  findWriteActions(auActions, "auditor");
  console.log("");

  // Overlap check
  console.log("--- Action overlap between policies ---");
  const opRd = [...opActions].filter((a) => rdActions.has(a));
  const opAu = [...opActions].filter((a) => auActions.has(a));
  const rdAu = [...rdActions].filter((a) => auActions.has(a));
  console.log(`  operator ∩ reader:  ${opRd.length} actions`);
  console.log(`  operator ∩ auditor: ${opAu.length} actions`);
  console.log(`  reader   ∩ auditor: ${rdAu.length} actions`);
  console.log("");

  console.log("=".repeat(60));
  const totalFailures =
    missingTotal + criticalMissing + scopingViolations + bannedViolationCount;
  if (totalFailures === 0) {
    console.log(
      "✅ AUDIT PASSED — all required actions are covered and scoped correctly",
    );
  } else {
    if (missingTotal > 0)
      console.log(
        `❌ AUDIT FAILED — ${missingTotal} missing per-resource-type actions`,
      );
    if (criticalMissing > 0)
      console.log(
        `❌ AUDIT FAILED — ${criticalMissing} missing critical command actions`,
      );
    if (scopingViolations > 0)
      console.log(
        `❌ AUDIT FAILED — ${scopingViolations} destructive/sensitive actions granted with Resource:* and no Condition`,
      );
    if (bannedViolationCount > 0)
      console.log(
        `❌ AUDIT FAILED — ${bannedViolationCount} banned actions found in the operator policy`,
      );
    process.exit(1);
  }
  console.log("=".repeat(60));
}
