/**
 * LLM-plan phase 2: plugin placeholder-strip + elicitedOptions merge.
 *
 * Responsible for:
 *   - Stripping plugin-registered empty/placeholder values.
 *   - Stripping hallucinated ARNs (per
 *     `feedback_placeholder_arn_preflight_guard.md` — LLMs sometimes emit
 *     `arn:aws:iam::123456789012:...` placeholders).
 *   - Merging user-confirmed `elicitedOptions` over the LLM output (applying
 *     `toCfn` transforms to convert boolean answers to valid CFN structures).
 *   - Deleting LLM-generated values that the user explicitly declined (toCfn
 *     returned undefined — e.g., user answered "No" to BucketEncryption).
 *   - e96.W2.R5-part-2 — Injecting plugin-level `defaults` for keys the LLM
 *     omitted AND the user did not explicitly elicit. The compound-mode path
 *     in `compound-plan.ts` already spreads pattern defaults first-thing; LLM
 *     mode had no analogous step, so plugin defaults like
 *     `{CreditSpecification: {CPUCredits: "standard"}}` (seeded for the UX-
 *     polish of the "CPU Credits" plan row) never reached the display when
 *     the LLM didn't happen to emit them. Non-deterministic LLM drift made
 *     the row blank on ~60% of runs.
 *
 * SRP: one reason to change — how plugin fields and user-elicited values
 * combine with LLM output.
 */
import { defaultPluginRegistry, RESOURCE_TYPES } from "@/index.js";
import type { ResourceField } from "@/resource-plugins/types.js";
import type { AgentState } from "@/graph/graph-state.js";
import { applyToCfnTransforms } from "../cfn-emitter.js";
import {
  collectPluginPlaceholders,
  stripEmpty,
  stripPlaceholderArns,
} from "../placeholders.js";

/**
 * Removes empty + placeholder values emitted by the LLM so that plugin
 * defaults or user-elicited values land on a clean slate.
 */
export function stripPlaceholders(
  desiredState: Record<string, unknown>,
  resourceType: string,
): Record<string, unknown> {
  const pluginPlaceholders = collectPluginPlaceholders(resourceType);
  const stripped = stripEmpty(desiredState, pluginPlaceholders);
  stripPlaceholderArns(stripped);
  return stripped;
}

/**
 * Merges `elicitedOptions` (user-confirmed values) over the LLM-generated
 * desired state. Applies `toCfn` transforms to convert boolean answers into
 * valid CFN structures, then deletes any LLM-generated value that the user
 * explicitly declined (toCfn returned `undefined`).
 *
 * Returns `desiredState` unchanged when there are no elicited options.
 */
