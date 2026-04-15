/**
 * Shared types for the doctor command.
 *
 * SOLID split (Wave-6b F1):
 *   - `DoctorCheck` — single-responsibility interface each check implements.
 *   - `CheckContext` — minimum info a check needs (version, timeout).
 *     Individual checks MAY ask for richer deps by extending it.
 *   - `DoctorSection`, `DoctorReport`, `CheckStatus` — result shapes that
 *     were previously inlined in `doctor.ts`. JSON output shape is stable:
 *     external tooling parses it (see docs/troubleshooting.md).
 */

/** Per-check deadline. Spec constraint: <10s total, 5s per check. */
export const DEFAULT_CHECK_TIMEOUT_MS = 5000;

/** Status of a single doctor check or sub-check. */
export type CheckStatus = "ok" | "warn" | "fail";

/** A single doctor sub-check line (e.g. one credential role). */
export interface DoctorSubCheck {
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** A top-level doctor section (e.g. "Credentials"). */
export interface DoctorSection {
  name: string;
  status: CheckStatus;
  summary?: string;
  subs: DoctorSubCheck[];
}

/** The complete doctor report. */
export interface DoctorReport {
  version: string;
  sections: DoctorSection[];
  /** Aggregate exit code derived from `sections`. */
  exitCode: number;
  /** Human-readable rollup line at the bottom. */
  summary: string;
}

/**
 * Minimal context every check receives from the runner. Concrete checks
 * extend this with their own typed deps (ISP: a check that only needs
 * STS asks for an STS factory, not a god-context).
 */
export interface CheckContext {
  timeoutMs: number;
}

/**
 * A doctor check is a single-responsibility diagnostic. The runner calls
 * `run(ctx)` and merges the returned `DoctorSection` into the report.
 *
 * - `id`: stable string used by `--skip-check` and the JSON output.
 * - `label`: human-readable name for registry listings.
 * - `run`: returns `DoctorSection` OR `null` to opt out (e.g. LLM routing
 *   is only surfaced when per-node config exists).
 */
export interface DoctorCheck {
  readonly id: string;
  readonly label: string;
  run(ctx: CheckContext): Promise<DoctorSection | null>;
}
