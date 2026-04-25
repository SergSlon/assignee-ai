/**
 * W3-02 (Epic 100 Round 5) — RBAC policy schema.
 *
 * Defines the Zod schema for a single RBAC policy document.  The schema
 * deliberately keeps the surface minimal for the scaffold wave; field-level
 * enforcement at command boundaries defers to Epic 101.
 *
 * Schema shape:
 *   {
 *     role:         string          — role name (e.g. "admin", "operator")
 *     actions:      string[]        — allowed action strings (e.g. ["plan", "apply"])
 *     resourceGlob: string          — resource-type glob (e.g. "AWS::S3::*")
 *   }
 *
 * Five reference fixtures live under `__fixtures__/`:
 *   admin-policy.json, operator-policy.json, read-only-policy.json,
 *   auditor-policy.json, restricted-policy.json.
 */

import { z } from "zod";

// ── Schema ─────────────────────────────────────────────────────────────

export const PolicySchema = z.object({
  /** Role identifier — free-form string; Epic 101 maps to OIDC claims. */
  role: z.string().min(1),

  /**
   * Actions permitted by this policy.
   * Convention: lowercase command names ("plan", "apply", "destroy", "list",
   * "status", "drift", "audit-verify").  Use ["*"] for full access.
   */
  actions: z.array(z.string().min(1)).min(1),

  /**
   * CloudFormation resource-type glob. Supports simple `*` wildcards only.
   * Example: "AWS::S3::*" permits actions on all S3 types.
   * Use "*" to permit all resource types.
   */
  resourceGlob: z.string().min(1),
});

export type Policy = z.infer<typeof PolicySchema>;

// ── Validation helper ──────────────────────────────────────────────────

/**
 * Parse and validate a raw object as a `Policy`.
 * Throws `ZodError` when the shape is invalid.
 */
export function parsePolicy(raw: unknown): Policy {
  return PolicySchema.parse(raw);
}

/**
 * Safe parse — returns `{ success, data?, error? }` without throwing.
 */
export function safeParsePolicies(
  raw: unknown[],
): Array<{ success: boolean; data?: Policy; error?: z.ZodError }> {
  return raw.map((item) => {
    const result = PolicySchema.safeParse(item);
    if (result.success) {
      return { success: true, data: result.data };
    }
    return { success: false, error: result.error };
  });
}
