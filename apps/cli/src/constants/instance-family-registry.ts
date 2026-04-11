/**
 * Instance family registry — canonical tables driving cost-advisor
 * suggestions that depend on instance-family knowledge (ARM equivalents,
 * spot eligibility, RDS large-class detection, RDS budget alternatives).
 *
 * Story 46.6 (2026-04-12): these tables used to live inline in
 * `apps/cli/src/nodes/advice/constants.ts` alongside security and display
 * constants, which meant adding support for a new instance family (m7g,
 * c7g, r7g, i4g, etc.) required editing the advice module. Extracting
 * them to a dedicated registry gives us a single source of truth and a
 * clean seam for a future `.assignee/config.yaml`-driven override
 * (Phase 2 — deferred until a user actually asks, to avoid speculative
 * merge logic).
 *
 * Each table is a pure data declaration: the advisor code does NOT
 * compute derived forms, so editing this file is the only step to add a
 * new family.
 *
 * @see Story 40.4, 40.5, 40.6 — original advisor introductions
 * @see apps/cli/src/nodes/advice/constants.ts — re-exports for backward compat
 */

/**
 * Instance type family prefix → ARM (Graviton) equivalent prefix.
 *
 * Each entry maps a non-ARM family to its Graviton cousin. The advisor
 * uses this to emit "consider t4g.* instead of t3.*" hints on plan
 * output when a cheaper ARM equivalent exists. Families without an ARM
 * equivalent (hpc, gpu, storage-optimized) are intentionally omitted.
 */
export const ARM_EQUIVALENTS: Record<string, string> = {
  "t3.": "t4g.",
  "m5.": "m6g.",
  "c5.": "c6g.",
};

/**
 * Instance type prefixes eligible for Spot Instance suggestion.
 *
 * Burstable families (t3, t4g) are the only ones the cost advisor
 * suggests moving to Spot — compute/memory-optimized workloads are
 * typically long-running and don't tolerate Spot interruptions well.
 * The advisor emits a "consider Spot" hint only for instances whose
 * type starts with one of these prefixes.
 */
export const SPOT_ELIGIBLE_PREFIXES = ["t3.", "t4g."] as const;

/**
 * RDS instance class prefixes considered "large" — the advisor emits
 * a downgrade suggestion for non-production intents using these classes.
 */
export const RDS_LARGE_CLASS_PREFIXES = ["db.r5.", "db.r6g."] as const;

/**
 * RDS instance class string suggested as the cheaper alternative when
 * a "large" class is detected on a non-production workload.
 */
export const RDS_BUDGET_ALTERNATIVES = "db.t3.medium or db.t4g.medium";
