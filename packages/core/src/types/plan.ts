import { z } from "zod";

/**
 * PlanSchema — placeholder for the Signed Intent contract.
 * Will be extended in Epic 4 with signing/policy fields.
 */
export const PlanSchema = z.object({
  planId: z.string().uuid(),
  runId: z.string().uuid(),
  resourceType: z.string(),
  desiredState: z.record(z.unknown()),
  estimatedMonthlyCost: z.string().optional(),
  createdAt: z.string().datetime(),
});

export type Plan = z.infer<typeof PlanSchema>;
