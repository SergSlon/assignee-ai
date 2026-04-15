/**
 * Maps EC2 instance family prefix to a user-friendly WorkloadProfile
 * category for the two-step category select UX.
 */

import { WorkloadProfile as WP } from "../../constants/workload-profiles.js";

export function categorizeFamily(family: string): {
  key: string;
  label: string;
  description: string;
} {
  const prefix = family.toLowerCase();
  if (prefix.startsWith("t"))
    return {
      key: WP.BURSTABLE,
      label: "Burstable",
      description: "Dev, small production, variable workloads",
    };
  if (prefix.startsWith("m"))
    return {
      key: WP.GENERAL,
      label: "General Purpose",
      description: "Balanced compute, memory, networking",
    };
  if (prefix.startsWith("c"))
    return {
      key: WP.COMPUTE,
      label: "Compute Optimized",
      description: "Batch, HPC, gaming, ML inference",
    };
  if (prefix.startsWith("r") || prefix.startsWith("x"))
    return {
      key: WP.MEMORY,
      label: "Memory Optimized",
      description: "Databases, caches, in-memory analytics",
    };
  if (
    prefix.startsWith("p") ||
    prefix.startsWith("g") ||
    prefix.startsWith("inf") ||
    prefix.startsWith("trn")
  )
    return {
      key: WP.ACCELERATED,
      label: "GPU / Accelerated",
      description: "ML training, inference, graphics, video",
    };
  if (
    prefix.startsWith("i") ||
    prefix.startsWith("d") ||
    prefix.startsWith("h")
  )
    return {
      key: WP.STORAGE,
      label: "Storage Optimized",
      description: "High I/O, data warehousing, distributed filesystems",
    };
  if (prefix.startsWith("hpc"))
    return {
      key: WP.HPC,
      label: "HPC",
      description: "High-performance computing",
    };
  if (prefix.startsWith("a"))
    return {
      key: WP.ARM,
      label: "ARM (Graviton 1st gen)",
      description: "ARM workloads, lowest cost",
    };
  return { key: WP.OTHER, label: "Other", description: prefix };
}
