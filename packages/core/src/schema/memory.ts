/**
 * Zod schemas for JSON memory files — provision log, failure log, pattern memory.
 *
 * This story (19.3) creates all three schemas as shared infrastructure.
 * Stories 19.4 and 19.5 consume the failure and pattern schemas respectively.
 *
 * @see Story 19.3, 19.4, 19.5
 */

import { z } from "zod";

export const ProvisionRecordSchema = z.object({
  runId: z.string().uuid(),
  resourceType: z.string(),
  resourceArn: z.string(),
  region: z.string(),
  desiredStateHash: z.string(),
  estimatedMonthlyCost: z.string(),
  timestamp: z.string().datetime(),
});

export const FailureRecordSchema = z.object({
  runId: z.string().uuid(),
  resourceType: z.string(),
  errorCode: z.string(),
  errorMessage: z.string(),
  suggestedFix: z.string(),
  timestamp: z.string().datetime(),
});

export const PatternRecordSchema = z.object({
  pattern: z.string(),
  optionsSelected: z.record(z.unknown()),
  count: z.number().int().positive(),
  lastUsed: z.string().datetime(),
});

export const ProvisionLogSchema = z.array(ProvisionRecordSchema);
export const FailureLogSchema = z.array(FailureRecordSchema);
export const PatternLogSchema = z.array(PatternRecordSchema);

export type ProvisionRecord = z.infer<typeof ProvisionRecordSchema>;
export type FailureRecord = z.infer<typeof FailureRecordSchema>;
export type PatternRecord = z.infer<typeof PatternRecordSchema>;
