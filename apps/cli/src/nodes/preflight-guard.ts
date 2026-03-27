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
  defaultPricingRegistry,
  defaultDecomposerRegistry,
  extractFirstTierPrice,
  type AwsPricingResponse,
  type PricingLineItem,
  type PricingLineItemResult,
  type PricingBreakdown,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION, PRICING_TIMEOUT_MS, HOURS_PER_MONTH } from "../config/constants.js";
import { CostEstimate, PricingTerm } from "../constants/pricing.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { withTimeout } from "../utils/timeout.js";
import { getFreeTierNote, loadAccountCreatedDate } from "../utils/free-tier.js";
import { getRequiredIamActions } from "@assignee/core";
import { getCachedPrice, setCachedPrice } from "../services/price-cache.js";
import type { AgentState } from "../services/graph.js";

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

  const mcpConfig = defaultPricingRegistry.getMcpConfig(
    state.resourceType,
    desiredState,
  );
  const localEstimate = defaultPricingRegistry.estimate(
    state.resourceType,
    desiredState,
  ).label;

  // Story 18.10: Blocking BP findings (replaces old guardrail engine + CRITICAL BP check)
  // BP evaluation is synchronous (<1ms) — run before the parallel block.
  // Story E2E.4: In noWizard/MCP mode, BP blocking is advisory only — the confirmed gate
  // in apply_plan serves as the safety mechanism. The fix_applicator has already had
  // its chance to auto-fix. Blocking here prevents MCP provisioning for common BPs
  // like ECR scan-on-push, CloudWatch alarm actions, etc.
  const bpFindings = state.bpFindings ?? [];
  const blockingFindings = bpFindings.filter((f) => f.blocking);
  let bpBlocked = false;
  if (blockingFindings.length > 0 && !state.noWizard && !state.autoApprove) {
    bpBlocked = true;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        blocked: true,
        blockingCount: blockingFindings.length,
        practiceIds: blockingFindings.map((f) => f.practiceId),
      },
    });
  } else if (
    blockingFindings.length > 0 &&
    (state.noWizard || state.autoApprove)
  ) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "warn",
      action: LOG_ACTIONS.BP_EVALUATED,
      extras: {
        blockedSkipped: true,
        reason: "noWizard mode — BP blocking is advisory only",
        blockingCount: blockingFindings.length,
        practiceIds: blockingFindings.map((f) => f.practiceId),
      },
    });
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
  } catch {
    // Non-blocking: free tier detection failure must never prevent plan/apply
    freeTierNote = undefined;
  }

  // Story 9.10: Parallel fan-out — pricing query and IAM pre-check run concurrently.
  // Uses Promise.allSettled so one failure doesn't cancel the other.
  const startMs = Date.now();
  const [pricingSettled, iamSettled] = await Promise.allSettled([
    // Pricing query
    (async (): Promise<string> => {
      if (!mcpConfig || !tools) return localEstimate;
      const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
      if (!pricingTool) return localEstimate;
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
          return localEstimate;
        }
        const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
        return (
          extractFirstTierPrice(data, mcpConfig.unit, mcpConfig.scale) ??
          CostEstimate.NA
        );
      } catch {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          extras: { resourceType: state.resourceType },
        });
        return localEstimate;
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
        const requiredActions = getRequiredIamActions(state.resourceType);
        const result = await withTimeout(
          iamTool.invoke({
            action_names: requiredActions,
            resource_arns: ["*"],
          }),
          PRICING_TIMEOUT_MS,
        );
        if (result === null) return { passed: true, missing: [] };
        const simResult = JSON.parse(unwrapMcpText(result));
        const missing = (simResult.EvaluationResults ?? [])
          .filter((r: any) => r.EvalDecision !== "allowed")
          .map((r: any) => r.EvalActionName as string);
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

  const costEstimate =
    pricingSettled.status === "fulfilled"
      ? pricingSettled.value
      : localEstimate;

  const iamResult =
    iamSettled.status === "fulfilled"
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
  if (defaultDecomposerRegistry.has(state.resourceType) && tools) {
    const lineItems = defaultDecomposerRegistry.decompose(
      state.resourceType,
      desiredState,
    );
    if (lineItems.length > 0) {
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
  let headlineCost = costEstimate;
  if (
    headlineCost === CostEstimate.NA &&
    pricingBreakdown &&
    pricingBreakdown.fixedSubtotal > 0
  ) {
    headlineCost = `$${pricingBreakdown.fixedSubtotal.toFixed(2)}/mo`;
  }

  return {
    estimatedMonthlyCost: headlineCost,
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
  };
}
