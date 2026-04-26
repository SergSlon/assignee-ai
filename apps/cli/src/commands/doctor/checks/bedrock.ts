/**
 * Doctor check #2 — LLM / Bedrock reachability.
 *
 * Sends a tiny "hello" prompt via `LlmAdapter` so doctor honours the
 * same env vars (`ASSIGNEE_LLM_DEFAULT` / deprecated `ASSIGNEE_MODEL`,
 * guardrails) as the rest of the CLI — no separate code path that could
 * mask provider misconfiguration.
 */

import { tryAssigneeCredentials } from "@assignee/core";
import { EnvVar } from "../../../constants/env-vars.js";
import { AWS_REGION } from "../../../config/constants.js";
import { LlmAdapter, DEFAULT_MODEL } from "@assignee/core/llm";
import { DEFAULT_CHECK_TIMEOUT_MS } from "../types.js";
import type { DoctorSection, DoctorSubCheck } from "../types.js";
import { rollup, withTimeout } from "../util.js";

export interface BedrockCheckDeps {
  /** Override the LLM adapter used for the check (test injection). */
  llmFactory?: () => {
    generateText: (
      prompt: string,
      options?: { maxTokens?: number },
    ) => Promise<readonly [Error | null, string | null]>;
  };
  timeoutMs?: number;
}

/**
 * Build the header name for the Bedrock section. Tier S #2: header
 * reflects the ACTUAL model that will be used, not the BEDROCK_MODEL_ID
 * default.
 */
function buildBedrockName(
  modelString: string,
  guardrailId: string | undefined,
  guardrailVersion: string | undefined,
): string {
  const modelLabel = modelString.replace(/^bedrock\//, "");
  const guardrail = guardrailId
    ? `, guardrail ${guardrailId}:${guardrailVersion ?? "1"}`
    : "";
  return `Bedrock (${AWS_REGION}, model ${modelLabel}${guardrail})`;
}

export async function checkBedrock(
  deps: BedrockCheckDeps = {},
): Promise<DoctorSection> {
  const subs: DoctorSubCheck[] = [];
  const modelString =
    process.env[EnvVar.ASSIGNEE_LLM_DEFAULT] ??
    // Back-compat: read legacy ASSIGNEE_MODEL env var (deprecated alias).
    process.env["ASSIGNEE_MODEL"] ??
    DEFAULT_MODEL;
  const guardrailId = process.env[EnvVar.BEDROCK_GUARDRAIL_ID];
  const guardrailVersion = process.env[EnvVar.BEDROCK_GUARDRAIL_VERSION];
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS;

  const adapter =
    deps.llmFactory?.() ??
    new LlmAdapter({
      modelString,
      ...(guardrailId ? { guardrailId } : {}),
      ...(guardrailVersion ? { guardrailVersion } : {}),
    });

  // Operator credentials are required for the bedrock provider; if they
  // are not set, we cannot do the live invoke. Skip gating when an
  // llmFactory is injected (tests provide an adapter that doesn't touch AWS).
  const wantsBedrock = modelString.startsWith("bedrock/");
  if (!deps.llmFactory && wantsBedrock && !tryAssigneeCredentials("operator")) {
    subs.push({
      label: `LLM (${modelString})`,
      status: "fail",
      detail: `operator credentials required for bedrock provider`,
    });
    return {
      name: buildBedrockName(modelString, guardrailId, guardrailVersion),
      status: "fail",
      subs,
    };
  }

  try {
    const [err, text] = await withTimeout(
      adapter.generateText("hello", { maxTokens: 16 }),
      timeoutMs,
      "LLM invoke",
    );
    if (err) {
      subs.push({
        label: `LLM (${modelString})`,
        status: "fail",
        detail: err.message,
      });
    } else if (!text || text.trim().length === 0) {
      subs.push({
        label: `LLM (${modelString})`,
        status: "warn",
        detail: "empty response (model is reachable but returned no text)",
      });
    } else {
      subs.push({
        label: `LLM (${modelString})`,
        status: "ok",
        detail: `responded (${text.trim().slice(0, 40).replace(/\s+/g, " ")}…)`,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    subs.push({
      label: `LLM (${modelString})`,
      status: "fail",
      detail: msg,
    });
  }

  if (guardrailId) {
    subs.push({
      label: "Guardrail",
      status: "ok",
      detail: `${guardrailId}:${guardrailVersion ?? "1"} (configured)`,
    });
  } else if (wantsBedrock) {
    // P018 (acquisition-DD L5 Aiko L5.3 S12): HIGH-severity finding when
    // Bedrock is active and no Guardrail is configured.
    // Skip this finding if the operator has explicitly opted out with
    // BEDROCK_GUARDRAIL_DISABLE=1 — treat as informed acceptance.
    const guardrailDisabled = process.env[EnvVar.BEDROCK_GUARDRAIL_DISABLE];
    const isDisabled =
      guardrailDisabled === "1" || guardrailDisabled === "true";
    if (!isDisabled) {
      subs.push({
        label: "Guardrail [HIGH]",
        status: "warn",
        detail:
          "No Bedrock Guardrail configured. A Guardrail is a runtime content " +
          "policy that blocks PII leakage, harmful topics, and jailbreak " +
          "responses from reaching your infrastructure automation. Without " +
          "one, LLM-generated content is unfiltered.\n" +
          "  • To enable: set BEDROCK_GUARDRAIL_ID=<id> and " +
          "BEDROCK_GUARDRAIL_VERSION=<version> (or 1).\n" +
          "  • To create a guardrail: " +
          "aws bedrock create-guardrail --name assignee-guardrail " +
          "--blocked-input-messaging 'Blocked by policy' " +
          "--blocked-outputs-messaging 'Blocked by policy'\n" +
          "  • To suppress this warning (not recommended): " +
          "set BEDROCK_GUARDRAIL_DISABLE=1.",
      });
    } else {
      subs.push({
        label: "Guardrail",
        status: "ok",
        detail:
          "not configured — BEDROCK_GUARDRAIL_DISABLE=1 set (operator accepted risk)",
      });
    }
  }

  return {
    name: buildBedrockName(modelString, guardrailId, guardrailVersion),
    status: rollup(subs),
    subs,
  };
}
