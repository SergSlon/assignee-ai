/**
 * Workload profile category keys used in EC2 instance type categorisation,
 * smart filtering, option ranking, and intent defaults.
 *
 * These are user-facing category keys (e.g. "burstable", "general") used in
 * the category-select UI and workload classifier — NOT the same as
 * InstanceCategory values which use longer forms like "general-purpose".
 *
 * Re-exports WorkloadProfileKey from @assignee/core as `WorkloadProfile`
 * for backward compatibility. Core is the single source of truth.
 */
import { WorkloadProfileKey } from "@assignee/core";

export const WorkloadProfile = WorkloadProfileKey;

export type WorkloadProfileValue =
  (typeof WorkloadProfile)[keyof typeof WorkloadProfile];
