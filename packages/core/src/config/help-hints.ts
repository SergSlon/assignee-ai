/**
 * Help-hints single source of truth (Story 54-it1-04).
 *
 * Exposes registry-derived renderers for the two hint blocks that used
 * to live as hardcoded string literals in three different call sites
 * (CLI `config/constants/help.ts`, core `graph/nodes/intent-parser.ts`,
 * MCP `apps/mcp-server/src/tools/plan-resource.ts`). Count drift
 * between the registry and the hint strings (Epic 54 iteration 1
 * findings L3-H1 / L3-H2 / L3-H3) is prevented by computing every
 * count from `SUPPORTED_TYPES_ARRAY.length` and
 * `defaultPatternRegistry.size()` at render time.
 *
 * Pure module — no SDK, filesystem, or runtime dependencies. Safe to
 * import from any layer (node, CLI, MCP tool handler).
 *
 * Rendering widths are capped at ≤ 100 columns (narrower than the 114
 * column wrap seen in the original PATTERNS_HINT) so the hint still
 * reads cleanly on a standard 100-column terminal. This closes MED
 * finding L2-001.
 *
 * Three render styles are supported for each hint:
 *   - `cli`:  rich grouped/tabular layout for `assignee --help`
 *             output (the long-form block historically in help.ts).
 *   - `mcp`:  compact single-line summary for structured MCP error
 *             responses (the `hint:` field in plan-resource.ts).
 *   - `short`: multi-line but concise variant for intent-parser
 *              errorMessage — embedded in the graph-state error.
 */

import { SUPPORTED_TYPES_ARRAY } from "./resource-types/supported.js";
import { defaultPatternRegistry } from "../pattern-templates/index.js";
import {
  HINT_MAX_COLUMNS as BLOCK_HINT_MAX_COLUMNS,
  buildSupportedTypesBlock,
  getTypeHint,
} from "./supported-types-block.js";

/** Available render styles for hint output. */
export type HintStyle = "cli" | "mcp" | "short";

/**
 * Max columns permitted in any rendered hint line (L2-001 closure).
 * Re-exported from `supported-types-block.ts` which owns the grouped
 * rendering; kept as a first-class export on this module so existing
 * consumers continue to import `{ HINT_MAX_COLUMNS }` from
 * `@assignee/core` without a path change.
 */
export const HINT_MAX_COLUMNS = BLOCK_HINT_MAX_COLUMNS;

/**
 * Re-export the supported-types-block public API so consumers that
 * import from `@assignee/core` (via the help-hints sub-barrel) get a
 * stable named accessor. Epic 92 wave 3.a (story e92-3a) moved the
 * block body to a dedicated module but preserved every existing
 * import-site by re-exporting here.
 *
 * - `buildSupportedTypesBlock()` — full CLI grouped grid. Only emit on
 *   `--help` output; never on error-path [FIX] text (see D-33).
 * - `getTypeHint()` — short single-line breadcrumb for error-path
 *   surfaces. Points users at `assignee plan --help`.
 */
export { buildSupportedTypesBlock, getTypeHint };

/** Registry-derived number of supported resource types (curated CFN list). */
export function getSupportedTypeCount(): number {
  return SUPPORTED_TYPES_ARRAY.length;
}

/** Registry-derived number of compound architecture patterns. */
export function getPatternCount(): number {
  return defaultPatternRegistry.size();
}

/** Return the authoritative list of supported resource types (as CFN strings). */
export function getSupportedResourceTypes(): readonly string[] {
  return SUPPORTED_TYPES_ARRAY;
}

/**
 * Return the authoritative list of compound patterns in registration
 * (= precedence) order. Exposed as plain objects so callers don't need
 * to import the ArchitecturePattern type.
 */
export function getCompoundPatterns(): ReadonlyArray<{
  patternId: string;
  displayName: string;
  resourceCount: number;
}> {
  return defaultPatternRegistry.list().map((p) => ({
    patternId: p.patternId,
    displayName: p.displayName,
    resourceCount: p.resourceList.length,
  }));
}

/**
 * CLI-style supported-types hint, grouped by user-facing domain rather
 * than raw CFN namespace. Every entry in SUPPORTED_TYPES_ARRAY is
 * represented. The grouping is maintained by hand because the
 * user-facing categorisation (Compute / Networking / …) is not
 * derivable from the `AWS::Service::Type` string.
 *
 * A drift-guard test asserts that every entry in SUPPORTED_TYPES_ARRAY
 * is mentioned somewhere in the rendered string so the grouping can't
 * silently fall behind the registry.
 */
