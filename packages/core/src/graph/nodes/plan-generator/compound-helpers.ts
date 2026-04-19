/**
 * Helpers for compound-plan.ts — separated so the orchestrator stays
 * inside the SRP size budget. Each helper has one reason to change:
 *   - `injectCompoundResourceName` → CFN naming-property map changes
 *   - `injectLambdaRoleArn` → Lambda ↔ IAM cross-reference / STS contract
 *   - `readCompoundPatternMemoryHints` → pattern-memory storage format
 *   - `injectPluginRequiredDefaults` → plugin-default safety-net policy
 *   - `postProcessEc2Compound` → EC2 SG/SSH scrub rules
 */
import {
  defaultPluginRegistry,
  RESOURCE_TYPES,
  CfnKey,
  ResourceDefault,
  parseMarker,
  getPartitionFromRegion,
} from "@/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { defaultMemoryService } from "@/services/memory.js";
import { tryAssigneeCredentials } from "@/config/aws-credentials.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import type { AgentState } from "../../graph-state.js";

/**
 * CFN naming property per resource type. CloudControl generates random
 * names when these are absent, which is bad for compound patterns because
 * (a) the names aren't recognizable in the console, and (b) some resources
 * (EventBridge Rule, ELBv2 LoadBalancer) have createOnly Name fields whose
 * nullability triggers Java NPEs in the CCAPI backend.
 */
const NAME_FIELDS: Record<string, string> = {
  [RESOURCE_TYPES.SQS_QUEUE]: CfnKey.QUEUE_NAME,
  [RESOURCE_TYPES.DYNAMODB_TABLE]: CfnKey.TABLE_NAME,
  [RESOURCE_TYPES.IAM_ROLE]: CfnKey.ROLE_NAME,
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: CfnKey.FUNCTION_NAME,
  [RESOURCE_TYPES.S3_BUCKET]: CfnKey.BUCKET_NAME,
  [RESOURCE_TYPES.SNS_TOPIC]: CfnKey.TOPIC_NAME,
  [RESOURCE_TYPES.EVENTS_RULE]: CfnKey.NAME,
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: CfnKey.NAME,
};

type QueuedResource = NonNullable<AgentState["resourceQueue"]>[number];

/** Injects a human-readable CFN Name (or equivalent) for compound resources. */
export function injectCompoundResourceName(
  desiredState: Record<string, unknown>,
  currentResource: QueuedResource,
  runId: string,
): void {
  const shortId = runId.slice(0, 8);
  const resourceId = currentResource.resourceId;
  const nameField = NAME_FIELDS[currentResource.resourceType];
  if (nameField && !desiredState[nameField]) {
    desiredState[nameField] = `assignee-${resourceId}-${shortId}`.toLowerCase();
  }

  // CloudFront OAC has its name nested inside OriginAccessControlConfig.Name.
  // Without a unique suffix, repeated test runs collide on the static
  // "assignee-static-website-oac" name and CCAPI rejects with "already exists".
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
}

/**
 * Lambda+IAM-role: CloudControl only returns the role NAME, but Lambda
 * needs the full role ARN. Constructs the ARN via STS GetCallerIdentity
 * (partition-aware), with graceful fallback when operator creds missing.
 */
