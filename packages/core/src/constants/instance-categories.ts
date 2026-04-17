/**
 * Canonical instance type categories used in workload classification and option ranking.
 * Single source of truth — every instance category string must reference these constants.
 */

export const InstanceCategory = {
  BURSTABLE: "burstable",
  GENERAL_PURPOSE: "general-purpose",
  COMPUTE_HEAVY: "compute-heavy",
  MEMORY_INTENSIVE: "memory-intensive",
  GPU_ACCELERATED: "gpu-accelerated",
  STORAGE_HEAVY: "storage-heavy",
  HPC: "hpc",
} as const;

export type InstanceCategoryType =
  (typeof InstanceCategory)[keyof typeof InstanceCategory];
