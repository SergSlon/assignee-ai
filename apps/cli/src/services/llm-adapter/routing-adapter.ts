/**
 * RoutingLlmAdapter — per-callsite LlmAdapter routing (Story 44.1).
 *
 * Extracted from llm-adapter.ts (Wave 6d F5). Preserves feedback_token_cost_visibility
 * by passing callsite through to the underlying LlmAdapter which records token usage.
 */
import type { ZodSchema } from "zod";
import type { LlmError } from "@assignee/core";
import type { LlmPort, LlmCallOptions, Result } from "@assignee/core";
import { EnvVar } from "../../constants/env-vars.js";
import { DEFAULT_MODEL } from "./model-parser.js";
import { LlmAdapter, type LlmAdapterConfig } from "./adapter.js";

/**
 * Routing adapter that delegates to per-callsite LlmAdapter instances.
 * Each unique model string shares a single adapter (lazy cache).
 *
 * When no routing config key matches the call's callsite, falls back to
 * "default" → ASSIGNEE_LLM_DEFAULT env var → ASSIGNEE_MODEL (deprecated)
 * → DEFAULT_MODEL constant, preserving full backward compatibility.
 */
export class RoutingLlmAdapter implements LlmPort {
  private readonly routingConfig: Readonly<Record<string, string>>;
  private readonly adapterCache = new Map<string, LlmAdapter>();
  private readonly baseConfig: Omit<LlmAdapterConfig, "modelString">;

  constructor(
    routingConfig: Record<string, string | undefined>,
    baseConfig: Omit<LlmAdapterConfig, "modelString"> = {},
  ) {
    // Strip undefined values so lookups are clean string-only.
    const clean: Record<string, string> = {};
    for (const [k, v] of Object.entries(routingConfig)) {
      if (v !== undefined) clean[k] = v;
    }
    this.routingConfig = clean;
    this.baseConfig = baseConfig;
  }

  /** Resolve the adapter for a given callsite, lazily creating if needed. */
  private getAdapter(callsite?: string): LlmAdapter {
    const modelString =
      (callsite ? this.routingConfig[callsite] : undefined) ??
      this.routingConfig["default"] ??
      process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
      process.env[EnvVar.ASSIGNEE_MODEL] ?? // deprecated fallback
      DEFAULT_MODEL;

    let adapter = this.adapterCache.get(modelString);
    if (!adapter) {
      adapter = new LlmAdapter({ ...this.baseConfig, modelString });
      this.adapterCache.set(modelString, adapter);
    }
    return adapter;
  }

  async generateStructured<T>(
    prompt: string,
    schema: ZodSchema<T>,
    options?: LlmCallOptions,
  ): Promise<Result<T, LlmError>> {
    return this.getAdapter(options?.callsite).generateStructured(
      prompt,
      schema,
      options,
    );
  }

  async generateText(
    prompt: string,
    options?: LlmCallOptions,
  ): Promise<Result<string, LlmError>> {
    return this.getAdapter(options?.callsite).generateText(prompt, options);
  }
}