export function mergeElicitedOptions(
  desiredState: Record<string, unknown>,
  state: AgentState,
): Record<string, unknown> {
  if (
    !state.elicitedOptions ||
    Object.keys(state.elicitedOptions).length === 0
  ) {
    return desiredState;
  }

  const transformed = applyToCfnTransforms(
    state.elicitedOptions,
    state.resourceType ?? "",
  );
  const merged: Record<string, unknown> = { ...desiredState, ...transformed };

  // Delete LLM-generated values that the user explicitly declined
  // (toCfn returned undefined).
  const plugin = defaultPluginRegistry.get(state.resourceType ?? "");
  if (!plugin) return merged;

  const allFields = [...plugin.commonFields, ...plugin.advancedFields];
  for (const [key, value] of Object.entries(state.elicitedOptions)) {
    const field = resolveFieldForKey(allFields, key, state.elicitedOptions);
    if (field?.toCfn && field.toCfn(value) === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

/**
 * Resource types whose plugin `defaults` should be backfilled into LLM
 * output for missing keys. Each entry is a deliberate secure-by-default
 * decision — see per-line rationale and the block comment on
 * `mergePluginDefaults` for the scoping protocol.
 *
 * e96.W2.R5-part-2 — seeded with EC2::Instance only.
 *
 * e98.W3.A1 — expanded to cover 11 additional plugins where the
 * plugin's `defaults` carry safety / compliance invariants that
 * previously reached the plan only if the LLM happened to emit them.
 * Each addition was reviewed against the corresponding best-practice
 * rules in `packages/best-practices/` (bp-worker consult). The
 * backfill promotes each of the following rules from safety-net to
 * sanity-check — i.e. the plugin default now satisfies the rule on
 * every plan, so the rule's real-world fire rate drops to near-zero
 * for bare-intent flows (a re-scoring is logged for W5.P1 BP severity
 * normalisation):
 *
 *   Rule              Severity  Blocking  Default that disarms it
 *   ----------------  --------  --------  ------------------------------
 *   BP-SNS-001        HIGH      auto-fix  SNS.KmsMasterKeyId=alias/aws/sns
 *   BP-SQS-001        HIGH      auto-fix  SQS.SqsManagedSseEnabled=true
 *   BP-RDS-002        CRITICAL  blocking  RDS.StorageEncrypted=true
 *   BP-ECR-001        HIGH      blocking  ECR.ImageScanningConfiguration.ScanOnPush=true
 *   BP-ECR-002        HIGH      advisory  ECR.ImageTagMutability=IMMUTABLE
 *   BP-EFS-001        CRITICAL  blocking  EFS.Encrypted=true
 *   BP-EFS-002        HIGH      advisory  EFS.BackupPolicy.Status=ENABLED
 *   BP-ECS-007        HIGH      blocking  ECS.ClusterSettings[containerInsights]=enabled
 *
 * Rules that still fire post-W3.A1 (values are not in the default
 * set — the plugin doesn't backfill them, so user/LLM drift can still
 * produce bad plans):
 *   BP-APIGW-002 (CORS), BP-APIGW-007 (endpoint), BP-CF-001 (viewer
 *   protocol), BP-CF-002 (logging), BP-ELB-001/002/003 (LB attributes),
 *   BP-NAT-001/003 (cross-resource refs), BP-RT-001 (gateway attach),
 *   BP-SQS-003 (KmsMasterKeyId — SSE via Sqs vs. KMS distinct).
 *
 * Awareness-tier rules always fire regardless of values:
 *   BP-ELB-007 (Scheme awareness) — pre-W3.A1 the LLM could have
 *   omitted Scheme; post-W3.A1 the default is `internet-facing` so
 *   users see the awareness finding on every ALB plan. No behavioural
 *   change (awareness ignores the value).
 *   BP-NAT-002 (ConnectivityType awareness) — same pattern.
 *
 * NOT on the allowlist and MUST NOT be added without a BP-enforcement
 * test rewrite:
 *   - `AWS::S3::Bucket` — defaults carry `PublicAccessBlockConfiguration`
 *     with all four block flags true. Backfilling here would disarm
 *     BP-S3-001/002/003/004 (all CRITICAL blocking) silently; the
 *     bp-enforcement integration suite relies on the LLM path
 *     emitting these as empty-leaves so the rules fire. Exclude until
 *     BP severity normalisation (W5.P1) decides the policy.
 *   - `AWS::DynamoDB::Table` — similar BP-DYN rules depend on the
 *     encryption / PITR defaults being LLM-controlled.
 * Keep S3 + DynamoDB on the auto-fix path; add them here only after
 * migrating their BP tests to assert against explicitly-bad plans
 * instead of plan-omission-implies-bad.
 */
const LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST: readonly string[] = [
  RESOURCE_TYPES.EC2_INSTANCE,
  // e98.W3.A1 — W3 expansion wave (11 plugins):
  RESOURCE_TYPES.SNS_TOPIC, // KmsMasterKeyId: alias/aws/sns — BP-SNS-001
  RESOURCE_TYPES.SQS_QUEUE, // SqsManagedSseEnabled=true, VisibilityTimeout=30
  RESOURCE_TYPES.EC2_ROUTE, // DestinationCidrBlock=0.0.0.0/0, RouteType=public
  RESOURCE_TYPES.EC2_NAT_GATEWAY, // ConnectivityType=public
  RESOURCE_TYPES.ELBV2_LOAD_BALANCER, // Type=application, Scheme=internet-facing, IpAddressType=ipv4
  RESOURCE_TYPES.RDS_DB_INSTANCE, // StorageEncrypted=true, MultiAz=false, StorageType=gp3 — BP-RDS-002
  RESOURCE_TYPES.ECS_CLUSTER, // ClusterSettings.containerInsights=enabled, CapacityProviders=[FARGATE]
  RESOURCE_TYPES.ECR_REPOSITORY, // ImageTagMutability=IMMUTABLE, ScanOnPush=true — BP-ECR-001/002
  RESOURCE_TYPES.EFS_FILE_SYSTEM, // Encrypted=true, BackupPolicy.Status=ENABLED — BP-EFS-001
  RESOURCE_TYPES.APIGATEWAYV2_API, // ProtocolType=HTTP
  RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION, // no non-empty defaults today — listed as ordered-pair so adding defaults later auto-participates
];

/**
 * True when `v` is an "empty leaf" — a value that carries no user or
 * LLM signal and therefore should be replaced by a plugin default
 * (not skipped). Covers the four shapes the LLM commonly emits when
 * it knows a CFN key exists but has nothing to say about it:
 *
 *   - `undefined`   — the key is absent entirely.
 *   - `null`        — the LLM emitted a null placeholder.
 *   - `{}`          — empty object (the C-R1 bug: LLM emits
 *                     `CreditSpecification: {}` on larger EC2 intents,
 *                     which the old `!== undefined` check treated as
 *                     "user-intent present" and skipped the default).
 *   - `[]`          — empty array (mirror of `{}` for list-valued keys).
 *   - `""`          — empty string (defensive).
 *
 * Non-empty objects, arrays, zeros, false, and all truthy primitives
 * are NOT empty — they carry signal and the plugin default must yield
 * to them (with deep-merge backfilling missing sub-keys for objects).
 *
 * e98.W2.R2 — exported so callers outside this module (and the unit
 * tests) can share the same emptiness contract.
 */
export function isEmptyLeaf(v: unknown): boolean {
  if (v === undefined || v === null) return true;
  if (v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

/**
 * Deep-merge a plugin default object over an LLM-emitted shell. Used by
 * `mergePluginDefaults` so partial LLM objects (e.g.
 * `CreditSpecification: {SomeOther: "x"}`) still pick up missing plugin-
 * default sub-keys like `CPUCredits: "standard"`.
 *
 * Semantics: LLM sub-keys win. Plugin defaults fill empty-leaf sub-keys
 * (recursive — nested empty objects are themselves backfilled). Arrays
 * are treated atomically — if the LLM emitted a non-empty array, the
 * plugin default is NOT merged into it (element-wise merge is out of
 * scope and would clobber user-ordered lists).
 */
function deepMergeDefault(
  llmValue: Record<string, unknown>,
  defaultValue: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...llmValue };
  for (const [subKey, subDefault] of Object.entries(defaultValue)) {
    const existing = result[subKey];
    if (isEmptyLeaf(existing)) {
      result[subKey] = subDefault;
      continue;
    }
    // Recurse into nested objects (both sides plain objects, not arrays).
    if (
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing) &&
      subDefault !== null &&
      typeof subDefault === "object" &&
      !Array.isArray(subDefault)
    ) {
      result[subKey] = deepMergeDefault(
        existing as Record<string, unknown>,
        subDefault as Record<string, unknown>,
      );
    }
    // Otherwise the LLM value is a non-empty primitive / array — keep it.
  }
  return result;
}

/**
 * Injects plugin-level `defaults` for keys NOT already carrying an
 * empty-leaf value in `desiredState`. Runs AFTER `stripPlaceholders` +
 * `mergeElicitedOptions` and BEFORE `sanitizeAgainstSchema`, so:
 *
 *   1. LLM-emitted non-empty values win (plugin default does not
 *      clobber them). For object-valued defaults, missing sub-keys are
 *      deep-merge backfilled — e.g. a stub-LLM
 *      `{CreditSpecification: {Something: "x"}}` picks up the plugin's
 *      `CPUCredits: "standard"` sub-key while keeping `Something`.
 *   2. User-elicited values win (already merged in by
 *      `mergeElicitedOptions`; plugin default does not clobber them).
 *   3. Plugin-default placeholders the LLM emitted verbatim have been
 *      stripped by `stripPlaceholders` first — so the injection fills
 *      the gap created by stripping, with the canonical plugin value.
 *   4. Downstream `sanitizeAgainstSchema` walks the CFN schema; any
 *      injected key that the schema rejects will be stripped cleanly
 *      rather than shipping a bad value.
 *
 * e98.W2.R2 (C-R1) — the previous skip-condition
 * `result[key] !== undefined` treated LLM-emitted `{}` as non-empty,
 * so the plan-display row for `CreditSpecification` re-blanked on any
 * EC2 intent where the LLM emitted an empty shell (reproducible on
 * `Create an EC2 instance t3.large with 100GB gp3 volume`). Replacing
 * the guard with `!isEmptyLeaf(...)` closes the forcing-flip that the
 * Epic 96 casing-alignment fix did not address.
 *
 * Scoped to resource types on `LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST`
 * (today: EC2::Instance only) because blanket backfill silently
 * dismantles BP-enforcement integration tests that rely on the LLM
 * producing a deliberately minimal plan — those tests assert
 * "blocking BP fires when safety config is missing." Backfilling
 * plugin defaults (e.g. S3 `PublicAccessBlockConfiguration`) would
 * auto-fix the plan and the BP would never fire. Add a new type to
 * the allowlist only after reviewing BP rules that fire on its
 * missing defaults.
 *
 * Returns `desiredState` unchanged when the plugin has no defaults
 * (most plugins don't) OR when `resourceType` is not on the allowlist.
 */
export function mergePluginDefaults(
  desiredState: Record<string, unknown>,
  resourceType: string,
): Record<string, unknown> {
  if (!resourceType) return desiredState;
  if (!LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST.includes(resourceType)) {
    return desiredState;
  }
  const plugin = defaultPluginRegistry.get(resourceType);
  if (!plugin || !plugin.defaults) return desiredState;
  const keys = Object.keys(plugin.defaults);
  if (keys.length === 0) return desiredState;
  const result: Record<string, unknown> = { ...desiredState };
  for (const key of keys) {
    const defaultValue = plugin.defaults[key];
    if (defaultValue === undefined) continue;
    const existing = result[key];
    if (isEmptyLeaf(existing)) {
      // Slot is empty — place the plugin default wholesale.
      result[key] = defaultValue;
      continue;
    }
    // Slot has content. For object-valued plugin defaults, deep-merge
    // missing sub-keys so partial LLM shells still surface the default.
    if (
      defaultValue !== null &&
      typeof defaultValue === "object" &&
      !Array.isArray(defaultValue) &&
      existing !== null &&
      typeof existing === "object" &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMergeDefault(
        existing as Record<string, unknown>,
        defaultValue as Record<string, unknown>,
      );
    }
    // Otherwise the LLM / user value is a non-empty primitive or array
    // — keep it untouched (user/LLM wins).
  }
  return result;
}

/**
 * Resolves the plugin field matching `key`. Prefers the `showIf`-matching
 * variant (so conditional fields with the same name don't get short-circuited
 * by a stale branch), then falls back to any field with that name.
 */
function resolveFieldForKey(
  allFields: ResourceField[],
  key: string,
  elicitedOptions: Record<string, unknown>,
): ResourceField | undefined {
  return (
    allFields.find((f) => {
      if (f.name !== key) return false;
      if (!f.question.showIf) return true;
      const { field: depField, value: depValue } = f.question.showIf;
      return elicitedOptions[depField] === depValue;
    }) ?? allFields.find((f) => f.name === key)
  );
}
