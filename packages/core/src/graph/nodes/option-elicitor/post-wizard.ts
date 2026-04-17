/**
 * Post-wizard hooks: recommendations + coherence validation + logging.
 *
 * Story 10.7: post-wizard recommendations surface "you probably also want
 * to enable X" hints after the user has answered all questions.
 * Story 41.5: coherence validation flags contradictions like "HA requested
 *   but single-AZ" that otherwise ship silently.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import * as clack from "@clack/prompts";
import {
  evaluateWizardRecommendations,
  displayRecommendations,
} from "../../../utils/wizard-recommendations.js";
import { validateCoherence } from "../../../utils/coherence-validator.js";
import { log, LOG_ACTIONS } from "../../../utils/logger/index.js";

export function runPostWizardHooks(params: {
  elicitedOptions: Record<string, unknown>;
  userIntent: string | undefined;
  resourceType: string;
  runId: string | undefined;
}): void {
  const { elicitedOptions, userIntent, resourceType, runId } = params;

  const recommendations = evaluateWizardRecommendations(
    elicitedOptions,
    userIntent ?? "",
    resourceType,
  );
  displayRecommendations(recommendations);

  const coherenceWarnings = validateCoherence(
    elicitedOptions,
    userIntent ?? "",
    resourceType,
  );
  if (coherenceWarnings.length > 0) {
    for (const w of coherenceWarnings) {
      clack.log.warn(w.message);
    }
  }

  log({
    ts: new Date().toISOString(),
    runId: runId ?? "",
    level: "info",
    action: LOG_ACTIONS.OPTION_ELICITED,
    extras: {
      resourceType,
      elicitedKeys: Object.keys(elicitedOptions),
      elicitedValues: Object.fromEntries(
        Object.entries(elicitedOptions).map(([k, v]) => [
          k,
          typeof v === "object" ? "[object]" : String(v),
        ]),
      ),
    },
  });
}
