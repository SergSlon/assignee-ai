/**
 * DriftDetectorService — compares desired state (from provision logs /
 * checkpoints) against actual state (from CloudControl GetResource).
 *
 * This file is a thin barrel; implementation lives in `drift-detector/`.
 * Decomposed in Wave-6c (per-module ≤300 LOC, SOLID OCP boundary).
 *
 * @see Story 28.1 — Drift Detector Service
 */

export { canonicalSort, deepEqual } from "./drift-detector/canonical.js";
export { normalizeValue } from "./drift-detector/normalize.js";
export { deepDiff } from "./drift-detector/field-diff.js";
export {
  DriftDetectorService,
  type DriftDetectorOptions,
  type BatchCheckEntry,
  type BatchCheckOptions,
  type ProgressCallback,
} from "./drift-detector/service.js";
