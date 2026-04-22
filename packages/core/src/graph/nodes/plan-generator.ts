/**
 * plan_generator node — calls LLM via LlmPort to produce a CloudFormation
 * desiredState that satisfies the user's intent and conforms to the fetched
 * schema. Compound patterns short-circuit the LLM and use
 * pattern.defaultOptions + completed-resource markers instead.
 *
 * Wave-6 F2: SOLID refactor. This file is now a thin façade over the
 * SRP-aligned sub-modules in `./plan-generator/`. All previously-exported
 * helpers are re-exported here for back-compatibility with existing tests
 * and intra-repo imports (resource-provisioner.ts, graph.ts, etc.).
 *
 * @see Story 1-5, NFR-05 (<3s after MCP up), NFR-15 (1024 max tokens)
 * @see Story 9.5 — LLM client decoupling (M3)
 * @see .agents/stories/wave-6-f2-plan-generator-solid-refactor.md
 */

import { ExecutionStatus, RESOURCE_TYPES, type LlmPort } from "../../index.js";
import type { AgentState } from "../graph-state.js";
import { runCompoundPlan } from "./plan-generator/compound-plan.js";
import { runLlmPlan } from "./plan-generator/llm-plan.js";
import { validatePlanShape } from "./plan-generator/llm-helpers.js";
import type { AzLookup } from "./plan-generator/marker-resolver.js";
import type { Advisory } from "./intent-parser.js";
import { resolveNameField } from "./intent-parser.js";
import { isPlaceholderResourceId } from "./preflight-guard/guards/placeholder-resource-id.js";

// ---------------------------------------------------------------------------
// Back-compat re-exports. Downstream code (plan-generator.test.ts,
// plan-generator.safeClone.test.ts, tocfn-exhaustive.test.ts,
// secure-defaults-audit.test.ts, resource-provisioner.ts) imports these
// names from "./plan-generator.js" — the refactor MUST NOT break them.
// ---------------------------------------------------------------------------
export {
  redactResourceId,
  safeCloneDesiredState,
} from "./plan-generator/safe-clone.js";
export {
  applyToCfnTransforms,
  assembleS3Composites,
  assembleEc2Storage,
} from "./plan-generator/cfn-emitter.js";
export {
  isTemplatePlaceholder,
  collectPluginPlaceholders,
  stripPlaceholderArns,
} from "./plan-generator/placeholders.js";
export {
  defaultAzLookup,
  resolveCompoundMarkers,
  __resetAzCacheForTests,
  type AzLookup,
} from "./plan-generator/marker-resolver.js";

/** BP minimum for CloudWatch Logs retention. Values below this are raised. */
export const BP_MIN_RETENTION_DAYS = 30;

/**
 * Plan-stage post-processing for advisory emission.
 *
 * Runs AFTER the LLM / compound path has computed a final desiredState,
 * but BEFORE plan-shape validation. Produces advisory entries for
 * silent mutations the user should be notified about:
 *
 *   - `BP_ADJUSTED_VALUE` (D-05): `AWS::Logs::LogGroup.RetentionInDays`
 *     below `BP_MIN_RETENTION_DAYS` is raised to the minimum, with a
 *     structured `{field, from, to}` payload.
 *   - `NAME_REWRITTEN`  (A-11, A-15): when the final desiredState's
 *     name field differs from the user-asserted value in
 *     `state.elicitedOptions[nameKey]`, emit a `{from, to}` advisory.
 *     Fires when any downstream sanitizer mutates the user's
 *     original input (unicode strip, dotted-dash rewrite, etc.).
 *
 * Mutates `desiredState` in-place when raising retention (returns the
 * same reference). Returns the list of newly-generated advisories.
 *
 * Epic 94 Wave 2 fixer e94.N5.
 */
