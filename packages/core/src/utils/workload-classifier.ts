/**
 * LLM-based workload profile classification.
 * Categorizes a user's infrastructure intent into a workload type,
 * enabling smart option filtering for large option sets (Story 21.2).
 *
 * @see Story 21.1
 */

import { z } from "zod";
import type { LlmPort } from "../ports/llm-port.js";
import {
  InstanceCategory,
  type InstanceCategoryType,
} from "../constants/instance-categories.js";
import { WorkloadProfileKey as WP } from "../config/cfn-keys.js";

export type WorkloadProfile = InstanceCategoryType | typeof WP.UNKNOWN;

export const WorkloadProfileSchema = z.object({
  profile: z.enum([
    InstanceCategory.BURSTABLE,
    InstanceCategory.GENERAL_PURPOSE,
    InstanceCategory.COMPUTE_HEAVY,
    InstanceCategory.MEMORY_INTENSIVE,
    InstanceCategory.GPU_ACCELERATED,
    InstanceCategory.STORAGE_HEAVY,
    WP.UNKNOWN,
  ]),
  confidence: z.number().min(0).max(1),
});

export type WorkloadClassification = z.infer<typeof WorkloadProfileSchema>;

/** Session-scoped cache: same intent string returns the same result without re-calling LLM. */
const classificationCache = new Map<string, WorkloadProfile>();

/**
 * Classify a user's AWS infrastructure intent into a workload profile using an LLM.
 *
 * - Uses `llmClient.generateStructured()` with a Zod schema
 * - Returns "unknown" if the LLM fails or confidence < 0.5
 * - Caches results per session (same intent = same result)
 *
 * @param userIntent - The user's natural-language infrastructure request
 * @param llmClient  - LLM port for structured generation
 * @returns The classified workload profile
 */
export async function classifyWorkload(
  userIntent: string,
  llmClient: LlmPort,
): Promise<WorkloadProfile> {
  const trimmed = userIntent.trim();
  if (!trimmed) return WP.UNKNOWN;

  // Check cache first
  const cached = classificationCache.get(trimmed);
  if (cached !== undefined) return cached;

  const prompt = [
    "Classify this AWS infrastructure intent into a workload profile.",
    "",
    "Profiles:",
    '- "burstable": dev/test, small apps, intermittent traffic',
    '- "general-purpose": balanced web apps, mid-size APIs',
    '- "compute-heavy": batch processing, CI/CD, encoding',
    '- "memory-intensive": caches, analytics, in-memory databases',
    '- "gpu-accelerated": ML training, inference, rendering',
    '- "storage-heavy": data lakes, backups, archival',
    `- "${WP.UNKNOWN}": no clear signal`,
    "",
    `Intent: "${trimmed}"`,
  ].join("\n");

  try {
    const [err, result] = await llmClient.generateStructured(
      prompt,
      WorkloadProfileSchema,
      { maxTokens: 128, callsite: "workload_classifier" },
    );

    if (err || !result) {
      classificationCache.set(trimmed, WP.UNKNOWN);
      return WP.UNKNOWN;
    }

    const profile: WorkloadProfile =
      result.confidence < 0.5 ? WP.UNKNOWN : result.profile;

    classificationCache.set(trimmed, profile);
    return profile;
  } catch {
    classificationCache.set(trimmed, WP.UNKNOWN);
    return WP.UNKNOWN;
  }
}

/**
 * Clear the classification cache. Exposed for testing only.
 * @internal
 */
export function _clearClassificationCache(): void {
  classificationCache.clear();
}
