/**
 * Intent-aware smart defaults for the option elicitor.
 *
 * Maps keyword patterns in the user's intent string to field default overrides.
 * Uses simple case-insensitive substring matching — no LLM calls required.
 * First matching rule per field wins (no conflicting overrides).
 *
 * @see Story 10.5
 *
 * This file is a thin facade over the decomposed module at
 * ./intent-defaults/. Rules are grouped by resource type into separate
 * files (rules-ec2, rules-s3, rules-lambda, rules-rds, rules-misc) and
 * aggregated in ./intent-defaults/registry.ts.
 *
 * Epic 92 wave 2 (e92.2.a): the facade wraps
 * `getIntentDefaults` with a user-assertion guard. When the user has
 * asserted a value in natural language — `"t3.micro web server"`,
 * `"10.42.0.0/16 VPC"`, `"postgres 16.3"` — the defaults engine must
 * not rewrite that field. Detection reuses the validator family
 * exported by the intent-parser so the parser and the defaults engine
 * agree on what counts as an assertion.
 */

import {
  getIntentDefaults as getIntentDefaultsRaw,
  applyIntentOverrides,
  INTENT_RULES,
} from "./intent-defaults/index.js";
import type {
  IntentDefaultOverride,
  IntentRule,
} from "./intent-defaults/index.js";
import { CfnKey } from "../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../config/resource-types/index.js";
import {
  isValidCidr,
  isValidInstanceType,
  isValidEngineVersion,
  isValidAmiId,
} from "../graph/nodes/intent-parser.js";

export type { IntentDefaultOverride, IntentRule };
export { INTENT_RULES, applyIntentOverrides };

/**
 * Returns field overrides for the given intent + resource type.
 *
 * Overrides whose `fieldName` matches a user-asserted token in the
 * intent string are suppressed — the user's explicit value wins. This
 * prevents the regressions captured by Epic 92 findings B-01, C-12,
 * and C-13 (silent rewrites of CIDR / InstanceType / EngineVersion).
 */
export function getIntentDefaults(
  userIntent: string,
  resourceType: string,
): IntentDefaultOverride[] {
  const raw = getIntentDefaultsRaw(userIntent, resourceType);
  if (raw.length === 0) return raw;
  const asserted = detectAssertedFields(userIntent, resourceType);
  if (asserted.size === 0) return raw;
  return raw.filter((o) => !asserted.has(o.fieldName));
}

/**
 * Detects which CFN fields the user has asserted in natural language.
 *
 * Conservative by design: a field is only marked asserted when the
 * corresponding validator (from intent-parser) accepts the token. An
 * adversarial token like `t99.huge` is NOT marked asserted here — the
 * intent-parser surfaces that as a plan failure, so the defaults
 * engine never sees it. When the parser runs first and fails the plan,
 * this helper is never reached with an invalid token.
 */
export function detectAssertedFields(
  userIntent: string,
  resourceType: string,
): Set<string> {
  const asserted = new Set<string>();
  if (!userIntent) return asserted;

  // CIDR → CidrBlock for network resources.
  const cidrMatch = /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}\b/.exec(
    userIntent,
  );
  if (
    cidrMatch &&
    isValidCidr(
      cidrMatch[0],
      resourceType === RESOURCE_TYPES.EC2_VPC ||
        resourceType === RESOURCE_TYPES.EC2_SUBNET ||
        resourceType === RESOURCE_TYPES.EC2_ROUTE
        ? "vpc"
        : "source",
    )
  ) {
    asserted.add(CfnKey.CIDR_BLOCK);
  }

  // InstanceType — only meaningful for EC2.
  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    const typeRegex = /\b([a-z][0-9][a-z]*[0-9]*[a-z]?)\.([a-z0-9]+)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = typeRegex.exec(userIntent)) !== null) {
      if (isValidInstanceType(m[0])) {
        asserted.add(CfnKey.INSTANCE_TYPE);
        break;
      }
    }
  }

  // AMI ID — only meaningful for EC2.
  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    const amiMatch = /\bami-[0-9a-f]{8,17}\b/.exec(userIntent);
    if (amiMatch && isValidAmiId(amiMatch[0])) {
      asserted.add(CfnKey.IMAGE_ID);
    }
  }

  // RDS engine version — only meaningful for RDS.
  if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    const intentLower = userIntent.toLowerCase();
    if (
      /\b(postgres(ql)?|mysql|mariadb|aurora|oracle|sql\s*server|engine|version)\b/.test(
        intentLower,
      )
    ) {
      const verRegex = /\b(\d+\.\d+(?:\.\d+)?)\b/g;
      let m: RegExpExecArray | null;
      while ((m = verRegex.exec(userIntent)) !== null) {
        if (isValidEngineVersion(m[1]!)) {
          asserted.add(CfnKey.ENGINE_VERSION);
          break;
        }
      }
    }
  }

  return asserted;
}
