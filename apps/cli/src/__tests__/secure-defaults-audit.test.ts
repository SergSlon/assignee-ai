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

/**
 * Assemble S3 composite CFN properties (BucketEncryption, Lifecycle, CORS).
 * Mirrors assembleS3Composites from plan-generator.ts.
 */
function assembleS3Composites(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  // Encryption
  if (options["BucketEncryption"] === true) {
    const kmsKey = options["KMSMasterKeyID"];
    const algorithm = kmsKey && String(kmsKey).trim() ? "aws:kms" : "AES256";
    transformed["BucketEncryption"] = {
      ServerSideEncryptionConfiguration: [
        {
          ServerSideEncryptionByDefault: {
            SSEAlgorithm: algorithm,
            ...(algorithm === "aws:kms"
              ? { KMSMasterKeyID: String(kmsKey) }
              : {}),
          },
        },
      ],
    };
  } else {
    delete transformed["BucketEncryption"];
  }
  delete transformed["KMSMasterKeyID"];

  // Lifecycle
  if (options["EnableLifecycle"] === true) {
    const transitionDays =
      parseInt(String(options["LifecycleTransitionDays"] ?? "30"), 10) || 30;
    const expirationDaysRaw = options["LifecycleExpirationDays"];
    const expirationDays =
      expirationDaysRaw && String(expirationDaysRaw).trim()
        ? parseInt(String(expirationDaysRaw), 10)
        : undefined;
    const rule: Record<string, unknown> = {
      Id: "assignee-default-lifecycle",
      Status: "Enabled",
      Transitions: [
        { StorageClass: "STANDARD_IA", TransitionInDays: transitionDays },
      ],
    };
    if (expirationDays && expirationDays > 0) {
      rule["ExpirationInDays"] = Math.max(expirationDays, transitionDays + 1);
    }
    transformed["LifecycleConfiguration"] = { Rules: [rule] };
  }
  delete transformed["EnableLifecycle"];
  delete transformed["LifecycleTransitionDays"];
  delete transformed["LifecycleExpirationDays"];

  // CORS
  if (options["EnableCors"] === true) {
    const origins = String(options["CorsAllowedOrigins"] ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const methods = String(options["CorsAllowedMethods"] ?? "GET")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    transformed["CorsConfiguration"] = {
      CorsRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: methods,
          AllowedOrigins: origins,
        },
      ],
    };
  }
  delete transformed["EnableCors"];
  delete transformed["CorsAllowedOrigins"];
  delete transformed["CorsAllowedMethods"];

  // Replication (not assembled without IAM role)
  delete transformed["EnableReplication"];
  delete transformed["ReplicationDestinationBucket"];
}

/**
 * Assemble EC2 BlockDeviceMappings from sub-fields.
 * Mirrors assembleEc2Storage from plan-generator.ts.
 */
function assembleEc2Storage(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  const volumeType = options["EbsVolumeType"];
  const volumeSize = options["EbsVolumeSize"];
  const encrypted = options["EbsEncrypted"];

  const hasAnyEbsField =
    volumeType !== undefined ||
    volumeSize !== undefined ||
    encrypted !== undefined;

  if (hasAnyEbsField) {
    const ebs: Record<string, unknown> = {};
    ebs["VolumeType"] =
      volumeType && typeof volumeType === "string" ? volumeType : "gp3";

    if (volumeSize && String(volumeSize).trim() !== "") {
      const size = parseInt(String(volumeSize), 10);
      ebs["VolumeSize"] = !isNaN(size) && size >= 1 ? size : 8;
    } else {
      ebs["VolumeSize"] = 8;
    }

    ebs["Encrypted"] = encrypted !== false;

    transformed["BlockDeviceMappings"] = [
      { DeviceName: "/dev/xvda", Ebs: ebs },
    ];
  }

  delete transformed["EbsVolumeType"];
  delete transformed["EbsVolumeSize"];
  delete transformed["EbsEncrypted"];
}

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
  // Verify we cover all 23 types
  it(`covers all ${SUPPORTED_TYPES_ARRAY.length} supported resource types`, () => {
    expect(SUPPORTED_TYPES_ARRAY.length).toBe(23);
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
