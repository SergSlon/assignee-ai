/**
 * plan_generator node — calls LLM via LlmPort to produce a CloudFormation desiredState
 * that satisfies the user's intent and conforms to the fetched schema.
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 * @see Story 9.5 — LLM client decoupling (M3)
 */

import {
  ExecutionMode,
  ExecutionStatus,
  defaultPluginRegistry,
  RESOURCE_TYPES,
  CfnKey,
  EIP_AUTO_ALLOCATE,
  ResourceDefault,
  AwsDefault,
  parseMarker,
  type ProvisionRecord,
  type FailureRecord,
  type ResourceResult,
} from "@assignee/core";
import { TWENTY_FOUR_HOURS_MS } from "../config/constants.js";
import { defaultMemoryService } from "../services/memory.js";
import { resolveAmiFromOsName } from "../utils/aws-resource-discovery.js";
import type { LlmPort } from "@assignee/core";
import { AWS_REGION, SCHEMA_EXCERPT_MAX_CHARS } from "../config/constants.js";
import {
  CloudFormationKey,
  CFN_RESOURCE_TYPE_PREFIX,
} from "../constants/cfn-keys.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";
import { sanitizeDesiredState } from "../services/desired-state-sanitizer.js";
import { repairRequiredFields } from "../services/required-field-repairer.js";
import { EnvVar } from "../constants/env-vars.js";
import { tryAssigneeCredentials } from "../config/aws-credentials.js";
import {
  PLACEHOLDER_AWS_ACCOUNT_IDS,
  ARN_ACCOUNT_REGEX,
} from "../constants/placeholder-accounts.js";

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
  if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    assembleS3Composites(transformed, elicitedOptions);
  }
  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    assembleEc2Storage(transformed, elicitedOptions);
  }

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
 * Heuristic markers that identify a plugin placeholder as an OBVIOUSLY
 * template / example value rather than a valid AWS resource value.
 *
 * Wave 15 background: the original `collectPluginPlaceholders` returned
 * EVERY placeholder regardless of shape, and `stripEmpty` then dropped
 * any LLM-supplied value that exactly matched. This silently broke the
 * Subnet plan path because the Subnet plugin's CidrBlock placeholder is
 * `"10.0.1.0/24"` — a perfectly VALID CIDR that a user could legitimately
 * specify as their actual subnet. The LLM mock used the same value, the
 * stripEmpty match fired, and CidrBlock was dropped from the final plan.
 *
 * The VPC test passed only by accident: VPC's CidrBlock has both a
 * placeholder AND an initialValue of `"10.0.0.0/16"`, so the elicitor
 * re-injected the value AFTER stripEmpty stripped it. Brittle.
 *
 * The right answer: only treat placeholders as strip-worthy when their
 * shape clearly says "this is a template, not a real value". Template
 * markers (case-insensitive substring match):
 *   - `my-` / `your-`     — pronoun-leaning examples like `my-bucket`
 *   - `...`                — explicit ellipsis like `arn:aws:kms:...`
 *   - `example`            — explicit example markers
 *   - `12345`              — AWS docs account placeholders
 *   - `0abc` / `0123`      — example resource ID hex stubs
 *   - `(leave blank`       — parenthetical instruction in clack labels
 *   - `(auto-generated`    — same family
 *   - `KEY1=` / `key1=`    — generic env-var template markers
 *   - `Brief description`  — generic text-area placeholder
 *
 * Real-shaped values like `"10.0.1.0/24"`, `"30"`, `"365"`, or
 * `"index.handler"` do NOT contain any of these markers and are
 * therefore NEVER stripped. The placeholder still appears in the
 * wizard prompt — it's only excluded from the strip set.
 */
const TEMPLATE_PLACEHOLDER_MARKERS: readonly string[] = [
  "my-",
  "your-",
  "...",
  "example",
  "12345",
  "0abc",
  "0123",
  "(leave blank",
  "(auto-generated",
  "KEY1=",
  "key1=",
  "Brief description",
];

/**
 * Returns true when a plugin placeholder string looks like an obviously
 * template / example value (e.g. `"my-bucket"`, `"arn:aws:iam::1234..."`,
 * `"Brief description..."`). False for valid-shaped values like
 * `"10.0.1.0/24"` or `"index.handler"`. Used by collectPluginPlaceholders
 * to gate which placeholders feed into stripEmpty's strip set.
 */
export function isTemplatePlaceholder(placeholder: string): boolean {
  const lower = placeholder.toLowerCase();
  return TEMPLATE_PLACEHOLDER_MARKERS.some((marker) =>
    lower.includes(marker.toLowerCase()),
  );
}

/**
 * Collects placeholder strings from plugin field definitions for a
 * resource type that look like obvious templates. Only TEMPLATE
 * placeholders (matching `isTemplatePlaceholder`) are returned — valid-
 * shaped placeholders like `"10.0.1.0/24"` are excluded so users whose
 * legitimate values happen to match an example don't get silently
 * dropped by stripEmpty.
 */
