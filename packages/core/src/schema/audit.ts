import { z } from 'zod'

export const AuditEventSchema = z.object({
  eventId: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string(),
  orgId: z.string(),
  resourceType: z.string(),
  desiredState: z.record(z.unknown()),
  policyResult: z.string().optional(),
  executionStatus: z.string(),
  timestamp: z.string().datetime(),
})

export type AuditEvent = z.infer<typeof AuditEventSchema>
