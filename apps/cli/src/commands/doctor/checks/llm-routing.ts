/**
 * Doctor check #7 — per-node LLM routing table (Story 44.1).
 *
 * Informational only — always `ok` (routing misconfiguration is caught at
 * runtime by `parseModelString`). Returns `null` when no routing config
 * exists so the section is omitted from the report entirely.
 */

import { EnvVar } from "../../../constants/env-vars.js";
import { DEFAULT_MODEL } from "../../../services/llm-adapter.js";
import { loadGlobalConfig } from "../../../config/load-global-config.js";
import { loadUserConfig } from "../../../config/user-config-loader.js";
import type { DoctorSection, DoctorSubCheck } from "../types.js";

export async function checkLlmRouting(): Promise<DoctorSection | null> {
  try {
    const userConfig = await loadUserConfig();
    const resolvedConfig = await loadGlobalConfig(userConfig);
    const llm = resolvedConfig?.llm;
    if (!llm || Object.keys(llm).length === 0) return null;

    const subs: DoctorSubCheck[] = [];
    for (const [callsite, model] of Object.entries(llm)) {
      if (model) {
        subs.push({
          label: callsite.padEnd(24, " "),
          status: "ok",
          detail: model,
        });
      }
    }

    // Show what unmatched callsites will fall back to
    const fallback =
      llm["default"] ??
      process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
      process.env[EnvVar.ASSIGNEE_MODEL] ??
      DEFAULT_MODEL;
    if (!llm["default"]) {
      const source = process.env[EnvVar.ASSIGNEE_LLM_DEFAULT]
        ? "ASSIGNEE_LLM_DEFAULT"
        : process.env[EnvVar.ASSIGNEE_MODEL]
          ? "ASSIGNEE_MODEL (deprecated)"
          : "built-in default";
      subs.push({
        label: "(fallback)".padEnd(24, " "),
        status: "ok",
        detail: `${fallback} (from ${source})`,
      });
    }

    return {
      name: `LLM routing (${Object.keys(llm).length} callsite${Object.keys(llm).length === 1 ? "" : "s"})`,
      status: "ok",
      subs,
    };
  } catch {
    return null;
  }
}
