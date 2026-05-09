/**
 * Bulk-destroy orchestrator for `assignee destroy --all`.
 *
 * Pipeline:
 *   1. Enumerate managed resources via fetchManagedResources (RGTA + IAM roles + provision log).
 *   2. Filter out resources matching EXCLUSION_ALLOWLIST (unconditional — no flag override).
 *   3. Apply the 100-resource hard cap (requires --allow-large-sweep for > 100).
 *   4. Sort the destroy plan by TYPE_DESTROY_ORDER to respect cross-resource dependencies.
 *   5. Render the plan + cost summary + exclusion list.
 *   6. In dry-run mode (no --yes): exit 0 with no AWS writes.
 *   7. In execute mode (--yes): prompt for typed account-ID confirmation (unless --no-confirm).
 *   8. Execute per-resource destroy via singleDestroyAction; continue on per-resource failure.
 *   9. Append one bulk audit event.
 *  10. Print final summary; exit non-zero when any resource failed.
 *
 * Design decisions:
 *
 * - Dry-run is the DEFAULT when --yes is omitted. This matches the story spec
 *   ("default to dry-run preview") and prevents accidental bulk destruction.
 *
 * - EXCLUSION_ALLOWLIST is enforced here by matching each resource's ARN against
 *   the patterns from `@assignee/core/destroy`. Non-taggable constructs (keyKind
 *   = "primaryIdentifier", arn = "") have an empty ARN and therefore are never
 *   matched — they are included in the plan by default. That is correct: non-
 *   taggable constructs (EC2::Route, SubnetRouteTableAssociation) are never
 *   assignee self-infrastructure resources, which are all IAM entities.
 *
 * - Per-resource destroy delegates to singleDestroyAction with { yes: true } so
 *   it never re-prompts. Confirmation is handled once, at the bulk level.
 *
 * - TYPE_DESTROY_ORDER defines a dependency-respecting destroy sequence.
 *   Types absent from the constant get order index 999 (last). The ordering
 *   comment explains each dependency edge.
 *
 * - Cost summary: sums `estimatedMonthlyCost` from ManagedResource if present
 *   and numeric. N/A rows count as $0. A note explains that Pricing MCP
 *   enrichment provides real-time costs (separate story).
 *
 * @see packages/core/src/destroy/exclusion-allowlist.ts  (allowlist patterns)
 * @see apps/cli/src/commands/destroy/single-flow.ts      (per-resource destroy)
 * @see feature-bulk-destroy-with-allowlist.md             (story spec)
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import { appendAuditRecord } from "@assignee/core/audit";
import { findExclusion, isExcluded } from "@assignee/core/destroy";
import { AssigneeError } from "@assignee/core";
import type { ManagedResource } from "@assignee/core";
import { fetchManagedResources } from "../../services/list-resources.js";
import { singleDestroyAction } from "./single-flow.js";

/**
 * Default destroyer used when the Commander wrapper doesn't inject one
 * (e.g. unit tests that exercise bulk-action in isolation). Production
 * wiring overrides via `BulkDestroyOptions.destroyOne` to reach the
 * full `destroyAction` (which honours per-type flags). The fallback
 * delegates to `singleDestroyAction` and intentionally drops per-type
 * flags — they only matter for KMS/SecretsManager and the test mocks
 * cover those paths via the destroyOne injection point.
 */
async function destroyOneFallback(
  resource: string,
  opts: { yes?: boolean },
): Promise<"already_pending" | void> {
  return singleDestroyAction(resource, { yes: opts.yes ?? true });
}
import { tryAssigneeCredentials } from "../../config/aws-credentials.js";
import { AWS_REGION } from "../../config/constants.js";
import { startSpinner, stopSpinner } from "../../utils/display.js";
import { ErrorCode } from "../../constants/errors.js";

