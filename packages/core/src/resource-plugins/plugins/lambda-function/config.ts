import { RESOURCE_TYPES } from "@/config/resource-types.js";
import { CfnKey, AwsDefault } from "@/config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../../types.js";
import { runtimeOptions, buildRuntimeHint } from "./runtimes.js";

export const defaults: ResourcePlugin["defaults"] = {
  [CfnKey.MEMORY_SIZE]: 128,
  [CfnKey.TIMEOUT]: 30,
  [CfnKey.RUNTIME]: AwsDefault.LAMBDA_RUNTIME,
  [CfnKey.HANDLER]: AwsDefault.LAMBDA_HANDLER,
  [CfnKey.ARCHITECTURES]: [AwsDefault.ARCH_X86],
  [CfnKey.EPHEMERAL_STORAGE]: { Size: 512 },
  // A8 follow-up: default to Active X-Ray tracing so BP-LAMBDA-015
  // (TracingConfig.Mode=Active) passes on fresh plans without
  // requiring the autoFix pass. The AWSXRayDaemonWriteAccess actions
  // are already covered by the PowerUserAccess PermissionsBoundary
  // shipped with the Lambda-bearing compound patterns, so enabling
  // tracing at the plan default level is a zero-friction observability
  // gain.
  TracingConfig: { Mode: "Active" },
  // Story E2E.3: Placeholder Code for noWizard/MCP mode.
  // Lambda cannot be created without Code; repairer injects this when
  // LLM omits it.
  [CfnKey.CODE]: {
    ZipFile:
      "exports.handler = async (event) => ({ statusCode: 200, body: 'placeholder' });",
  },
};

/**
 * Auto-provisions a CloudWatch LogGroup at `/aws/lambda/<functionName>`
 * with the user-provided retention (defaults to 14 days) — ensures
 * BP-LAMBDA observability gates pass without requiring manual wiring.
 */
export function companionResources(
  desiredState: Record<string, unknown>,
): CfnOutput[] {
  const functionName = desiredState[CfnKey.FUNCTION_NAME];
  if (typeof functionName !== "string" || !functionName) return [];

  const retention =
    typeof desiredState[CfnKey.LOG_RETENTION_IN_DAYS] === "number"
      ? desiredState[CfnKey.LOG_RETENTION_IN_DAYS]
      : 14;

  const sanitized = functionName.replace(/[^a-zA-Z0-9]/g, "");
  return [
    {
      logicalId: `${sanitized}LogGroup`,
      type: RESOURCE_TYPES.LOGS_LOG_GROUP,
      properties: {
        [CfnKey.LOG_GROUP_NAME]: `/aws/lambda/${functionName}`,
        [CfnKey.RETENTION_IN_DAYS]: retention,
      },
    },
  ];
}

export const configHints: ResourcePlugin["configHints"] = [
  buildRuntimeHint(runtimeOptions),
  "Lambda Role: if the user did not provide a specific IAM role ARN, OMIT the Role property — do NOT invent placeholder ARNs",
  "Environment: must be a CloudFormation Environment object with a Variables map, e.g. { Variables: { KEY: 'value' } }. Parse comma-separated KEY=VALUE input.",
  "Architectures: must be an array with exactly one element — either ['x86_64'] or ['arm64']. arm64 (Graviton) is ~20% cheaper.",
  "EphemeralStorage: must be an object { Size: <number> } where Size is one of 512, 1024, 2048, 4096, 10240 MB. Default 512 MB is free.",
  "VpcConfig: if VpcSubnetIds are provided, emit a single VpcConfig object combining SubnetIds and SecurityGroupIds arrays. Do NOT set VpcConfig without subnets.",
  "Layers: must be an array of full Lambda Layer ARNs including version number. Max 5 layers.",
];
