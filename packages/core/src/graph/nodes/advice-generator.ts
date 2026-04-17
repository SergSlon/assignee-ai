/**
 * advice_generator node — generates inline contextual advice hints for the plan review.
 * Runs between plan_generator and bp_evaluator. Non-blocking: LLM failures
 * produce an empty hints array, never a pipeline failure.
 *
 * @see Story 40.1 — Advice-Lite: Inline Contextual Intelligence
 */

import type { LlmPort } from "../../index.js";
import type { StructuredTool } from "@langchain/core/tools";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import type { AgentState } from "../graph-state.js";
import { costAlternatives } from "./advice/cost-advisor/orchestrator.js";
import { securityPosture } from "./advice/security-advisor.js";
import { architectureAdvisor } from "./advice/architecture-advisor.js";
import {
  gatherMcpAdviceContext,
  type McpAdviceContext,
} from "./advice/mcp-advisor.js";
import { MAX_ADVICE_HINTS, ADVICE_LLM_MAX_TOKENS } from "./advice/constants.js";
import { enrichAdvisoryPrices } from "../../services/advisory-price-enricher/index.js";

/**
 * Factory for the advice_generator LangGraph node.
 * Accepts llmClient via injection — same pattern as plan_generator and intent_parser.
 * Tools are passed at invocation time (same pattern as preflight_guard).
 */
export function createAdviceGeneratorNode({
  llmClient,
}: {
  llmClient: LlmPort;
}) {
  return async function adviceGeneratorNode(
    state: AgentState,
    tools?: StructuredTool[],
  ): Promise<Partial<AgentState>> {
    // Skip if --no-advice flag is set
    if (state.noAdvice) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.ADVICE_SKIPPED,
        extras: { reason: "noAdvice flag" },
      });
      return { adviceHints: [] };
    }

    // Skip for companion resources in compound mode (only advise on primary)
    if (
      state.resourcePattern &&
      state.currentResourceIndex !== undefined &&
      state.currentResourceIndex > 0
    ) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.ADVICE_SKIPPED,
        extras: {
          reason: "companion resource",
          index: state.currentResourceIndex,
        },
      });
      return { adviceHints: [] };
    }

    // Skip if no desiredState to analyze
    if (!state.desiredState || Object.keys(state.desiredState).length === 0) {
      return { adviceHints: [] };
    }

    const startedAt = Date.now();
    const hints: string[] = [];
    const ds = state.desiredState!;

    // Phase 1: Run rule-based advisors AND MCP-backed enrichers in
    // parallel. The advisory price enricher (Story 46.3) fetches live
    // rates for the fixed-price constants used by `costAlternatives`,
    // and `gatherMcpAdviceContext` pulls additional context for the LLM
    // phase. Both are non-blocking — Promise.allSettled isolates per-
    // task failure so one MCP timeout never poisons the rest.
    let mcpContext: McpAdviceContext = {};
    // enrichAdvisoryPrices is built to NEVER throw — every error path
    // resolves to a fulfilled all-fallback map. We still wrap it in
    // Promise.allSettled so a future regression that breaks that
    // contract doesn't poison the parallel block. The `rejected` branch
    // is intentionally minimal — fall back to an empty map and let
    // cost-advisor's `enrichedLabel` helper synthesize "(estimated)"
    // labels per-ID. We do NOT re-invoke the enricher (Edge Hunter F8).
    const [enrichedSettled, mcpContextSettled] = await Promise.allSettled([
      enrichAdvisoryPrices(tools, state.runId),
      tools && tools.length > 0
        ? gatherMcpAdviceContext(state.resourceType, ds, tools)
        : Promise.resolve<McpAdviceContext>({}),
    ]);
    const enrichedPrices =
      enrichedSettled.status === "fulfilled"
        ? enrichedSettled.value
        : new Map();
    if (mcpContextSettled.status === "fulfilled") {
      mcpContext = mcpContextSettled.value;
    }

    // Rule-based advisors run sync after the parallel block has resolved.
    // costAlternatives reads `enrichedPrices` so its hints carry the
    // live "(live)" suffix when the MCP path succeeded.
    hints.push(...securityPosture(state.resourceType, ds, state.userIntent));
    hints.push(...costAlternatives(state.resourceType, ds, enrichedPrices));
    hints.push(
      ...architectureAdvisor(state.resourcePattern, state.resourceQueue),
    );

    // Phase 3: LLM-generated hints enriched with MCP data (if rule-based didn't produce enough)
    if (hints.length < MAX_ADVICE_HINTS) {
      try {
        const prompt = buildAdvicePrompt(state, mcpContext);
        const [err, text] = await llmClient.generateText(prompt, {
          maxTokens: ADVICE_LLM_MAX_TOKENS,
          callsite: "advice_generator",
          runId: state.runId,
        });

        if (!err && text) {
          const llmHints = parseHints(text);
          // Deduplicate: skip LLM hints that overlap with rule-based ones
          for (const llmHint of llmHints) {
            if (hints.length >= MAX_ADVICE_HINTS) break;
            hints.push(llmHint);
          }
        }
      } catch {
        // LLM failure is non-blocking — rule-based hints are still returned
      }
    }

    const finalHints = hints.slice(0, MAX_ADVICE_HINTS);

    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.ADVICE_GENERATED,
      durationMs: Date.now() - startedAt,
      extras: {
        resourceType: state.resourceType,
        hintCount: finalHints.length,
        ruleBasedCount: hints.length,
      },
    });

    return { adviceHints: finalHints };
  };
}

function buildAdvicePrompt(
  state: AgentState,
  mcpContext: McpAdviceContext = {},
): string {
  const stateKeys = Object.keys(state.desiredState ?? {}).join(", ");
  const costLine = state.estimatedMonthlyCost
    ? `Estimated cost: ${state.estimatedMonthlyCost}/month.`
    : "";

  // Build MCP context section if any data is available
  const mcpSections: string[] = [];
  if (mcpContext.pricingSnippet) {
    mcpSections.push(`LIVE PRICING DATA:\n${mcpContext.pricingSnippet}`);
  }
  if (mcpContext.docSnippet) {
    mcpSections.push(
      `AWS DOCUMENTATION (current best practices):\n${mcpContext.docSnippet}`,
    );
  }
  if (mcpContext.securitySnippet) {
    mcpSections.push(
      `SECURITY POSTURE ANALYSIS:\n${mcpContext.securitySnippet}`,
    );
  }
  const mcpBlock =
    mcpSections.length > 0
      ? `\n\nREAL-TIME AWS DATA (use this to give specific, current advice):\n${mcpSections.join("\n\n")}`
      : "";

  return `You are an AWS cloud advisor. A user is about to provision this resource:

Resource type: ${state.resourceType}
User intent: "${state.userIntent}"
Configuration keys: ${stateKeys}
${costLine}${mcpBlock}

Provide 3-5 short, actionable tips about cost optimization, security best practices, and architecture improvements. Each tip must be a single sentence. Focus on the most impactful advice for this specific resource type and configuration. When real-time data is provided above, use it for specific numbers and recommendations.

Return ONLY a JSON array of strings, e.g.: ["Tip 1", "Tip 2", "Tip 3"]`;
}

function parseHints(text: string): string[] {
  try {
    // Try to extract JSON array from the response
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return [];

    const parsed: unknown = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (item): item is string => typeof item === "string" && item.length > 0,
      )
      .slice(0, MAX_ADVICE_HINTS);
  } catch {
    return [];
  }
}