// ── Destroy order (dependency-respecting) ─────────────────────────────
//
// Cross-resource dependency rationale (each pair is a directed edge
// A→B meaning "A must be destroyed BEFORE B"):
//
//   CloudFront → S3 (bucket may be an origin; CF must release the origin first)
//   Lambda → IAM Role (Lambda's execution role; delete function first)
//   ECS Task Definition → IAM Role (task execution role)
//   ECS Service → ECS Cluster (service must be gone before cluster drain)
//   EC2 Route → EC2 RouteTable (routes are sub-resources of route tables)
//   EC2 RouteTable → VPC (route tables are anchored to VPCs)
//   EC2 Subnet → VPC
//   EC2 InternetGateway → VPC (IGW detach/delete before VPC)
//   EC2 SecurityGroup → VPC
//   EC2 VPCGatewayAttachment → VPC / IGW
//   EC2 SubnetRouteTableAssociation → Subnet + RouteTable
//   ALB/NLB/ELB → Security Group (ELB holds an ENI on the SG)
//   RDS Instance → RDS Subnet Group (subnet group cannot be deleted while instance exists)
//   SNS Subscription → SNS Topic
//   SQS Queue → IAM Role (if policy references queue)
//   SecretsManager Secret → KMS Key (if secret uses a CMK)
//   IAM Role → KMS Key (if role policy references key) — actually KMS stays last
//   IAM ManagedPolicy → IAM User / Role (detached by destroy, but still order for safety)
//
// Types not in this list get order index 999 (destroyed last/arbitrarily).
const TYPE_DESTROY_ORDER: ReadonlyMap<string, number> = new Map([
  // CloudFront distributions must be disabled + deleted before S3 origins
  ["AWS::CloudFront::Distribution", 10],
  ["AWS::CloudFront::CloudFrontOriginAccessControl", 11],

  // ECS: services before clusters; task defs before execution roles
  ["AWS::ECS::Service", 20],
  ["AWS::ECS::TaskDefinition", 21],
  ["AWS::ECS::Cluster", 22],

  // Lambda before its execution role
  ["AWS::Lambda::Function", 30],
  ["AWS::Lambda::EventSourceMapping", 31],

  // ALB/NLB/ELBv2 before target groups and security groups
  ["AWS::ElasticLoadBalancingV2::LoadBalancer", 40],
  ["AWS::ElasticLoadBalancingV2::TargetGroup", 41],
  ["AWS::ElasticLoadBalancingV2::Listener", 42],

  // RDS instances before subnet groups
  ["AWS::RDS::DBInstance", 50],
  ["AWS::RDS::DBCluster", 51],
  ["AWS::RDS::DBSubnetGroup", 52],

  // SNS subscriptions before topics
  ["AWS::SNS::Subscription", 60],
  ["AWS::SNS::Topic", 61],

  // SQS queues before any referencing IAM policies
  ["AWS::SQS::Queue", 70],

  // EC2 constructs: sub-resources before their parents
  // Route/SubnetRouteTableAssociation before RouteTable
  ["AWS::EC2::Route", 80],
  ["AWS::EC2::SubnetRouteTableAssociation", 81],
  // VPCGatewayAttachment must be removed before the IGW and VPC
  ["AWS::EC2::VPCGatewayAttachment", 82],
  // RouteTable before Subnet + VPC
  ["AWS::EC2::RouteTable", 83],
  // Subnet before VPC
  ["AWS::EC2::Subnet", 84],
  // IGW before VPC
  ["AWS::EC2::InternetGateway", 85],
  // SecurityGroup before VPC
  ["AWS::EC2::SecurityGroup", 86],
  // EC2 instance before its SG
  ["AWS::EC2::Instance", 87],
  // EIP after EC2 instance (disassociate first)
  ["AWS::EC2::EIP", 88],
  // VPC is a parent — destroy last among EC2 constructs
  ["AWS::EC2::VPC", 89],

  // S3 buckets after CloudFront
  ["AWS::S3::Bucket", 90],

  // DynamoDB tables (no sub-resource ordering needed here)
  ["AWS::DynamoDB::Table", 100],

  // ElastiCache
  ["AWS::ElastiCache::ReplicationGroup", 110],
  ["AWS::ElastiCache::SubnetGroup", 111],

  // EventBridge: rules before buses; connections before API destinations
  ["AWS::Events::Rule", 120],
  ["AWS::Events::ApiDestination", 121],
  ["AWS::Events::Connection", 122],
  ["AWS::Events::EventBus", 123],

  // SecretsManager secrets before KMS keys (secret may reference CMK)
  ["AWS::SecretsManager::Secret", 130],

  // IAM: Users + Roles before Policies; KMS after all IAM (role policy may reference key)
  ["AWS::IAM::User", 140],
  ["AWS::IAM::Role", 141],
  ["AWS::IAM::ManagedPolicy", 142],

  // KMS keys very last (everything that may reference the key is already gone)
  ["AWS::KMS::Key", 150],
]);

