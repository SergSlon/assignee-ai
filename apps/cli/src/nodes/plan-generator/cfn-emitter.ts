/**
 * CFN emitter — plugin-option → CloudFormation-property transforms.
 *
 * SRP: one reason to change — CFN mandatory-tag rules / composite-field
 * shape changes. OCP: resource-type-specific composite handlers are
 * registered in `COMPOSITE_ASSEMBLERS`; adding a new resource type only
 * requires adding a new entry there, no edit to the `applyToCfnTransforms`
 * core loop.
 */
import {
  defaultPluginRegistry,
  RESOURCE_TYPES,
  CfnKey,
  ResourceDefault,
  AwsDefault,
} from "@assignee/core";

/**
 * A composite-assembler mutates `transformed` (the post-toCfn map) using
 * the original `options` (pre-toCfn). Keyed by resource type in
 * `COMPOSITE_ASSEMBLERS` — the emitter core stays closed for modification.
 */
export type CompositeAssembler = (
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
) => void;

/**
 * Transforms elicited options using plugin toCfn mappers.
 * Fields with toCfn that return undefined are omitted (user said "no").
 * Fields without toCfn pass through unchanged.
 */
export function applyToCfnTransforms(
  elicitedOptions: Record<string, unknown>,
  resourceType: string,
): Record<string, unknown> {
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) return elicitedOptions;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  const transformed: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(elicitedOptions)) {
    // When multiple fields share the same name (e.g., EngineVersion with different showIf),
    // find the one whose showIf condition is satisfied by the current elicitedOptions.
    const field =
      allFields.find((f) => {
        if (f.name !== key) return false;
        if (!f.question.showIf) return true;
        const { field: depField, value: depValue } = f.question.showIf;
        return elicitedOptions[depField] === depValue;
      }) ?? allFields.find((f) => f.name === key);
    if (field?.toCfn) {
      const cfnValue = field.toCfn(value);
      if (cfnValue !== undefined) {
        transformed[key] = cfnValue;
      }
      // If toCfn returns undefined, omit the field (user said "no")
    } else if (value !== false) {
      // false without toCfn means "user declined" — omit from CFN output
      transformed[key] = value;
    }
  }

  // Post-transform: assemble composite CFN structures from sub-fields
  // via the open-for-extension registry.
  const assembler = COMPOSITE_ASSEMBLERS[resourceType];
  if (assembler) assembler(transformed, elicitedOptions);

  return transformed;
}

/**
 * Assembles S3 composite CFN properties from individual sub-fields.
 * E.g., EnableLifecycle + LifecycleTransitionDays + LifecycleExpirationDays
 * → LifecycleConfiguration: { Rules: [...] }
 *
 * Mutates `transformed` in place — removes intermediate keys, adds CFN keys.
 */