function renderSupportedTypesHintCli(): string {
  return buildSupportedTypesBlock();
}

/**
 * Shorter supported-types hint used inside intent-parser's
 * errorMessage. Epic 96 Wave 2 R3 (D-03): the "short" variant used to
 * hand-maintain its own grouped grid — a subset of the CLI block with
 * families silently trimmed. That duplication meant every new supported
 * type had to be added to TWO strings by hand, and Epic 92/94 added
 * types without touching the short body → the error-path hint silently
 * fell behind the `--help` block (Epic 95 D-03 finding). The short
 * variant now delegates to `buildSupportedTypesBlock()` (the canonical
 * CLI grid) so the registry is the single source of truth and the
 * drift-guard test in help-hints.test.ts covers both surfaces.
 *
 * Sizing: `buildSupportedTypesBlock()` is ≤ HINT_MAX_COLUMNS (100) per
 * line and enumerates all 10 user-facing domain groups with the full
 * type list. Embedding it in an intent-parser errorMessage adds ~20
 * short lines to stderr — acceptable for the one-shot "we couldn't
 * parse your intent" message, and strictly better than the old
 * hand-curated subset which could miss the type the user wanted.
 */
function renderSupportedTypesHintShort(): string {
  return buildSupportedTypesBlock();
}

/**
 * Compact one-line hint for structured MCP error responses. Lists a
 * representative set of family names so operators using MCP clients
 * (where newlines render poorly) still get a meaningful breadcrumb.
 * The count is registry-derived to prevent drift.
 */
function renderSupportedTypesHintMcp(): string {
  const count = getSupportedTypeCount();
  return `Supported types (${count}): S3, Lambda, DynamoDB, SQS, SNS, EC2, RDS, IAM Role, SSM Parameter, CloudWatch Logs, EventBridge Rule, and more. Run \`assignee infra plan --help\` for the full grouped list.`;
}

/**
 * Render a supported-types hint for the requested consumer style.
 *
 * Usage:
 *   - CLI `--help` / `plan --help` output  → style "cli"
 *   - Graph-state errorMessage from intent-parser → style "short"
 *   - MCP plan-resource tool JSON error hint → style "mcp"
 */
export function renderSupportedTypesHint(style: HintStyle): string {
  switch (style) {
    case "cli":
      return renderSupportedTypesHintCli();
    case "short":
      return renderSupportedTypesHintShort();
    case "mcp":
      return renderSupportedTypesHintMcp();
  }
}

/**
 * CLI-style compound patterns hint. Listed in registration
 * (= first-keyword-match precedence) order to mirror the runtime
 * registry. Count is registry-derived so adding/removing a pattern in
 * core automatically updates the hint. Fits within 100 columns.
 *
 * Pattern descriptions are a short resource summary; the fuller
 * resource list is rendered by `renderCompoundPatternsBlock` in the
 * CLI's `plan/discovery.ts` (discovery view). See L2-002 for the
 * explicit label split between this "curated" view and the discovery
 * view's CFN-namespace view.
 */