export function collectPluginPlaceholders(resourceType: string): Set<string> {
  const placeholders = new Set<string>();
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) return placeholders;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const field of allFields) {
    if (field.question.placeholder) {
      const ph = field.question.placeholder;
      if (isTemplatePlaceholder(ph)) {
        placeholders.add(ph);
        // Also extract the prefix before any parenthetical suffix so
        // partial matches like "my-bucket" (from "my-bucket (leave
        // blank...)") are caught by stripEmpty. The prefix inherits
        // the template-or-not classification from the parent string;
        // we already know the parent IS a template (we're inside the
        // isTemplatePlaceholder branch), so the prefix is too.
        const prefixMatch = ph.match(/^(.+?)\s+\(/);
        if (prefixMatch) {
          placeholders.add(prefixMatch[1]!.trim());
        }
      }
    }
  }
  return placeholders;
}

/** Recursively removes empty-placeholder values the LLM may insert despite prompt rules. */
function stripEmpty(
  obj: Record<string, unknown>,
  placeholders?: Set<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    // Strip values that exactly match a plugin placeholder string
    if (typeof v === "string" && placeholders && placeholders.has(v)) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>, placeholders);
      if (Object.keys(nested).length === 0) continue;
      out[k] = nested;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Strips placeholder ARNs from array fields in desiredState.
 * The LLM frequently hallucinates ARNs with canonical AWS docs account IDs
 * (e.g., 123456789012) in array fields like AlarmActions, OKActions, etc.
 * Removes placeholder elements; deletes the field if the array becomes empty.
 *
 * Operates on ALL top-level array fields containing strings — generic enough
 * to catch any ARN-bearing array, not just CloudWatch Alarm fields.
 */
export function stripPlaceholderArns(
  desiredState: Record<string, unknown>,
): Record<string, unknown> {
  for (const [key, value] of Object.entries(desiredState)) {
    if (!Array.isArray(value)) continue;
    // Only process arrays that contain at least one string element
    if (!value.some((item) => typeof item === "string")) continue;

    const cleaned = value.filter((item) => {
      if (typeof item !== "string") return true;
      const match = ARN_ACCOUNT_REGEX.exec(item);
      if (!match) return true; // not an ARN — keep
      return !PLACEHOLDER_AWS_ACCOUNT_IDS.has(match[1]!);
    });

    if (cleaned.length === 0) {
      delete desiredState[key];
    } else if (cleaned.length < value.length) {
      desiredState[key] = cleaned;
    }
  }
  return desiredState;
}

/**
 * Lookup function returning the sorted list of AvailabilityZone names for a
 * region. Abstracted so unit tests can substitute a deterministic fixture in
 * place of a real EC2 DescribeAvailabilityZones call.
 */
export type AzLookup = (region: string) => Promise<string[]>;

/**
 * Default AZ lookup — dynamically imports the EC2 SDK and calls
 * DescribeAvailabilityZones with operator credentials. Results are cached per
 * region for the lifetime of the process; compound plan generation may need
 * multiple AZs within a single run and we don't want to pay for the SDK
 * round-trip more than once.
 */
const AZ_CACHE: Map<string, string[]> = new Map();
export async function defaultAzLookup(region: string): Promise<string[]> {
  const cached = AZ_CACHE.get(region);
  if (cached) return cached;
  const operatorCreds = tryAssigneeCredentials("operator");
  if (!operatorCreds) {
    throw new Error(
      `Cannot resolve AvailabilityZone markers: operator credentials missing. ` +
        `Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY.`,
    );
  }
  const { EC2Client, DescribeAvailabilityZonesCommand } =
    await import("@aws-sdk/client-ec2");
  const ec2 = new EC2Client({ region, credentials: operatorCreds });
  const result = await ec2.send(
    new DescribeAvailabilityZonesCommand({
      Filters: [{ Name: "state", Values: ["available"] }],
    }),
  );
  const zones = (result.AvailabilityZones ?? [])
    .map((z) => z.ZoneName)
    .filter((z): z is string => typeof z === "string" && z.length > 0)
    .sort();
  if (zones.length === 0) {
    throw new Error(
      `DescribeAvailabilityZones returned no zones for region "${region}".`,
    );
  }
  AZ_CACHE.set(region, zones);
  return zones;
}

/** Test-only hook: clears the region→AZ cache so fixtures don't leak between tests. */
export function __resetAzCacheForTests(): void {
  AZ_CACHE.clear();
}

/**
 * Walks `desiredState` recursively and substitutes every marker-token string
 * with the concrete value it represents:
 *
 * - `__ASSIGNEE_REF_<id>__`    → physical ID from `completedResources` (resourceArn)
 * - `__ASSIGNEE_GETATT_<id>_<attr>__` → physical ID from `completedResources`
 *                                   (CloudControl only returns the primary
 *                                   identifier, which is what downstream
 *                                   resources actually need)
 * - `__ASSIGNEE_AZ_<n>__`      → Nth AvailabilityZone name in `region`
 *
 * Fails fast with a descriptive error when a REF target is missing, so
 * dependency-order bugs surface at plan time instead of producing a malformed
 * CloudControl request.
 *
 * Mutates `desiredState` in place (and returns it) for ergonomic chaining.
 */

/**
 * Plan-mode placeholder resolution: replaces compound markers with
 * human-readable placeholders for display. Unlike `resolveCompoundMarkers`,
 * this does NOT need AWS credentials or completed resources — it produces
 * display-only strings like "(from vpc)" or "us-east-1a".
 *
 * Mutates `desiredState` in place.
 */
