import { z } from "zod";
import type {
  ArchitecturePattern,
  ResourceSpec,
  ResourceResult,
} from "../pattern-templates/types.js";
import { SUPPORTED_TYPES_ARRAY } from "../config/resource-types.js";

export const ExecutionMode = {
  PLAN: "plan",
  APPLY: "apply",
} as const;
export type ExecutionModeType =
  (typeof ExecutionMode)[keyof typeof ExecutionMode];

export const ExecutionStatus = {
  PENDING: "PENDING",
  IN_PROGRESS: "IN_PROGRESS",
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
  POLICY_BLOCKED: "POLICY_BLOCKED",
  UNSUPPORTED_RESOURCE: "UNSUPPORTED_RESOURCE",
  CANCELLED: "CANCELLED",
} as const;
export type ExecutionStatusType =
  (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

export const PreflightMode = {
  LOCAL: "local",
  SAAS: "saas",
} as const;
export type PreflightModeType =
  (typeof PreflightMode)[keyof typeof PreflightMode];

export const GraphStateSchema = z.object({
  // Core intent
  userIntent: z.string().default(""),
  runId: z
    .string()
    .uuid()
    .default(() => crypto.randomUUID()),
  executionMode: z.nativeEnum(ExecutionMode).default(ExecutionMode.APPLY),

  // Schema resolution
  resourceType: z.enum(SUPPORTED_TYPES_ARRAY).optional(),
  resourceSchema: z.record(z.unknown()).optional(),

  // Plan output
  desiredState: z.record(z.unknown()).optional(),
  estimatedMonthlyCost: z.string().optional(), // e.g. "~$0.023/month" or "N/A"

  // Preflight
  preflightPassed: z.boolean().default(false),
  preflightErrors: z.array(z.string()).default([]),
  preflightMode: z.nativeEnum(PreflightMode).default(PreflightMode.LOCAL), // 'saas' in MVP (Story 4.3b)

  // Execution
  requestToken: z.string().optional(), // CloudControl async token
  resourceArn: z.string().optional(),
  executionStatus: z
    .nativeEnum(ExecutionStatus)
    .default(ExecutionStatus.PENDING),
  errorMessage: z.string().optional(),

  // Timing — set at graph start for NFR-05 performance tracking (Story 1.5)
  startedAt: z.number().optional(),

  // Option elicitation — populated by option_elicitor node (Story 7.3)
  elicitedOptions: z.record(z.unknown()).optional(),

  // Compound architecture pattern — populated by intent_parser when a pattern is detected (Story 8.1)
  resourcePattern: z.custom<ArchitecturePattern>().optional(),

  // Story 8.2: compound provisioning loop state
  resourceQueue: z.custom<ResourceSpec[]>().optional(), // Flattened dependency-ordered resources
  currentResourceIndex: z.number().optional(), // Index into resourceQueue
  completedResources: z.custom<ResourceResult[]>().optional(), // Accumulated per-resource results

  // LangGraph message history
  messages: z.array(z.unknown()).default([]),
});

export type GraphState = z.infer<typeof GraphStateSchema>;