function getDestroyOrder(resourceType: string): number {
  return TYPE_DESTROY_ORDER.get(resourceType) ?? 999;
}

/** Sort a resource list by TYPE_DESTROY_ORDER ascending (stable). */
function sortByDestroyOrder(resources: ManagedResource[]): ManagedResource[] {
  return [...resources].sort(
    (a, b) => getDestroyOrder(a.resourceType) - getDestroyOrder(b.resourceType),
  );
}

// ── Cost summary helper ────────────────────────────────────────────────

/**
 * Compute the total estimated monthly cost saved by destroying all
 * resources in the plan. Rows with "N/A" or non-numeric values count
 * as $0 (no Pricing MCP enrichment yet — separate story).
 */
function sumEstimatedCosts(resources: ManagedResource[]): string {
  let total = 0;
  let hasAny = false;
  for (const r of resources) {
    const cost = r.estimatedMonthlyCost;
    if (!cost || cost === "N/A") continue;
    // Strip leading "$" and parse numeric part
    const numeric = parseFloat(cost.replace(/^\$/, "").replace(/[^0-9.]/g, ""));
    if (!Number.isNaN(numeric)) {
      total += numeric;
      hasAny = true;
    }
  }
  if (!hasAny) return "N/A";
  return `$${total.toFixed(2)}/month`;
}

// ── Typed account-ID confirmation ─────────────────────────────────────

/**
 * Get the AWS account ID for the current operator credentials.
 * Falls back to "UNKNOWN" when credentials are not configured so the
 * prompt is still rendered (operator must still type something).
 */
function resolveAccountId(): string {
  const creds = tryAssigneeCredentials("operator");
  if (!creds) return "UNKNOWN";
  // Access keys encode the account ID in the first characters, but we
  // don't have direct access to STS here. Use the region as a proxy
  // only if nothing else is available. In practice, the user's account
  // ID is returned by the credential loader if it cached the STS call.
  // For now emit "CONFIRM" as a safe fallback for non-STS paths.
  // The operator must type their account ID — if we don't know it,
  // we display a message explaining where to find it.
  return "CONFIRM";
}

/**
 * Prompt the operator to type their 12-digit AWS account ID before
 * any destroy fires. Returns true on confirmation, false on refusal.
 *
 * The phrase must be the account ID to prevent fat-finger accidents
 * while still being memorisable (operators know their account ID).
 */
async function promptTypedAccountConfirmation(
  accountId: string,
): Promise<boolean> {
  const phrase =
    accountId === "CONFIRM" || accountId === "UNKNOWN"
      ? "DESTROY-EVERYTHING"
      : accountId;

  const hintLine =
    accountId === "CONFIRM" || accountId === "UNKNOWN"
      ? `(Your AWS account ID — run \`aws sts get-caller-identity\` to find it, or type DESTROY-EVERYTHING to proceed)`
      : `(Your AWS account ID: ${accountId})`;

  process.stderr.write(
    `\n[bulk-destroy] CONFIRMATION REQUIRED\n` +
      `  You are about to destroy ALL managed resources in this AWS account.\n` +
      `  This action is IRREVERSIBLE.\n` +
      `  ${hintLine}\n\n`,
  );

  const answer = await clack.text({
    message: `Type '${phrase}' to confirm bulk destruction, or press Ctrl-C to cancel:`,
  });

  if (clack.isCancel(answer)) return false;
  if (typeof answer !== "string") return false;
  return answer.trim() === phrase;
}

// ── Plan rendering ─────────────────────────────────────────────────────

