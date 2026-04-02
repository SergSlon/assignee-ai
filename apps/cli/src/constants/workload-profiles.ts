/**
 * Workload profile category keys used in EC2 instance type categorisation,
 * smart filtering, option ranking, and intent defaults.
 *
 * These are user-facing category keys (e.g. "burstable", "general") used in
 * the category-select UI and workload classifier — NOT the same as
 * InstanceCategory values which use longer forms like "general-purpose".
 *
 * Single source of truth — every workload profile string must reference these constants.
 */

export const WorkloadProfile = {
  UNKNOWN: "unknown",
  BURSTABLE: "burstable",
  GENERAL: "general",
  COMPUTE: "compute",
  MEMORY: "memory",
  ACCELERATED: "accelerated",
  STORAGE: "storage",
  HPC: "hpc",
  ARM: "arm",
  OTHER: "other",
} as const;

export type WorkloadProfileKey =
  (typeof WorkloadProfile)[keyof typeof WorkloadProfile];
