/**
 * Audit script: compares code-generated IAM policies (source of truth) against
 * what each command actually calls, and flags any missing permissions.
 *
 * Run with: pnpx tsx scripts/audit-iam-policies.ts
 */

import {
  operatorPolicy,
  readerPolicy,
  auditorPolicy,
  SUPPORTED_TYPES_ARRAY,
  getRequiredIamActions,
} from "../packages/core/dist/index.js";

const op = operatorPolicy();
const rd = readerPolicy();
const au = auditorPolicy();

function collectActions(doc: {
  Statement: { Action: string[] }[];
}): Set<string> {
  const s = new Set<string>();
  for (const st of doc.Statement) for (const a of st.Action) s.add(a);
  return s;
}

const opActions = collectActions(op);
const rdActions = collectActions(rd);
const auActions = collectActions(au);

console.log("=".repeat(60));
console.log("IAM POLICY AUDIT");
console.log("=".repeat(60));
console.log(
  `Operator: ${opActions.size} actions, ${op.Statement.length} statements`,
);
console.log(
  `Reader:   ${rdActions.size} actions, ${rd.Statement.length} statements`,
);
console.log(
  `Auditor:  ${auActions.size} actions, ${au.Statement.length} statements`,
);
console.log("");

// Verify every supported type's required actions are in operator policy
console.log("--- Per-resource-type coverage (operator policy) ---");
let missingTotal = 0;
for (const type of SUPPORTED_TYPES_ARRAY) {
  const required = getRequiredIamActions(type);
  const missing: string[] = [];
  for (const act of required) {
    if (!opActions.has(act)) missing.push(act);
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

// Verify critical command actions
console.log("--- Critical command action coverage ---");
const criticalForOperator = [
  "bedrock:InvokeModel",
  "cloudcontrol:CreateResource",
  "cloudcontrol:DeleteResource",
  "cloudcontrol:GetResource",
  "cloudcontrol:UpdateResource",
  "tag:GetResources",
  "tag:TagResources",
  "ssm:GetParameter",
  "ssm:PutParameter",
  "ssm:DeleteParameter",
  "lambda:CreateFunction",
  "lambda:GetFunction",
  "lambda:CreateEventSourceMapping",
  "iam:CreateRole",
  "iam:PassRole",
  "ec2:RunInstances",
  "ec2:CreateKeyPair",
  "ec2:DescribeKeyPairs",
  "ec2:DeleteKeyPair",
  // Note: cloudformation:DescribeType is READER-only (schema service uses reader creds)
];
for (const action of criticalForOperator) {
  const ok = opActions.has(action);
  console.log(`  ${ok ? "✓" : "❌"} operator: ${action}`);
}
console.log("");

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
}
console.log("");

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
}
console.log("");

// Cross-contamination check: auditor and reader should NOT have write actions
console.log("--- Least privilege: no write actions in reader/auditor ---");
const writeVerbs = [
  "Create",
  "Delete",
  "Put",
  "Update",
  "Attach",
  "Detach",
  "Authorize",
  "Revoke",
  "Modify",
  "Associate",
  "Disassociate",
  "Terminate",
  "Run",
  "Start",
  "Stop",
  "Reboot",
  "Reset",
  "Enable",
  "Disable",
  "Tag",
  "Untag",
];
function findWriteActions(actions: Set<string>, label: string): void {
  const writes: string[] = [];
  for (const act of actions) {
    const verb = act.split(":")[1] ?? "";
    if (writeVerbs.some((w) => verb.startsWith(w))) {
      writes.push(act);
    }
  }
  if (writes.length > 0) {
    console.log(`  ❌ ${label}: ${writes.length} write actions found!`);
    for (const w of writes) console.log(`      - ${w}`);
  } else {
    console.log(`  ✓ ${label}: zero write actions (read-only verified)`);
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
if (missingTotal === 0) {
  console.log("✅ AUDIT PASSED — all required actions are covered");
} else {
  console.log(`❌ AUDIT FAILED — ${missingTotal} missing actions`);
  process.exit(1);
}
console.log("=".repeat(60));