export function computePlanAdvisories(
  desiredState: Record<string, unknown> | undefined,
  resourceType: string,
  elicitedOptions: Record<string, unknown> | undefined,
): Advisory[] {
  const advisories: Advisory[] = [];
  if (!desiredState || !resourceType) return advisories;

  // --- LLM-hallucinated placeholder EC2 ID strip ---
  //
  // The LLM path sometimes emits canonical docs placeholder IDs like
  // `sg-12345678`, `subnet-12345678`, `vpc-12345678` for required
  // dependency fields when the user did NOT supply them. These values
  // hit the downstream preflight `placeholder-resource-id` guard and
  // hard-fail the plan with a PLAN_FAILED error. The intent parser's
  // singleton overrides (e94.N5 — C-08, C-09) route these intents to
  // a single CFN type, but the hallucinated deps still land in the
  // desiredState because the LLM fills in example values whenever a
  // required field has no user-supplied value.
  //
  // The plan-stage comparator deletes these hallucinations so the
  // downstream preflight sees only real / user-supplied values. An
  // `EC2_PLACEHOLDER_STRIPPED` advisory is emitted per-field so the
  // user is told exactly which dependency is missing.
  stripPlaceholderEc2Ids(desiredState, "", advisories);

  // --- D-05: RetentionInDays minimum enforcement ---
  if (resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP) {
    const raw = desiredState["RetentionInDays"];
    const asserted =
      typeof raw === "number" && Number.isFinite(raw) && raw > 0
        ? raw
        : typeof raw === "string" && /^\d+$/.test(raw)
          ? Number(raw)
          : null;
    if (asserted !== null && asserted < BP_MIN_RETENTION_DAYS) {
      desiredState["RetentionInDays"] = BP_MIN_RETENTION_DAYS;
      advisories.push({
        code: "BP_ADJUSTED_VALUE",
        message: `RetentionInDays was raised from ${asserted} to ${BP_MIN_RETENTION_DAYS} to satisfy the best-practice minimum (${BP_MIN_RETENTION_DAYS} days).`,
        hint: `Explicitly set RetentionInDays >= ${BP_MIN_RETENTION_DAYS} to suppress this advisory, or disable the best-practice minimum via your organisation config.`,
        details: {
          field: "RetentionInDays",
          from: asserted,
          to: BP_MIN_RETENTION_DAYS,
        },
      });
    }
  }

  // --- A-11 + A-15: NAME_REWRITTEN comparator ---
  const nameField = resolveNameField(resourceType);
  if (nameField && elicitedOptions) {
    const asserted = elicitedOptions[nameField];
    const finalValue = desiredState[nameField];
    if (
      typeof asserted === "string" &&
      asserted.length > 0 &&
      typeof finalValue === "string" &&
      finalValue.length > 0 &&
      asserted !== finalValue
    ) {
      advisories.push({
        code: "NAME_REWRITTEN",
        message: `The resource name was rewritten from "${asserted}" to "${finalValue}" by a downstream sanitizer.`,
        hint: `If you want the original value, choose a name that conforms to ${resourceType} naming rules (ASCII, allowed charset, length) so no rewrite is required.`,
        details: {
          field: nameField,
          from: asserted,
          to: finalValue,
        },
      });
    }
  }

  return advisories;
}

/**
 * Recursively walk `target` and strip scalar / array entries that match
 * the canonical LLM-hallucinated EC2-style placeholder IDs (e.g.
 * `sg-12345678`, `subnet-12345678`). Scalar placeholders → delete
 * the key; placeholder array elements → filtered; arrays that empty
 * → key removed.
 *
 * Each strip appends a `EC2_PLACEHOLDER_STRIPPED` advisory with the
 * path of the removed field so the user can see which dependency the
 * plan is missing.
 */
