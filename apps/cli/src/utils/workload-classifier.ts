/**
 * LLM-based workload profile classification.
 * Categorizes a user's infrastructure intent into a workload type,
 * enabling smart option filtering for large option sets (Story 21.2).
 *
 * @see Story 21.1
 */

import { z } from "zod";
import type { LlmPort } from "@assignee/core";
import {
  InstanceCategory,
  type InstanceCategoryType,
} from "../constants/instance-categories.js";

export type WorkloadProfile = InstanceCategoryType | "unknown";

export const WorkloadProfileSchema = z.object({
  profile: z.enum([
    InstanceCategory.BURSTABLE,
    InstanceCategory.GENERAL_PURPOSE,
    InstanceCategory.COMPUTE_HEAVY,
    InstanceCategory.MEMORY_INTENSIVE,
    InstanceCategory.GPU_ACCELERATED,
    InstanceCategory.STORAGE_HEAVY,
    "unknown",
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
  if (!trimmed) return "unknown";

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
    '- "unknown": no clear signal',
    "",
    `Intent: "${trimmed}"`,
  ].join("\n");

  try {
    const [err, result] = await llmClient.generateStructured(
      prompt,
      WorkloadProfileSchema,
      { maxTokens: 128 },
    );

    if (err || !result) {
      classificationCache.set(trimmed, "unknown");
      return "unknown";
    }

    const profile: WorkloadProfile =
      result.confidence < 0.5 ? "unknown" : result.profile;

    classificationCache.set(trimmed, profile);
    return profile;
  } catch {
    classificationCache.set(trimmed, "unknown");
    return "unknown";
  }
}

/**
 * Clear the classification cache. Exposed for testing only.
 * @internal
 */
export function _clearClassificationCache(): void {
  classificationCache.clear();
}