export function assembleS3Composites(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  // ── Encryption ──
  if (options[CfnKey.BUCKET_ENCRYPTION] === true) {
    const kmsKey = options[CfnKey.KMS_MASTER_KEY_ID_S3];
    const algorithm =
      kmsKey && String(kmsKey).trim()
        ? "aws:kms"
        : AwsDefault.ENCRYPTION_AES256;
    transformed[CfnKey.BUCKET_ENCRYPTION] = {
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
    delete transformed[CfnKey.BUCKET_ENCRYPTION];
  }
  delete transformed[CfnKey.KMS_MASTER_KEY_ID_S3];

  // ── Lifecycle ──
  if (options[CfnKey.ENABLE_LIFECYCLE] === true) {
    // M-R9: `parseInt(...) || 30` swallows a deliberate `0` from the user.
    // Validate the parsed integer is finite AND non-negative; otherwise fall
    // back to the 30-day default. `0` for transition days is meaningful
    // (immediate transition) and must not be silently rewritten.
    const parsedTransition = parseInt(
      String(options[CfnKey.LIFECYCLE_TRANSITION_DAYS] ?? "30"),
      10,
    );
    const transitionDays =
      Number.isFinite(parsedTransition) && parsedTransition >= 0
        ? parsedTransition
        : 30;
    // V1 PARTIAL: same Number.isFinite-based parse as transitionDays above.
    // The previous `parseInt(...) ?` antipattern silently swallowed
    // non-numeric input. 0 is still treated as "no expiration" because the
    // downstream `expirationDays && expirationDays > 0` check requires a
    // strictly positive value (AWS rejects 0-day expirations).
    const expirationDaysRaw = options[CfnKey.LIFECYCLE_EXPIRATION_DAYS];
    let expirationDays: number | undefined;
    if (expirationDaysRaw !== undefined && expirationDaysRaw !== null) {
      const trimmed = String(expirationDaysRaw).trim();
      if (trimmed.length > 0) {
        const parsed = parseInt(trimmed, 10);
        expirationDays = Number.isFinite(parsed) ? parsed : undefined;
      }
    }

    const rule: Record<string, unknown> = {
      Id: "assignee-default-lifecycle",
      Status: CfnKey.ENABLED,
      Transitions: [
        { StorageClass: "STANDARD_IA", TransitionInDays: transitionDays },
      ],
    };
    if (expirationDays && expirationDays > 0) {
      // AWS requires expiration > transition days; clamp to transitionDays + 1 minimum
      if (expirationDays <= transitionDays) {
        process.stderr.write(
          `Warning: Expiration (${expirationDays}d) must be greater than transition (${transitionDays}d). Adjusted to ${transitionDays + 1}d.\n`,
        );
      }
      rule[CfnKey.EXPIRATION_IN_DAYS] = Math.max(
        expirationDays,
        transitionDays + 1,
      );
    }
    transformed[CfnKey.LIFECYCLE_CONFIGURATION] = { Rules: [rule] };
  }
  delete transformed[CfnKey.ENABLE_LIFECYCLE];
  delete transformed[CfnKey.LIFECYCLE_TRANSITION_DAYS];
  delete transformed[CfnKey.LIFECYCLE_EXPIRATION_DAYS];

  // ── CORS ──
  if (options[CfnKey.ENABLE_CORS] === true) {
    const origins = String(options[CfnKey.CORS_ALLOWED_ORIGINS] ?? "*")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const methods = String(options[CfnKey.CORS_ALLOWED_METHODS] ?? "GET")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    transformed[CfnKey.CORS_CONFIGURATION] = {
      CorsRules: [
        {
          AllowedHeaders: ["*"],
          AllowedMethods: methods,
          AllowedOrigins: origins,
        },
      ],
    };
  }
  delete transformed[CfnKey.ENABLE_CORS];
  delete transformed[CfnKey.CORS_ALLOWED_ORIGINS];
  delete transformed[CfnKey.CORS_ALLOWED_METHODS];

  // ── Replication ──
  // Replication requires an IAM Role ARN. Since the wizard cannot auto-create
  // IAM roles, we skip ReplicationConfiguration entirely if no role is provided
  // and log a warning so the user knows why replication was not configured.
  if (
    options[CfnKey.ENABLE_REPLICATION] === true &&
    options[CfnKey.REPLICATION_DESTINATION_BUCKET]
  ) {
    process.stderr.write(
      "Warning: Cross-region replication requires an IAM Role ARN that cannot be auto-created in the wizard. Skipping ReplicationConfiguration. Create the role manually and add it to your template.\n",
    );
  }
  delete transformed[CfnKey.ENABLE_REPLICATION];
  delete transformed[CfnKey.REPLICATION_DESTINATION_BUCKET];
}

/**
 * Assembles EC2 BlockDeviceMappings from individual EBS sub-fields.
 * EbsVolumeType + EbsVolumeSize + EbsEncrypted → BlockDeviceMappings: [...]
 *
 * Mutates `transformed` in place — removes intermediate keys, adds CFN keys.
 */
export function assembleEc2Storage(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  const volumeType = options[CfnKey.EBS_VOLUME_TYPE];
  const volumeSize = options[CfnKey.EBS_VOLUME_SIZE];
  const encrypted = options[CfnKey.EBS_ENCRYPTED];

  // Only assemble if at least one EBS field was provided
  const hasAnyEbsField =
    volumeType !== undefined ||
    volumeSize !== undefined ||
    encrypted !== undefined;

  if (hasAnyEbsField) {
    const ebs: Record<string, unknown> = {};

    if (volumeType && typeof volumeType === "string") {
      ebs[CfnKey.VOLUME_TYPE] = volumeType;
    } else {
      ebs[CfnKey.VOLUME_TYPE] = ResourceDefault.EBS_VOLUME_TYPE; // default
    }

    if (volumeSize && String(volumeSize).trim() !== "") {
      const size = parseInt(String(volumeSize), 10);
      if (!isNaN(size) && size >= 1) {
        ebs[CfnKey.VOLUME_SIZE] = size;
      } else {
        ebs[CfnKey.VOLUME_SIZE] = 8; // default from plugin initialValue
      }
    } else {
      ebs[CfnKey.VOLUME_SIZE] = 8; // default when left blank
    }

    // Default to true (encrypted) unless explicitly set to false
    ebs[CfnKey.ENCRYPTED] = encrypted !== false;

    transformed[CfnKey.BLOCK_DEVICE_MAPPINGS] = [
      {
        DeviceName: "/dev/xvda",
        Ebs: ebs,
      },
    ];
  }

  delete transformed[CfnKey.EBS_VOLUME_TYPE];
  delete transformed[CfnKey.EBS_VOLUME_SIZE];
  delete transformed[CfnKey.EBS_ENCRYPTED];
}

/**
 * OCP registry: resource-type → composite assembler. Adding a new
 * resource-type composite only requires registering it here; the
 * `applyToCfnTransforms` core loop stays closed to modification.
 */
const COMPOSITE_ASSEMBLERS: Readonly<Record<string, CompositeAssembler>> = {
  [RESOURCE_TYPES.S3_BUCKET]: assembleS3Composites,
  [RESOURCE_TYPES.EC2_INSTANCE]: assembleEc2Storage,
};
