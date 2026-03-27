/**
 * plan_generator node — calls LLM via LlmPort to produce a CloudFormation desiredState
 * that satisfies the user's intent and conforms to the fetched schema.
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 * @see Story 9.5 — LLM client decoupling (M3)
 */

import {
  ExecutionStatus,
  defaultPluginRegistry,
  RESOURCE_TYPES,
  type ProvisionRecord,
  type FailureRecord,
} from "@assignee/core";
import { TWENTY_FOUR_HOURS_MS } from "../config/constants.js";
import { defaultMemoryService } from "../services/memory.js";
import { resolveAmiFromOsName } from "../utils/aws-resource-discovery.js";
import type { LlmPort } from "@assignee/core";
import { SCHEMA_EXCERPT_MAX_CHARS } from "../config/constants.js";
import { CloudFormationKey } from "../constants/cfn-keys.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";
import { sanitizeDesiredState } from "../services/desired-state-sanitizer.js";
import { repairRequiredFields } from "../services/required-field-repairer.js";

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
    const field = allFields.find((f) => f.name === key);
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
function assembleS3Composites(
  transformed: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  // ── Encryption ──
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

  // ── Lifecycle ──
  if (options["EnableLifecycle"] === true) {
    const transitionDays =
      parseInt(String(options["LifecycleTransitionDays"] ?? "30"), 10) || 30;
    const expirationDaysRaw = options["LifecycleExpirationDays"];
    const expirationDays =
      expirationDaysRaw && String(expirationDaysRaw).trim()
        ? parseInt(String(expirationDaysRaw), 10)
        : undefined;

    const rule: Record<string, unknown> = {
      Status: "Enabled",
      Transitions: [
        { StorageClass: "STANDARD_IA", TransitionInDays: transitionDays },
      ],
    };
    if (expirationDays && expirationDays > 0) {
      // AWS requires expiration > transition days; clamp to transitionDays + 1 minimum
      rule["ExpirationInDays"] = Math.max(expirationDays, transitionDays + 1);
    }
    transformed["LifecycleConfiguration"] = { Rules: [rule] };
  }
  delete transformed["EnableLifecycle"];
  delete transformed["LifecycleTransitionDays"];
  delete transformed["LifecycleExpirationDays"];

  // ── CORS ──
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
      CorsRules: [{ AllowedMethods: methods, AllowedOrigins: origins }],
    };
  }
  delete transformed["EnableCors"];
  delete transformed["CorsAllowedOrigins"];
  delete transformed["CorsAllowedMethods"];

  // ── Replication ──
  if (
    options["EnableReplication"] === true &&
    options["ReplicationDestinationBucket"]
  ) {
    // Role must come from the user or a future IAM role creation feature.
    // Omitted here so stripEmpty does not produce invalid CFN.
    transformed["ReplicationConfiguration"] = {
      Rules: [
        {
          Status: "Enabled",
          Destination: {
            Bucket: String(options["ReplicationDestinationBucket"]),
          },
        },
      ],
    };
  }
  delete transformed["EnableReplication"];
  delete transformed["ReplicationDestinationBucket"];
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
  const volumeType = options["EbsVolumeType"];
  const volumeSize = options["EbsVolumeSize"];
  const encrypted = options["EbsEncrypted"];

  // Only assemble if at least one EBS field was provided
  const hasAnyEbsField =
    volumeType !== undefined ||
    volumeSize !== undefined ||
    encrypted !== undefined;

  if (hasAnyEbsField) {
    const ebs: Record<string, unknown> = {};

    if (volumeType && typeof volumeType === "string") {
      ebs["VolumeType"] = volumeType;
    } else {
      ebs["VolumeType"] = "gp3"; // default
    }

    if (volumeSize && String(volumeSize).trim() !== "") {
      const size = parseInt(String(volumeSize), 10);
      if (!isNaN(size) && size >= 1) {
        ebs["VolumeSize"] = size;
      } else {
        ebs["VolumeSize"] = 8; // default from plugin initialValue
      }
    } else {
      ebs["VolumeSize"] = 8; // default when left blank
    }

    // Default to true (encrypted) unless explicitly set to false
    ebs["Encrypted"] = encrypted !== false;

    transformed["BlockDeviceMappings"] = [
      {
        DeviceName: "/dev/xvda",
        Ebs: ebs,
      },
    ];
  }

  delete transformed["EbsVolumeType"];
  delete transformed["EbsVolumeSize"];
  delete transformed["EbsEncrypted"];
}

/**
 * Collects all placeholder strings from the plugin field definitions for a resource type.
 * These are the example values that appear in text inputs and should never leak into the plan.
 */
