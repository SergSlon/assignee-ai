/**
 * preflight_guard node — cost estimation + basic validation gate.
 * Pricing is delegated to PricingStrategyRegistry (Story 9.4).
 * Pricing query has a 3s hard timeout (non-blocking: never blocks apply on failure).
 * SaaS policy validation is Epic 4; POC always passes.
 *
 * @see Story 1-7, Story 9-4
 */

import {
  ExecutionStatus,
  CostEstimateLabel,
  defaultPricingRegistry,
  defaultDecomposerRegistry,
  extractFirstTierPrice,
  getRequiredIamActions,
  PLACEHOLDER_DB_PASSWORDS,
  RDS_PASSWORD_FIELDS,
  type AwsPricingResponse,
  type DataSource,
  type PricingLineItem,
  type PricingLineItemResult,
  type PricingBreakdown,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import {
  AWS_REGION,
  PRICING_TIMEOUT_MS,
  HOURS_PER_MONTH,
} from "../config/constants.js";
import { PricingTerm } from "../constants/pricing.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { withTimeout } from "../utils/timeout.js";
import { getFreeTierNote, loadAccountCreatedDate } from "../utils/free-tier.js";
import { getCachedPrice, setCachedPrice } from "../services/price-cache.js";
import type { AgentState } from "../services/graph.js";
import { PromiseStatus } from "../config/constants.js";
import { getOperatorCallerArn } from "../utils/resolve-arn.js";
import {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "../constants/placeholder-accounts.js";

/**
 * Maximum recursion depth for the placeholder-ARN walker. CCAPI desired
 * state is at most a handful of layers deep in practice (resource ->
 * properties -> nested config like Tags / SecurityGroupIds / IamPolicy
 * documents), so 32 is generous. The cap exists to defend against
 * pathological input — a circular structure or hostile deeply-nested
 * JSON would otherwise blow the stack. Wave 11 P2-7 / edge finding #7
 * ("no cycle guard on the recursive walker").
 */
const PLACEHOLDER_WALK_MAX_DEPTH = 32;

/**
 * Walks a desiredState object recursively and returns a friendly error
 * message if any string value is an ARN containing one of the placeholder
 * account IDs above. Returns undefined when the state is clean.
 *
 * Strict ARN regex (`^arn:aws[\w-]*:[\w-]*:[\w-]*:(\d{12}):`) anchors on
 * the canonical 5-colon prefix and captures the account-ID segment to
 * avoid false positives on free-text fields that happen to contain "123
 * 456789012" inside a longer string.
 */
function detectPlaceholderArn(
  desiredState: Record<string, unknown>,
): string | undefined {
  function walk(
    value: unknown,
    path: string,
    depth: number,
  ): { field: string; arn: string; account: string } | undefined {
    if (depth > PLACEHOLDER_WALK_MAX_DEPTH) return undefined;
    if (typeof value === "string") {
      const match = ARN_ACCOUNT_REGEX.exec(value);
      if (match && PLACEHOLDER_AWS_ACCOUNT_IDS.has(match[1]!)) {
        return { field: path, arn: value, account: match[1]! };
      }
      return undefined;
    }
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const found = walk(value[i], `${path}[${i}]`, depth + 1);
        if (found) return found;
      }
      return undefined;
    }
    if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        const found = walk(v, path ? `${path}.${k}` : k, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }

  const hit = walk(desiredState, "", 0);
  if (!hit) return undefined;
  return (
    `Field "${hit.field}" contains a placeholder ARN ` +
    `(${hit.arn}). The account ID ${hit.account} is an AWS docs example, ` +
    `not a real account. Provide a real ARN with --set ${hit.field}=arn:aws:... ` +
    `or omit the field entirely if the resource type allows it.`
  );
}

/**
 * RDS resource types whose desiredState is screened for placeholder
 * MasterUserPassword sentinels. Kept narrow so the guard never fires on
 * unrelated services that happen to expose a "Password" field.
 */
const RDS_PASSWORD_GUARDED_TYPES: ReadonlySet<string> = new Set([
  "AWS::RDS::DBInstance",
  "AWS::RDS::DBCluster",
]);

/**
 * Returns an actionable error when the desiredState of an RDS resource
 * still carries one of the known placeholder MasterUserPassword sentinels
 * (see PLACEHOLDER_DB_PASSWORDS). Returns undefined when the state is
 * clean or the resource type is out of scope.
 *
 * Mirrors detectPlaceholderArn — same shape, same surfacing. The guard is
 * intentionally scoped to RDS_PASSWORD_GUARDED_TYPES instead of walking
 * arbitrary nested objects: the pattern template emits the sentinel
 * directly on the top-level desiredState of the RDS resource, and a
 * deeper walk would risk false positives on unrelated services that
 * happen to expose a Password-named field.
 */
function detectSentinelPassword(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string | undefined {
  if (!RDS_PASSWORD_GUARDED_TYPES.has(resourceType)) return undefined;
  for (const field of RDS_PASSWORD_FIELDS) {
    const value = desiredState[field];
    if (typeof value === "string" && PLACEHOLDER_DB_PASSWORDS.has(value)) {
      return (
        `Field "${field}" is still the placeholder password baked into the ` +
        `pattern template. Override it before apply with: ` +
        `--set ${field}=<a-real-password>. ` +
        `Requirements: 8+ characters; cannot contain '/', '@', '"', or spaces. ` +
        `For automation, generate one with: openssl rand -base64 24 | tr -d '/+=@\"'.`
      );
    }
  }
  return undefined;
}

/**
 * Wave 19 Bug #8: verify that every ManagedPolicyArn in an IAM::Role plan
 * actually exists in IAM. The LLM was observed inventing plausible-looking
 * but fictional ARNs (e.g. `arn:aws:iam::aws:policy/service-role/AmazonEC2RoleforAWSServiceAccess`).
 *
 * Returns an error message string when at least one ARN doesn't exist, or
 * `null` when all ARNs verify successfully (or verification couldn't run
 * for IAM-permission reasons — fail-open here is OK because CCAPI will
 * still reject bad ARNs at provision time, just with a less actionable
 * error).
 *
 * Uses the operator's existing IAM client. `iam:GetPolicy` is already in
 * AssigneeOperatorPolicy via the auditor read paths.
 */
async function verifyManagedPolicyArns(
  arns: readonly string[],
): Promise<string | null> {
  if (arns.length === 0) return null;
  try {
    const { IAMClient, GetPolicyCommand } = await import("@aws-sdk/client-iam");
    const { operatorCredentials } =
      await import("../config/operator-credentials.js");
    const creds = operatorCredentials();
    const iam = new IAMClient({
      // IAM is global; us-east-1 is the canonical control-plane region
      region: "us-east-1",
      ...(creds.accessKeyId && creds.secretAccessKey
        ? {
            credentials: {
              accessKeyId: creds.accessKeyId,
              secretAccessKey: creds.secretAccessKey,
            },
          }
        : {}),
    });

    const invalidArns: { arn: string; reason: string }[] = [];
    for (const arn of arns) {
      try {
        await iam.send(new GetPolicyCommand({ PolicyArn: arn }));
      } catch (err) {
        const errName = (err as { name?: string })?.name ?? "";
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errName === "NoSuchEntityException") {
          invalidArns.push({
            arn,
            reason: "policy does not exist in IAM",
          });
        } else if (
          errName === "AccessDenied" ||
          errMsg.includes("not authorized")
        ) {
          // Operator role lacks iam:GetPolicy — fail open. CCAPI will still
          // reject bad ARNs at provision time. Don't block on a permission
          // gap that's separate from the bug we're trying to catch.
          return null;
        } else {
          // Unknown error — log to extras but don't block. Network blip,
          // throttling, etc.
          invalidArns.push({
            arn,
            reason: `verification failed: ${errMsg}`,
          });
        }
      }
    }

    if (invalidArns.length > 0) {
      const lines = invalidArns
        .map((x) => `  - ${x.arn} → ${x.reason}`)
        .join("\n");
      return (
        `One or more ManagedPolicyArns do not exist in IAM:\n${lines}\n\n` +
        `These ARNs were likely hallucinated by the LLM. Either:\n` +
        `  1. Remove them: \`assignee apply <intent> --set ManagedPolicyArns=\`\n` +
        `  2. Replace with a verified ARN: see iam-role.ts configHints for the verified list\n` +
        `  3. Specify the policies you want explicitly in your intent (e.g. ` +
        `"... attach the AmazonS3ReadOnlyAccess policy")`
      );
    }
    return null;
  } catch (err) {
    // Import or client construction failed — don't block, fall through
    log({
      ts: new Date().toISOString(),
      runId: "system",
      level: "warn",
      action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
      extras: {
        phase: "managed_policy_verification_skipped",
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return null;
  }
}

export async function preflightGuardNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  // Validate all schema-required fields are present in the generated desiredState.
  const requiredFields =
    (state.resourceSchema?.["required"] as string[] | undefined) ?? [];
  const desiredState = (state.desiredState ?? {}) as Record<string, unknown>;
  const missingFields = requiredFields.filter((f) => !(f in desiredState));

  if (missingFields.length > 0) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Missing required fields for ${state.resourceType}: ${missingFields.join(", ")}. Include them in your intent, e.g. "Create a lambda with role arn:aws:iam::ACCOUNT_ID:role/my-role".`,
    };
  }

  // Reject placeholder ARNs that the LLM may have hallucinated despite the
  // explicit schema-prompt warning. The most common offender is account
  // 123456789012 which appears in every AWS docs example. Submitting these
  // to AWS triggers a confusing "Cross-account pass role is not allowed"
  // (Lambda) or "User is not authorized to perform: ... on resource: arn:
  // aws:iam::123456789012:..." (any other resource) at provisioning time,
  // far away from where the value was generated.
  //
  // Closes Phase 2 Lambda compound passrole bug — surfaces the placeholder
  // at preflight with an actionable message instead of letting it reach
  // CloudControl.
  const placeholderArnError = detectPlaceholderArn(desiredState);
  if (placeholderArnError) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: placeholderArnError,
    };
  }

  // Reject RDS plans that still carry the placeholder MasterUserPassword
  // baked into the three-tier-web pattern. The pattern emits a
  // deterministic sentinel string so this guard can positively identify
  // it and stop a known-public password from reaching CCAPI. Without
  // this, a user who forgets to --set MasterUserPassword=... would deploy
  // an RDS instance whose master password is in source control. See
  // packages/core/src/config/placeholder-passwords.ts for the sentinel
  // set; mirrors detectPlaceholderArn for consistency.
  const sentinelPasswordError = detectSentinelPassword(
    state.resourceType ?? "",
    desiredState,
  );
  if (sentinelPasswordError) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: sentinelPasswordError,
    };
  }

  // Wave 19 Bug #8: the LLM was observed hallucinating non-existent AWS
  // managed policy ARNs (e.g. `AmazonEC2RoleforAWSServiceAccess`,
  // `AmazonEC2RoleforAWSCodeDeployRole` — neither exists). Submitting these
  // to CCAPI produces a confusing
  // `Scope ARN: arn:aws:iam::aws:policy/... does not exist or is not attachable`
  // 404 at provision time, leaving the user thinking the resource type is
  // broken. Verify each ManagedPolicyArn against IAM with `iam:GetPolicy`
  // before CCAPI sees it. The configHint added to iam-role.ts already
  // constrains the LLM to a verified allowlist, but this preflight is the
  // belt-and-braces guarantee for cases where the LLM ignores the hint or
  // the user passes an invented ARN via --set.
  if (state.resourceType === "AWS::IAM::Role") {
    const managedPolicyArns = desiredState["ManagedPolicyArns"];
    if (Array.isArray(managedPolicyArns) && managedPolicyArns.length > 0) {
      const verificationError = await verifyManagedPolicyArns(
        managedPolicyArns.filter((a): a is string => typeof a === "string"),
      );
      if (verificationError) {
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: verificationError,
        };
      }
    }
  }

  const mcpConfig = defaultPricingRegistry.getMcpConfig(
    state.resourceType,
    desiredState,
  );
  // Story 46.2: track both label and source so the display layer can tag
  // the headline cost with where the number came from. Local strategies
  // already declare their own source ("free" for free-tier resources,
  // "fallback" for everything else); we keep that intact and only override
  // it to "mcp" when the live Pricing API path actually returns a value.
  const localPricing = defaultPricingRegistry.estimate(
    state.resourceType,
    desiredState,
  );
  const localEstimate = localPricing.label;
  const localSource = localPricing.source;

  // Story 18.10: Blocking BP findings (replaces old guardrail engine + CRITICAL BP check)
  // BP evaluation is synchronous (<1ms) — run before the parallel block.
  // Story 41.2: Enforcement level controls blocking behaviour:
  //   "enforce" (default) — block on any blocking finding, regardless of --yes/--no-wizard
  //   "warn"              — log findings but never block
  //   "skip"              — no evaluation at all
  const bpFindings = state.bpFindings ?? [];
  const blockingFindings = bpFindings.filter((f) => f.blocking);
  let bpBlocked = false;
  const bpLevel = state.bpEnforcementLevel ?? "enforce";

  if (bpLevel === "skip") {
    // User explicitly opted out of BP evaluation — no blocking, minimal logging
    bpBlocked = false;
  } else if (bpLevel === "warn") {
    // Advisory mode — log findings but don't block
    if (blockingFindings.length > 0) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATED,
        extras: {
          enforcement: "warn",
          blockingCount: blockingFindings.length,
          practiceIds: blockingFindings.map((f) => f.practiceId),
        },
      });
    }
    bpBlocked = false;
  } else {
    // "enforce" (default) — block regardless of --yes or --no-wizard
    if (blockingFindings.length > 0) {
      bpBlocked = true;
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.BP_EVALUATED,
        extras: {
          blocked: true,
          enforcement: "enforce",
          blockingCount: blockingFindings.length,
          practiceIds: blockingFindings.map((f) => f.practiceId),
        },
      });
    }
  }

  // Story 7.8: Free tier awareness — non-blocking (AC #6)
  // Synchronous — run before the parallel block.
  let freeTierNote: ReturnType<typeof getFreeTierNote> | undefined;
  try {
    const accountCreated = loadAccountCreatedDate();
    freeTierNote = getFreeTierNote(state.resourceType, accountCreated);
    if (freeTierNote) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.FREE_TIER_DETECTED,
        extras: {
          resourceType: state.resourceType,
          freeTierType: freeTierNote.type,
        },
      });
    }
  } catch (err) {
    // Non-blocking: free tier detection failure must never prevent plan/apply
    freeTierNote = undefined;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.FREE_TIER_DETECTED,
      extras: {
        result: "skipped_on_error",
        resourceType: state.resourceType,
        error: String(err),
      },
    });
  }

  // Story 9.10: Parallel fan-out — pricing query and IAM pre-check run concurrently.
  // Uses Promise.allSettled so one failure doesn't cancel the other.
  const startMs = Date.now();
  const [pricingSettled, iamSettled] = await Promise.allSettled([
    // Pricing query — returns BOTH the label and where it came from so the
    // display layer can tell the user "live" vs "estimated".
    (async (): Promise<{ label: string; source: DataSource }> => {
      if (!mcpConfig || !tools)
        return { label: localEstimate, source: localSource };
      const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
      if (!pricingTool) return { label: localEstimate, source: localSource };
      try {
        const timeoutMs = mcpConfig.timeoutMs ?? PRICING_TIMEOUT_MS;
        const result = await withTimeout(
          pricingTool.invoke({
            service_code: mcpConfig.serviceCode,
            region: AWS_REGION,
            filters: mcpConfig.filters,
            output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
          }),
          timeoutMs,
        );
        if (result === null) {
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "warn",
            action: LOG_ACTIONS.PRICING_TIMEOUT,
            extras: { resourceType: state.resourceType, timeoutMs },
          });
          return { label: localEstimate, source: localSource };
        }
        const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
        const extracted = extractFirstTierPrice(
          data,
          mcpConfig.unit,
          mcpConfig.scale,
        );
        if (extracted !== null) {
          // Live AWS Pricing API response — authoritative.
          return { label: extracted, source: "mcp" };
        }
        // MCP returned a payload but we couldn't extract a usable price
        // from it (e.g. high-tier-only response, missing tiers). Fall
        // back to the local estimate so the user sees the strategy's
        // human-readable label, not "N/A". Source carries the strategy's
        // own provenance — usually "fallback", but "free" for free-tier
        // resources where the local strategy authoritatively says zero.
        return { label: localEstimate, source: localSource };
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          extras: { resourceType: state.resourceType },
        });
        return { label: localEstimate, source: localSource };
      }
    })(),

    // IAM pre-check
    (async (): Promise<{ passed: boolean; missing: string[] }> => {
      if (!tools || !state.resourceType) return { passed: true, missing: [] };
      const iamTool = tools.find(
        (t) => t.name === ToolName.SIMULATE_PRINCIPAL_POLICY,
      );
      if (!iamTool) return { passed: true, missing: [] };
      try {
        // The real IAM MCP server requires policy_source_arn (the IAM
        // principal whose policies to evaluate). Resolve the operator's
        // caller ARN from the cached STS GetCallerIdentity response.
        // If credentials are missing or STS fails, skip gracefully.
        const callerArn = await getOperatorCallerArn();
        if (!callerArn) {
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "warn",
            action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
            extras: {
              resourceType: state.resourceType,
              reason: "operator_arn_unavailable",
            },
          });
          return { passed: true, missing: [] };
        }
        const requiredActions = getRequiredIamActions(state.resourceType);
        const result = await withTimeout(
          iamTool.invoke({
            policy_source_arn: callerArn,
            action_names: requiredActions,
            resource_arns: ["*"],
          }),
          PRICING_TIMEOUT_MS,
        );
        if (result === null) return { passed: true, missing: [] };
        // The real IAM MCP server wraps the response in { result: {...} }.
        // Unwrap the envelope the same way as WA Security (v0.1.7 pattern).
        const parsed = JSON.parse(unwrapMcpText(result)) as {
          result?: {
            EvaluationResults?: Array<{
              EvalDecision?: string;
              EvalActionName?: string;
            }>;
          };
          EvaluationResults?: Array<{
            EvalDecision?: string;
            EvalActionName?: string;
          }>;
        };
        const simResult = parsed.result ?? parsed;
        const missing = (simResult.EvaluationResults ?? [])
          .filter((r) => r.EvalDecision !== "allowed")
          .map((r) => r.EvalActionName as string);
        return { passed: missing.length === 0, missing };
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.IAM_CHECK_SKIPPED,
          extras: { resourceType: state.resourceType },
        });
        return { passed: true, missing: [] }; // Graceful degradation
      }
    })(),
  ]);

  const pricingResult =
    pricingSettled.status === PromiseStatus.FULFILLED
      ? pricingSettled.value
      : { label: localEstimate, source: localSource };
  const costEstimate = pricingResult.label;
  let costEstimateSource: DataSource = pricingResult.source;

  const iamResult =
    iamSettled.status === PromiseStatus.FULFILLED
      ? iamSettled.value
      : { passed: true, missing: [] as string[] }; // Graceful degradation

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
    extras: {
      parallelFanOutMs: Date.now() - startMs,
      pricingStatus: pricingSettled.status,
      iamStatus: iamSettled.status,
    },
  });

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
    extras: { costEstimate, resourceType: state.resourceType },
  });

  // Story 23.6: Pricing breakdown from decomposers
  let pricingBreakdown: PricingBreakdown | undefined;
  // Tracks decomposers that returned an empty line-item list — a deliberate
  // signal that the resource has no billable components for the given config
  // (e.g. SSM Standard-tier params, ECS clusters with default capacity).
  // Used below as a safety net so the headline shows "Free" instead of "N/A".
  let decomposerReportedFree = false;
  if (defaultDecomposerRegistry.has(state.resourceType)) {
    const lineItems = defaultDecomposerRegistry.decompose(
      state.resourceType,
      desiredState,
    );
    if (lineItems.length === 0) {
      decomposerReportedFree = true;
    } else if (tools) {
      pricingBreakdown = await queryLineItemPrices(
        lineItems,
        tools,
        state.runId,
        state.projectDir,
      );
    }
  }

  // Accumulate per-resource costs for compound provisioning display (Story 8.3)
  let perResourceCosts: Record<string, string> | undefined;
  if (
    state.resourcePattern &&
    state.resourceQueue &&
    state.currentResourceIndex !== undefined &&
    state.currentResourceIndex >= 0 &&
    state.currentResourceIndex < state.resourceQueue.length
  ) {
    const currentResource = state.resourceQueue[state.currentResourceIndex]!; // bounds-checked above
    perResourceCosts = {
      ...(state.perResourceCosts ?? {}),
      [currentResource.resourceId]: costEstimate,
    };
  }

  const iamCheckPassed = iamResult.passed;
  const missingActions = iamResult.missing;

  if (!iamCheckPassed) {
    return {
      executionStatus: ExecutionStatus.FAILED,
      errorMessage: `Insufficient IAM permissions. Missing actions: ${missingActions.join(", ")}. Ask your admin to grant these permissions or use a different profile.`,
    };
  }

  // If the single-line pricing query returned "N/A" but the decomposer
  // produced a valid fixedSubtotal, use the decomposer's total as the headline.
  // Story 46.2: derive the headline source from breakdown provenance —
  // "cached" if any line item was served from disk cache, "mcp" otherwise.
  // Free-tier strategies with source="free" never reach this branch
  // because their localEstimate label is "Free", not "N/A".
  const breakdownSource = (b: PricingBreakdown): DataSource =>
    b.hasCacheHits ? "cached" : "mcp";
  let headlineCost = costEstimate;
  if (
    headlineCost === CostEstimateLabel.NA &&
    pricingBreakdown &&
    pricingBreakdown.fixedSubtotal > 0
  ) {
    headlineCost = `$${pricingBreakdown.fixedSubtotal.toFixed(2)}/mo`;
    costEstimateSource = breakdownSource(pricingBreakdown);
  }

  // If headline is still "N/A" but the breakdown has usage-based items with valid
  // per-unit prices (e.g., S3 storage where fixedSubtotal=0), use the first
  // usage-based unit price as the headline (e.g., "$0.0230/GB-month").
  // Only apply when the breakdown completed without partial failure — if the
  // top-level pricing timed out, we keep "N/A" rather than showing a possibly
  // incomplete per-unit rate.
  if (
    headlineCost === CostEstimateLabel.NA &&
    pricingBreakdown &&
    !pricingBreakdown.hasPartialFailure &&
    pricingBreakdown.usageBasedItems.length > 0
  ) {
    const firstPriced = pricingBreakdown.usageBasedItems.find(
      (item) => item.unitPrice !== null,
    );
    if (firstPriced) {
      headlineCost = firstPriced.displayPrice;
      costEstimateSource = breakdownSource(pricingBreakdown);
    }
  }

  // Safety net: a decomposer that returns an empty line-item list is
  // explicitly declaring "no billable components for this configuration"
  // (e.g. SSM Standard-tier parameters). Without this branch the headline
  // would fall through as N/A — which means "no pricing data available",
  // a different state and a misleading display. Show "Free" instead.
  if (headlineCost === CostEstimateLabel.NA && decomposerReportedFree) {
    headlineCost = CostEstimateLabel.FREE;
    costEstimateSource = "free";
  }

  return {
    estimatedMonthlyCost: headlineCost,
    estimatedMonthlyCostSource: costEstimateSource,
    preflightPassed: !bpBlocked,
    freeTierNote: freeTierNote ?? undefined,
    ...(perResourceCosts !== undefined ? { perResourceCosts } : {}),
    ...(pricingBreakdown !== undefined ? { pricingBreakdown } : {}),
  };
}

/**
 * Query MCP for each pricing line item in parallel (Story 23.6).
 * Uses price cache (Story 23.4) to avoid redundant queries.
 */
async function queryLineItemPrices(
  lineItems: PricingLineItem[],
  tools: StructuredTool[],
  runId: string,
  projectDir?: string,
): Promise<PricingBreakdown> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  const fetchedAt = new Date().toISOString().split("T")[0]!;
  let hasPartialFailure = false;
  // Story 46.2: track whether any line item was served from cache so the
  // headline-cost rewrite can pick "cached" vs "mcp" honestly.
  let hasCacheHits = false;

  const results: PricingLineItemResult[] = await Promise.all(
    lineItems.map(async (item): Promise<PricingLineItemResult> => {
      if (!pricingTool) {
        hasPartialFailure = true;
        return {
          lineItem: item,
          unitPrice: null,
          monthlyCost: null,
          displayPrice: "unavailable",
        };
      }

      // Check cache first (Story 23.4)
      const category =
        item.kind === "fixed" && item.priceUnit === "/hr"
          ? "compute"
          : "storage";
      const cached = getCachedPrice(
        item.serviceCode,
        item.filters,
        category,
        projectDir,
      );

      try {
        let data: AwsPricingResponse;

        if (cached) {
          data = cached as AwsPricingResponse;
          hasCacheHits = true;
        } else {
          const timeoutMs = item.timeoutMs ?? PRICING_TIMEOUT_MS;
          const result = await withTimeout(
            pricingTool.invoke({
              service_code: item.serviceCode,
              region: AWS_REGION,
              filters: item.filters,
              output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
            }),
            timeoutMs,
          );

          if (result === null) {
            hasPartialFailure = true;
            return {
              lineItem: item,
              unitPrice: null,
              monthlyCost: null,
              displayPrice: "unavailable",
            };
          }

          data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
          setCachedPrice(item.serviceCode, item.filters, data);
        }

        const priceStr = extractFirstTierPrice(
          data,
          item.priceUnit,
          item.scale,
          item.filters,
        );

        if (!priceStr) {
          log({
            ts: new Date().toISOString(),
            runId: "system",
            level: "warn",
            action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
            extras: {
              priceUnavailable: item.label,
              serviceCode: item.serviceCode,
              responseItems: data.data?.length ?? 0,
            },
          });
          hasPartialFailure = true;
          return {
            lineItem: item,
            unitPrice: null,
            monthlyCost: null,
            displayPrice: "unavailable",
          };
        }

        // Calculate monthly cost for fixed items
        let monthlyCost: number | null = null;
        const rawPrice = parseFloat(priceStr.replace(/^\$/, ""));

        if (item.kind === "fixed" && !isNaN(rawPrice)) {
          if (item.priceUnit === "/hr") {
            monthlyCost = rawPrice * HOURS_PER_MONTH * item.quantity;
          } else if (item.priceUnit.includes("/GB-mo")) {
            monthlyCost = rawPrice * item.quantity;
          } else {
            monthlyCost = rawPrice * item.quantity;
          }
        }

        const displayPrice =
          monthlyCost !== null
            ? `$${monthlyCost.toFixed(2)}/mo`
            : `${priceStr}`;

        return {
          lineItem: item,
          unitPrice: priceStr,
          monthlyCost,
          displayPrice,
        };
      } catch {
        hasPartialFailure = true;
        log({
          ts: new Date().toISOString(),
          runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          extras: { lineItem: item.label, serviceCode: item.serviceCode },
        });
        return {
          lineItem: item,
          unitPrice: null,
          monthlyCost: null,
          displayPrice: "unavailable",
        };
      }
    }),
  );

  const fixedItems = results.filter((r) => r.lineItem.kind === "fixed");
  const usageBasedItems = results.filter(
    (r) => r.lineItem.kind === "usage_based",
  );
  const fixedSubtotal = fixedItems.reduce(
    (sum, r) => sum + (r.monthlyCost ?? 0),
    0,
  );

  return {
    fixedItems,
    usageBasedItems,
    fixedSubtotal,
    fetchedAt,
    hasPartialFailure,
    hasCacheHits,
  };
}
