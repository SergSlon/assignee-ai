/**
 * Aggregated INTENT_RULES — composed from per-resource-type rule modules.
 *
 * Intra-resource-type ordering matters (first-match-per-field wins), so each
 * per-type file preserves its original ordering from the pre-decomposition
 * monolith. Inter-type ordering is irrelevant because getIntentDefaults
 * filters by resourceType before applying rules.
 */

import type { IntentRule } from "./types.js";
import { EC2_RULES } from "./rules-ec2.js";
import { S3_RULES } from "./rules-s3.js";
import { LAMBDA_RULES } from "./rules-lambda.js";
import { RDS_RULES } from "./rules-rds.js";
import { MISC_RULES } from "./rules-misc.js";

/** Full keyword → override ruleset. Exported for matrix tests (read-only usage). */
export const INTENT_RULES: IntentRule[] = [
  ...EC2_RULES,
  ...S3_RULES,
  ...LAMBDA_RULES,
  ...RDS_RULES,
  ...MISC_RULES,
];
