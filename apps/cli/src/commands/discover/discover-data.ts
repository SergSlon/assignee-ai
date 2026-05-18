/**
 * Shared data layer for `assignee dev discover`.
 *
 * Provides registry-derived catalogue items across three categories:
 *   - resource-types  : all entries from SUPPORTED_TYPES_ARRAY
 *   - patterns        : all compound patterns from defaultPatternRegistry
 *   - commands        : CLI commands (sourced from CLI_COMMANDS in variant-matrix)
 *
 * This module is deliberately presentation-free — it returns plain
 * objects only, no ANSI codes. The `discover.ts` command file applies
 * formatting for each output mode (interactive / plain / JSON).
 *
 * Story 108-A-03.
 *
 * ## Deliberate divergence from `plan/discovery.ts`
 *
 * `renderDiscoveryBlock()` in `plan/discovery.ts` is a presentation-
 * only function that emits a formatted string for `plan --help`. It has
 * no extractable data-layer contract — its output is concatenated text
 * for Commander's `addHelpText()`. Extracting a shared helper would
 * create coupling between two unrelated output surfaces (help text vs
 * interactive picker). The two callers therefore diverge deliberately:
 *
 *   - `plan/discovery.ts`  — renders a fixed-width text block for --help.
 *   - `discover-data.ts`   — returns plain objects for the pick/json/text
 *                            output modes of `assignee dev discover`.
 *
 * This decision is documented per Story 108-A-03 AC#5.
 */

import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";

/**
 * Typed tuple of CLI command names registered in `apps/cli/src/index.ts`.
 *
 * Mirrors `CLI_COMMANDS` in `packages/core/src/__tests__/variant-matrix/index.ts`.
 * Keep in sync manually: adding a new command here requires also updating the
 * variant-matrix CLI_COMMANDS tuple (drift-guard CI enforces this for test
 * coverage). Both tuples currently hold 18 entries (as of Story 108-A-03,
 * which added "discover" as entry 18).
 */
// Exported for drift-guard regression test (Option B): a unit test in
// discover.test.ts asserts that this tuple is structurally equal to
// CLI_COMMANDS in packages/core/src/__tests__/variant-matrix/index.ts.
export const DISCOVER_COMMAND_LIST = [
  "plan",
  "apply",
  "completions",
  "init",
  "describe",
  "destroy",
  "drift",
  "optimize",
  "list",
  "setup",
  "status",
  "reconcile",
  "doctor",
  "restore-provisions",
  "audit-verify",
  "update",
  "version",
  "discover",
] as const;

type DiscoverCommandName = (typeof DISCOVER_COMMAND_LIST)[number];

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Valid category strings for the `--category` filter flag. */
export type DiscoverCategory = "resource-types" | "patterns" | "commands";

/** A single catalogue entry returned by `buildCatalogue()`. */
export interface CatalogueItem {
  /** Stable machine-readable identifier. */
  id: string;
  /** The category this item belongs to. */
  category: DiscoverCategory;
  /** Human-readable description of the item. */
  description: string;
  /**
   * Sample `assignee infra plan` (or other command) invocation for this item.
   * Non-null for types and patterns; for CLI commands it shows --help.
   */
  exampleIntent: string;
}

// ---------------------------------------------------------------------------
// Category-specific builders
// ---------------------------------------------------------------------------

/** Minimal description map for resource types (CFN → friendly label). */
const TYPE_LABELS: Readonly<Record<string, string>> = {
  "AWS::S3::Bucket": "S3 object-storage bucket",
  "AWS::SSM::Parameter": "SSM Parameter Store parameter",
  "AWS::IAM::Role": "IAM execution role",
  "AWS::EC2::Instance": "EC2 virtual machine instance",
  "AWS::RDS::DBInstance": "RDS relational database instance",
  "AWS::Lambda::Function": "Lambda serverless function",
  "AWS::EC2::VPC": "EC2 Virtual Private Cloud",
  "AWS::EC2::Subnet": "EC2 VPC subnet",
  "AWS::EC2::SecurityGroup": "EC2 security group (firewall rules)",
  "AWS::DynamoDB::Table": "DynamoDB NoSQL table",
  "AWS::SQS::Queue": "SQS message queue",
  "AWS::SNS::Topic": "SNS pub/sub notification topic",
  "AWS::ElasticLoadBalancingV2::LoadBalancer":
    "Application/Network Load Balancer",
  "AWS::ECS::Cluster": "ECS container cluster",
  "AWS::ECR::Repository": "ECR container image repository",
  "AWS::Logs::LogGroup": "CloudWatch Logs log group",
  "AWS::EC2::InternetGateway": "EC2 Internet Gateway",
  "AWS::EC2::RouteTable": "EC2 route table",
  "AWS::EC2::Route": "EC2 routing rule",
  "AWS::EC2::NatGateway":
    "EC2 NAT Gateway (outbound internet for private subnets)",
  "AWS::ApiGatewayV2::Api": "API Gateway v2 HTTP/WebSocket API",
  "AWS::CloudWatch::Alarm": "CloudWatch metric alarm",
  "AWS::SecretsManager::Secret": "Secrets Manager secret",
  "AWS::EC2::VPCGatewayAttachment": "EC2 VPC-to-Internet-Gateway attachment",
  "AWS::EC2::SubnetRouteTableAssociation":
    "EC2 subnet-to-route-table association",
  "AWS::EFS::FileSystem": "EFS elastic file system",
  "AWS::EFS::MountTarget": "EFS mount target (subnet attachment)",
  "AWS::Events::Rule": "EventBridge scheduled/event rule",
  "AWS::Events::EventBus": "EventBridge custom event bus",
  "AWS::SNS::Subscription": "SNS topic subscription",
  "AWS::KMS::Key": "KMS encryption key",
  "AWS::Events::Connection": "EventBridge connection (OAuth/API key)",
  "AWS::Events::ApiDestination": "EventBridge API destination (HTTP target)",
  "AWS::CloudFront::Distribution": "CloudFront CDN distribution",
  "AWS::CloudFront::OriginAccessControl": "CloudFront origin access control",
  "AWS::S3::BucketPolicy": "S3 bucket policy (access control document)",
  "AWS::RDS::DBSubnetGroup": "RDS subnet group (multi-AZ placement)",
  "AWS::EC2::EIP": "EC2 Elastic IP address",
};

