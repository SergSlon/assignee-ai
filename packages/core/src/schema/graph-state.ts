import { z } from 'zod'

export const GraphStateSchema = z.object({
  // Core intent
  userIntent: z.string().default(''),
  runId: z.string().uuid().default(() => crypto.randomUUID()),
  executionMode: z.enum(['plan', 'apply']).default('apply'),

  // Schema resolution
  resourceType: z.string().default(''),
  resourceSchema: z.record(z.unknown()).optional(),

  // Plan output
  desiredState: z.record(z.unknown()).optional(),
  estimatedMonthlyCost: z.string().optional(), // e.g. "~$0.023/month" or "N/A"

  // Preflight
  preflightPassed: z.boolean().default(false),
  preflightErrors: z.array(z.string()).default([]),
  preflightMode: z.enum(['local', 'saas']).default('local'), // 'saas' in MVP (Story 4.3b)

  // Execution
  requestToken: z.string().optional(), // CloudControl async token
  resourceArn: z.string().optional(),
  executionStatus: z
    .enum([
      'PENDING',
      'IN_PROGRESS',
      'SUCCESS',
      'FAILED',
      'POLICY_BLOCKED',
      'UNSUPPORTED_RESOURCE',
      'CANCELLED',
    ])
    .default('PENDING'),
  errorMessage: z.string().optional(),

  // LangGraph message history
  messages: z.array(z.unknown()).default([]),
})

export type GraphState = z.infer<typeof GraphStateSchema>