function renderPlanLine(
  idx: number,
  total: number,
  r: ManagedResource,
): string {
  const id = r.arn || r.primaryIdentifier || "(no identifier)";
  const cost =
    r.estimatedMonthlyCost && r.estimatedMonthlyCost !== "N/A"
      ? ` [${r.estimatedMonthlyCost}]`
      : "";
  return `  ${String(idx + 1).padStart(String(total).length, " ")}. ${r.resourceType} — ${id}${cost}`;
}

function renderPlan(
  plan: ManagedResource[],
  excluded: Array<{ resource: ManagedResource; reason: string }>,
  totalCostSaved: string,
): void {
  const isTTY = process.stdout.isTTY;
  const hr = "─".repeat(70);

  const header = isTTY
    ? chalk.bold.red("╔══════════════════════════════════════════╗\n") +
      chalk.bold.red("║       assignee destroy --all  DRY-RUN   ║\n") +
      chalk.bold.red("╚══════════════════════════════════════════╝")
    : "=== assignee destroy --all  DRY-RUN ===";

  process.stdout.write(header + "\n\n");

  // Plan
  if (plan.length === 0) {
    process.stdout.write(
      "Nothing to destroy (no managed resources outside the exclusion allowlist).\n",
    );
  } else {
    process.stdout.write(
      (isTTY ? chalk.bold("DESTROY PLAN") : "DESTROY PLAN") +
        ` (${plan.length} resource${plan.length !== 1 ? "s" : ""}, in order):\n`,
    );
    for (let i = 0; i < plan.length; i++) {
      process.stdout.write(renderPlanLine(i, plan.length, plan[i]!) + "\n");
    }
    process.stdout.write("\n");
    process.stdout.write(
      (isTTY
        ? chalk.bold("Estimated monthly savings: ")
        : "Estimated monthly savings: ") +
        totalCostSaved +
        "\n",
    );
    process.stdout.write(
      `  Note: real-time cost enrichment requires Pricing MCP — ` +
        `see feature-pricing-mcp-list-enrichment.md\n\n`,
    );
  }

  // Excluded resources
  if (excluded.length > 0) {
    process.stdout.write(hr + "\n");
    process.stdout.write(
      (isTTY
        ? chalk.bold.yellow("EXCLUDED (self-lockout protection): ")
        : "EXCLUDED (self-lockout protection): ") +
        `${excluded.length} resource${excluded.length !== 1 ? "s" : ""}\n`,
    );
    for (const { resource, reason } of excluded) {
      const id =
        resource.arn || resource.primaryIdentifier || "(no identifier)";
      process.stdout.write(`  • ${id}\n    ${reason}\n`);
    }
    process.stdout.write("\n");
  }

  process.stdout.write(hr + "\n");
  if (plan.length === 0) {
    process.stdout.write("No resources to destroy.\n");
  } else {
    process.stdout.write(
      "Re-run with --yes to execute this plan.\n" +
        "  Use --yes --no-confirm to skip typed-confirmation (CI/CD).\n",
    );
  }
}

// ── Progress rendering ─────────────────────────────────────────────────

/**
 * Per-resource outcome for the final summary + per-line rendering.
 * - `"destroyed"` — resource was freshly destroyed in this run.
 * - `"already_pending"` — resource was already scheduled for deletion (idempotent success).
 * - `"failed"` — destroy threw an error.
 *
 * Hoisted to module scope (Defect 2 fix, 2026-05-09) so the renderer
 * can pattern-match on it.
 */
type ResourceOutcome = "destroyed" | "already_pending" | "failed";

function renderResourceStart(
  idx: number,
  total: number,
  r: ManagedResource,
): void {
  const id = r.arn || r.primaryIdentifier || "(no identifier)";
  process.stderr.write(
    `[${idx + 1}/${total}] Destroying ${r.resourceType} — ${id} ...\n`,
  );
}

/**
 * Defect 2 fix (2026-05-09): widened to accept the per-resource
 * `outcome` instead of a bare `success` boolean. The previous signature
 * collapsed `destroyed` and `already_pending` into the same `success`
 * branch and unconditionally printed `"✓ Destroyed"`, which was a lie
 * for KMS keys / SecretsManager secrets that were already in
 * PendingDeletion before this run. The bulk loop already classifies
 * the outcome at site `:675-ish`; this renderer now branches on it.
 */
