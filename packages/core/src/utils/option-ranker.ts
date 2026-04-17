/**
 * Option Ranking and Filtering Engine (Story 21.2).
 *
 * Ranks and filters AWS options based on a workload profile, returning the
 * top N most relevant options with the rest as overflow (for "Show all..." UX).
 *
 * Pure utility — no LLM calls, no AWS calls, no UI.
 * Scoring is keyword-based: each option's value/label is matched against
 * profile-specific keywords to produce a relevance score.
 */

import {
  InstanceCategory,
  type InstanceCategoryType,
} from "../constants/instance-categories.js";
import { WorkloadProfileKey as WP } from "../config/cfn-keys.js";

/** Workload profile type — matches workload-classifier output (Story 21.1). */
export type WorkloadProfile = InstanceCategoryType | typeof WP.UNKNOWN;

/** Result of ranking options for a given workload profile. */
export interface RankedResult {
  /** Top options to show immediately. */
  visible: Array<{ value: string; label: string }>;
  /** Remaining options hidden behind "Show all..." escape hatch. */
  overflow: Array<{ value: string; label: string }>;
  /** The workload profile used for ranking. */
  profile: WorkloadProfile;
  /** Whether ranking was actually applied (false for "unknown" profile). */
  filtered: boolean;
}

/** Keywords that boost an option's score for each workload profile. */
const PROFILE_KEYWORDS: Record<WorkloadProfile, string[]> = {
  [InstanceCategory.BURSTABLE]: ["t3", "t4g", "burst", "micro", "small", "dev"],
  [InstanceCategory.GENERAL_PURPOSE]: [
    "m5",
    "m6i",
    "m7i",
    "general",
    "balanced",
  ],
  [InstanceCategory.COMPUTE_HEAVY]: ["c5", "c6i", "c7i", "compute", "batch"],
  [InstanceCategory.MEMORY_INTENSIVE]: [
    "r5",
    "r6g",
    "r7g",
    "x2",
    "memory",
    "cache",
    "analytics",
  ],
  [InstanceCategory.GPU_ACCELERATED]: [
    "p3",
    "p4",
    "p5",
    "g4",
    "g5",
    "g6",
    "inf",
    "gpu",
    "ml",
  ],
  [InstanceCategory.STORAGE_HEAVY]: ["d3", "i3", "i4", "h1", "storage"],
  [InstanceCategory.HPC]: ["hpc6a", "hpc7a", "hpc7g", "hpc", "simulation"],
  [WP.UNKNOWN]: [],
};

/** Score bonus for options marked as recommended. */
const RECOMMENDED_BONUS = 10;

/** Points per keyword match. */
const KEYWORD_MATCH_SCORE = 5;

/**
 * Scores a single option against a workload profile's keywords.
 * Checks both value and label (case-insensitive) for keyword matches.
 */
function scoreOption(
  option: { value: string; label: string; recommended?: boolean },
  keywords: string[],
): number {
  let score = 0;
  const haystack = `${option.value} ${option.label}`.toLowerCase();

  for (const keyword of keywords) {
    if (haystack.includes(keyword.toLowerCase())) {
      score += KEYWORD_MATCH_SCORE;
    }
  }

  if (option.recommended) {
    score += RECOMMENDED_BONUS;
  }

  return score;
}

/**
 * Ranks and filters options based on a workload profile.
 *
 * @param options     - The full list of options to rank
 * @param profile     - The detected workload profile
 * @param maxVisible  - Maximum number of options to show (default 8)
 * @returns RankedResult with visible/overflow split
 */
export function rankOptions(
  options: ReadonlyArray<
    { value: string; label: string } & Record<string, unknown>
  >,
  profile: WorkloadProfile,
  maxVisible: number = 8,
): RankedResult {
  // "unknown" profile: return all options unfiltered
  if (profile === WP.UNKNOWN) {
    return {
      visible: options.map(({ value, label }) => ({ value, label })),
      overflow: [],
      profile,
      filtered: false,
    };
  }

  const keywords = PROFILE_KEYWORDS[profile];

  // Score and sort
  const scored = options.map((opt) => ({
    value: opt.value,
    label: opt.label,
    score: scoreOption(
      {
        value: opt.value,
        label: opt.label,
        recommended: opt["recommended"] as boolean | undefined,
      },
      keywords,
    ),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.value.localeCompare(b.value);
  });

  const visible = scored
    .slice(0, maxVisible)
    .map(({ value, label }) => ({ value, label }));
  const overflow = scored
    .slice(maxVisible)
    .map(({ value, label }) => ({ value, label }));

  return {
    visible,
    overflow,
    profile,
    filtered: true,
  };
}

export { PROFILE_KEYWORDS, RECOMMENDED_BONUS, KEYWORD_MATCH_SCORE };
