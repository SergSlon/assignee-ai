import type { ExecutionStatusType } from "../schema/graph-state.js";

/**
 * Outcome of provisioning a single resource within a compound provisioning loop.
 * Accumulated in `state.completedResources` as each resource completes or fails.
 */
export interface ResourceResult {
  /** Logical resource ID from the pattern definition, e.g. "lambda-execution-role" */
  resourceId: string;
  /** CloudFormation resource type, e.g. RESOURCE_TYPES.IAM_ROLE */
  resourceType: string;
  /** ARN of the created resource (undefined if provisioning failed) */
  resourceArn?: string;
  /** Final execution status for this resource */
  executionStatus: ExecutionStatusType;
}

/**
 * Specification for a single AWS resource within an architecture pattern.
 * The `resourceId` is the logical name used in `dependencyOrder` ordering.
 */
export interface ResourceSpec {
  /** CloudFormation resource type, e.g. RESOURCE_TYPES.LAMBDA_FUNCTION */
  resourceType: string;
  /** Logical identifier within the pattern, e.g. "lambda-execution-role" (used in dependencyOrder) */
  resourceId: string;
  /** Human-readable display name, e.g. "Lambda Execution Role" */
  displayName: string;
  /**
   * Whether this resource can be provisioned via CloudControl API.
   * Defaults to true when omitted. Set to false for display-only resources that require
   * manual configuration and cannot be provisioned via CloudControl
   * (e.g. AWS::ApiGatewayV2::Api requires domain/route config from the user).
   */
  provisionable?: boolean;
}

/**
 * Describes a compound architecture pattern that assignee.ai can recognize and provision as a unit.
 * Consumed by PatternRegistry.detect() (intent-parser) and compound-dispatcher node (Story 8.2).
 *
 * @see pattern-templates/patterns/ for 5 canonical pattern implementations
 */
export interface ArchitecturePattern {
  /** Unique pattern identifier (kebab-case), e.g. "serverless-api" */
  patternId: string;
  /** Human-readable name, e.g. "Serverless API" */
  displayName: string;
  /**
   * Natural language keywords triggering this pattern (case-insensitive substring match).
   * Must contain ≥5 variants. Order matters — first match wins across all patterns.
   */
  keywords: string[];
  /**
   * Negative keywords that DISQUALIFY this pattern even when a positive
   * keyword matches. Case-insensitive substring match. Used to prevent
   * bare or explicitly-standalone intents from ballooning into compound
   * patterns that drag in expensive infrastructure (e.g. a $32.85/mo
   * NAT Gateway on bare "Create a VPC"). Examples:
   *   - `serverless-api` adds "websocket" so "serverless websocket API"
   *     falls through to the dedicated websocket-api pattern.
   *   - `efs-with-vpc` adds "standalone" so
   *     "Create a standalone EFS file system" routes to the bare
   *     AWS::EFS::FileSystem type (where the user will be told via
   *     intent-parser that they need mount targets).
   *
   * When omitted, no negative filtering is applied (backward compatible).
   * Checked AFTER positive keyword match — a pattern with a positive
   * hit but ANY negative hit is skipped, and the registry continues
   * scanning for a later pattern.
   */
  negativeKeywords?: readonly string[];
  /** Ordered list of all resources in the pattern */
  resourceList: ResourceSpec[];
  /**
   * Provisioning order groups. Each inner array is a group of resourceIds that can be
   * provisioned in parallel. Groups are sequential — group[0] finishes before group[1] starts.
   * All resourceId values MUST appear in resourceList.
   *
   * @example [["iam-execution-role"], ["lambda-fn", "dynamodb-table"], ["api-gateway"]]
   */
  dependencyOrder: string[][];
  /**
   * Default configuration values per resourceId. Keys are resourceId values from resourceList.
   * Merged with user-elicited options in Story 8.2's compound-dispatcher node.
   */
  defaultOptions: Record<string, Record<string, unknown>>;
}
