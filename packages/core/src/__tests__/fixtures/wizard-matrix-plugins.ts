/**
 * Wizard Interaction Matrix — shared test fixtures.
 *
 * Provides:
 *   - A canonical list of registered resource plugins (excluding the `generic`
 *     fallback plugin, which is tested separately).
 *   - Subset lists for tests that target a specific feature
 *     (showIf / fetcher / companion / advanced fields).
 *   - A default-answer generator that returns a valid value for a field given
 *     its `question.type`.
 *   - A sequence generator that walks commonFields (+ optionally advancedFields)
 *     in the same order the option-elicitor prompts them, producing the array
 *     of answers to hand to a stubbed `promptWithHelp`.
 *
 * This file contains **only pure helpers and data** — no mocks and no test cases.
 * Individual test files (`wizard-matrix-*.test.ts`) import from here and set up
 * their own mocks.
 *
 * @see _bmad-output/implementation-artifacts/wizard-interaction-matrix.md
 */

import { defaultPluginRegistry, RESOURCE_TYPES } from "@assignee/core";
import type { ResourceField, ResourcePlugin } from "@assignee/core";

/**
 * Canonical list of primary resource types covered by the wizard matrix.
 *
 * This must match `packages/core/src/resource-plugins/index.ts` (minus the
 * generic fallback plugin). When a new plugin is registered there, add its
 * RESOURCE_TYPES key here so the matrix tests cover it automatically.
 */
const PLUGIN_RESOURCE_TYPES: readonly string[] = Object.freeze([
  RESOURCE_TYPES.S3_BUCKET,
  RESOURCE_TYPES.EC2_INSTANCE,
  RESOURCE_TYPES.RDS_DB_INSTANCE,
  RESOURCE_TYPES.LAMBDA_FUNCTION,
  RESOURCE_TYPES.EC2_SECURITY_GROUP,
  RESOURCE_TYPES.DYNAMODB_TABLE,
  RESOURCE_TYPES.EC2_VPC,
  RESOURCE_TYPES.EC2_SUBNET,
  RESOURCE_TYPES.SQS_QUEUE,
  RESOURCE_TYPES.SNS_TOPIC,
  RESOURCE_TYPES.SSM_PARAMETER,
  RESOURCE_TYPES.IAM_ROLE,
  RESOURCE_TYPES.ECS_CLUSTER,
  RESOURCE_TYPES.ECR_REPOSITORY,
  RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
  RESOURCE_TYPES.LOGS_LOG_GROUP,
  RESOURCE_TYPES.EC2_INTERNET_GATEWAY,
  RESOURCE_TYPES.EC2_ROUTE_TABLE,
  RESOURCE_TYPES.EC2_ROUTE,
  RESOURCE_TYPES.EC2_NAT_GATEWAY,
  RESOURCE_TYPES.APIGATEWAYV2_API,
  RESOURCE_TYPES.CLOUDWATCH_ALARM,
  RESOURCE_TYPES.SECRETSMANAGER_SECRET,
  RESOURCE_TYPES.EFS_FILE_SYSTEM,
  RESOURCE_TYPES.EFS_MOUNT_TARGET,
  RESOURCE_TYPES.EVENTS_RULE,
  RESOURCE_TYPES.EVENTS_EVENT_BUS,
  RESOURCE_TYPES.SNS_SUBSCRIPTION,
  RESOURCE_TYPES.KMS_KEY,
  RESOURCE_TYPES.EVENTS_CONNECTION,
  RESOURCE_TYPES.EVENTS_API_DESTINATION,
  RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  RESOURCE_TYPES.S3_BUCKET_POLICY,
]);

function mustGetPlugin(resourceType: string): ResourcePlugin {
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) {
    throw new Error(
      `wizard-matrix fixture: no plugin registered for ${resourceType}. ` +
        `Make sure @assignee/core's resource-plugins index registers it.`,
    );
  }
  return plugin;
}

/**
 * All registered resource plugins in registration order, minus the `generic`
 * fallback. Resolved via `defaultPluginRegistry.get()` rather than direct
 * imports because only the registry (not individual plugin instances) is
 * re-exported from the top-level `@assignee/core` barrel.
 */
export const ALL_PLUGINS: readonly ResourcePlugin[] = Object.freeze(
  PLUGIN_RESOURCE_TYPES.map(mustGetPlugin),
);

/** Plugins with at least one advanced field — used by the "advanced confirm" test. */
export const PLUGINS_WITH_ADVANCED: readonly ResourcePlugin[] = Object.freeze(
  ALL_PLUGINS.filter((p) => p.advancedFields.length > 0),
);

/** Plugins that define `showIf` on any field — used by conditional-field tests. */
export const PLUGINS_WITH_SHOWIF: readonly ResourcePlugin[] = Object.freeze(
  ALL_PLUGINS.filter((p) =>
    [...p.commonFields, ...p.advancedFields].some(
      (f) => f.question.showIf !== undefined,
    ),
  ),
);

/** Plugins that define `fetcher` on any field — used by discovery fallback tests. */
export const PLUGINS_WITH_FETCHERS: readonly ResourcePlugin[] = Object.freeze(
  ALL_PLUGINS.filter((p) =>
    [...p.commonFields, ...p.advancedFields].some(
      (f) => f.question.fetcher !== undefined,
    ),
  ),
);

/** Plugins that define a `companionResources()` factory — used by companion tests. */
export const PLUGINS_WITH_COMPANIONS: readonly ResourcePlugin[] = Object.freeze(
  ALL_PLUGINS.filter((p) => typeof p.companionResources === "function"),
);