export function collectPluginPlaceholders(resourceType: string): Set<string> {
  const placeholders = new Set<string>();
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin) return placeholders;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const field of allFields) {
    if (field.question.placeholder) {
      placeholders.add(field.question.placeholder);
      // Also extract the prefix before any parenthetical suffix so that
      // partial matches like "my-bucket" (from "my-bucket (leave blank...)")
      // are caught by stripEmpty.
      const prefixMatch = field.question.placeholder.match(/^(.+?)\s+\(/);
      if (prefixMatch) {
        placeholders.add(prefixMatch[1]!.trim());
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
 * Factory for the plan_generator LangGraph node.
 * Accepts llmClient via injection — no direct @ai-sdk imports.
 */
export function createPlanGeneratorNode({ llmClient }: { llmClient: LlmPort }) {
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
      if (!currentResource) return {};
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
        [RESOURCE_TYPES.SQS_QUEUE]: "QueueName",
        [RESOURCE_TYPES.DYNAMODB_TABLE]: "TableName",
        [RESOURCE_TYPES.IAM_ROLE]: "RoleName",
        [RESOURCE_TYPES.LAMBDA_FUNCTION]: "FunctionName",
        [RESOURCE_TYPES.S3_BUCKET]: "BucketName",
        [RESOURCE_TYPES.SNS_TOPIC]: "TopicName",
      };
      const nameField = NAME_FIELDS[currentResource.resourceType];
      if (nameField && !desiredState[nameField]) {
        desiredState[nameField] = `assignee-${resourceId}-${shortId}`;
      }

      // Compound cross-reference: inject ARNs from previously completed resources
      // e.g., Lambda needs the IAM Role ARN from a prior step
      if (state.completedResources && state.completedResources.length > 0) {
        const completed = state.completedResources;
        if (
          currentResource.resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION &&
          !desiredState["Role"]
        ) {
          const role = completed.find(
            (r) => r.resourceType === RESOURCE_TYPES.IAM_ROLE,
          );
          if (role?.resourceArn) {
            const roleName = String(role.resourceArn);
            if (roleName.startsWith("arn:")) {
              desiredState["Role"] = roleName;
            } else {
              // CloudControl returns the role name — construct the full ARN
              try {
                const { STSClient, GetCallerIdentityCommand } =
                  await import("@aws-sdk/client-sts");
                const sts = new STSClient({
                  region: process.env["AWS_REGION"] ?? "us-east-1",
                });
                const identity = await sts.send(
                  new GetCallerIdentityCommand({}),
                );
                desiredState["Role"] =
                  `arn:aws:iam::${identity.Account}:role/${roleName}`;
              } catch {
                desiredState["Role"] = roleName;
              }
            }
          }
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
      } catch {
        // Graceful degradation — pattern memory read failure is non-blocking
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
      (state.resourceSchema["properties"] as
        | Record<string, unknown>
        | undefined) ??
      (state.resourceSchema[CloudFormationKey.PROPERTIES] as
        | Record<string, unknown>
        | undefined) ??
      {};
    const schemaKeys = Object.keys(schemaProperties);
    const requiredKeys: string[] =
      (state.resourceSchema["required"] as string[] | undefined) ?? [];

    if (!process.env["BEDROCK_GUARDRAIL_ID"]) {
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
    } catch {
      // Graceful degradation — memory read failure is non-blocking
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
      const latestFailure = previousFailuresForType[0];
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
    } catch {
      // Graceful degradation — memory read failure is non-blocking
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
      'WRONG format example: { "MyBucket": { "Type": "AWS::S3::Bucket", "Properties": { "BucketName": "payments-data-prod" } } }',
      "",
      `Schema excerpt:\n${JSON.stringify(state.resourceSchema, null, 2).slice(0, SCHEMA_EXCERPT_MAX_CHARS)}`,
      "",
      "Output the flat properties JSON object now:",
    ].join("\n");

    const [genErr, text] = await llmClient.generateText(prompt);

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
    } catch {
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
        (inner[CloudFormationKey.TYPE] as string).startsWith("AWS::") &&
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
          const field = allFields.find((f) => f.name === key);
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
      typeof desiredState["ImageId"] === "string" &&
      !String(desiredState["ImageId"]).startsWith("ami-")
    ) {
      const osName = String(desiredState["ImageId"]);
      const resolvedAmi = await resolveAmiFromOsName(osName);
      if (resolvedAmi) {
        desiredState["ImageId"] = resolvedAmi;
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
    // If the LLM generated AUTO_ALLOCATE_EIP or omitted AllocationId, allocate a real EIP.
    if (
      state.resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY &&
      (desiredState["ConnectivityType"] === "public" ||
        !desiredState["ConnectivityType"]) &&
      (!desiredState["AllocationId"] ||
        desiredState["AllocationId"] === "AUTO_ALLOCATE_EIP")
    ) {
      try {
        const { EC2Client, AllocateAddressCommand } =
          await import("@aws-sdk/client-ec2");
        const ec2 = new EC2Client({
          region: process.env["AWS_REGION"] ?? "us-east-1",
        });
        const eipResult = await ec2.send(
          new AllocateAddressCommand({ Domain: "vpc" }),
        );
        if (eipResult.AllocationId) {
          desiredState["AllocationId"] = eipResult.AllocationId;
        }
      } catch (eipErr: unknown) {
        const errMsg =
          eipErr instanceof Error ? eipErr.message : String(eipErr);
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PLAN_GENERATED,
          extras: { eipAllocationFailed: true, error: errMsg },
        });
        // Fallback: remove the placeholder so CloudControl gets a clean error
        delete desiredState["AllocationId"];
      }
    }

    // Story E2E.3: Generic required-field repairer — fills missing required fields
    // from plugin defaults. Replaces one-off Lambda Code special case.
    const { repaired: repairedState, injectedFields } = repairRequiredFields(
      desiredState,
      state.resourceType ?? "",
      requiredKeys,
    );
    desiredState = repairedState;

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