function renderPatternsHintCli(): string {
  const count = getPatternCount();
  // Handwritten descriptions are keyed by patternId so additions to
  // the registry that forget to add a description here are caught by
  // the drift-guard test.
  const descriptions: Record<string, string> = {
    "serverless-api":
      "Lambda + API Gateway v2 + IAM Role + LogGroup (8 resources)",
    "three-tier-web":
      "VPC + public/private subnets + ALB + EC2 + RDS + SecurityGroups",
    "container-service":
      "VPC + ALB + ECS Cluster + ECR + IAM Role (15 resources)",
    "message-processing": "SQS main + DLQ + Lambda + IAM Role + DynamoDB",
    "static-website": "S3 Bucket + CloudFront + OAC + Bucket Policy",
    "efs-with-vpc": "Private VPC + NFS SG + EFS + Mount Targets (9 resources)",
    "vpc-networking": "VPC + Subnets + IGW + NAT + Routes (17 resources)",
    "vpc-public-only": "VPC + public Subnets + IGW + Routes (free-tier)",
    "scheduled-lambda":
      "IAM Role + Lambda + EventBridge Rule + Permission (4 resources)",
    "lambda-with-exec-role":
      "IAM Role + Lambda (2 resources, auto-created exec role)",
    "websocket-api":
      "IAM + Lambda + Logs + API Gateway v2 WebSocket + 3 Routes (12 resources)",
    "sqs-with-dlq":
      "Primary SQS Queue + Dead-Letter Queue (RedrivePolicy wired, 2 resources)",
    "sns-with-email-subscription":
      "SNS Topic + Email Subscription (Protocol=email, 2 resources)",
  };

  const lines: string[] = [];
  lines.push(
    `Architecture patterns (${count} compound, first keyword match wins):`,
  );
  // Two-line layout per pattern: the "Create a X" framing on line 1,
  // the resource-composition description indented on line 2. Keeps
  // every line ≤ HINT_MAX_COLUMNS (100) even when descriptions grow.
  for (const p of defaultPatternRegistry.list()) {
    const desc = descriptions[p.patternId] ?? p.displayName;
    const framing = `  "Create a ${p.displayName.toLowerCase()}"`;
    lines.push(framing);
    lines.push(`      -> ${desc}`);
  }
  return lines.join("\n");
}

/** Short single-line patterns hint — used in compact surfaces. */
function renderPatternsHintShort(): string {
  const count = getPatternCount();
  const names = defaultPatternRegistry
    .list()
    .map((p) => p.patternId)
    .join(", ");
  return `Compound patterns (${count}): ${names}.`;
}

/**
 * Render a compound-patterns hint for the requested style.
 *
 * The `mcp` style is currently identical to `short` — MCP clients
 * only need the one-line summary.
 */
export function renderPatternsHint(style: HintStyle): string {
  switch (style) {
    case "cli":
      return renderPatternsHintCli();
    case "short":
    case "mcp":
      return renderPatternsHintShort();
  }
}

/**
 * Beginner-friendly example resource types used by the NL-intent
 * clarifier when nudging a user to rephrase an ambiguous intent.
 *
 * Curated — NOT auto-derived from SUPPORTED_TYPES_ARRAY — because the
 * set of example types shown to a confused user is a UX decision
 * (friendly names, beginner-recognisable services) rather than a full
 * enumeration. Still lives in the help-hints SSO module so the curated
 * list is maintained alongside the authoritative registry rather than
 * duplicated as string literals across CLI surfaces (Story 56-it2-04
 * L3-L3). Each entry MUST correspond to a supported CFN type — a
 * drift-guard test in help-hints.test.ts enforces this.
 */
export const BEGINNER_EXAMPLE_TYPES: readonly string[] = Object.freeze([
  "S3 bucket",
  "Lambda function",
  "DynamoDB table",
]);

/**
 * Render a comma-separated, `etc.`-suffixed list of beginner example
 * resource types for the clarifier prompt. Produces e.g.
 * "S3 bucket, Lambda function, DynamoDB table, etc." — a single source
 * of truth so the clarifier, docs and any future UX surfaces share the
 * same curated list (Story 56-it2-04 L3-L3).
 *
 * @see {@link BEGINNER_EXAMPLE_TYPES} — the curated list rendered here.
 * @see apps/cli/src/services/clarifier.ts `buildClarifyingQuestion` /
 *      `askClarifyingQuestion` — the consumer that embeds this string
 *      in the user-facing rephrase prompt. Story 62-it1-02 L3-L1 added
 *      this cross-ref so renames on either side stay discoverable.
 */
export function renderClarifierExampleList(
  // Epic 65-it1-01 (L3-L1 LOW): the list parameter is injectable so the
  // defensive empty-array guard below is directly testable. Default is the
  // frozen curated list, so every existing caller is unchanged.
  examples: readonly string[] = BEGINNER_EXAMPLE_TYPES,
): string {
  // Epic 65-it1-01 (L3-L1 LOW): defensive empty-array guard. If a future
  // curation leaves the example list empty (e.g. a rename migration
  // temporarily wipes the list) the naive join-and-suffix would emit
  // ", etc." — a visually broken fragment in the clarifier prompt. Return
  // an empty string instead so the consumer sees nothing rather than a
  // malformed list.
  if (examples.length === 0) return "";
  return `${examples.join(", ")}, etc.`;
}
