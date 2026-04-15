/**
 * Destroy strategy interface for CLI resource-type-specific destroy behavior.
 *
 * Mirrors the shape used in
 * `apps/mcp-server/src/services/destroy-strategies/types.ts` so the two
 * codebases stay consistent. F1b extended the interface with a full
 * replacement `destroy` hook (for EIP/CloudFront which bypass CCAPI
 * entirely) and a `postDestroy` hook (for ALB ENI drain).
 *
 * Each strategy encapsulates:
 * - CloudControl identifier resolution (ARN vs extracted name vs custom)
 * - Pre-destroy actions (detach, disable protection, empty bucket, etc.)
 * - Full custom destroy (EIP ReleaseAddress, CloudFront disable+delete)
 * - Post-destroy actions (ENI drain, propagation waits)
 * - Polling configuration hints (`isSlow` — extended polling cap)
 *
 * @see Wave-6 F1a — CLI destroy-service SOLID refactor (part 1)
 * @see Wave-6 F1b — hooks migration (part 2)
 */

import type { AwsConfig } from "../cloudcontrol-client.js";

/**
 * Minimal view of the resource being destroyed, visible to every
 * strategy hook. Sourced directly from the caller's input to
 * `destroySingleResource(...)`.
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
 * Lightweight partial-result shape returned by the full-destroy hook.
 * The dispatcher combines this with resource metadata to produce the
 * final `DestroyResult`.
 */
export interface DestroyHookOutcome {
  success: boolean;
  error?: string;
}

/**
 * Execution context passed to every strategy hook. Contains the
 * resolved AWS region, operator credentials, user-facing progress
 * callback, and a structured warn logger so strategies don't depend
 * on private destroy-service helpers.
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
   * Whether to use the full ARN as the CloudControl Identifier
   * (vs the extracted name/id). Mirrors MCP's `usesArnIdentifier`.
   */
  usesArnIdentifier?: boolean;

  /**
   * Whether this resource takes longer to delete. Dispatcher callers
   * may use this to extend polling caps. Currently advisory — F1b will
   * promote this to an effective poll-cap override.
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
   * `success: false` aborts the destroy and is returned to the caller;
   * `undefined` or `{ success: true }` proceeds to the CCAPI path.
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
