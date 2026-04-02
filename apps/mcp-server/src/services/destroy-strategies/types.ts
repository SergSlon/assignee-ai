/**
 * Destroy strategy interface for resource-type-specific destroy behavior.
 *
 * Each strategy encapsulates:
 * - CloudControl identifier resolution (ARN vs extracted name vs custom)
 * - Pre-destroy actions (detach, disable protection, etc.)
 * - Polling configuration (standard vs extended for slow deletes)
 *
 * @see Story 18.5 (CLI destroy), Epic 20 (MCP tools)
 */

export interface DestroyStrategy {
  /** CloudFormation resource type, e.g. "AWS::EC2::InternetGateway" */
  resourceType: string;

  /** Whether to use the full ARN as the CloudControl Identifier (vs extracted name/id) */
  usesArnIdentifier?: boolean;

  /** Whether this resource takes longer to delete (extended polling: 300 attempts vs 60) */
  isSlow?: boolean;

  /**
   * Custom CloudControl identifier extraction from ARN.
   * Only needed when the default extraction (last ARN segment) is insufficient.
   * Return value is used as `DeleteResourceCommand.Identifier`.
   */
  extractIdentifier?(arn: string, region: string): string;

  /**
   * Pre-destroy actions executed before the CloudControl DeleteResource call.
   * Examples: IGW VPC detach, DynamoDB deletion protection disable.
   * Failures should be non-fatal (logged, not thrown) since CloudControl
   * will give a clearer error if the pre-condition isn't met.
   */
  preDestroy?(identifier: string, region: string): Promise<void>;
}
