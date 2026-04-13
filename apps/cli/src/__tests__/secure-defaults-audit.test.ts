/**
 * Golden test: For EVERY supported resource type, accepting all wizard defaults
 * produces a desiredState that passes ALL blocking best-practice rules.
 *
 * This guarantees that out-of-the-box wizard settings are secure — no user
 * should ever need to change defaults to satisfy critical BP checks.
 */
import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SUPPORTED_TYPES_ARRAY, defaultPluginRegistry } from "@assignee/core";
import type { ResourcePlugin } from "@assignee/core";
import { evaluateTriggers, loadBestPractices } from "@assignee/best-practices";
import type { EvalContext } from "@assignee/best-practices";
import {
  assembleS3Composites,
  assembleEc2Storage,
} from "../nodes/plan-generator.js";

// ---------------------------------------------------------------------------
// Load all BP rules once
// ---------------------------------------------------------------------------
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const BP_ROOT = join(__dirname, "../../../../packages/best-practices");
const allPractices = loadBestPractices(BP_ROOT);

/**
 * Check types that always fire regardless of desiredState content.
 * These are cross-resource or informational checks that cannot be satisfied
 * by any single resource's wizard defaults.
 */
const CROSS_RESOURCE_CHECK_TYPES = new Set([
  "cross_resource_reference",
  "cross_resource_count",
  "awareness",
]);

/**
 * BP rules that check for cross-resource references (e.g., an IGW needing a
 * VPCGatewayAttachment, or an Alarm needing an SNS ARN in AlarmActions).
 * These properties inherently require references to OTHER resources that
 * cannot be populated by wizard defaults alone. They are validated at the
 * plan/pattern level, not at the individual resource default level.
 */
const CROSS_RESOURCE_BP_IDS = new Set([
  "BP-IGW-001", // VPCGatewayAttachment — requires a separate VPCGatewayAttachment resource
  "BP-CW-001", // AlarmActions — requires an SNS topic ARN from another resource
]);

/** Filter practices to only those satisfiable by single-resource defaults. */
const singleResourcePractices = allPractices.filter(
  (bp) =>
    !CROSS_RESOURCE_CHECK_TYPES.has(bp.check_type) &&
    !CROSS_RESOURCE_BP_IDS.has(bp.id),
);

// ---------------------------------------------------------------------------
// Helpers — replicate the wizard "accept all defaults" + toCfn transform flow
// ---------------------------------------------------------------------------

/**
 * Simulate populateDefaultOptions: for each non-showIf field, use initialValue.
 * This mirrors what happens when a user presses Enter on every wizard prompt.
 */
function collectDefaultAnswers(
  plugin: ResourcePlugin,
): Record<string, unknown> {
  const answers: Record<string, unknown> = {};
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];

  for (const field of allFields) {
    // Skip conditionally-shown fields (they depend on interactive choices)
    if (field.question.showIf) continue;

    const initialValue = field.question.initialValue;
    const pluginDefault = plugin.defaults[field.name];

    if (initialValue !== undefined) {
      answers[field.name] = initialValue;
    } else if (pluginDefault !== undefined) {
      answers[field.name] = pluginDefault;
    }
    // Optional fields without defaults are simply omitted
  }

  return answers;
}

/**
 * Apply toCfn transforms: for each answer, if the corresponding field has a
 * toCfn function, call it and use the result. If toCfn returns undefined,
 * omit the field. If no toCfn, pass the value through (unless false).
 */
function applyTransforms(
  answers: Record<string, unknown>,
  plugin: ResourcePlugin,
): Record<string, unknown> {
  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  const transformed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(answers)) {
    const field =
      allFields.find((f) => {
        if (f.name !== key) return false;
        if (!f.question.showIf) return true;
        const { field: depField, value: depValue } = f.question.showIf;
        return answers[depField] === depValue;
      }) ?? allFields.find((f) => f.name === key);

    if (field?.toCfn) {
      const cfnValue = field.toCfn(value);
      if (cfnValue !== undefined) {
        transformed[key] = cfnValue;
      }
    } else if (value !== false) {
      transformed[key] = value;
    }
  }

  return transformed;
}

// assembleS3Composites and assembleEc2Storage imported from plan-generator.ts
// to avoid logic duplication that could silently diverge.

/**
 * Build the full desiredState for a resource type by simulating "accept all
 * wizard defaults" — the same path a user takes by pressing Enter on every prompt.
 */
function buildDefaultDesiredState(
  resourceType: string,
): Record<string, unknown> {
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) {
    // No plugin — return plugin defaults or empty (free resources like generic)
    return {};
  }

  // Step 1: Collect default wizard answers
  const answers = collectDefaultAnswers(plugin);

  // Step 2: Apply toCfn transforms
  const transformed = applyTransforms(answers, plugin);

  // Step 3: Apply composite assemblers for resource types that need them
  if (resourceType === "AWS::S3::Bucket") {
    assembleS3Composites(transformed, answers);
  }
  if (resourceType === "AWS::EC2::Instance") {
    assembleEc2Storage(transformed, answers);
  }

  // Step 4: Merge with plugin.defaults (plugin defaults are the base, transforms override)
  return { ...plugin.defaults, ...transformed };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("Secure defaults audit — all wizard defaults pass blocking BP rules", () => {
  // A1  (2026-04-08): EFS + EFS::MountTarget lifted the count to 27.
  // A8  (2026-04-08): EventBridge Rule lifted the count to 28.
  // A9  (2026-04-09): EventBridge EventBus lifted the count to 29.
  // A10 (2026-04-09): SNS Subscription promoted to first-class, count 30.
  // A11 (2026-04-09): KMS::Key first-class (symmetric CMK), count 31.
  // A12 (2026-04-09): Events::Connection first-class, count 32.
  // A13 (2026-04-09): Events::ApiDestination first-class, count 33.
  // A14 (2026-04-09): CloudFront::Distribution first-class, count 34.
  // (f) 2026-04-09 Task 4b: OriginAccessControl + S3::BucketPolicy, count 36.
  it(`covers all ${SUPPORTED_TYPES_ARRAY.length} supported resource types`, () => {
    expect(SUPPORTED_TYPES_ARRAY.length).toBe(37);
  });

  for (const resourceType of SUPPORTED_TYPES_ARRAY) {
    it(`${resourceType}: default wizard answers produce zero blocking findings`, () => {
      const desiredState = buildDefaultDesiredState(resourceType);

      const context: EvalContext = {
        resourceType,
        desiredState,
      };

      const findings = evaluateTriggers(context, singleResourcePractices);
      const blocking = findings.filter((f) => f.blocking === true);

      if (blocking.length > 0) {
        const details = blocking
          .map(
            (f) =>
              `  - [${f.practiceId}] ${f.title}: ${f.message}` +
              (f.remediation ? `\n    Remediation: ${f.remediation}` : ""),
          )
          .join("\n");
        expect.fail(
          `${resourceType} has ${blocking.length} blocking finding(s) with default wizard answers:\n${details}`,
        );
      }

      expect(blocking).toHaveLength(0);
    });
  }
});