function resolvePlaceholderMarkers(
  desiredState: Record<string, unknown>,
  region: string,
): void {
  function azPlaceholder(index: number): string {
    return `${region}${String.fromCharCode(97 + index)}`;
  }

  function resolveValue(value: string): string {
    const parsed = parseMarker(value);
    if (!parsed) return value;
    if (parsed.kind === "ref" || parsed.kind === "getatt") {
      return `(from ${parsed.resourceId})`;
    }
    return azPlaceholder(parsed.index);
  }

  function walk(obj: unknown): unknown {
    if (typeof obj === "string") {
      return resolveValue(obj);
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        obj[i] = walk(obj[i]);
      }
      return obj;
    }
    if (obj && typeof obj === "object") {
      for (const [key, value] of Object.entries(
        obj as Record<string, unknown>,
      )) {
        (obj as Record<string, unknown>)[key] = walk(value);
      }
      return obj;
    }
    return obj;
  }

  walk(desiredState);
}

export async function resolveCompoundMarkers(
  desiredState: Record<string, unknown>,
  options: {
    completedResources: readonly ResourceResult[];
    region: string;
    currentResourceId: string;
    azLookup?: AzLookup;
  },
): Promise<Record<string, unknown>> {
  const lookup = options.azLookup ?? defaultAzLookup;
  let azCache: string[] | undefined;

  async function resolveString(value: string, path: string): Promise<string> {
    const parsed = parseMarker(value);
    if (!parsed) return value;
    if (parsed.kind === "ref" || parsed.kind === "getatt") {
      const match = options.completedResources.find(
        (r) => r.resourceId === parsed.resourceId,
      );
      if (!match) {
        throw new Error(
          `Compound marker resolution failed at "${path}" for resource ` +
            `"${options.currentResourceId}": no completed resource with ` +
            `resourceId "${parsed.resourceId}" found. ` +
            `Check the pattern's dependencyOrder — the referenced resource ` +
            `must be provisioned before "${options.currentResourceId}".`,
        );
      }
      if (!match.resourceArn) {
        throw new Error(
          `Compound marker resolution failed at "${path}" for resource ` +
            `"${options.currentResourceId}": dependency "${parsed.resourceId}" ` +
            `completed without a physical identifier (resourceArn undefined). ` +
            `This is a CloudControl adapter bug — please file an issue.`,
        );
      }
      return String(match.resourceArn);
    }
    // AZ marker
    if (!azCache) {
      azCache = await lookup(options.region);
    }
    const zone = azCache[parsed.index];
    if (!zone) {
      throw new Error(
        `Compound marker resolution failed at "${path}" for resource ` +
          `"${options.currentResourceId}": AZ index ${parsed.index} is out ` +
          `of range — region "${options.region}" only has ${azCache.length} ` +
          `availability zones (${azCache.join(", ")}).`,
      );
    }
    return zone;
  }

  async function walk(value: unknown, path: string): Promise<unknown> {
    if (typeof value === "string") {
      return resolveString(value, path);
    }
    if (Array.isArray(value)) {
      const out: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        out.push(await walk(value[i], `${path}[${i}]`));
      }
      return out;
    }
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = await walk(v, path ? `${path}.${k}` : k);
      }
      return out;
    }
    return value;
  }

  const resolved = (await walk(desiredState, "")) as Record<string, unknown>;
  // Mutate in place for the caller's convenience — keep reference stability.
  for (const k of Object.keys(desiredState)) delete desiredState[k];
  Object.assign(desiredState, resolved);
  return desiredState;
}

/**
 * Factory for the plan_generator LangGraph node.
 * Accepts llmClient via injection — no direct @ai-sdk imports.
 */
