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
  type ProvisionRecord,
  type FailureRecord,
} from "@assignee/core";
import { defaultMemoryService } from "../services/memory.js";
import type { LlmPort } from "@assignee/core";
import { SCHEMA_EXCERPT_MAX_CHARS } from "../config/constants.js";
import { CloudFormationKey } from "../constants/cfn-keys.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import type { AgentState } from "../services/graph.js";

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
  if (resourceType === "AWS::S3::Bucket") {
    assembleS3Composites(transformed, elicitedOptions);
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
      rule["ExpirationInDays"] = expirationDays;
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
    transformed["ReplicationConfiguration"] = {
      Role: "", // Must be filled by the LLM or user
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

/** Recursively removes empty-placeholder values the LLM may insert despite prompt rules. */
function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === "object" && !Array.isArray(v)) {
      const nested = stripEmpty(v as Record<string, unknown>);
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
          "Cannot generate plan: resource schema is missing. Hint: check cfn-mcp-server connectivity.",
      };
    }

    const startedAt = Date.now();
    // cfn-mcp-server returns lowercase "properties"; older servers used "Properties"
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
    try {
      const failures = await defaultMemoryService.readFailures();
      const previousFailuresForType = failures
        .filter((f: FailureRecord) => f.resourceType === state.resourceType)
        .sort((a: FailureRecord, b: FailureRecord) =>
          b.timestamp.localeCompare(a.timestamp),
        );
      const latestFailure = previousFailuresForType[0];
      if (latestFailure) {
        const fixSuffix = latestFailure.suggestedFix
          ? ` Fix: ${latestFailure.suggestedFix}`
          : "";
        memoryHints.push(
          `\u26A0 Previous error with ${latestFailure.resourceType}: ${latestFailure.errorMessage}.${fixSuffix}`,
        );
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
      "7. For S3 BucketName: use only lowercase letters, digits, hyphens (3–63 chars)",
      ...(resourceHints.length > 0
        ? [
            "",
            "RESOURCE-SPECIFIC RULES (take precedence over general rules above):",
            ...resourceHints.map((h, i) => `R${i + 1}. ${h}`),
          ]
        : []),
      ...(provisionHintLine ? ["", `COST CONTEXT: ${provisionHintLine}`] : []),
      "",
      'CORRECT format example: { "BucketName": "my-bucket" }',
      'WRONG format example: { "MyBucket": { "Type": "AWS::S3::Bucket", "Properties": { "BucketName": "my-bucket" } } }',
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

    // Validate against schema — drop hallucinated fields (Zod.strict equivalent)
    if (schemaKeys.length > 0) {
      const validated: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(desiredState)) {
        if (schemaKeys.includes(key)) {
          validated[key] = val;
        }
        // silently drop fields not in schema
      }
      desiredState = validated;
    }

    // Remove empty placeholders the LLM may have inserted despite the prompt rules
    desiredState = stripEmpty(desiredState);

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

    const durationMs = Date.now() - startedAt;
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      durationMs,
      extras: { resourceType: state.resourceType },
    });

    return {
      desiredState,
      ...(memoryHints.length > 0 ? { memoryHints } : {}),
    };
  };
}
