/**
 * Shared list-resources types — the canonical shape for resources
 * returned by `assignee list` and the `list_managed_resources` MCP
 * tool, plus the provision-log entry shape both apps read from
 * `~/.assignee/memory/provisions.json`.
 *
 * Extracted into `@assignee/core` by Story 49.2 (Epic 49) to
 * consolidate the prior duplicated copies across apps/cli and
 * apps/mcp-server.
 */

/** Shape of a managed resource returned by the list service. */
export interface ManagedResource {
  resourceType: string;
  arn: string;
  region: string;
  createdDate: string;
  estimatedMonthlyCost: string;
  /**
   * CCAPI primaryIdentifier for resources whose `arn` is empty (non-
   * taggable constructs: AWS::EC2::Route, SubnetRouteTableAssociation,
   * VPCGatewayAttachment). Omitted for taggable resources where `arn`
   * is authoritative.
   *
   * Epic 98 e98.W1.B1 (B-02 BLOCKER).
   */
  primaryIdentifier?: string;
  /**
   * Discriminator for the identifier shape. Defaults to `"arn"` when
   * unset (backward-compatible with Epic 49's Story 49.2 shape). When
   * `"primaryIdentifier"`, `arn` is the empty string and consumers
   * should render the resource from `primaryIdentifier` + type.
   */
  keyKind?: "arn" | "primaryIdentifier";
  /**
   * bug-s3-bucket-policy-attach-failure-observability — `false` when the
   * provision log records that the apply-time
   * `attachCompensatingBucketPolicy` SDK call failed for this S3 bucket.
   * Undefined for non-S3 resources, S3 buckets where the policy attach
   * succeeded (the field is also undefined to keep the happy path
   * minimal — `assignee list` only flags the failure case), and pre-bug
   * provision records. The CLI list renderer surfaces a warning row
   * when the field is `false`.
   */
  compensatingPolicyAttached?: boolean;
  /**
   * bug-s3-bucket-policy-attach-failure-observability — human-readable
   * reason captured from the failed `PutBucketPolicy` call so the
   * `assignee list` warning row can echo the same message the operator
   * saw on stderr at apply time. Undefined when
   * `compensatingPolicyAttached` is unset or `true`.
   */
  compensatingPolicyError?: string;
}

/** Provision log entry from `~/.assignee/memory/provisions.json`. */
export interface ProvisionLogEntry {
  runId?: string;
  resourceType?: string;
  resourceArn?: string;
  region?: string;
  estimatedMonthlyCost?: string;
  timestamp?: string;
  /**
   * bug-s3-bucket-policy-attach-failure-observability — apply-time S3
   * compensating-policy outcome (S3 buckets only). See
   * `packages/core/src/schema/memory.ts` for the full contract.
   */
  compensatingPolicyAttached?: boolean;
  /** Reason captured when `compensatingPolicyAttached` is `false`. */
  compensatingPolicyError?: string;
}