export function createPlanGeneratorNode({
  llmClient,
  azLookup,
}: {
  llmClient: LlmPort;
  /** Optional AZ lookup override — used in tests to avoid real EC2 calls. */
  azLookup?: AzLookup;
}) {
  return async function planGeneratorNode(
    state: AgentState,
  ): Promise<Partial<AgentState>> {
    // Compound mode: short-circuit Bedrock — use pattern defaultOptions instead
    if (
      state.resourcePattern &&
      state.resourceQueue &&
      state.currentResourceIndex !== undefined
    ) {
      const currentResource = state.resourceQueue[state.currentResourceIndex];
      if (!currentResource)
        return {
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Compound resource index ${state.currentResourceIndex} out of bounds (queue length ${state.resourceQueue.length})`,
        };
      const patternDefaults =
        (state.resourcePattern.defaultOptions[currentResource.resourceId] as
          | Record<string, unknown>
          | undefined) ?? {};
      const rawOptions = state.elicitedOptions ?? {};
      const transformedOptions = applyToCfnTransforms(
        rawOptions,
        currentResource.resourceType,
      );
      const desiredState: Record<string, unknown> = {
        ...patternDefaults,
        ...transformedOptions,
      };

      // Inject human-readable resource names for compound patterns
      // CloudControl generates random names if not specified
      const shortId = state.runId.slice(0, 8);
      const resourceId = currentResource.resourceId;
      const NAME_FIELDS: Record<string, string> = {
        [RESOURCE_TYPES.SQS_QUEUE]: CfnKey.QUEUE_NAME,
        [RESOURCE_TYPES.DYNAMODB_TABLE]: CfnKey.TABLE_NAME,
        [RESOURCE_TYPES.IAM_ROLE]: CfnKey.ROLE_NAME,
        [RESOURCE_TYPES.LAMBDA_FUNCTION]: CfnKey.FUNCTION_NAME,
        [RESOURCE_TYPES.S3_BUCKET]: CfnKey.BUCKET_NAME,
        [RESOURCE_TYPES.SNS_TOPIC]: CfnKey.TOPIC_NAME,
        // 2026-04-12: EventBridge Rule uses "Name" as its naming
        // property (createOnly). Without a unique name, CCAPI's Java
        // backend throws a NPE on the null Name field. Adding it here
        // so compound scheduled-lambda gets `assignee-schedule-rule-<shortId>`.
        [RESOURCE_TYPES.EVENTS_RULE]: CfnKey.NAME,
      };
      const nameField = NAME_FIELDS[currentResource.resourceType];
      if (nameField && !desiredState[nameField]) {
        desiredState[nameField] =
          `assignee-${resourceId}-${shortId}`.toLowerCase();
      }

      // CloudFront OAC has its name nested inside
      // OriginAccessControlConfig.Name — the flat NAME_FIELDS map can't
      // reach it. Without a unique suffix, repeated test runs collide on
      // the static "assignee-static-website-oac" name and CCAPI rejects
      // with "already exists". Inject the shortId so each run is unique.
      if (
        currentResource.resourceType ===
        RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL
      ) {
        const oac = desiredState["OriginAccessControlConfig"] as
          | Record<string, unknown>
          | undefined;
        if (oac && typeof oac["Name"] === "string") {
          oac["Name"] = `assignee-${resourceId}-${shortId}`;
        }
      }

      // Compound cross-reference: inject ARNs from previously completed resources
      // e.g., Lambda needs the IAM Role ARN from a prior step.
      //
      // A pattern may also seed `desiredState.Role` with a marker token like
      // `__ASSIGNEE_GETATT_iam-execution-role_Arn__`. The generic marker
      // resolver further down would replace it with the bare role NAME
      // (CloudControl only returns the primary identifier for IAM roles),
      // but Lambda requires the full role ARN. So we detect the marker here
      // and treat it like a missing Role so the existing STS-based ARN
      // construction path runs.
      const existingRoleValue = desiredState[CfnKey.ROLE];
      const roleIsMarker =
        typeof existingRoleValue === "string" &&
        parseMarker(existingRoleValue) !== undefined;
      if (roleIsMarker) {
        delete desiredState[CfnKey.ROLE];
      }
      if (state.completedResources && state.completedResources.length > 0) {
        const completed = state.completedResources;
        if (
          currentResource.resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION &&
          !desiredState[CfnKey.ROLE]
        ) {
          const role = completed.find(
            (r) => r.resourceType === RESOURCE_TYPES.IAM_ROLE,
          );
          if (role?.resourceArn) {
            const roleName = String(role.resourceArn);
            if (roleName.startsWith("arn:")) {
              desiredState[CfnKey.ROLE] = roleName;
            } else {
              // CloudControl returns the role name — construct the full ARN.
              // Precondition: only call STS when operator credentials are
              // configured. Previously the try/catch also swallowed a
              // MissingAssigneeCredentialsError thrown by the credential
              // helper — so the plan would silently proceed with a bare
              // role NAME instead of an ARN, and CloudControl would later
              // fail downstream with a non-obvious error. Now we explicitly
              // check first, emit a clear warn log, and fall back to the
              // bare name. Real STS errors (throttling, network, IAM) still
              // fall through the inner try/catch below.
              const operatorCreds = tryAssigneeCredentials("operator");
              if (!operatorCreds) {
                desiredState[CfnKey.ROLE] = roleName;
                log({
                  ts: new Date().toISOString(),
                  runId: state.runId,
                  level: "warn",
                  action: LOG_ACTIONS.PLAN_GENERATED,
                  extras: {
                    note: "sts_skipped_missing_operator_credentials",
                    roleName,
                    hint: "Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY to derive the full IAM role ARN.",
                  },
                });
              } else {
                try {
                  const { STSClient, GetCallerIdentityCommand } =
                    await import("@aws-sdk/client-sts");
                  const region = AWS_REGION;
                  const sts = new STSClient({
                    region,
                    credentials: operatorCreds,
                  });
                  const identity = await sts.send(
                    new GetCallerIdentityCommand({}),
                  );
                  // Detect partition from region: aws-us-gov for GovCloud,
                  // aws-cn for China, aws for everything else.
                  const partition = region.startsWith("us-gov-")
                    ? "aws-us-gov"
                    : region.startsWith("cn-")
                      ? "aws-cn"
                      : "aws";
                  desiredState[CfnKey.ROLE] =
                    `arn:${partition}:iam::${identity.Account}:role/${roleName}`;
                } catch (err) {
                  desiredState[CfnKey.ROLE] = roleName;
                  log({
                    ts: new Date().toISOString(),
                    runId: state.runId,
                    level: "info",
                    action: LOG_ACTIONS.PLAN_GENERATED,
                    extras: {
                      note: "sts_caller_identity_unavailable_using_role_name",
                      roleName,
                      error: String(err),
                    },
                  });
                }
              }
            }
          }
        }
      }

      // Compound marker resolution — substitute __ASSIGNEE_REF_*__ /
      // __ASSIGNEE_GETATT_*__ / __ASSIGNEE_AZ_*__ tokens with concrete values
      // from `completedResources` and the target region's AZ list. This MUST
      // run before CloudControl sees the desiredState, because CloudControl
      // does NOT process CloudFormation intrinsics or marker tokens.
      //
      // In PLAN mode, skip full resolution — resources aren't provisioned yet
      // so Ref markers have no targets, and AZ lookups may lack credentials.
      // Instead, replace markers with human-readable placeholders for display.
      //
      // 2026-04-11 fix for serverless-api nightly failure: non-provisionable
      // companion resources (provisionable: false) never go through CCAPI at
      // all — resource-provisioner short-circuits them to SUCCESS with
      // undefined resourceArn (see resource-provisioner.ts + test at
      // resource-provisioner.test.ts:790). Their desiredState is plan-only
      // (for display/cost/documentation), so marker resolution must use
      // placeholders. Without this branch, serverless-api's LAMBDA_INTEGRATION
      // resource (provisionable:false, defaultOptions references
      // markerRef(HTTP_API)) threw "Compound marker resolution failed at
      // 'ApiId': dependency 'http-api' completed without a physical
      // identifier — this is a CloudControl adapter bug" because HTTP_API
      // itself is also provisionable:false and never populates
      // completedResources[].resourceArn.
      const isNonProvisionableCompanion =
        currentResource.provisionable === false;
      if (
        state.executionMode === ExecutionMode.PLAN ||
        isNonProvisionableCompanion
      ) {
        resolvePlaceholderMarkers(desiredState, AWS_REGION);
      } else {
        try {
          await resolveCompoundMarkers(desiredState, {
            completedResources: state.completedResources ?? [],
            region: AWS_REGION,
            currentResourceId: currentResource.resourceId,
            azLookup,
          });
        } catch (resolveErr) {
          return {
            executionStatus: ExecutionStatus.FAILED,
            errorMessage:
              resolveErr instanceof Error
                ? resolveErr.message
                : String(resolveErr),
          };
        }
      }

      // Story 19.5: Read pattern memory for compound mode hints
      const compoundMemoryHints: string[] = [];
      try {
        const patterns = await defaultMemoryService.readPatterns();
        const previousPattern = patterns.find(
          (p) => p.pattern === state.resourcePattern!.patternId,
        );
        if (previousPattern && previousPattern.count > 0) {
          const dateStr = new Date(
            previousPattern.lastUsed,
          ).toLocaleDateString();
          compoundMemoryHints.push(
            `Using your usual ${previousPattern.pattern} defaults (used ${previousPattern.count} times, last ${dateStr})`,
          );
        }
      } catch (err) {
        // Graceful degradation — pattern memory read failure is non-blocking
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
          extras: {
            phase: "read_patterns_compound",
            error: String(err),
          },
        });
      }

      // Wave 19 Bug #1 (generic safety net): inject plugin-level defaults for
      // any required CFN field that the pattern template forgot. The compound
      // path used to rely entirely on `patternDefaults` and never consulted
      // the resource plugin's `defaults` map — which meant any pattern that
      // omitted a required field (e.g. lambda-with-exec-role missing
      // `Code` and `Handler`) would silently produce an apply-time CCAPI
      // failure.
      //
      // We mirror what `repairRequiredFields` does in the standalone path,
      // but without a schema to drive it (compound mode short-circuits the
      // schema fetch). Instead, we use the plugin's `commonFields` declarations
      // — fields marked `required: true` are the ones whose defaults should
      // be injected. This narrowly targets the actual gap (CFN-required
      // missing fields) while avoiding the trap that the original Wave 19
      // safety net hit: blindly injecting EVERY plugin default included
      // wizard-only discriminators like `RouteType` for AWS::EC2::Route,
      // which CCAPI rejects with `extraneous key [RouteType] is not permitted`
      // and breaks compound VPC apply.
      try {
        const plugin = defaultPluginRegistry.get(currentResource.resourceType);
        if (plugin) {
          // Index the plugin's commonFields by name so we can apply each
          // field's `toCfn` transform when injecting its default. Wizard-only
          // discriminators like AWS::EC2::Route's `RouteType` are marked
          // `required: true` (the wizard needs them to drive showIf logic)
          // but their `toCfn` returns undefined — meaning the value should
          // never reach CCAPI. Without calling `toCfn`, the safety net
          // injects `RouteType: "public"` literally and CCAPI rejects with
          // `extraneous key [RouteType] is not permitted`. We mirror what
          // the wizard path does.
          const fieldByName = new Map(
            plugin.commonFields.map((f) => [f.name, f] as const),
          );
          const requiredFieldNames = new Set<string>(
            plugin.commonFields
              .filter((f) => f.required === true)
              .map((f) => f.name),
          );
          const injectedFromPluginDefaults: string[] = [];
          for (const [key, rawValue] of Object.entries(plugin.defaults)) {
            if (!requiredFieldNames.has(key)) continue;
            if (desiredState[key] !== undefined) continue;
            if (rawValue === undefined) continue;
            // Apply the field's toCfn transform if present. Skip injection
            // when toCfn maps the value to undefined — this is the
            // wizard-only-discriminator escape hatch. Default values that
            // have no toCfn pass through unchanged.
            const field = fieldByName.get(key);
            const cfnValue = field?.toCfn ? field.toCfn(rawValue) : rawValue;
            if (cfnValue === undefined) continue;
            desiredState[key] = cfnValue;
            injectedFromPluginDefaults.push(key);
          }
          if (injectedFromPluginDefaults.length > 0) {
            log({
              ts: new Date().toISOString(),
              runId: state.runId,
              level: "info",
              action: LOG_ACTIONS.PLAN_GENERATED,
              extras: {
                phase: "compound_plugin_defaults_injected",
                resourceType: currentResource.resourceType,
                resourceId: currentResource.resourceId,
                injectedFields: injectedFromPluginDefaults,
              },
            });
          }
        }
      } catch (err) {
        // Plugin lookup failure is non-fatal — fall through to whatever
        // patternDefaults provided. The downstream preflight-guard will
        // catch any genuinely missing required fields.
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.PLAN_GENERATED,
          extras: {
            phase: "compound_plugin_defaults_skipped",
            resourceType: currentResource.resourceType,
            error: String(err),
          },
        });
      }

      // EC2 post-processing for compound mode (same as standalone path)
      if (currentResource.resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
        const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
        if (Array.isArray(sgIds)) {
          const valid = (sgIds as string[]).filter(
            (id) => typeof id === "string" && id.startsWith("sg-"),
          );
          if (valid.length === 0) {
            delete desiredState[CfnKey.SECURITY_GROUP_IDS];
          } else {
            desiredState[CfnKey.SECURITY_GROUP_IDS] = valid;
          }
        }
        if (state.userIntent && /\bssh\b/i.test(state.userIntent)) {
          if (!desiredState[CfnKey.KEY_NAME]) {
            desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
          }
        }
      }

      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.PLAN_GENERATED,
        durationMs: 0,
        extras: { resourceType: currentResource.resourceType, compound: true },
      });
      return {
        desiredState,
        resourceType: currentResource.resourceType,
        ...(compoundMemoryHints.length > 0
          ? { memoryHints: compoundMemoryHints }
          : {}),
      };
    }

    if (state.executionStatus !== ExecutionStatus.PENDING) return {};

    if (!state.resourceSchema) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          "Cannot generate plan: resource schema is missing. Hint: check CloudFormation Registry SDK connectivity and ASSIGNEE_OPERATOR credentials.",
      };
    }

    const startedAt = Date.now();
    // CloudFormation Registry SDK returns lowercase "properties"; older MCP servers used "Properties"
    const schemaProperties =
      (state.resourceSchema[CfnKey.CFN_PROPERTIES] as
        | Record<string, unknown>
        | undefined) ??
      (state.resourceSchema[CloudFormationKey.PROPERTIES] as
        | Record<string, unknown>
        | undefined) ??
      {};
    const schemaKeys = Object.keys(schemaProperties);
    const requiredKeys: string[] =
      (state.resourceSchema[CfnKey.CFN_REQUIRED] as string[] | undefined) ?? [];

    if (!process.env[EnvVar.BEDROCK_GUARDRAIL_ID]) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.GUARDRAIL_DISABLED,
        extras: {
          message: "BEDROCK_GUARDRAIL_ID not set — guardrail disabled for POC",
        },
      });
    }

    const resourceHints =
      defaultPluginRegistry.get(state.resourceType ?? "")?.configHints ?? [];

    // Story 19.3: Read provision history for cost hints
    let provisionHintLine = "";
    const memoryHints: string[] = [];
    try {
      const provisions = await defaultMemoryService.readProvisions();
      const previousForType = provisions
        .filter((p: ProvisionRecord) => p.resourceType === state.resourceType)
        .sort((a: ProvisionRecord, b: ProvisionRecord) =>
          b.timestamp.localeCompare(a.timestamp),
        );
      if (previousForType.length > 0) {
        const prev = previousForType[0]!;
        const dateStr = new Date(prev.timestamp).toLocaleDateString();
        provisionHintLine = `Previous provision of this type: ${prev.estimatedMonthlyCost}/month (run ${prev.runId}, ${dateStr}).`;
        memoryHints.push(provisionHintLine);
      }
    } catch (err) {
      // Graceful degradation — memory read failure is non-blocking
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
        extras: { phase: "read_provisions", error: String(err) },
      });
    }

    // Story 19.4: Read failure history for warning hints
    // Story 20.13: Skip failures older than the latest success for same type
    try {
      const failures = await defaultMemoryService.readFailures();
      const previousFailuresForType = failures
        .filter((f: FailureRecord) => f.resourceType === state.resourceType)
        .sort((a: FailureRecord, b: FailureRecord) =>
          b.timestamp.localeCompare(a.timestamp),
        );
      // Only show provisioning failures (apply errors), not transient plan errors
      const provisioningFailures = previousFailuresForType.filter(
        (f: FailureRecord) =>
          !f.errorMessage.includes("invalid JSON") &&
          !f.errorMessage.includes("Plan generator") &&
          !f.errorMessage.includes("Intent parsing"),
      );
      const latestFailure = provisioningFailures[0];
      if (latestFailure) {
        // Only show if failure is newer than latest success for this type
        const provisions = await defaultMemoryService.readProvisions();
        const latestSuccess = provisions
          .filter((p: ProvisionRecord) => p.resourceType === state.resourceType)
          .sort((a: ProvisionRecord, b: ProvisionRecord) =>
            b.timestamp.localeCompare(a.timestamp),
          )[0];
        const failureIsStale =
          latestSuccess &&
          latestFailure.timestamp.localeCompare(latestSuccess.timestamp) <= 0;
        // Also treat failures older than 24 hours as stale regardless of success history
        const failureAge =
          Date.now() - new Date(latestFailure.timestamp).getTime();
        const failureIsTooOld = failureAge > TWENTY_FOUR_HOURS_MS;
        if (!failureIsStale && !failureIsTooOld) {
          const fixSuffix = latestFailure.suggestedFix
            ? ` Fix: ${latestFailure.suggestedFix}`
            : "";
          memoryHints.push(
            `\u26A0 Previous error with ${latestFailure.resourceType}: ${latestFailure.errorMessage}.${fixSuffix}`,
          );
        }
      }
    } catch (err) {
      // Graceful degradation — memory read failure is non-blocking
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "info",
        action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
        extras: { phase: "read_failures", error: String(err) },
      });
    }

    const prompt = [
      `You are an AWS resource configuration expert. Generate the resource properties JSON for a "${state.resourceType}" resource.`,
      `User intent: <user_intent>${(state.userIntent ?? "").replace(/<\/user_intent>/gi, "")}</user_intent>`,
      "",
      `Required properties: ${JSON.stringify(requiredKeys)}`,
      `Available properties: ${JSON.stringify(schemaKeys)}`,
      "",
      "RULES:",
      "1. Output ONLY valid JSON — no markdown fences, no explanation",
      "2. Output a FLAT JSON object with ONLY the resource properties directly — do NOT wrap in a CloudFormation Resources block or nest under a logical resource ID",
      "3. Include ONLY properties from the Available properties list",
      "4. Include ALL Required properties with real values",
      "5. Include properties clearly implied by the user's intent (e.g. InstanceType, Engine, FunctionName, Runtime)",
      "6. OMIT any property you don't have a specific value for — do NOT use empty strings, 0, false, or [] as placeholders",
      "7. NEVER use placeholder or example values from schema descriptions (e.g., ami-0abcdef1234567890, my-key-pair, subnet-0abc1234, sg-0123456789abcdef0, arn:aws:iam::123456789012:role/my-role, my-instance-profile, my-bucket, my-resource). If the user did not provide a real value, OMIT the property entirely.",
      "8. For S3 BucketName: use only lowercase letters, digits, hyphens (3–63 chars)",
      ...(resourceHints.length > 0
        ? [
            "",
            "RESOURCE-SPECIFIC RULES (take precedence over general rules above):",
            ...resourceHints.map((h, i) => `R${i + 1}. ${h}`),
          ]
        : []),
      ...(provisionHintLine ? ["", `COST CONTEXT: ${provisionHintLine}`] : []),
      "",
      'CORRECT format example: { "BucketName": "payments-data-prod" }',
      `WRONG format example: { "MyBucket": { "Type": "${RESOURCE_TYPES.S3_BUCKET}", "Properties": { "BucketName": "payments-data-prod" } } }`,
      "",
      `Schema excerpt:\n${JSON.stringify(state.resourceSchema, null, 2).slice(0, SCHEMA_EXCERPT_MAX_CHARS)}`,
      "",
      "Output the flat properties JSON object now:",
    ].join("\n");

    const [genErr, text] = await llmClient.generateText(prompt, {
      callsite: "plan_generator",
      runId: state.runId,
    });

    if (genErr || !text) {
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage: `Plan generation failed. Hint: check Bedrock connectivity and AWS credentials.${genErr ? ` Error: ${genErr.message}` : ""}`,
      };
    }

    let desiredState: Record<string, unknown>;
    try {
      const cleaned = text
        .trim()
        .replace(/^```(?:json)?\n?/, "")
        .replace(/\n?```$/, "");
      desiredState = JSON.parse(cleaned) as Record<string, unknown>;
    } catch (err) {
      log({
        ts: new Date().toISOString(),
        runId: state.runId,
        level: "warn",
        action: LOG_ACTIONS.PLAN_GENERATED,
        extras: {
          result: "invalid_json",
          error: String(err),
        },
      });
      return {
        executionStatus: ExecutionStatus.FAILED,
        errorMessage:
          "Plan generator returned invalid JSON. Hint: try rephrasing your intent.",
      };
    }

    // Safety net: unwrap CloudFormation Resources section format if LLM generated it.
    // Detects: { "LogicalId": { "Type": "AWS::...", "Properties": {...} } }
    const topValues = Object.values(desiredState);
    if (
      topValues.length === 1 &&
      typeof topValues[0] === "object" &&
      topValues[0] !== null
    ) {
      const inner = topValues[0] as Record<string, unknown>;
      if (
        typeof inner[CloudFormationKey.TYPE] === "string" &&
        (inner[CloudFormationKey.TYPE] as string).startsWith(
          CFN_RESOURCE_TYPE_PREFIX,
        ) &&
        typeof inner[CloudFormationKey.PROPERTIES] === "object"
      ) {
        desiredState = inner[CloudFormationKey.PROPERTIES] as Record<
          string,
          unknown
        >;
      }
    }

    // Remove empty placeholders and plugin placeholder values the LLM may have inserted
    const pluginPlaceholders = collectPluginPlaceholders(
      state.resourceType ?? "",
    );
    desiredState = stripEmpty(desiredState, pluginPlaceholders);

    // Strip placeholder ARNs from array fields (e.g., AlarmActions with 123456789012)
    stripPlaceholderArns(desiredState);

    // Merge elicited options — user-confirmed values override LLM-generated values.
    // Apply toCfn transforms to convert boolean answers to valid CFN structures.
    if (
      state.elicitedOptions &&
      Object.keys(state.elicitedOptions).length > 0
    ) {
      const transformed = applyToCfnTransforms(
        state.elicitedOptions,
        state.resourceType ?? "",
      );
      desiredState = { ...desiredState, ...transformed };

      // Delete LLM-generated values that the user explicitly declined
      const plugin = defaultPluginRegistry.get(state.resourceType ?? "");
      if (plugin) {
        const allFields = [...plugin.commonFields, ...plugin.advancedFields];
        for (const [key, value] of Object.entries(state.elicitedOptions)) {
          const field =
            allFields.find((f) => {
              if (f.name !== key) return false;
              if (!f.question.showIf) return true;
              const { field: depField, value: depValue } = f.question.showIf;
              return state.elicitedOptions?.[depField] === depValue;
            }) ?? allFields.find((f) => f.name === key);
          if (field?.toCfn) {
            const cfnValue = field.toCfn(value);
            if (cfnValue === undefined) {
              delete desiredState[key];
            }
          }
        }
      }
    }

    // Sanitize against schema — strip extraneous keys (recursive) + coerce types.
    // MUST run AFTER elicitedOptions merge since plugins may add non-schema keys
    // (e.g., DynamoDB PointInTimeRecoveryEnabled is a plugin field, not a CFN property).
    if (schemaKeys.length > 0) {
      const { sanitized, strippedKeys, coercedKeys } = sanitizeDesiredState(
        desiredState,
        state.resourceSchema,
      );
      desiredState = sanitized;
      if (strippedKeys.length > 0 || coercedKeys.length > 0) {
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "info",
          action: LOG_ACTIONS.PLAN_GENERATED,
          extras: {
            sanitized: true,
            strippedKeys,
            coercedKeys: coercedKeys.map((c) => `${c.path}: ${c.from}→${c.to}`),
          },
        });
      }
    }

    // Resolve OS name to real AMI ID for EC2 instances
    if (
      state.resourceType === RESOURCE_TYPES.EC2_INSTANCE &&
      typeof desiredState[CfnKey.IMAGE_ID] === "string" &&
      !String(desiredState[CfnKey.IMAGE_ID]).startsWith("ami-")
    ) {
      const osName = String(desiredState[CfnKey.IMAGE_ID]);
      const resolvedAmi = await resolveAmiFromOsName(osName);
      if (resolvedAmi) {
        desiredState[CfnKey.IMAGE_ID] = resolvedAmi;
      } else {
        // Cannot resolve OS name — fail the plan clearly
        return {
          desiredState: {},
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: `Cannot resolve "${osName}" to a real AMI ID. Please either:\n  1. Run "aws sso login" to refresh credentials, then retry\n  2. Use "Other" in the AMI field and enter a real AMI ID (e.g., ami-0c55b159cbfafe1f0)`,
        };
      }
    }

    // Story E2E.5: NatGateway with public connectivity requires an EIP AllocationId.
    // If the LLM generated AUTO_ALLOCATE_EIP or omitted AllocationId, insert a
    // placeholder that resource_provisioner will resolve at apply time.
    // IMPORTANT: We must NOT allocate a real EIP during plan generation because
    // if the user runs `plan` but never `apply`, the EIP would leak ($3.60/month).
    if (
      state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
      (desiredState[CfnKey.CONNECTIVITY_TYPE] ===
        AwsDefault.CONNECTIVITY_PUBLIC ||
        !desiredState[CfnKey.CONNECTIVITY_TYPE]) &&
      (!desiredState[CfnKey.ALLOCATION_ID] ||
        desiredState[CfnKey.ALLOCATION_ID] === EIP_AUTO_ALLOCATE)
    ) {
      desiredState[CfnKey.ALLOCATION_ID] = EIP_AUTO_ALLOCATE;
    }

    // Story E2E.3: Generic required-field repairer — fills missing required fields
    // from plugin defaults. Replaces one-off Lambda Code special case.
    const { repaired: repairedState, injectedFields } = repairRequiredFields(
      desiredState,
      state.resourceType ?? "",
      requiredKeys,
    );
    desiredState = repairedState;

    // EC2 post-processing: clean up LLM artifacts and handle SSH intent
    if (state.resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
      // Strip empty/placeholder SecurityGroupIds that the LLM may generate
      const sgIds = desiredState[CfnKey.SECURITY_GROUP_IDS];
      if (Array.isArray(sgIds)) {
        const valid = (sgIds as string[]).filter(
          (id) => typeof id === "string" && id.startsWith("sg-"),
        );
        if (valid.length === 0) {
          delete desiredState[CfnKey.SECURITY_GROUP_IDS];
        } else {
          desiredState[CfnKey.SECURITY_GROUP_IDS] = valid;
        }
      }

      // SSH intent: inject key pair placeholder if user wants SSH but LLM omitted KeyName
      if (state.userIntent && /\bssh\b/i.test(state.userIntent)) {
        if (!desiredState[CfnKey.KEY_NAME]) {
          desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
        }
      }
    }

    const durationMs = Date.now() - startedAt;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      durationMs,
      extras: {
        resourceType: state.resourceType,
        ...(injectedFields.length > 0
          ? {
              repairedFields: injectedFields.map(
                (f) => `${f.field}(${f.source})`,
              ),
            }
          : {}),
      },
    });

    // --set values are now included in elicitedOptions (merged in option-elicitor),
    // so they flow through applyToCfnTransforms above. No separate merge needed.

    return {
      desiredState,
      ...(memoryHints.length > 0 ? { memoryHints } : {}),
    };
  };
}
