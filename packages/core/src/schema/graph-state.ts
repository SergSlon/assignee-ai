import { z } from "zod";
import type {
  ArchitecturePattern,
  ResourceSpec,
  ResourceResult,
} from "../pattern-templates/types.js";
import { SUPPORTED_TYPES_ARRAY } from "../config/resource-types.js";
import { OrgPolicy } from "../config/resource-policy.js";

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
  /**
   * Set by the intent-parser when the user's input is a read-only query
   * (kind=query). The graph routes directly from intent_parser →
   * query_handler → result_formatter, bypassing the heavy creation pipeline
   * (schema-fetch / wizard / plan-generator). Zero AWS writes are performed.
   */
  QUERY_INTENT: "QUERY_INTENT",
} as const;
export type ExecutionStatusType =
  (typeof ExecutionStatus)[keyof typeof ExecutionStatus];

export const BPEnforcementLevel = {
  ENFORCE: "enforce",
  WARN: "warn",
  SKIP: "skip",
} as const;
export type BPEnforcementLevelType =
  (typeof BPEnforcementLevel)[keyof typeof BPEnforcementLevel];

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

  // Story 8.3: per-resource cost map keyed by resourceId (populated by preflight_guard in compound mode)
  perResourceCosts: z.record(z.string()).optional(),

  // Config — org policy + user preferences (Story 7.2)
  orgConfig: z
    .record(
      z.record(
        z.object({
          policy: z.enum([
            OrgPolicy.LOCKED,
            OrgPolicy.DEFAULT,
            OrgPolicy.ALWAYS_ASK,
          ]),
          value: z.unknown().optional(),
        }),
      ),
    )
    .optional(),
  userConfig: z.record(z.record(z.unknown())).optional(),

  // Best-practice enforcement level (Story 41.2)
  bpEnforcementLevel: z
    .enum([
      BPEnforcementLevel.ENFORCE,
      BPEnforcementLevel.WARN,
      BPEnforcementLevel.SKIP,
    ])
    .default(BPEnforcementLevel.ENFORCE),

  // LangGraph message history
  messages: z.array(z.unknown()).default([]),
});

export type GraphState = z.infer<typeof GraphStateSchema>;

/**
 * Graph state field name constants — single source of truth for state channel
 * names used in serialization, MCP server responses, and pipeline contract tests.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const StateField = {
  EXECUTION_STATUS: "executionStatus",
  RESOURCE_TYPE: "resourceType",
  DESIRED_STATE: "desiredState",
  ESTIMATED_MONTHLY_COST: "estimatedMonthlyCost",
  ERROR_MESSAGE: "errorMessage",
  RESOURCE_ARN: "resourceArn",
  SECURITY_FINDINGS: "securityFindings",
  COMPLETED_RESOURCES: "completedResources",
  BP_FINDINGS: "bpFindings",
  FREE_TIER_NOTE: "freeTierNote",
  ADVICE_HINTS: "adviceHints",
  PREFLIGHT_PASSED: "preflightPassed",
  ELICITED_OPTIONS: "elicitedOptions",
  RESOURCE_PATTERN: "resourcePattern",
  RESOURCE_QUEUE: "resourceQueue",
} as const;