/** Human-readable name fragments for CLI commands (name → description). */
const COMMAND_DESCRIPTIONS: Readonly<Record<DiscoverCommandName, string>> = {
  plan: "Generate an infrastructure plan from a natural-language intent",
  apply: "Plan and immediately provision resources (plan + apply in one step)",
  completions: "Install or print shell tab-completion scripts (zsh/bash/fish)",
  init: "Create a project-level or global Assignee configuration file",
  describe: "Show details about a managed resource",
  destroy: "Destroy one or more managed resources",
  drift: "Detect and optionally reconcile configuration drift",
  optimize: "Scan managed resources for cost-rightsizing recommendations",
  list: "List all managed resources with their current status",
  setup: "Create least-privilege IAM users and store credentials",
  status: "Show the current status and best-practice score for resources",
  reconcile: "Reconcile drift by re-applying the provisioned state",
  doctor: "Check environment health (credentials, region, MCP servers)",
  "restore-provisions": "Restore resource provisions from an audit log",
  "audit-verify": "Verify audit log integrity and completeness",
  update: "Update a managed resource by applying property changes",
  version: "Show CLI version, Node version, and pinned MCP server versions",
  discover:
    "Interactively browse and search all supported resource types, patterns, and commands",
};

function buildTypeItems(): CatalogueItem[] {
  return SUPPORTED_TYPES_ARRAY.map((type) => {
    const label = TYPE_LABELS[type] ?? type;
    // Derive a friendly short name from the CFN type (e.g. "S3 bucket")
    const parts = type.split("::");
    const shortName = parts[2] ?? parts[1] ?? type;
    return {
      id: type,
      category: "resource-types" as const,
      description: label,
      exampleIntent: `assignee infra plan "Create a ${shortName}"`,
    };
  });
}

function buildPatternItems(): CatalogueItem[] {
  return defaultPatternRegistry.list().map((p) => ({
    id: p.patternId,
    category: "patterns" as const,
    description: `${p.displayName} (${p.resourceList.length} resources)`,
    exampleIntent: `assignee infra plan "Create a ${p.displayName.toLowerCase()}"`,
  }));
}

/**
 * Maps each leaf command name to its noun-group parent.
 * Must stay in sync with `CommandGroup` / `CommandPath` in
 * `packages/core/src/constants/commands.ts`.
 */
const LEAF_TO_GROUP: Readonly<Record<DiscoverCommandName, string>> = {
  // infra group
  plan: "infra",
  apply: "infra",
  destroy: "infra",
  drift: "infra",
  reconcile: "infra",
  optimize: "infra",
  "restore-provisions": "infra",
  // admin group
  "audit-verify": "admin",
  describe: "admin",
  doctor: "admin",
  list: "admin",
  status: "admin",
  // dev group
  completions: "dev",
  discover: "dev",
  init: "dev",
  setup: "dev",
  update: "dev",
  version: "dev",
};

function buildCommandItems(): CatalogueItem[] {
  return DISCOVER_COMMAND_LIST.map((cmd) => {
    const group = LEAF_TO_GROUP[cmd];
    return {
      id: cmd,
      category: "commands" as const,
      description:
        COMMAND_DESCRIPTIONS[cmd] ?? `assignee ${group} ${cmd} command`,
      exampleIntent: `assignee ${group} ${cmd} --help`,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build the full catalogue of discoverable items.
 *
 * @param categoryFilter - optional category to restrict the output.
 *   When undefined, all three categories are returned in order:
 *   resource-types → patterns → commands.
 *
 * Registry-derived: the count of items changes automatically when
 * new types, patterns, or commands are added to their registries.
 */
export function buildCatalogue(
  categoryFilter?: DiscoverCategory,
): CatalogueItem[] {
  const all: CatalogueItem[] = [
    ...buildTypeItems(),
    ...buildPatternItems(),
    ...buildCommandItems(),
  ];
  if (categoryFilter === undefined) return all;
  return all.filter((item) => item.category === categoryFilter);
}

/**
 * Apply a fuzzy (substring) filter over a catalogue list.
 *
 * The filter is case-insensitive and matches against `id`,
 * `description`, and `category`. Returns the original list when
 * `query` is empty or whitespace-only.
 *
 * @param items  - the catalogue items to search.
 * @param query  - the search string entered by the user.
 * @returns filtered subset (empty array when nothing matches).
 */
export function fuzzyFilter(
  items: CatalogueItem[],
  query: string,
): CatalogueItem[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter(
    (item) =>
      item.id.toLowerCase().includes(normalized) ||
      item.description.toLowerCase().includes(normalized) ||
      item.category.toLowerCase().includes(normalized),
  );
}
