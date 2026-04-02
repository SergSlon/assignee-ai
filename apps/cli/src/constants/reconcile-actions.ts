/**
 * Canonical reconcile action values used in drift reconciliation.
 * Single source of truth — every reconcile action string must reference these constants.
 */

export const ReconcileAction = {
  RECONCILE: "reconcile",
  ACCEPT: "accept",
  SKIP: "skip",
} as const;

export type ReconcileActionType =
  (typeof ReconcileAction)[keyof typeof ReconcileAction];
