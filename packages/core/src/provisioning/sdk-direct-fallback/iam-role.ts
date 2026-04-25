/**
 * SDK-direct fallback adapter for AWS::IAM::Role.
 *
 * W5-04 (P055 → L5-S08): Used when CCAPI is not available in the operator's
 * partition but the IAM service itself is available (GovCloud, ISO, ISO-E).
 *
 * IAM is a global service — no region required for the API call, but the SDK
 * client still needs a region for signing. Uses the operator's configured region.
 *
 * Scope / deferral:
 *   - Creates a role with AssumeRolePolicyDocument and optional Description.
 *   - Inline policies, managed policy attachments, and instance profiles are
 *     Epic 102+ scope (CCAPI handles these via CloudFormation property mapping).
 *   - Delete, update, getResource are CCAPI-delegated in commercial; Epic 102+
 *     for non-commercial.
 *
 * @see https://docs.aws.amazon.com/IAM/latest/APIReference/API_CreateRole.html
 */

import { IAMClient, CreateRoleCommand } from "@aws-sdk/client-iam";
import { operatorCredentials } from "../../config/operator-credentials.js";
import { AWS_REGION } from "../../config/constants/aws.js";

/** Synthetic requestToken sentinel — signals immediate success to the poller. */
export const SDK_DIRECT_COMPLETE_TOKEN = "SDK_DIRECT_COMPLETE";

export interface SdkDirectResult {
  requestToken: string;
  identifier: string;
}

/**
 * Creates an IAM role via the direct AWS SDK (not CloudControl).
 *
 * @param desiredStateJson - JSON string of CloudFormation desired-state properties.
 *   Must include `"RoleName"` and `"AssumeRolePolicyDocument"` properties.
 * @param region           - AWS region for SDK signing (IAM is global).
 * @returns SdkDirectResult with a synthetic requestToken + role name identifier.
 * @throws Error with actionable message if required fields are missing.
 */
export async function createIamRoleSdkDirect(
  desiredStateJson: string,
  region: string = AWS_REGION,
): Promise<SdkDirectResult> {
  let desiredState: Record<string, unknown>;
  try {
    desiredState = JSON.parse(desiredStateJson) as Record<string, unknown>;
  } catch {
    throw new Error(
      `SDK-direct IAM Role create: desiredState is not valid JSON: ${desiredStateJson.slice(0, 120)}`,
    );
  }

  const roleName = desiredState["RoleName"];
  if (typeof roleName !== "string" || !roleName) {
    throw new Error(
      `SDK-direct IAM Role create: "RoleName" is required in desiredState but was not found. ` +
        `Provided keys: ${Object.keys(desiredState).join(", ")}`,
    );
  }

  const assumeRolePolicy = desiredState["AssumeRolePolicyDocument"];
  if (!assumeRolePolicy) {
    throw new Error(
      `SDK-direct IAM Role create: "AssumeRolePolicyDocument" is required in desiredState but was not found. ` +
        `Provided keys: ${Object.keys(desiredState).join(", ")}`,
    );
  }

  // Normalize: CCAPI accepts the policy as an object; IAM SDK requires a string.
  const policyDocument =
    typeof assumeRolePolicy === "string"
      ? assumeRolePolicy
      : JSON.stringify(assumeRolePolicy);

  const description =
    typeof desiredState["Description"] === "string"
      ? desiredState["Description"]
      : undefined;

  const creds = operatorCredentials();
  const client = new IAMClient({
    region,
    credentials: {
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      ...(creds.sessionToken ? { sessionToken: creds.sessionToken } : {}),
    },
  });

  await client.send(
    new CreateRoleCommand({
      RoleName: roleName,
      AssumeRolePolicyDocument: policyDocument,
      ...(description ? { Description: description } : {}),
    }),
  );

  return {
    requestToken: SDK_DIRECT_COMPLETE_TOKEN,
    identifier: roleName,
  };
}
