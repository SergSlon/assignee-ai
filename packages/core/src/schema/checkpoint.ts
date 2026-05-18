/**
 * PlanCheckpoint Zod schema — domain-level checkpoint for plan reuse.
 * Serializes the minimum state needed to resume an approved plan
 * without re-running the full planning graph.
 *
 * @see Story 10.1, architecture.md#Checkpoint Serialization
 * @see FR-19 (checkpoint write), FR-21 (checkpoint detection)
 *
 * Story e92.1.d (Epic 89 regression C-05): additive fields
 *   `currentResourceIndex` + `completedResources` capture partial-apply
 *   resume state for compound patterns. Pre-Epic-92 checkpoints parse
 *   unchanged — the Zod `.optional().default(...)` pattern fills in
 *   safe defaults (`0` / `[]`) so old consumers never see `undefined`.
 */

import { z } from "zod";

export const CHECKPOINT_VERSION = "1" as const;

const PolicyApprovalStatusSchema = z.object({
  validatedAt: z.string(),
  policyVersion: z.string(),
  passed: z.boolean(),
});

const CheckpointResourceSpecSchema = z.object({
  resourceId: z.string(),
  resourceType: z.string(),
  displayName: z.string(),
  desiredState: z.record(z.unknown()),
});

/**
 * Minimal outcome record for a resource the compound-provisioning
 * loop has already fully provisioned. When the user re-runs
 * `assignee infra apply` against the same checkpoint, the plan-generator
 * skips over every resource whose ARN shows up here and resumes from
 * `currentResourceIndex`. We intentionally persist only ARN + type
 * (not the full `ResourceResult` shape) so the on-disk checkpoint
 * stays small and contains no graph-internal metadata.
 */
const CompletedResourceSchema = z.object({
  resourceArn: z.string(),
  resourceType: z.string(),
});

export type CheckpointCompletedResource = z.infer<
  typeof CompletedResourceSchema
>;

export const PlanCheckpointSchema = z.object({
  checkpoint_version: z.literal(CHECKPOINT_VERSION),
  created_at: z.string(),
  ttl_hours: z.number().int().positive(),
  runId: z.string().uuid(),
  userIntent: z.string(),
  resourceType: z.string(),
  resourcePatternId: z.string().nullish(),
  resourceQueue: z.array(CheckpointResourceSpecSchema).nullish(),
  desiredState: z.record(z.unknown()),
  estimatedMonthlyCost: z.string(),
  preflightPassed: z.boolean(),
  elicitedOptions: z.record(z.unknown()).optional(),
  policyApprovalStatus: PolicyApprovalStatusSchema.optional(),
  /**
   * Index into `resourceQueue` of the NEXT resource to plan/apply.
   * `0` on a fresh plan; advances as the compound provisioner loop
   * finishes resources. Pre-Epic-92 checkpoints omit this field; the
   * `.default(0)` pattern fills it in at parse time so downstream
   * code never has to branch on `undefined`.
   */
  currentResourceIndex: z.number().int().nonnegative().optional().default(0),
  /**
   * Ordered list of resources the compound loop has fully
   * provisioned. Used by the plan-generator on resume to skip
   * ahead to `currentResourceIndex` without re-planning. Defaults
   * to `[]` for single-resource checkpoints and for any pre-Epic-92
   * compound checkpoint that never persisted completion state.
   */
  completedResources: z.array(CompletedResourceSchema).optional().default([]),
});

export type PlanCheckpoint = z.infer<typeof PlanCheckpointSchema>;