export async function injectLambdaRoleArn(
  desiredState: Record<string, unknown>,
  currentResource: QueuedResource,
  state: AgentState,
): Promise<void> {
  // A pattern may seed `desiredState.Role` with a marker token like
  // `__ASSIGNEE_GETATT_iam-execution-role_Arn__`. The generic marker
  // resolver further down would replace it with the bare role NAME, but
  // Lambda requires the full role ARN. Detect the marker and treat it
  // like a missing Role so the STS-based ARN construction runs.
  const existingRoleValue = desiredState[CfnKey.ROLE];
  const roleIsMarker =
    typeof existingRoleValue === "string" &&
    parseMarker(existingRoleValue) !== undefined;
  if (roleIsMarker) {
    delete desiredState[CfnKey.ROLE];
  }
  if (!state.completedResources || state.completedResources.length === 0) {
    return;
  }
  if (currentResource.resourceType !== RESOURCE_TYPES.LAMBDA_FUNCTION) return;
  if (desiredState[CfnKey.ROLE]) return;

  const role = state.completedResources.find(
    (r) => r.resourceType === RESOURCE_TYPES.IAM_ROLE,
  );
  if (!role?.resourceArn) return;

  const roleName = String(role.resourceArn);
  if (roleName.startsWith("arn:")) {
    desiredState[CfnKey.ROLE] = roleName;
    return;
  }

  // Precondition: only call STS when operator credentials are configured.
  // Previously a try/catch swallowed MissingAssigneeCredentialsError — so
  // the plan silently proceeded with a bare role NAME instead of an ARN,
  // and CloudControl later failed with a non-obvious error.
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
    return;
  }
  try {
    const { STSClient, GetCallerIdentityCommand } =
      await import("@aws-sdk/client-sts");
    const region = AWS_REGION;
    const sts = new STSClient({ region, credentials: operatorCreds });
    const identity = await sts.send(new GetCallerIdentityCommand({}));
    // Partition detection covers commercial, GovCloud, China, ISO, ISOB.
    const partition = getPartitionFromRegion(region);
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

/**
 * Story 19.5: reads compound-pattern memory to produce a "Using your usual X
 * defaults" hint when the current pattern has been used before. Non-blocking.
 */
export async function readCompoundPatternMemoryHints(
  state: AgentState,
): Promise<string[]> {
  const hints: string[] = [];
  try {
    const patterns = await defaultMemoryService.readPatterns();
    const previousPattern = patterns.find(
      (p) => p.pattern === state.resourcePattern!.patternId,
    );
    if (previousPattern && previousPattern.count > 0) {
      const dateStr = new Date(previousPattern.lastUsed).toLocaleDateString();
      hints.push(
        `Using your usual ${previousPattern.pattern} defaults (used ${previousPattern.count} times, last ${dateStr})`,
      );
    }
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId: state.runId,
      level: "info",
      action: LOG_ACTIONS.MEMORY_WRITE_FAILED,
      extras: { phase: "read_patterns_compound", error: String(err) },
    });
  }
  return hints;
}

/**
 * Wave 19 Bug #1 safety net: inject plugin-level defaults for any required
 * CFN field that the pattern template forgot. Uses `required: true` from
 * plugin.commonFields to narrowly target CFN-required fields, and calls
 * each field's `toCfn` before injection so wizard-only discriminators
 * (e.g. AWS::EC2::Route `RouteType`) map to undefined and stay out of CCAPI.
 */
export function injectPluginRequiredDefaults(
  desiredState: Record<string, unknown>,
  currentResource: QueuedResource,
  runId: string,
): void {
  try {
    const plugin = defaultPluginRegistry.get(currentResource.resourceType);
    if (!plugin) return;

    const fieldByName = new Map(
      plugin.commonFields.map((f) => [f.name, f] as const),
    );
    const requiredFieldNames = new Set<string>(
      plugin.commonFields.filter((f) => f.required === true).map((f) => f.name),
    );
    const injectedFromPluginDefaults: string[] = [];
    for (const [key, rawValue] of Object.entries(plugin.defaults)) {
      if (!requiredFieldNames.has(key)) continue;
      if (desiredState[key] !== undefined) continue;
      if (rawValue === undefined) continue;
      const field = fieldByName.get(key);
      const cfnValue = field?.toCfn ? field.toCfn(rawValue) : rawValue;
      if (cfnValue === undefined) continue;
      desiredState[key] = cfnValue;
      injectedFromPluginDefaults.push(key);
    }
    if (injectedFromPluginDefaults.length > 0) {
      log({
        ts: new Date().toISOString(),
        runId,
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
  } catch (err) {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "info",
      action: LOG_ACTIONS.PLAN_GENERATED,
      extras: {
        phase: "compound_plugin_defaults_skipped",
        resourceType: currentResource.resourceType,
        error: String(err),
      },
    });
  }
}

/**
 * EC2 post-processing for compound mode — mirrors the standalone path.
 * Strips empty/placeholder SecurityGroupIds and injects KeyName placeholder
 * for SSH-intent flows.
 */
export function postProcessEc2Compound(
  desiredState: Record<string, unknown>,
  currentResource: QueuedResource,
  userIntent: string | undefined,
): void {
  if (currentResource.resourceType !== RESOURCE_TYPES.EC2_INSTANCE) return;
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
  if (userIntent && /\bssh\b/i.test(userIntent)) {
    if (!desiredState[CfnKey.KEY_NAME]) {
      desiredState[CfnKey.KEY_NAME] = ResourceDefault.SSH_KEY_PLACEHOLDER;
    }
  }
}