/**
 * Pick a string that matches a `showIf.pattern` regex from a small table of
 * values used by the plugins currently in the matrix. Falls back to the
 * literal pattern (which is unlikely to match) if no candidate works — the
 * caller should detect this and skip drive-based assertions.
 */
export function pickPatternMatch(pattern: string): string | undefined {
  const candidates = [
    "t3.small",
    "t3.medium",
    "t4g.small",
    "db.t3.medium",
    "provisioned",
    "PROVISIONED",
    "HTTP",
    "WEBSOCKET",
    "true",
    "false",
  ];
  const re = new RegExp(pattern);
  return candidates.find((c) => re.test(c));
}

/**
 * Evaluate a field's showIf condition against the currently-answered map.
 * Mirrors the real `evaluateShowIf` implementation in `wizard-helpers.ts`:
 *   - If `pattern` is set, regex-test the stringified dep value.
 *   - If `value === true`, treat as truthy check (arrays → non-empty).
 *   - If `value === false`, treat as falsy check (arrays → empty).
 *   - Otherwise, strict equality against `value`.
 */
function showIfSatisfied(
  field: ResourceField,
  answered: Record<string, unknown>,
): boolean {
  const cond = field.question.showIf;
  if (!cond) return true;
  const depValue = answered[cond.field];
  if (cond.pattern) {
    return new RegExp(cond.pattern).test(String(depValue ?? ""));
  }
  if (cond.value === true) {
    return Array.isArray(depValue) ? depValue.length > 0 : !!depValue;
  }
  if (cond.value === false) {
    return Array.isArray(depValue) ? depValue.length === 0 : !depValue;
  }
  return depValue === cond.value;
}

/**
 * Generate a single default answer for a field.
 *
 * Priority:
 *   1. `field.question.initialValue` (if defined and non-empty)
 *   2. Type-specific fallback:
 *      - `boolean`        → `true` (so showIf children gated on truthy show)
 *      - `enum`           → first option's value, or a string fallback
 *      - `string`         → `<fieldName>-value` (deterministic, non-empty)
 *      - `multi`          → array containing the first option's value (non-empty
 *                            so option-elicitor doesn't drop the answer)
 *      - `categorySelect` → first category's first option value
 *
 * Throws on unknown question types so a new field type forces a fixture update.
 */
export function generateDefaultAnswer(field: ResourceField): unknown {
  const q = field.question;

  // Empty-string initialValues (e.g. EFS::KmsKeyId initialValue: "") are
  // intentionally treated as "no useful default" — option-elicitor drops
  // empty-string answers from elicitedOptions, which would make happy-path
  // assertions vacuous for the dependent showIf children. Override with the
  // type-specific fallback below instead.
  if (q.initialValue !== undefined && q.initialValue !== "") {
    return q.initialValue;
  }

  switch (q.type) {
    case "boolean":
      return true;
    case "enum": {
      const first = q.options?.[0]?.value;
      return first ?? `${field.name.toLowerCase()}-value`;
    }
    case "string":
      return `${field.name.toLowerCase()}-value`;
    case "multi": {
      // Non-empty so option-elicitor stores the answer and our assertions
      // can verify it. If the field has options, prefer the first; otherwise
      // a single synthetic value tagged with the field name.
      const first = q.options?.[0]?.value;
      return first ? [first] : [`${field.name.toLowerCase()}-value`];
    }
    case "categorySelect": {
      const firstCat = q.categories?.[0];
      return (
        firstCat?.options?.[0]?.value ?? `${field.name.toLowerCase()}-value`
      );
    }
    default: {
      // Force a fixture update when a new question type is added — silently
      // returning undefined makes every assertion for the new type vacuous.
      const exhaustive: never = q.type;
      throw new Error(
        `wizard-matrix fixture: unsupported question type ${String(exhaustive)} on field ${field.name}`,
      );
    }
  }
}

/** One item in a prompt sequence — mirrors what promptWithHelp would receive/return. */
export interface SequencedAnswer {
  /** The field that will be prompted. */
  field: ResourceField;
  /** Tier where this field lives — common or advanced. */
  tier: "common" | "advanced";
  /** The value that should be returned by the stubbed promptWithHelp. */
  value: unknown;
}

/**
 * Walk a plugin's commonFields (+ optionally advancedFields) in prompt order,
 * evaluating showIf conditions against the accumulating answer map. Returns a
 * sequence that tests can feed to `promptWithHelp` one call at a time.
 *
 * Mirrors the loop in `optionElicitorNode` (apps/cli/src/nodes/option-elicitor.ts):
 *   - Skip fields whose showIf condition is not met.
 *   - Record each answer into the running `answerMap` so subsequent showIf
 *     evaluations see up-to-date state.
 */
export function generateAnswerSequence(
  plugin: ResourcePlugin,
  opts: { includeAdvanced?: boolean } = {},
): { sequence: SequencedAnswer[]; answerMap: Record<string, unknown> } {
  const sequence: SequencedAnswer[] = [];
  const answerMap: Record<string, unknown> = {};

  for (const field of plugin.commonFields) {
    if (!showIfSatisfied(field, answerMap)) continue;
    const value = generateDefaultAnswer(field);
    sequence.push({ field, tier: "common", value });
    if (value !== undefined) answerMap[field.name] = value;
  }

  if (opts.includeAdvanced) {
    for (const field of plugin.advancedFields) {
      if (!showIfSatisfied(field, answerMap)) continue;
      const value = generateDefaultAnswer(field);
      sequence.push({ field, tier: "advanced", value });
      if (value !== undefined) answerMap[field.name] = value;
    }
  }

  return { sequence, answerMap };
}

/** Flatten a sequence to the value-only array expected by `mockImplementation`. */
export function sequenceValues(seq: SequencedAnswer[]): unknown[] {
  return seq.map((s) => s.value);
}
