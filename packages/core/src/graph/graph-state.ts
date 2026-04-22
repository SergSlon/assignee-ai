/**
 * LangGraph state annotation for the Assignee.ai agent graph.
 *
 * Story 50-4 Wave 5 Pass D: lifted to `@assignee/core/graph` so the 13 node
 * implementations (now in `packages/core/src/graph/nodes/`) can share the
 * `AgentState` type without importing back into `apps/cli`.
 *
 * The CLI file `apps/cli/src/services/graph-state.ts` is now a thin
 * re-export shim — Pass E will lift the remaining `createGraph` + routing
 * wiring.
 */

import { Annotation } from "@langchain/langgraph";
import {
  ExecutionMode,
  type ExecutionModeType,
  ExecutionStatus,
  type ExecutionStatusType,
  PreflightMode,
  type PreflightModeType,
  BPEnforcementLevel,
  type BPEnforcementLevelType,
} from "../schema/graph-state.js";
import type {
  ArchitecturePattern,
  ResourceSpec,
  ResourceResult,
} from "../pattern-templates/types.js";
import type {
  OrgResourceConfig,
  UserResourceConfig,
  ResolvedGlobalConfig,
  PricingBreakdown,
  DataSource,
} from "../index.js";
import { AssigneeError } from "../errors.js";
import type { FreeTierNote } from "../utils/free-tier.js";
import type { AppliedFix, SecurityFinding } from "../types/fix-finding.js";
import type { BPFinding } from "@assignee/best-practices";
import type { Advisory } from "./nodes/intent-parser.js";

export type { AppliedFix, SecurityFinding };

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
  estimatedMonthlyCostSource: Annotation<DataSource | undefined>({
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
  presetFields: Annotation<Record<string, string> | undefined>({
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
  orgConfig: Annotation<OrgResourceConfig | undefined>({
    reducer: (_, b) => b,
  }),
  userConfig: Annotation<UserResourceConfig | undefined>({
    reducer: (_, b) => b,
  }),
  resolvedConfig: Annotation<ResolvedGlobalConfig | undefined>({
    reducer: (_, b) => b,
  }),
  checkpointResumed: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  freeTierNote: Annotation<FreeTierNote | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  noWizard: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => true,
  }),
  bpFindings: Annotation<BPFinding[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  autoApprove: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  quickMode: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  securityFindings: Annotation<SecurityFinding[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  memoryHints: Annotation<string[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  placeholderCodeInjected: Annotation<boolean | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  appliedFixes: Annotation<AppliedFix[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  pricingBreakdown: Annotation<PricingBreakdown | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  autoFixEnabled: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  projectDir: Annotation<string | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  outputFormat: Annotation<string | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  bpEnforcementLevel: Annotation<BPEnforcementLevelType>({
    reducer: (_, b) => b,
    default: () => BPEnforcementLevel.ENFORCE,
  }),
  adviceHints: Annotation<string[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  noAdvice: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  sourceDir: Annotation<string | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  sourceFileCount: Annotation<number | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  retryCount: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),
  /**
   * Non-blocking structured advisories surfaced from the parse / plan
   * pipeline. Unlike `errorMessage` (which halts the plan) advisories
   * let the plan succeed but surface a user-visible signal that some
   * aspect of the input was silently altered.
   *
   * Epic 94 wave 1 fixer e94.R8 (A-06): populated by the intent-parser
   * when the "named <x>" clause drops trailing tokens.
   */
  advisories: Annotation<Advisory[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
});

export type AgentState = typeof graphAnnotation.State;
