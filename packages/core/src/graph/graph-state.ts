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
import type { ManagedResource } from "../list-resources/types.js";

/**
 * Structured result from the query_handler node. Populated when
 * intentKind="query" and the query-handler successfully resolved the
 * user's question against managed resources.
 *
 * Story: feature-query-intent-classifier
 */
export interface QueryResult {
  /** The resource type the user was asking about (if resolved). */
  resourceType?: string;
  /** Resolved managed resources matching the query. */
  resources: ManagedResource[];
  /** Human-readable one-liner summarising what was asked. */
  naturalQuestion: string;
  /** Whether the result set is empty for the queried type. */
  isEmpty: boolean;
}
import type { AppliedFix, SecurityFinding } from "../types/fix-finding.js";
import type { BPFinding } from "@assignee/best-practices";
import type { Advisory } from "./nodes/intent-parser.js";
import {
  ProcessEnvConfigAdapter,
  type ConfigPort,
} from "../config/config-port.js";
import type { ExistingResource } from "../services/resource-discovery-port.js";

export type { AppliedFix, SecurityFinding };
export type { ExistingResource };

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
    // PD-2: explicit `b ?? undefined` so that a preflight-guard return of
    // `pricingBreakdown: undefined` (free/non-priced resource) actively clears
    // any breakdown that leaked from the previous compound-plan resource,
    // instead of retaining it when the key was absent from the partial update.
    reducer: (_, b) => b ?? undefined,
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
  /**
   * CloudFront distribution hostname (e.g. "d1eka2i9dtl8tu.cloudfront.net") surfaced
   * from ProgressEvent.ResourceModel.DomainName when the status_poller polls a
   * successful AWS::CloudFront::Distribution creation. Propagated into
   * ResourceResult.metadata.cloudFrontDomainName by the compound apply formatter
   * so the static-website URL printer can use the real DNS-resolvable hostname
   * instead of constructing a broken `<id>.cloudfront.net` URL.
   */
  cloudFrontDomainName: Annotation<string | undefined>({
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
   * W10-05 (P042 → L6-F20): throttling-backoff retry counter.
   * Incremented by status_poller each time a transient 503 / ThrottlingException
   * is encountered. Resets to 0 at graph start. Distinct from `retryCount`
   * (CloudFront S3 DNS-propagation retries) so the two budgets are independent.
   */
  throttleRetryCount: Annotation<number>({
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
   *
   * Epic 94 wave 3 fixer e94.N6 (B-04 / C-05 / C-06): also populated by
   * `preflight_guard` when a placeholder-class guard would have blocked
   * the plan under `--no-apply` preview mode. Code
   * `PREFLIGHT_PLACEHOLDER_DOWNGRADED` carries the original guard
   * message so the user sees what would fail on apply without losing
   * the preview render.
   */
  advisories: Annotation<Advisory[] | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  /**
   * Epic 94 wave 3 fixer e94.N6 (C-05 / C-06): set by the CLI plan
   * command when the user passed `--no-apply`. Under this flag the
   * user explicitly asked for a read-only preview; placeholder-class
   * preflight failures (ARN / EC2-ID / sentinel-password) are
   * downgraded to advisories so the plan still renders. Mutating
   * paths (apply / destroy) leave the flag at its default `false` so
   * the original fail-closed semantics are preserved.
   */
  noApply: Annotation<boolean>({
    reducer: (_, b) => b,
    default: () => false,
  }),
  /**
   * MASTER-009 (RW4b): tenant-scoped configuration adapter threaded
   * through graph state so depth-3+ call sites (preflight guards,
   * llm-plan invoke, plan formatter) can read configuration without
   * constructing a fresh `ProcessEnvConfigAdapter` per call.
   *
   * `createGraph` injects its `effectiveConfig` (constructor-supplied
   * `options.config` OR the lazy fallback `new ProcessEnvConfigAdapter()`)
   * via the per-node telemetry wrapper so every node-internal callee
   * sees the same shared adapter for the run. The annotation default
   * returns a fresh `ProcessEnvConfigAdapter` so direct unit-test
   * invocations of node functions (without `createGraph`) still get a
   * working ConfigPort; the reducer keeps the existing value when the
   * incoming partial update does not carry one (the common case —
   * nodes do not normally write to `state.config`).
   */
  config: Annotation<ConfigPort>({
    reducer: (a, b) => b ?? a,
    default: () => new ProcessEnvConfigAdapter(),
  }),
  /**
   * Intent kind classified by the intent-parser. Set for every intent;
   * defaults to undefined (treated as "create") for backward-compat.
   *
   * - "create"  — user wants to provision a new resource (existing path).
   * - "query"   — user wants to read/list/describe existing resources.
   * - "destroy" — user wants to remove a resource (routes to destroy flow).
   * - "update"  — user wants to modify a resource (deferred, falls through to create).
   */
  intentKind: Annotation<"create" | "query" | "destroy" | "update" | undefined>(
    {
      reducer: (_, b) => b,
      default: () => undefined,
    },
  ),
  /**
   * Structured output from the query-handler node. Populated when
   * intentKind="query" and the query-handler successfully resolved the
   * user's question against managed resources. The result-formatter
   * renders this instead of the plan/apply output.
   */
  queryResult: Annotation<QueryResult | undefined>({
    reducer: (_, b) => b,
    default: () => undefined,
  }),
  /**
   * EPIC-107-2 (PH1-G-2 deep fix): existing AWS resources discovered at
   * intent-parse time via the ResourceDiscoveryPort.
   *
   * These are READ-ONLY nodes that were already provisioned in the user's
   * account. They are NEVER iterated by the destroy strategies — destroy
   * only touches `ManagedResource` entries from provisions.json.
   *
   * Destroy isolation invariant (Variation F): `existingResources` is
   * populated by the existing-resource-extractor, persisted through graph
   * state, and consumed by compound-pattern consumers that need to wire
   * Desired resources to Existing ones. The destroy bulk-action and
   * single-flow use `fetchManagedResources()` exclusively — they do NOT
   * read this field.
   *
   * Default `[]` ensures all existing reader call-sites are backwards-
   * compatible without modification.
   */
  existingResources: Annotation<ExistingResource[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
});

export type AgentState = typeof graphAnnotation.State;
