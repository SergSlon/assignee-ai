/**
 * Long-form help text blocks shown in `assignee --help` and error
 * messages. Domain sub-module of the former `config/constants.ts`
 * coupling hub (Story 49.5).
 *
 * **Source of truth.** Both the resource-type hint and the compound-
 * pattern hint are rendered by `@assignee/core`'s `help-hints`
 * module so the CLI, MCP plan-resource tool, and core intent-parser
 * graph node all pull from the same registry-derived string. Do NOT
 * hardcode type/pattern lists in this file — add them to the core
 * registry and they'll flow into every consumer automatically
 * (Story 54-it1-04).
 *
 * Widths in the underlying renderer are capped at 100 columns so
 * `assignee plan --help` reads cleanly on a standard 100-col terminal.
 */

import { renderPatternsHint, renderSupportedTypesHint } from "@assignee/core";

/**
 * Human-readable hint shown when an unsupported resource type is
 * requested. Groups types by domain for scannability instead of
 * dumping CFN type names. The count and grouping are derived from
 * `SUPPORTED_TYPES_ARRAY` at render time — see
 * `@assignee/core/config/help-hints.ts`.
 */
export const SUPPORTED_TYPES_HINT = renderSupportedTypesHint("cli");

/**
 * Architecture patterns hint shown in help text. Listed in registration
 * (= keyword-match precedence) order to mirror the runtime registry.
 * Count is registry-derived; see `@assignee/core/config/help-hints.ts`.
 */
export const PATTERNS_HINT = renderPatternsHint("cli");

/** Examples hint shown in help text. */
export const EXAMPLES_HINT = `Examples:
  assignee plan "Create an S3 bucket"             Plan a single resource
  assignee plan "Create a serverless API"          Plan a multi-resource architecture
  assignee apply "Create a Lambda function"        Plan and deploy in one step
  assignee drift                                   Check all resources for drift`;
