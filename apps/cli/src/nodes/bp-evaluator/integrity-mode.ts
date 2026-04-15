/**
 * BP integrity enforcement mode resolution + error type.
 *
 * ENFORCE → hash/signature failures throw and block plan.
 * WARN    → emit stderr warning, continue (tests default here).
 * DISABLED→ skip integrity checks entirely.
 *
 * Wave-6c F3: extracted from bp-evaluator.ts (SRP).
 */

import { EnvVar } from "../../constants/env-vars.js";

export const BpIntegrityMode = {
  ENFORCE: "enforce",
  WARN: "warn",
  DISABLED: "disabled",
} as const;

export type BpIntegrityModeType =
  (typeof BpIntegrityMode)[keyof typeof BpIntegrityMode];

/**
 * Thrown when BP integrity verification fails in enforce mode. Preflight
 * should catch this at the top of the pipeline and block the plan.
 */
export class BpIntegrityError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
    public readonly mismatchedFiles: string[] = [],
  ) {
    super(message);
    this.name = "BpIntegrityError";
  }
}

/**
 * Resolve the integrity enforcement mode from env var + NODE_ENV.
 *   - ASSIGNEE_BP_INTEGRITY=enforce|warn|disabled → explicit override
 *   - NODE_ENV=test → "warn" default (so tests don't fail on TOFU)
 *   - otherwise → "enforce" default (production-safe)
 */
export function resolveBpIntegrityMode(): BpIntegrityModeType {
  const raw = (process.env[EnvVar.ASSIGNEE_BP_INTEGRITY] ?? "").toLowerCase();
  if (raw === BpIntegrityMode.ENFORCE) return BpIntegrityMode.ENFORCE;
  if (raw === BpIntegrityMode.WARN) return BpIntegrityMode.WARN;
  if (raw === BpIntegrityMode.DISABLED) return BpIntegrityMode.DISABLED;
  if (process.env["NODE_ENV"] === "test") return BpIntegrityMode.WARN;
  return BpIntegrityMode.ENFORCE;
}