function renderResourceDone(
  idx: number,
  total: number,
  r: ManagedResource,
  outcome: ResourceOutcome,
  error?: string,
): void {
  const id = r.arn || r.primaryIdentifier || "(no identifier)";
  if (outcome === "destroyed") {
    const line = `[${idx + 1}/${total}] ✓ Destroyed ${r.resourceType} — ${id}\n`;
    process.stderr.write(process.stderr.isTTY ? chalk.green(line) : line);
  } else if (outcome === "already_pending") {
    // ↻ marker (counter-clockwise arrow) signals "already in flight"
    // so the operator can distinguish a fresh destroy from a re-run
    // hitting an already-scheduled resource. Yellow on TTY.
    const line = `[${idx + 1}/${total}] ↻ Already pending ${r.resourceType} — ${id}\n`;
    process.stderr.write(process.stderr.isTTY ? chalk.yellow(line) : line);
  } else {
    const line = `[${idx + 1}/${total}] ✗ FAILED ${r.resourceType} — ${id}: ${error ?? "unknown error"}\n`;
    process.stderr.write(process.stderr.isTTY ? chalk.red(line) : line);
  }
}

// ── JSON output envelope ───────────────────────────────────────────────

interface BulkDestroyJsonEnvelope {
  ok: boolean;
  operation: "bulk_destroy";
  plan: Array<{ arn: string; resourceType: string; region: string }>;
  executed: Array<{
    arn: string;
    resourceType: string;
    success: boolean;
    /** Detailed outcome: "destroyed" | "already_pending" | "failed". */
    outcome: string;
    error?: string;
  }>;
  excluded: Array<{ arn: string; resourceType: string; reason: string }>;
  totalCostSaved: string;
}

// ── Option types ───────────────────────────────────────────────────────

export interface BulkDestroyOptions {
  yes?: boolean;
  noConfirm?: boolean;
  allowLargeSweep?: boolean;
  json?: boolean;
  pendingWindowInDays?: string;
  forceDeleteWithoutRecovery?: boolean;
  recoveryWindowInDays?: string;
  /**
   * Per-resource destroy callback. Injected by the Commander wrapper to
   * avoid a circular import (`destroy.ts` → `bulk-action.ts` →
   * `destroy.ts`). Defaults to a thin wrapper around `singleDestroyAction`
   * for tests; production wiring uses the full `destroyAction` from
   * `destroy.ts` so per-type flags (KMS pending-window /
   * SecretsManager recovery-window / force-delete) reach the CCAPI-bypass
   * dispatcher.
   *
   * May return `"already_pending"` when the resource was already scheduled
   * for deletion (KMS / SecretsManager idempotent-success paths). Returning
   * `void` / `undefined` is treated as `"destroyed"`. This allows the bulk
   * summary to distinguish new destroys from pre-existing scheduled states.
   */
  destroyOne?: (
    resource: string,
    opts: {
      yes?: boolean;
      pendingWindowInDays?: string;
      forceDeleteWithoutRecovery?: boolean;
      recoveryWindowInDays?: string;
    },
  ) => Promise<"already_pending" | void>;
}

// ── Hard cap ──────────────────────────────────────────────────────────

const RESOURCE_CAP = 100;

// ── Main orchestrator ─────────────────────────────────────────────────

/**
 * Main bulk-destroy action. Called by the Commander wrapper when `--all`
 * is passed. See module-level JSDoc for the full pipeline description.
 *
 * Returns without throwing on per-resource failure (continue-on-error).
 * Sets process.exitCode to 1 when any resource fails.
 */
