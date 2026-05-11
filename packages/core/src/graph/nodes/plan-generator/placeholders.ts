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
 *      docs account-id ARNs AND template-token ARNs (e.g.
 *      `arn:aws:sqs:REGION:ACCOUNT_ID:DLQ_NAME`) from nested desiredState.
 */
import { defaultPluginRegistry } from "@/index.js";
import {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "@/constants/placeholder-accounts.js";
import { findTemplateTokenInArn } from "@/graph/nodes/preflight-guard/guards/placeholder-arn.js";

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
 * Strips placeholder ARNs from arbitrary nested shapes in desiredState.
 *
 * The LLM frequently hallucinates ARNs with canonical AWS docs account IDs
 * (e.g., 123456789012, 111122223333) in a variety of shapes:
 *   - Top-level arrays (`AlarmActions`, `OKActions`, `NotificationARNs`)
 *   - Scalar string fields (`PerformanceInsightsKMSKeyId`, `DomainAuthSecretArn`,
 *     `KmsKeyId`) — see Epic 92 findings C-01 / C-02 where LLM-emitted RDS
 *     Postgres scalar KMS ARNs slipped past the pre-Epic-92 top-level-only
 *     walker and hard-failed preflight on the first natural intent.
 *   - Nested objects / mixed arrays (future-proofing: e.g. `OriginConfig.CertificateArn`).
 *
 * Behaviour:
 *   - Scalar string placeholder → delete the key.
 *   - Array element placeholder → filter element out.
 *   - Array emptied by filtering → delete the key.
 *   - Nested object placeholder values → delete the nested key; if the
 *     nested object empties, delete the parent key as well.
 *
 * The walker is depth-capped (32) to defend against cycles / hostile
 * deeply-nested JSON, matching `detectPlaceholderArn` in the preflight
 * guard (Epic 92 wave-1: the stripper silently drops LLM emissions
 * FIRST, the guard catches user-supplied placeholders that survive).
 *
 * Partition-aware: delegates to `ARN_ACCOUNT_REGEX` (`^arn:aws[\\w-]*:`)
 * so GovCloud + China + ISO partitions are covered. Never use the
 * literal `arn:aws:` prefix (per `feedback_partition_aware_arn_matching`).
 */
export const PLACEHOLDER_STRIP_MAX_DEPTH = 32;

/**
 * True iff the string is an ARN whose account-ID segment matches a
 * canonical AWS docs example OR contains a template-token placeholder
 * (e.g. `arn:aws:sqs:REGION:ACCOUNT_ID:DLQ_NAME`). Shared between the
 * stripper below and the preflight guard's detector so both agree on
 * what "placeholder" means.
 */
export function isPlaceholderArn(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const match = ARN_ACCOUNT_REGEX.exec(value);
  if (match && PLACEHOLDER_AWS_ACCOUNT_IDS.has(match[1]!)) return true;
  // Also treat template-token ARNs (REGION, ACCOUNT_ID, DLQ_NAME, etc.)
  // as placeholder ARNs so the stripper removes them before preflight.
  return findTemplateTokenInArn(value) !== undefined;
}

export function stripPlaceholderArns(
  desiredState: Record<string, unknown>,
): Record<string, unknown> {
  walkAndStrip(desiredState, 0);
  return desiredState;
}

/**
 * Recursively scrubs placeholder ARNs out of the target in place.
 * Returns `true` when the target became empty (caller may want to
 * delete the parent key).
 */
function walkAndStrip(target: unknown, depth: number): boolean {
  if (depth > PLACEHOLDER_STRIP_MAX_DEPTH) return false;
  if (Array.isArray(target)) {
    // Walk each element; collect survivors. For nested containers we
    // recurse first, then drop the element if it emptied to nothing.
    const survivors: unknown[] = [];
    for (const item of target) {
      if (typeof item === "string") {
        if (isPlaceholderArn(item)) continue;
        survivors.push(item);
        continue;
      }
      if (item && typeof item === "object") {
        const emptied = walkAndStrip(item, depth + 1);
        if (emptied) continue;
        survivors.push(item);
        continue;
      }
      survivors.push(item);
    }
    if (survivors.length !== target.length) {
      target.length = 0;
      target.push(...survivors);
    }
    return target.length === 0;
  }
  if (target && typeof target === "object") {
    const record = target as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      if (typeof value === "string") {
        if (isPlaceholderArn(value)) delete record[key];
        continue;
      }
      if (value && typeof value === "object") {
        const emptied = walkAndStrip(value, depth + 1);
        if (emptied) delete record[key];
      }
    }
    return Object.keys(record).length === 0;
  }
  return false;
}
