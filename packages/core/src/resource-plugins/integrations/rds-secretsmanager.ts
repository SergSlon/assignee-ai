/**
 * RDS + SecretsManager integration hook.
 *
 * Detects AWS::RDS::DBInstance in a plan and auto-suggests a companion
 * AWS::SecretsManager::Secret for the MasterUserPassword, plus a
 * SecretTargetAttachment for rotation support.
 *
 * @see Story 26.5 — SecretsManager + RDS Integration
 */

import {
  RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "../../config/resource-types.js";
import { CfnKey } from "../../config/cfn-keys.js";

/** Characters excluded from generated passwords for RDS compatibility. */
export const RDS_SAFE_EXCLUDE_CHARACTERS = "/@\"\\'";

/** Default password length for generated secrets. */
export const DEFAULT_PASSWORD_LENGTH = 32;

/** SecretsManager dynamic reference format for CloudFormation. */
export function secretDynamicReference(secretLogicalId: string): string {
  return `{{resolve:secretsmanager:\${${secretLogicalId}}:SecretString:password}}`;
}

/** Result of the RDS-SecretsManager integration analysis. */
export interface RdsSecretsIntegrationResult {
  /** Whether SecretsManager should be suggested for this RDS instance. */
  shouldSuggest: boolean;
  /** The companion Secret resource (if shouldSuggest is true). */
  secretResource?: {
    logicalId: string;
    type: string;
    properties: Record<string, unknown>;
  };
  /** The companion SecretTargetAttachment (if shouldSuggest is true). */
  attachmentResource?: {
    logicalId: string;
    type: string;
    properties: Record<string, unknown>;
  };
  /** The dynamic reference to inject into RDS MasterUserPassword. */
  dynamicReference?: string;
  /** Whether user explicitly provided a password (opt-out scenario). */
  userProvidedPassword: boolean;
}

/**
 * Analyze an RDS plan and determine if SecretsManager integration is needed.
 *
 * @param rdsDesiredState - The desiredState of the RDS::DBInstance resource
 * @param rdsLogicalId    - The logical ID of the RDS instance in the plan
 * @returns Integration result with companion resources or opt-out info
 */
export function analyzeRdsSecretsIntegration(
  rdsDesiredState: Record<string, unknown>,
  rdsLogicalId: string = "DatabaseInstance",
): RdsSecretsIntegrationResult {
  const masterPassword = rdsDesiredState[CfnKey.MASTER_USER_PASSWORD];

  // If user explicitly provided a password, respect their choice
  if (
    masterPassword !== undefined &&
    masterPassword !== null &&
    masterPassword !== ""
  ) {
    return {
      shouldSuggest: false,
      userProvidedPassword: true,
    };
  }

  const secretLogicalId = `${rdsLogicalId}Secret`;
  const attachmentLogicalId = `${rdsLogicalId}SecretAttachment`;

  return {
    shouldSuggest: true,
    userProvidedPassword: false,
    secretResource: {
      logicalId: secretLogicalId,
      type: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
      properties: {
        Name: `rds/${rdsLogicalId}/credentials`,
        Description: `Auto-generated credentials for RDS instance ${rdsLogicalId}`,
        GenerateSecretString: {
          SecretStringTemplate: JSON.stringify({ username: "admin" }),
          GenerateStringKey: "password",
          PasswordLength: DEFAULT_PASSWORD_LENGTH,
          ExcludeCharacters: RDS_SAFE_EXCLUDE_CHARACTERS,
        },
      },
    },
    attachmentResource: {
      logicalId: attachmentLogicalId,
      type: COMPANION_RESOURCE_TYPES.SECRETSMANAGER_SECRET_TARGET_ATTACHMENT,
      properties: {
        SecretId: { Ref: secretLogicalId },
        TargetId: { Ref: rdsLogicalId },
        TargetType: RESOURCE_TYPES.RDS_DB_INSTANCE,
      },
    },
    dynamicReference: secretDynamicReference(secretLogicalId),
  };
}

/**
 * Check if a plan contains an RDS instance that needs SecretsManager.
 *
 * @param planResources - Array of { resourceType, desiredState } from the plan
 * @returns true if any RDS instance lacks a MasterUserPassword
 */
export function planNeedsRdsSecretsIntegration(
  planResources: Array<{
    resourceType: string;
    desiredState: Record<string, unknown>;
  }>,
): boolean {
  return planResources.some(
    (r) =>
      r.resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE &&
      !r.desiredState[CfnKey.MASTER_USER_PASSWORD],
  );
}
