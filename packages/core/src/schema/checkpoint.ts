/**
 * PlanCheckpoint Zod schema — domain-level checkpoint for plan reuse.
 * Serializes the minimum state needed to resume an approved plan
 * without re-running the full planning graph.
 *
 * @see Story 10.1, architecture.md#Checkpoint Serialization
 * @see FR-19 (checkpoint write), FR-21 (checkpoint detection)
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
});

export type PlanCheckpoint = z.infer<typeof PlanCheckpointSchema>;
