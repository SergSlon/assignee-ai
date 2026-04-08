/**
 * SDKFallbackDispatcher — handles resource types with known CCAPI gaps.
 * Routes to native AWS SDK calls for types that Cloud Control API cannot provision.
 *
 * Follows the same Result tuple pattern as ProvisioningPort for consistency.
 * Uses ASSIGNEE_OPERATOR_* credentials for provisioning.
 *
 * @see Story 7.7 — SDK Fallback Dispatcher for CCAPI Gaps
 * @see A6 (2026-04-08) — Lambda EventSourceMapping and SNS Topic delete
 *      migrated to CCAPI after live-AWS probes confirmed full support.
 *      SNS Subscription is the only remaining SDK-routed type.
 */

import {
  SNSClient,
  SubscribeCommand,
  UnsubscribeCommand,
} from "@aws-sdk/client-sns";
import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_SDK_ROUTABLE_TYPES,
  CCAPI_REDIRECT_TYPES,
  ConfigurationError,
  CfnKey,
} from "@assignee/core";
import {
  ProvisioningErrorKind,
  type ProvisioningPortError,
} from "./provisioning-port.js";
import type { AwsConfig } from "./cloudcontrol-client.js";
import { AWS_REGION, CredentialError } from "../config/constants.js";
import { AwsErrorName } from "../constants/aws-errors.js";

/** Result type alias following error-first tuple convention. */
type FallbackResult<T> = [ProvisioningPortError, null] | [null, T];

/** Redirect info returned when a resource type is unsupported but has a known alternative. */
export interface RedirectInfo {
  redirect: true;
  message: string;
}

/**
 * Dispatches provisioning calls to native AWS SDK for resource types
 * that cannot be provisioned through Cloud Control API.
 *
 * Supported SDK routes:
 *   - AWS::SNS::Subscription → SNS SDK SubscribeCommand
 *
 * Redirect types (return error with guidance):
 *   - AWS::Lambda::Permission → use AWS::Lambda::PermissionPolicy
 *   - AWS::ElastiCache::ReplicationGroup → use AWS::ElastiCache::ServerlessCache
 */
export class SDKFallbackDispatcher {
  private readonly snsClient: SNSClient;

  constructor(config: AwsConfig) {
    if (!config.accessKeyId) {
      throw new ConfigurationError(CredentialError.MISSING_ACCESS_KEY);
    }
    if (!config.secretAccessKey) {
      throw new ConfigurationError(CredentialError.MISSING_SECRET_KEY);
    }

    const credentials = {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    };

    const region = config.region || AWS_REGION;

    this.snsClient = new SNSClient({
      region,
      credentials,
    });
  }

  /**
   * Returns true if the given resource type can be handled by direct SDK calls.
   * @param resourceType - CloudFormation resource type string
   */
  canHandle(resourceType: string): boolean {
    return (CCAPI_SDK_ROUTABLE_TYPES as readonly string[]).includes(
      resourceType,
    );
  }

  /**
   * Returns redirect info if the resource type is unsupported and has a known alternative.
   * Returns null if the type is not a redirect type.
   * @param resourceType - CloudFormation resource type string
   */
  isRedirect(resourceType: string): RedirectInfo | null {
    const alternative = CCAPI_REDIRECT_TYPES[resourceType];
    if (!alternative) return null;

    if (resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_PERMISSION) {
      return {
        redirect: true,
        message: `AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.`,
      };
    }

    if (resourceType === CCAPI_FALLBACK_TYPES.ELASTICACHE_REPLICATION_GROUP) {
      return {
        redirect: true,
        message: `ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.`,
      };
    }

    return {
      redirect: true,
      message: `${resourceType} is not supported by CCAPI. Use ${alternative} instead.`,
    };
  }

  /**
   * Returns true if the given resource type can be deleted by direct SDK calls.
   * Mirrors canHandle() for delete operations.
   * @param resourceType - CloudFormation resource type string
   */
  canDelete(resourceType: string): boolean {
    return (CCAPI_SDK_ROUTABLE_TYPES as readonly string[]).includes(
      resourceType,
    );
  }

  /**
   * Unsubscribes an SNS Subscription via the SNS SDK.
   *
   * @param subscriptionArn - The subscription ARN to remove
   * @returns Error-first tuple with void result on success
   */
  async unsubscribe(
    subscriptionArn: string,
  ): Promise<FallbackResult<{ success: true }>> {
    try {
      await this.snsClient.send(
        new UnsubscribeCommand({ SubscriptionArn: subscriptionArn }),
      );
      return [null, { success: true }];
    } catch (err) {
      return [classifySdkError(err), null];
    }
  }

  /**
   * Creates an SNS Subscription via the SNS SDK.
   *
   * @param desiredState - Resource properties matching CloudFormation schema
   * @returns Error-first tuple with the subscription ARN as identifier on success
   */
  async subscribe(
    desiredState: Record<string, unknown>,
  ): Promise<FallbackResult<{ identifier: string }>> {
    try {
      const command = new SubscribeCommand({
        TopicArn: desiredState[CfnKey.TOPIC_ARN] as string,
        Protocol: desiredState[CfnKey.PROTOCOL] as string,
        Endpoint: desiredState[CfnKey.ENDPOINT] as string,
        ReturnSubscriptionArn: true,
      });

      const result = await this.snsClient.send(command);

      if (!result.SubscriptionArn) {
        return [
          {
            kind: ProvisioningErrorKind.UNKNOWN,
            message: "SubscribeCommand returned no SubscriptionArn",
          },
          null,
        ];
      }

      return [null, { identifier: result.SubscriptionArn }];
    } catch (err) {
      return [classifySdkError(err), null];
    }
  }
}

/**
 * Classifies a generic SDK error into a ProvisioningPortError.
 * @param err - The caught error from an AWS SDK call
 */
function classifySdkError(err: unknown): ProvisioningPortError {
  if (err instanceof Error) {
    const name = err.name;
    if (
      name === AwsErrorName.RESOURCE_NOT_FOUND ||
      name === AwsErrorName.NOT_FOUND
    ) {
      return { kind: ProvisioningErrorKind.NOT_FOUND, message: err.message };
    }
    if (
      name === AwsErrorName.RESOURCE_CONFLICT ||
      name === AwsErrorName.INVALID_PARAMETER
    ) {
      return {
        kind: ProvisioningErrorKind.ALREADY_EXISTS,
        message: err.message,
      };
    }
    if (
      name === AwsErrorName.TOO_MANY_REQUESTS ||
      name === AwsErrorName.THROTTLING
    ) {
      return { kind: ProvisioningErrorKind.THROTTLED, message: err.message };
    }
    if (name === AwsErrorName.SERVICE_EXCEPTION) {
      return {
        kind: ProvisioningErrorKind.SERVICE_ERROR,
        message: err.message,
      };
    }
    return { kind: ProvisioningErrorKind.UNKNOWN, message: err.message };
  }
  return { kind: ProvisioningErrorKind.UNKNOWN, message: String(err) };
}