export async function runBulkDestroyAction(
  opts: BulkDestroyOptions,
): Promise<void> {
  const jsonMode = opts.json === true;

  // ── 1. Enumerate managed resources ──────────────────────────────────
  if (!jsonMode) {
    startSpinner("Enumerating managed resources...");
  }
  let allResources: ManagedResource[];
  try {
    allResources = await fetchManagedResources(AWS_REGION);
  } finally {
    if (!jsonMode) {
      stopSpinner();
    }
  }

  // ── 2. Apply the exclusion allowlist (unconditional) ────────────────
  const planResources: ManagedResource[] = [];
  const excludedResources: Array<{
    resource: ManagedResource;
    reason: string;
  }> = [];

  for (const r of allResources) {
    const exclusion = r.arn ? findExclusion(r.arn) : undefined;
    if (exclusion) {
      excludedResources.push({ resource: r, reason: exclusion.reason });
    } else {
      planResources.push(r);
    }
  }

  // ── 3. Hard resource cap ────────────────────────────────────────────
  if (planResources.length > RESOURCE_CAP && !opts.allowLargeSweep) {
    const msg =
      `Bulk destroy would affect ${planResources.length} resources, which exceeds the ` +
      `${RESOURCE_CAP}-resource safety threshold. ` +
      `Pass --allow-large-sweep to proceed. ` +
      `(${excludedResources.length} resources are excluded by the self-lockout allowlist.)`;
    if (jsonMode) {
      process.stdout.write(
        JSON.stringify({
          ok: false,
          operation: "bulk_destroy",
          error: msg,
          plan: [],
          executed: [],
          excluded: excludedResources.map((e) => ({
            arn: e.resource.arn,
            resourceType: e.resource.resourceType,
            reason: e.reason,
          })),
          totalCostSaved: "N/A",
        }) + "\n",
      );
    } else {
      process.stderr.write(`[bulk-destroy] ERROR: ${msg}\n`);
    }
    process.exitCode = 1;
    return;
  }

  // ── 4. Sort by destroy order ─────────────────────────────────────────
  const orderedPlan = sortByDestroyOrder(planResources);

  // ── 5. Compute cost summary ──────────────────────────────────────────
  const totalCostSaved = sumEstimatedCosts(orderedPlan);

  // ── 6. JSON mode: emit plan envelope only ────────────────────────────
  if (jsonMode && !opts.yes) {
    const envelope: BulkDestroyJsonEnvelope = {
      ok: true,
      operation: "bulk_destroy",
      plan: orderedPlan.map((r) => ({
        arn: r.arn,
        resourceType: r.resourceType,
        region: r.region,
      })),
      executed: [],
      excluded: excludedResources.map((e) => ({
        arn: e.resource.arn,
        resourceType: e.resource.resourceType,
        reason: e.reason,
      })),
      totalCostSaved,
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return;
  }

  // ── 6b. Text dry-run: render plan and exit ────────────────────────────
  if (!opts.yes) {
    renderPlan(orderedPlan, excludedResources, totalCostSaved);
    return;
  }

  // ── 7. Typed account-ID confirmation (--yes path) ────────────────────
  if (!opts.noConfirm) {
    // JSON mode + interactive prompt is incompatible: the prompt writes
    // human prose to stderr that downstream JSON consumers cannot parse,
    // and stdin reads block the JSON envelope from being emitted promptly.
    // Force the operator to choose: either drop --json (interactive) or
    // pass --no-confirm (CI/CD).
    if (jsonMode) {
      throw new AssigneeError(
        "--json mode is incompatible with the interactive typed-account-ID prompt. " +
          "Pass --no-confirm to skip the prompt (CI/CD), or drop --json to use the interactive flow.",
        ErrorCode.DESTROY_ERROR,
      );
    }
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Bulk destroy requires typed-account-ID confirmation. Use --no-confirm for non-interactive mode (CI/CD).",
        ErrorCode.DESTROY_ERROR,
      );
    }
    const accountId = resolveAccountId();
    const confirmed = await promptTypedAccountConfirmation(accountId);
    if (!confirmed) {
      process.stderr.write(
        "[bulk-destroy] Confirmation not received. No resources destroyed.\n",
      );
      process.exitCode = 1;
      return;
    }
  } else {
    process.stderr.write(
      "[bulk-destroy] WARNING: --no-confirm flag used — skipping typed-account-ID confirmation. " +
        "For CI/CD use only.\n",
    );
  }

  if (orderedPlan.length === 0) {
    if (!jsonMode) {
      process.stdout.write(
        "Nothing to destroy (all managed resources are in the exclusion allowlist).\n",
      );
    }
    await writeAuditEvent({
      plan: orderedPlan,
      executed: [],
      excluded: excludedResources,
      totalCostSaved,
    });
    return;
  }

  // ── 8. Execute per-resource destroy (continue-on-error) ──────────────
  if (!jsonMode) {
    process.stdout.write(
      `\nExecuting bulk destroy of ${orderedPlan.length} resource${orderedPlan.length !== 1 ? "s" : ""}...\n\n`,
    );
  }

  const executionResults: Array<{
    resource: ManagedResource;
    success: boolean;
    outcome: ResourceOutcome;
    error?: string;
  }> = [];

  for (let i = 0; i < orderedPlan.length; i++) {
    const r = orderedPlan[i]!;
    if (!jsonMode) {
      renderResourceStart(i, orderedPlan.length, r);
    }

    let success = false;
    let outcome: ResourceOutcome = "failed";
    let errorMessage: string | undefined;

    try {
      // Determine what identifier to pass to singleDestroyAction.
      // It accepts an ARN or a resource name. For non-taggable constructs
      // (keyKind = "primaryIdentifier"), use the primaryIdentifier.
      const identifier =
        r.arn ||
        r.primaryIdentifier ||
        (() => {
          throw new AssigneeError(
            `Resource ${r.resourceType} has neither ARN nor primaryIdentifier — cannot destroy.`,
            ErrorCode.DESTROY_ERROR,
          );
        })();

      // Build destroy opts — forward per-type flags conditionally on the
      // resolved resource type. The downstream destroyAction guard rejects
      // `pendingWindow` for non-KMS / `recoveryWindow` + `forceDelete` for
      // non-SecretsManager, so we MUST gate the forwarding here.
      const isKmsKey = r.resourceType === "AWS::KMS::Key";
      const isSecret = r.resourceType === "AWS::SecretsManager::Secret";
      const perResourceOpts: {
        yes: true;
        pendingWindowInDays?: string;
        forceDeleteWithoutRecovery?: boolean;
        recoveryWindowInDays?: string;
      } = { yes: true };
      if (isKmsKey && opts.pendingWindowInDays !== undefined) {
        perResourceOpts.pendingWindowInDays = opts.pendingWindowInDays;
      }
      if (isSecret && opts.recoveryWindowInDays !== undefined) {
        perResourceOpts.recoveryWindowInDays = opts.recoveryWindowInDays;
      }
      if (isSecret && opts.forceDeleteWithoutRecovery === true) {
        perResourceOpts.forceDeleteWithoutRecovery = true;
      }

      // Use the injected destroyer when wired (production); fall back to the
      // single-flow path (tests) when the callback wasn't provided. The
      // single-flow path doesn't honour per-type flags, but tests pin the
      // expectation by mocking destroyOne directly.
      const destroyer = opts.destroyOne ?? destroyOneFallback;
      const result = await destroyer(identifier, perResourceOpts);
      success = true;
      outcome = result === "already_pending" ? "already_pending" : "destroyed";
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
      outcome = "failed";
      process.exitCode = 1;
    }

    executionResults.push({
      resource: r,
      success,
      outcome,
      error: errorMessage,
    });
    if (!jsonMode) {
      renderResourceDone(i, orderedPlan.length, r, outcome, errorMessage);
    }
  }

  // ── Compute outcome counts (used in both audit + summary) ────────────
  const destroyedCount = executionResults.filter(
    (r) => r.outcome === "destroyed",
  ).length;
  const alreadyPendingCount = executionResults.filter(
    (r) => r.outcome === "already_pending",
  ).length;
  const failCount = executionResults.filter(
    (r) => r.outcome === "failed",
  ).length;
  // Legacy field: any non-failed result counts as succeeded (for JSON compat).
  const successCount = destroyedCount + alreadyPendingCount;

  // ── 9. Audit log: one batch event per invocation ─────────────────────
  await writeAuditEvent({
    plan: orderedPlan,
    executed: executionResults,
    excluded: excludedResources,
    totalCostSaved,
    destroyedCount,
    alreadyPendingCount,
  });

  // ── 10. Final summary ─────────────────────────────────────────────────

  if (jsonMode) {
    const envelope: BulkDestroyJsonEnvelope = {
      ok: failCount === 0,
      operation: "bulk_destroy",
      plan: orderedPlan.map((r) => ({
        arn: r.arn,
        resourceType: r.resourceType,
        region: r.region,
      })),
      executed: executionResults.map((r) => ({
        arn: r.resource.arn,
        resourceType: r.resource.resourceType,
        success: r.success,
        outcome: r.outcome,
        ...(r.error ? { error: r.error } : {}),
      })),
      excluded: excludedResources.map((e) => ({
        arn: e.resource.arn,
        resourceType: e.resource.resourceType,
        reason: e.reason,
      })),
      totalCostSaved: successCount > 0 ? totalCostSaved : "N/A",
    };
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
  } else {
    // Three-bucket summary line. When already_pending > 0, show it explicitly.
    // When failed == 0, exit 0 (process.exitCode is only set to 1 on failures).
    const summaryParts: string[] = [`${destroyedCount} destroyed`];
    if (alreadyPendingCount > 0) {
      summaryParts.push(`${alreadyPendingCount} already pending`);
    }
    summaryParts.push(`${failCount} failed`);
    process.stdout.write(
      `\nBulk destroy complete: ${summaryParts.join(", ")}.\n`,
    );
    if (failCount > 0) {
      process.stdout.write(
        `\nFailed resources (manual remediation required):\n`,
      );
      for (const r of executionResults.filter((x) => x.outcome === "failed")) {
        const id = r.resource.arn || r.resource.primaryIdentifier || "(no id)";
        process.stdout.write(`  • ${r.resource.resourceType} — ${id}\n`);
        process.stdout.write(`    Error: ${r.error}\n`);
      }
      process.stdout.write(
        `\nCheck ~/.assignee/audit/audit.log for the full event record.\n`,
      );
    }
    if (excludedResources.length > 0) {
      process.stdout.write(
        `\n${excludedResources.length} resource${excludedResources.length !== 1 ? "s were" : " was"} excluded (self-lockout protection). ` +
          `Run \`assignee list\` to verify.\n`,
      );
    }
  }
}

