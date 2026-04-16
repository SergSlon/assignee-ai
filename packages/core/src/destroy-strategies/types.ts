/**
 * Shared destroy-strategy types consumed by both `apps/cli` and
 * `apps/mcp-server`. Originally lived as parallel copies in each app's
 * `services/destroy-strategies/types.ts` — consolidated here by
 * Story 49.1 (Epic 49 code audit remediation).
 *
 * The interface intentionally uses the richer CLI signature
 * (`DestroyContext` with `onProgress`/`warn` callbacks, plus
 * `destroy`/`postDestroy` hooks) so every caller can express the same
 * behavior. The MCP dispatcher builds a `DestroyContext` from its
 * resolved identifier + operator credentials before invoking the
 * registered strategy hook.
 */

/** Minimal AWS credential + region bundle passed into every hook. */
export interface AwsConfig {
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

/** AWS CloudControl API operation status values. */
export const CCAPIStatus = {
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
} as const;

/** CloudControl HandlerErrorCode for "resource does not exist". */
export const CCAPI_NOT_FOUND_ERROR_CODE = "NotFound";

/**
 * Minimal view of the resource being destroyed, visible to every
 * strategy hook. Sourced directly from the dispatcher's input.
 */
export interface DestroyResourceInput {
  arn: string;
  resourceType: string;
  /** CloudControl identifier (typically the extracted name/id, but may be an ARN). */
  identifier: string;
  /** Originally requested region ("global" promotion happens in the dispatcher). */
  region: string;
}

/**
 * Partial-result shape returned by the full-destroy hook. The
 * dispatcher combines this with resource metadata to produce the final
 * caller-visible result.
 */
export interface DestroyHookOutcome {
  success: boolean;
  error?: string;
}

/**
 * Execution context passed to every strategy hook. Contains the
 * resolved AWS region, operator credentials, user-facing progress
 * callback, and a structured warn logger so strategies don't depend on
 * private dispatcher helpers.
 */
export interface DestroyContext {
  resource: DestroyResourceInput;
  /** Fully populated operator AwsConfig — already region-promoted. */
  awsConfig: AwsConfig;
  /** Effective region after "global" → canonical region promotion. */
  effectiveRegion: string;
  /** Optional user-facing progress callback — may be undefined in silent mode. */
  onProgress?: (message: string) => void;
  /**
   * Structured warn-level log callback. Non-fatal strategy failures
   * (EFS mount-target cleanup, IGW partial detach, ALB ENI drain
   * failure) emit via this channel.
   */
  warn: (action: string, extras: Record<string, unknown>) => void;
}

export interface DestroyStrategy {
  /** CloudFormation resource type, e.g. "AWS::SNS::Topic". */
  resourceType: string;

  /**
   * Whether to use the full ARN as the CloudControl Identifier (vs the
   * extracted name/id). Some CCAPI types require the ARN (TopicArn,
   * LoadBalancerArn, Arn, etc.) — passing a bare name returns NotFound.
   */
  usesArnIdentifier?: boolean;

  /**
   * Whether this resource takes longer to delete. Dispatcher callers
   * use this to extend polling caps (e.g. ELBv2 LoadBalancer ENI
   * drain, RDS instance deletion).
   */
  isSlow?: boolean;

  /**
   * Custom CloudControl identifier extraction. Default behavior is
   * "use resource.identifier as-is (or resource.arn when
   * usesArnIdentifier === true)". Override when a CCAPI type needs
   * something derived (e.g. SQS QueueUrl synthesized from ARN parts).
   */
  extractIdentifier?(arn: string, identifier: string, region: string): string;

  /**
   * Pre-destroy hook executed before the CloudControl DeleteResource
   * call. Examples: IGW VPC detach, DynamoDB deletion-protection
   * disable, S3 bucket empty. A resolved `DestroyHookOutcome` with
   * `success: false` aborts the destroy and is returned to the
   * caller; `undefined` or `{ success: true }` proceeds to the CCAPI
   * path.
   */
  preDestroy?(context: DestroyContext): Promise<DestroyHookOutcome | void>;

  /**
   * Full replacement for the generic CloudControl delete path. When
   * defined the dispatcher invokes this instead of CCAPI. Used for
   * types whose delete handler is unreliable (EIP) or cannot be
   * driven through CCAPI at all (CloudFront disable-then-delete
   * dance).
   */
  destroy?(context: DestroyContext): Promise<DestroyHookOutcome>;

  /**
   * Post-destroy hook executed after a SUCCESSFUL CCAPI delete (or a
   * successful `destroy` hook). Example: ALB ENI drain wait. Never
   * fails the overall destroy — failures are logged via `context.warn`.
   */
  postDestroy?(context: DestroyContext): Promise<void>;
}