function stripPlaceholderEc2Ids(
  target: unknown,
  pathPrefix: string,
  advisories: Advisory[],
): void {
  if (target === null || target === undefined) return;
  if (Array.isArray(target)) {
    // Walk in reverse so splicing does not disturb unvisited indices.
    for (let i = target.length - 1; i >= 0; i--) {
      const item = target[i];
      const itemPath = `${pathPrefix}[${i}]`;
      if (typeof item === "string" && isPlaceholderResourceId(item)) {
        target.splice(i, 1);
        advisories.push({
          code: "EC2_PLACEHOLDER_STRIPPED",
          message: `Dropped LLM-hallucinated placeholder resource ID "${item}" from ${itemPath}. Provide a real ID via --set ${pathPrefix}=<real-id> or let a compound pattern create the prerequisite resource.`,
          hint: `Rerun with --set ${pathPrefix}=<real-id>, or describe the full topology (e.g. "Create an EFS mount target in VPC vpc-abc123 subnet subnet-def456").`,
          details: {
            field: itemPath,
            from: item,
            to: null,
          },
        });
        continue;
      }
      if (item && typeof item === "object") {
        stripPlaceholderEc2Ids(item, itemPath, advisories);
      }
    }
    return;
  }
  if (typeof target === "object") {
    const record = target as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      const value = record[key];
      const fieldPath = pathPrefix ? `${pathPrefix}.${key}` : key;
      if (typeof value === "string" && isPlaceholderResourceId(value)) {
        delete record[key];
        advisories.push({
          code: "EC2_PLACEHOLDER_STRIPPED",
          message: `Dropped LLM-hallucinated placeholder resource ID "${value}" from ${fieldPath}. Provide a real ID via --set ${fieldPath}=<real-id> or let a compound pattern create the prerequisite resource.`,
          hint: `Rerun with --set ${fieldPath}=<real-id>, or describe the full topology (e.g. "Create an EFS mount target in VPC vpc-abc123 subnet subnet-def456").`,
          details: {
            field: fieldPath,
            from: value,
            to: null,
          },
        });
        continue;
      }
      if (value && typeof value === "object") {
        stripPlaceholderEc2Ids(value, fieldPath, advisories);
      }
    }
  }
}

/**
 * Factory for the plan_generator LangGraph node. Accepts `llmClient`
 * (LlmPort) and an optional `azLookup` (AzLookup port) via dependency
 * injection — DIP: the node depends on narrow ports, not on concrete
 * adapters. Tests inject fakes.
 *
 * The node body is a single dispatch: compound vs LLM path. All business
 * logic lives in the sub-modules.
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
    // Compound mode: short-circuit LLM — use pattern defaultOptions instead.
    const isCompound =
      state.resourcePattern !== undefined &&
      state.resourceQueue !== undefined &&
      state.currentResourceIndex !== undefined;
    const result = isCompound
      ? await runCompoundPlan(state, azLookup)
      : await runLlmPlan(state, llmClient);

    // Epic 92 Wave 2.d — post-LLM, post-sanitize plan-time validators.
    // Runs for BOTH compound and LLM paths so pattern-authored desiredStates
    // are also checked. Sanitizer (Wave 1) already auto-fixes what it can;
    // validators surface an explicit FAILED for the remaining known-bad
    // shapes (DDB KeySchema↔AttributeDefinitions parity, CloudFront
    // dual-origin-config) BEFORE the resource reaches CCAPI.
    //
    // Skip validation when the result is already FAILED (invalid JSON, LLM
    // error, etc.) so we don't overwrite a more specific upstream error.
    if (result.executionStatus === ExecutionStatus.FAILED) return result;

    const desired = result.desiredState;
    const resourceType =
      (isCompound
        ? state.resourceQueue?.[state.currentResourceIndex ?? 0]?.resourceType
        : state.resourceType) ?? "";
    // Epic 94 N5 (A-11, A-15, D-05) — plan-stage advisory emission.
    // Runs BEFORE shape validation so advisories also render on
    // failure envelopes (though failure-path return short-circuits
    // via `executionStatus: FAILED`).
    let addedAdvisories: Advisory[] = [];
    if (desired && typeof desired === "object" && resourceType) {
      addedAdvisories = computePlanAdvisories(
        desired as Record<string, unknown>,
        resourceType,
        state.elicitedOptions,
      );
    }

    if (desired && typeof desired === "object" && resourceType) {
      const validationError = validatePlanShape(
        desired as Record<string, unknown>,
        resourceType,
      );
      if (validationError !== null) {
        return {
          ...result,
          executionStatus: ExecutionStatus.FAILED,
          errorMessage: validationError,
        };
      }
    }

    // Merge plan-stage advisories with any already on state (from the
    // intent-parser, prior graph iterations, etc.). No-op when none
    // were produced.
    if (addedAdvisories.length > 0) {
      const existing = state.advisories ?? [];
      return {
        ...result,
        advisories: [...existing, ...addedAdvisories],
      };
    }
    return result;
  };
}