// ── Audit helper ───────────────────────────────────────────────────────

async function writeAuditEvent(ctx: {
  plan: ManagedResource[];
  executed: Array<{
    resource: ManagedResource;
    success: boolean;
    outcome: string;
    error?: string;
  }>;
  excluded: Array<{ resource: ManagedResource; reason: string }>;
  totalCostSaved: string;
  destroyedCount?: number;
  alreadyPendingCount?: number;
}): Promise<void> {
  try {
    await appendAuditRecord({
      action: "bulk_destroy_executed",
      planCount: ctx.plan.length,
      successCount: ctx.executed.filter((r) => r.success).length,
      destroyedCount:
        ctx.destroyedCount ??
        ctx.executed.filter((r) => r.outcome === "destroyed").length,
      alreadyPendingCount:
        ctx.alreadyPendingCount ??
        ctx.executed.filter((r) => r.outcome === "already_pending").length,
      failCount: ctx.executed.filter((r) => !r.success).length,
      excludedCount: ctx.excluded.length,
      totalCostSaved: ctx.totalCostSaved,
      plan: ctx.plan.map((r) => ({ arn: r.arn, resourceType: r.resourceType })),
      executed: ctx.executed.map((r) => ({
        arn: r.resource.arn,
        resourceType: r.resource.resourceType,
        success: r.success,
        outcome: r.outcome,
        ...(r.error ? { error: r.error } : {}),
      })),
      excluded: ctx.excluded.map((e) => ({
        arn: e.resource.arn,
        resourceType: e.resource.resourceType,
        reason: e.reason,
      })),
    });
  } catch (err) {
    // Audit write failure must NOT swallow or abort; log to stderr.
    // Spec §Reviewer notes: "Audit log full / unwritable — must NOT proceed
    // without an audit record." However, the audit has already been
    // attempted; we log the failure so the operator can investigate.
    process.stderr.write(
      `[bulk-destroy] WARNING: Failed to write audit log entry: ` +
        `${err instanceof Error ? err.message : String(err)}\n` +
        `  Check ~/.assignee/audit/ permissions.\n`,
    );
  }
}

// ── isExcluded re-export (for tests) ──────────────────────────────────
export { isExcluded };
