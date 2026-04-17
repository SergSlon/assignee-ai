/**
 * Placeholder-handling utilities for plan-generator.
 *
 * Three responsibilities (all SRP-aligned around "remove junk values the
 * LLM or plugin templates would otherwise leave in desiredState"):
 *   1. `isTemplatePlaceholder` / `collectPluginPlaceholders` —
 *      identify plugin field placeholders that are obvious template
 *      examples (e.g. "my-bucket") rather than valid real values.
 *   2. `stripEmpty` — recursively delete empty strings / null / empty
 *      arrays and exact plugin-placeholder string matches.
 *   3. `stripPlaceholderArns` — remove LLM-hallucinated canonical AWS
 *      docs account-id ARNs from top-level array fields.
 */
import { defaultPluginRegistry } from "@assignee/core";
import {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "../../../constants/placeholder-accounts.js";

/**
 * Heuristic markers that identify a plugin placeholder as an OBVIOUSLY
 * template / example value rather than a valid AWS resource value.
 *
 * Wave 15 background: the original `collectPluginPlaceholders` returned
 * EVERY placeholder regardless of shape, and `stripEmpty` then dropped
 * any LLM-supplied value that exactly matched. This silently broke the
 * Subnet plan path because the Subnet plugin's CidrBlock placeholder is
 * `"10.0.1.0/24"` — a perfectly VALID CIDR that a user could legitimately
 * specify as their actual subnet. The LLM mock used the same value, the
 * stripEmpty match fired, and CidrBlock was dropped from the final plan.
 *
 * The VPC test passed only by accident: VPC's CidrBlock has both a
 * placeholder AND an initialValue of `"10.0.0.0/16"`, so the elicitor
 * re-injected the value AFTER stripEmpty stripped it. Brittle.
 *
 * The right answer: only treat placeholders as strip-worthy when their
 * shape clearly says "this is a template, not a real value". Template
 * markers (case-insensitive substring match):
 *   - `my-` / `your-`     — pronoun-leaning examples like `my-bucket`
 *   - `...`                — explicit ellipsis like `arn:aws:kms:...`
 *   - `example`            — explicit example markers
 *   - `12345`              — AWS docs account placeholders
 *   - `0abc` / `0123`      — example resource ID hex stubs
 *   - `(leave blank`       — parenthetical instruction in clack labels
 *   - `(auto-generated`    — same family
 *   - `KEY1=` / `key1=`    — generic env-var template markers
 *   - `Brief description`  — generic text-area placeholder
 *
 * Real-shaped values like `"10.0.1.0/24"`, `"30"`, `"365"`, or
 * `"index.handler"` do NOT contain any of these markers and are
 * therefore NEVER stripped. The placeholder still appears in the
 * wizard prompt — it's only excluded from the strip set.
 */
export const TEMPLATE_PLACEHOLDER_MARKERS: readonly string[] = [
  "my-",
  "your-",
  "...",
  "example",
  "12345",
  "0abc",
  "0123",
  "(leave blank",
  "(auto-generated",
  "KEY1=",
  "key1=",
  "Brief description",
];

/**
 * Returns true when a plugin placeholder string looks like an obviously
 * template / example value (e.g. `"my-bucket"`, `"arn:aws:iam::1234..."`,
 * `"Brief description..."`). False for valid-shaped values like
 * `"10.0.1.0/24"` or `"index.handler"`. Used by collectPluginPlaceholders
 * to gate which placeholders feed into stripEmpty's strip set.
 */
export function isTemplatePlaceholder(placeholder: string): boolean {
  const lower = placeholder.toLowerCase();
  return TEMPLATE_PLACEHOLDER_MARKERS.some((marker) =>
    lower.includes(marker.toLowerCase()),
  );
}

/**
 * Collects placeholder strings from plugin field definitions for a
 * resource type that look like obvious templates. Only TEMPLATE
 * placeholders (matching `isTemplatePlaceholder`) are returned — valid-
 * shaped placeholders like `"10.0.1.0/24"` are excluded so users whose
 * legitimate values happen to match an example don't get silently
 * dropped by stripEmpty.
 */
export function collectPluginPlaceholders(resourceType: string): Set<string> {
  const placeholders = new Set<string>();
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) return placeholders;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const field of allFields) {
    if (field.question.placeholder) {
      const ph = field.question.placeholder;
      if (isTemplatePlaceholder(ph)) {
        placeholders.add(ph);
        // Also extract the prefix before any parenthetical suffix so
        // partial matches like "my-bucket" (from "my-bucket (leave
        // blank...)") are caught by stripEmpty. The prefix inherits
        // the template-or-not classification from the parent string;
        // we already know the parent IS a template (we're inside the
        // isTemplatePlaceholder branch), so the prefix is too.
        const prefixMatch = ph.match(/^(.+?)\s+\(/);
        if (prefixMatch) {
          placeholders.add(prefixMatch[1]!.trim());
        }
      }
    }
  }
  return placeholders;
}

/** Recursively removes empty-placeholder values the LLM may insert despite prompt rules. */
export function stripEmpty(
  obj: Record<string, unknown>,
  placeholders?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    // Strip values that exactly match a plugin placeholder string
    if (typeof v === "string" && placeholders && placeholders.has(v)) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>, placeholders);
      if (Object.keys(nested).length === 0) continue;
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Strips placeholder ARNs from array fields in desiredState.
 * The LLM frequently hallucinates ARNs with canonical AWS docs account IDs
 * (e.g., 123456789012) in array fields like AlarmActions, OKActions, etc.
 * Removes placeholder elements; deletes the field if the array becomes empty.
 *
 * Operates on ALL top-level array fields containing strings — generic enough
 * to catch any ARN-bearing array, not just CloudWatch Alarm fields.
 */
export function stripPlaceholderArns(
  desiredState: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(desiredState)) {
    if (!Array.isArray(value)) continue;
    // Only process arrays that contain at least one string element
    if (!value.some((item) => typeof item === "string")) continue;

    const cleaned = value.filter((item) => {
      if (typeof item !== "string") return true;
      const match = ARN_ACCOUNT_REGEX.exec(item);
      if (!match) return true; // not an ARN — keep
      return !PLACEHOLDER_AWS_ACCOUNT_IDS.has(match[1]!);
    });

    if (cleaned.length === 0) {
      delete desiredState[key];
    } else if (cleaned.length < value.length) {
      desiredState[key] = cleaned;
    }
  }
  return desiredState;
}
