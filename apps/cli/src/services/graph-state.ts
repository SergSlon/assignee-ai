/**
 * LangGraph state annotation for the Assignee.ai agent graph.
 * Separated from graph.ts to isolate state definition from wiring.
 */

import { Annotation } from "@langchain/langgraph";
import {
  ExecutionMode,
  type ExecutionModeType,
  ExecutionStatus,
  type ExecutionStatusType,
  PreflightMode,
  type PreflightModeType,
  type ArchitecturePattern,
  type ResourceSpec,
  type ResourceResult,
  type OrgResourceConfig,
  type UserResourceConfig,
  type GuardrailFinding,
  AssigneeError,
} from "@assignee/core";
import type { BPFinding } from "@assignee/best-practices";
import type { FreeTierNote } from "../utils/free-tier.js";

/** Post-provision security finding from Well-Architected Security MCP server (Story 19.2). */
export interface SecurityFinding {
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFORMATIONAL";
  title: string;
  recommendation: string;
  service: string;
}

export const graphAnnotation = Annotation.Root({
  userIntent: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  runId: Annotation<string>({
    reducer: (_, b) => b,
    default: () => crypto.randomUUID(),
  }),
  executionMode: Annotation<ExecutionModeType>({
    reducer: (_, b) => b,
    default: () => ExecutionMode.APPLY,
  }),
  resourceType: Annotation<string>({ reducer: (_, b) => b, default: () => "" }),
  resourceSchema: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
  desiredState: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
  estimatedMonthlyCost: Annotation<string | undefined>({
    reducer: (_, b) => b,
  }),
  preflightPassed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  preflightErrors: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  preflightMode: Annotation<PreflightModeType>({
    reducer: (_, b) => b,
    default: () => PreflightMode.LOCAL,
  }),
  requestToken: Annotation<string | undefined>({ reducer: (_, b) => b }),
  resourceArn: Annotation<string | undefined>({ reducer: (_, b) => b }),
  executionStatus: Annotation<ExecutionStatusType>({
    reducer: (_, b) => b,
    default: () => ExecutionStatus.PENDING,
  }),
  errorMessage: Annotation<string | undefined>({ reducer: (_, b) => b }),
  startedAt: Annotation<number | undefined>({ reducer: (_, b) => b }),
  messages: Annotation<unknown[]>({
    reducer: (a, b) => [...a, ...b],
    default: () => [],
  }),
  elicitedOptions: Annotation<Record<string, unknown> | undefined>({
    reducer: (_, b) => b,
  }),
  resourcePattern: Annotation<ArchitecturePattern | undefined>({
    reducer: (_, b) => b,
  }),
  resourceQueue: Annotation<ResourceSpec[] | undefined>({
    reducer: (_, b) => b,
  }),
  currentResourceIndex: Annotation<number | undefined>({
    reducer: (_, b) => b,
  }),
  completedResources: Annotation<ResourceResult[] | undefined>({
    reducer: (_, b) => b,
  }),
  perResourceCosts: Annotation<Record<string, string> | undefined>({
    reducer: (_, b) => b,
  }),
  error: Annotation<AssigneeError | undefined>({ reducer: (_, b) => b }),
  // Story 7.2: org policy + user config for option elicitation
  orgConfig: Annotation<OrgResourceConfig | undefined>({
    reducer: (_, b) => b,
  }),
  userConfig: Annotation<UserResourceConfig | undefined>({
    reducer: (_, b) => b,
  }),
  // Story 10.1: checkpoint reuse — set to true when apply resumes from a saved checkpoint
  checkpointResumed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  // Story 10.4: fast guardrail findings (display-only, non-blocking)
  guardrailFindings: Annotation<GuardrailFinding[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  // Story 7.8: free tier eligibility note (display-only, non-blocking)
  freeTierNote: Annotation<FreeTierNote | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  // Story 11.1: skip interactive option elicitor prompts, use plugin defaults
  noWizard: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  // Story 12.3: best practice findings from bp_evaluator node
  bpFindings: Annotation<BPFinding[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  // Story 11.2: auto-approve HITL for CI/CD (--yes flag)
  autoApprove: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  // Story 19.2: post-provision security findings (display-only, non-blocking)
  securityFindings: Annotation<SecurityFinding[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  // Story 19.3: memory hints from provision history (display-only, non-blocking)
  memoryHints: Annotation<string[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
});

export type AgentState = typeof graphAnnotation.State;
