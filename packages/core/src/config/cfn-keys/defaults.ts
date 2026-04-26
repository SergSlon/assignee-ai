/**
 * Resource default values + AWS defaults used across plugins, decomposers,
 * strategies, and CLI code. Use instead of raw string literals.
 *
 * Split out of `cfn-keys.ts` for SRP / file-size compliance.
 *
 * @see Story 42.10 — zero magic strings policy
 */

/**
 * Default values for resource properties used across plugins and decomposers.
 * Use instead of raw string literals like "gp3" or "postgres".
 */
export const ResourceDefault = {
  EBS_VOLUME_TYPE: "gp3",
  RDS_ENGINE_POSTGRES: "postgres",
  /** Placeholder KeyName injected when user intent mentions SSH but no key pair is specified. */
  SSH_KEY_PLACEHOLDER: "assignee-ssh-key",
  /**
   * Placeholder SubnetId injected by the SSH-bundle intent rule.
   * Resolved at provision time to the first subnet in the account's default
   * VPC via `ensureSubnet` in resource-provisioner/subnet.ts.
   */
  SUBNET_PLACEHOLDER: "assignee-default-subnet",
  /**
   * Placeholder sentinel for SecurityGroupIds on the SSH-bundle intent rule.
   * The companion resource system (ec2-instance/config.ts) auto-creates a
   * security group when this sentinel (or any empty/placeholder array) is
   * present. The value is pre-injected as an empty array so the wizard skips
   * the Security Groups prompt.
   */
  SG_PLACEHOLDER: "assignee-default-sg",
} as const;

/**
 * AWS default values used across plugins, decomposers, strategies, and CLI code.
 * Use instead of raw string literals like "t3.micro", "application", etc.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const AwsDefault = {
  // ── EC2 ───────────────────────────────────────────────────────
  INSTANCE_TYPE: "t3.micro",
  EC2_AMI: "amazon-linux-2023",
  ARCH_X86: "x86_64",
  ARCH_ARM: "arm64",

  // ── RDS ───────────────────────────────────────────────────────
  DB_INSTANCE_CLASS: "db.t3.micro",
  RDS_ENGINE_POSTGRES: "postgres",
  RDS_ENGINE_MYSQL: "mysql",

  // ── EBS / Storage ─────────────────────────────────────────────
  EBS_VOLUME_TYPE: "gp3",

  // ── ELBv2 ─────────────────────────────────────────────────────
  LB_TYPE_APPLICATION: "application",
  LB_SCHEME_INTERNET_FACING: "internet-facing",

  // ── API Gateway V2 ────────────────────────────────────────────
  PROTOCOL_HTTP: "HTTP",
  PROTOCOL_WEBSOCKET: "WEBSOCKET",

  // ── CloudWatch / Logs ─────────────────────────────────────────
  LOG_CLASS_STANDARD: "STANDARD",
  LOG_CLASS_INFREQUENT: "INFREQUENT_ACCESS",

  // ── DynamoDB ──────────────────────────────────────────────────
  BILLING_PAY_PER_REQUEST: "PAY_PER_REQUEST",
  BILLING_PROVISIONED: "PROVISIONED",

  // ── ECS ───────────────────────────────────────────────────────
  CAPACITY_FARGATE: "FARGATE",
  CAPACITY_FARGATE_SPOT: "FARGATE_SPOT",

  // ── EFS ───────────────────────────────────────────────────────
  EFS_PERFORMANCE_GENERAL_PURPOSE: "generalPurpose",
  EFS_PERFORMANCE_MAX_IO: "maxIO",
  EFS_THROUGHPUT_BURSTING: "bursting",
  EFS_THROUGHPUT_PROVISIONED: "provisioned",
  EFS_THROUGHPUT_ELASTIC: "elastic",
  EFS_BACKUP_ENABLED: "ENABLED",
  EFS_BACKUP_DISABLED: "DISABLED",

  // ── Connectivity / Visibility ──────────────────────────────────
  CONNECTIVITY_PUBLIC: "public",
  CONNECTIVITY_PRIVATE: "private",
  LB_SCHEME_INTERNAL: "internal",

  // ── Encryption ────────────────────────────────────────────────
  ENCRYPTION_AES256: "AES256",

  // ── Lambda ────────────────────────────────────────────────────
  LAMBDA_HANDLER: "index.handler",
  LAMBDA_RUNTIME: "nodejs22.x",

  // ── SSM ───────────────────────────────────────────────────────
  SSM_TIER_STANDARD: "Standard",
} as const;

/** Generic "unknown" fallback for missing metadata fields (ARN parts, resource type, etc.). */
export const UNKNOWN_FALLBACK = "unknown" as const;

/**
 * AWS service identifier for API Gateway V2 execute endpoints (as it appears in ARNs).
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const AWS_SERVICE_EXECUTE_API = "execute-api" as const;
