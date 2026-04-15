/**
 * Keyword-based resource-type classifier for the estimate_cost tool.
 *
 * Zero-cost (<1ms), no I/O, no LLM calls. Evaluates the three keyword
 * tables in priority order; returns on the first match.
 *
 * @see Story 20.4
 */

import {
  COMPOUND_CROSS_REF_KEYWORDS,
  KEYWORD_TO_RESOURCE_TYPE,
  TASK_4B_PRIORITY_KEYWORDS,
} from "./keyword-tables.js";
import type { KeywordEntry } from "./types.js";

/**
 * Order of tables evaluated by classifyResourceType. Declared here so
 * the precedence is explicit in one place and OCP-friendly (adding a
 * new priority block = push one more table to the array).
 */
const PRIORITY_TABLES: ReadonlyArray<ReadonlyArray<KeywordEntry>> = [
  // Most specific first — OAC + BucketPolicy must beat the bare
  // "cloudfront" / "bucket" substrings downstream.
  TASK_4B_PRIORITY_KEYWORDS,
  // Compound cross-ref multi-word phrases (vpc gateway attachment,
  // sns subscription, kms key, …) must beat shorter substrings.
  COMPOUND_CROSS_REF_KEYWORDS,
  // General catalogue — broad single-word keywords live here.
  KEYWORD_TO_RESOURCE_TYPE,
];

/**
 * Classifies a natural language description into a CloudFormation
 * resource type. Case-insensitive substring match; returns null if no
 * keyword in any table matches.
 *
 * Defensive: upstream callers may pass undefined (empty MCP request
 * body, missing TYPE_TO_KEYWORD entry, etc.). Returning null lets
 * cross-system consistency tests surface missing-keyword gaps as
 * clean failures rather than TypeErrors.
 */
export function classifyResourceType(
  description: string | undefined | null,
): string | null {
  if (typeof description !== "string" || description.length === 0) {
    return null;
  }
  const normalized = description.toLowerCase();
  for (const table of PRIORITY_TABLES) {
    for (const entry of table) {
      if (entry.keywords.some((kw) => normalized.includes(kw))) {
        return entry.resourceType;
      }
    }
  }
  return null;
}
