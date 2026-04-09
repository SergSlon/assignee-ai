/**
 * Cost alternative advisor — suggests cheaper resource configurations.
 * All prices come from Pricing MCP at runtime (zero hardcoded amounts).
 * When MCP is unavailable, returns structural hints without prices.
 *
 * @see Story 40.4 — Cost Alternative Advisor
 */

import { RESOURCE_TYPES, CfnKey } from "@assignee/core";
import {
  ARM_EQUIVALENTS,
  SPOT_ELIGIBLE_PREFIXES,
  RDS_LARGE_CLASS_PREFIXES,
  RDS_BUDGET_ALTERNATIVES,
  LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB,
  AdviceIcon,
} from "./constants.js";

/**
 * Generates cost optimization hints based on the resource configuration.
 * Does NOT call Pricing MCP directly — that's Story 40.2 (MCP enrichment).
 * For now, returns structural cost advice that doesn't need runtime prices.
 */
export function costAlternatives(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string[] {
  const hints: string[] = [];

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    ec2CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    rdsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    s3CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    lambdaCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    dynamodbCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY) {
    hints.push(
      `${AdviceIcon.COST} NAT Gateway costs ~$32/mo fixed + data processing fees \u2014 consider VPC endpoints for S3/DynamoDB to reduce data transfer through NAT`,
    );
  } else if (resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER) {
    hints.push(
      `${AdviceIcon.COST} ALB costs ~$16/mo fixed + LCU charges \u2014 for simple routing, consider using API Gateway instead`,
    );
  } else if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    sqsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.CLOUDWATCH_ALARM) {
    hints.push(
      `${AdviceIcon.COST} Standard alarms cost $0.10/alarm/month \u2014 high-resolution alarms (period < 60s) cost 3x more`,
    );
  } else if (resourceType === RESOURCE_TYPES.ECS_CLUSTER) {
    hints.push(
      `${AdviceIcon.COST} ECS cluster itself is free \u2014 costs come from the underlying EC2 instances or Fargate tasks`,
    );
  } else if (resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP) {
    hints.push(
      `${AdviceIcon.COST} CloudWatch Logs ingestion costs $0.50/GB \u2014 set a retention period to avoid unbounded storage costs`,
    );
  } else if (resourceType === RESOURCE_TYPES.EFS_FILE_SYSTEM) {
    efsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.EFS_MOUNT_TARGET) {
    hints.push(
      `${AdviceIcon.COST} EFS mount targets are free \u2014 storage and NFS data transfer are billed on the parent AWS::EFS::FileSystem. One mount target per AZ is required for multi-AZ access.`,
    );
  } else if (resourceType === RESOURCE_TYPES.EVENTS_RULE) {
    eventsRuleCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION) {
    cloudFrontCostHints(hints);
  }

  return hints;
}

/**
 * CloudFront Distribution cost hints. The decomposer emits data-transfer-out
 * + HTTPS requests as the two always-on usage-based lines; the invalidation
 * trap is the non-obvious one that bites teams who do per-deploy wildcard
 * invalidations. We always surface it because the trap is behavior-driven,
 * not config-driven — knowable only at deploy time.
 *
 * @see A14 (2026-04-09) — CloudFront::Distribution first-class
 * @see (f) 2026-04-09 — wired from decomposer reminder list
 */
function cloudFrontCostHints(hints: string[]): void {
  hints.push(
    `${AdviceIcon.COST} First 1,000 invalidation paths/month are free; $0.005 each after that. Aggressive per-deploy invalidations can turn into real cost \u2014 prefer cache-busting filenames.`,
  );
}

/**
 * EventBridge Rule cost hints. The rule itself is free on the default
 * bus, but the workload fees (invoked target's invocation cost) scale
 * linearly with the schedule frequency — so surfacing the cadence
 * prompts the user to reality-check their rate/cron before shipping.
 */
function eventsRuleCostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
  const schedule = ds["ScheduleExpression"];
  const eventBusName = ds["EventBusName"];
  const bus =
    typeof eventBusName === "string" ? eventBusName.trim() : "default";

  // Default-bus rule: free rule evaluation + free AWS-service event
  // delivery. The workload fee comes from the target, not the rule.
  if (!bus || bus === "default") {
    hints.push(
      `${AdviceIcon.COST} EventBridge rule evaluation on the default bus is free — the cost you pay is the target's invocation cost (Lambda per-ms, SQS per-request, etc.) multiplied by the schedule frequency.`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Custom event bus "${bus}" bills $1.00 per million events published (on top of target invocation fees). Confirm the volume estimate before shipping a high-throughput source.`,
    );
  }

  // Schedule reality-check: short rate() intervals rack up target
  // invocations fast. rate(1 minute) = 43,800/month; rate(10 seconds)
  // via cron = 262,800/month.
  if (typeof schedule === "string") {
    const rateMatch = schedule.match(
      /^rate\(\s*(\d+)\s*(minute|hour|day)s?\s*\)$/,
    );
    if (rateMatch) {
      const n = Number(rateMatch[1]);
      const unit = rateMatch[2];
      let perMonth = 0;
      if (unit === "minute") perMonth = Math.round((60 * 24 * 30.44) / n);
      else if (unit === "hour") perMonth = Math.round((24 * 30.44) / n);
      else if (unit === "day") perMonth = Math.round(30.44 / n);
      if (perMonth > 0) {
        hints.push(
          `${AdviceIcon.COST} ${schedule} fires approximately ${perMonth.toLocaleString()} times per month — budget the target invocation cost against this rate before shipping.`,
        );
      }
    }
  }

  // DLQ reliability reminder — not a cost hint per se, but a
  // workload-cost reminder: failed async invocations retry 185 times
  // by default before dropping, which can amplify a buggy target
  // handler's cost. Tuning RetryPolicy + DeadLetterConfig on the
  // Target turns that into a bounded spend.
  hints.push(
    `${AdviceIcon.COST} Set DeadLetterConfig + RetryPolicy on each Target — the default 185 retries over 24h can turn a failing async handler into a runaway cost amplifier.`,
  );
}

/**
 * EFS cost hints. Ordered from most to least impactful — the plugin
 * surfaces at most 5 lines in the inline advice box so the first
 * hint should be the one most likely to save money on the user's
 * workload.
 */
function efsCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const throughputMode = ds[CfnKey.THROUGHPUT_MODE] as string | undefined;
  const provisionedMiBps = ds[CfnKey.PROVISIONED_THROUGHPUT_IN_MIBPS] as
    | number
    | string
    | undefined;
  const azName = ds[CfnKey.AVAILABILITY_ZONE_NAME];

  // Provisioned throughput — expensive and often unnecessary. Wording
  // mirrors the decomposer's FIXED provisioned-throughput line so the
  // plan box and the advisor tell the same story: ~$6/MiB-s-month
  // baseline, bills regardless of utilization, crossover with
  // bursting/elastic sits around ~50 MiB/s for typical workloads.
  if (throughputMode === "provisioned") {
    const provisionedNum =
      typeof provisionedMiBps === "number"
        ? provisionedMiBps
        : typeof provisionedMiBps === "string"
          ? Number(provisionedMiBps)
          : undefined;
    const prefix =
      provisionedNum && provisionedNum > 0
        ? `ThroughputMode=provisioned with ${provisionedNum} MiB/s`
        : `ThroughputMode=provisioned`;
    hints.push(
      `${AdviceIcon.COST} ${prefix} \u2014 $6/MiB-s-month baseline; the committed rate bills regardless of usage. Switch back to bursting / elastic if steady-state throughput is below ~50 MiB/s.`,
    );
  }

  // One Zone mode — dramatically cheaper for non-critical data.
  if (typeof azName === "string" && azName.length > 0) {
    hints.push(
      `${AdviceIcon.COST} One Zone EFS (AvailabilityZoneName=${azName}) is ~47% cheaper per GB-month than Regional, but has zero multi-AZ redundancy — only use for reproducible or easily-recoverable data.`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Regional EFS (default) stores data across 3 AZs. For non-critical workloads, consider One Zone (AvailabilityZoneName) to save ~47% per GB-month.`,
    );
  }

  // Lifecycle tiering — big lever for cold data.
  hints.push(
    `${AdviceIcon.COST} Enable EFS Lifecycle Management (IA after 30d, Archive after 90d) to move cold data to cheaper tiers automatically — can cut storage bill by 80%+ for write-once-read-rarely workloads.`,
  );
}

function ec2CostHints(ds: Record<string, unknown>, hints: string[]): void {
  const instanceType = ds[CfnKey.INSTANCE_TYPE] as string | undefined;
  if (!instanceType) return;

  // Suggest ARM (Graviton) alternatives for x86 instance types
  for (const [x86Prefix, armPrefix] of Object.entries(ARM_EQUIVALENTS)) {
    if (instanceType.startsWith(x86Prefix)) {
      const armEquivalent = instanceType.replace(x86Prefix, armPrefix);
      hints.push(
        `${AdviceIcon.COST} Consider ${armEquivalent} (ARM/Graviton) instead of ${instanceType} \u2014 typically ~20% cheaper with comparable performance`,
      );
      break;
    }
  }

  // Suggest spot for dev/test workloads
  if (SPOT_ELIGIBLE_PREFIXES.some((p) => instanceType.startsWith(p))) {
    hints.push(
      `${AdviceIcon.COST} For dev/test workloads, consider Spot Instances \u2014 up to 90% cheaper (but can be interrupted)`,
    );
  }
}

function rdsCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const instanceClass = ds[CfnKey.DB_INSTANCE_CLASS] as string | undefined;

  // Suggest smaller class for non-prod
  if (
    instanceClass &&
    RDS_LARGE_CLASS_PREFIXES.some((p) => instanceClass.startsWith(p))
  ) {
    hints.push(
      `${AdviceIcon.COST} For non-production workloads, consider ${RDS_BUDGET_ALTERNATIVES} instead of ${instanceClass} \u2014 significantly cheaper for light database loads`,
    );
  }

  // Multi-AZ cost warning
  if (ds[CfnKey.MULTI_AZ] === true) {
    hints.push(
      `${AdviceIcon.COST} Multi-AZ is enabled \u2014 this roughly doubles the instance cost (standby replica) but provides automatic failover`,
    );
  }
}

function s3CostHints(ds: Record<string, unknown>, hints: string[]): void {
  const hasLifecycle =
    ds["LifecycleConfiguration"] !== undefined ||
    ds[CfnKey.ENABLE_LIFECYCLE] === true;

  if (!hasLifecycle) {
    hints.push(
      `${AdviceIcon.COST} Consider adding lifecycle rules to transition infrequent data to S3-IA or Glacier after 30-90 days`,
    );
  }

  // Intelligent-Tiering reminder — mirrors the decomposer's IT line item
  // so plan-time advice explains the break-even logic. IT is a clear win
  // for large objects with unpredictable access, but is actively worse
  // than Standard for tiny or rarely-accessed objects due to the per-
  // object monitoring fee.
  const itConfigs = ds["IntelligentTieringConfigurations"];
  if (Array.isArray(itConfigs) && itConfigs.length > 0) {
    hints.push(
      `${AdviceIcon.COST} Intelligent-Tiering saves ~45% vs Standard for access patterns >128KB; breaks even around 30 days per object. Worse than Standard for objects accessed <1/month due to the monitoring fee.`,
    );
  }

  // Replication reminder — the decomposer already surfaces the source-side
  // PUT + destination-side storage line items, but inter-region data
  // transfer at the destination region's inbound rate is NOT shown as its
  // own line item. Call it out so users don't under-estimate CRR spend.
  const replicationConfig = ds["ReplicationConfiguration"];
  const hasReplication =
    typeof replicationConfig === "object" &&
    replicationConfig !== null &&
    Array.isArray((replicationConfig as Record<string, unknown>)["Rules"]) &&
    ((replicationConfig as { Rules: unknown[] }).Rules.length ?? 0) > 0;
  if (hasReplication) {
    hints.push(
      `${AdviceIcon.COST} Cross-region replication ALSO bills inter-region data transfer at the destination region's inbound rate \u2014 not shown separately in the plan box above.`,
    );
  }
}

function lambdaCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const memorySize = ds[CfnKey.MEMORY_SIZE] as number | undefined;

  if (memorySize && memorySize > LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB) {
    hints.push(
      `${AdviceIcon.COST} Lambda memory is set to ${memorySize}MB \u2014 test with lower memory if your function isn't CPU-bound (Lambda CPU scales linearly with memory)`,
    );
  }
}

function dynamodbCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const billingMode = ds["BillingMode"] as string | undefined;
  if (billingMode === "PROVISIONED" || !billingMode) {
    hints.push(
      `${AdviceIcon.COST} Using provisioned capacity \u2014 consider PAY_PER_REQUEST (on-demand) for unpredictable workloads to avoid over-provisioning`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Using on-demand capacity \u2014 for steady workloads, provisioned capacity with auto-scaling can be 70% cheaper`,
    );
  }
}

function sqsCostHints(ds: Record<string, unknown>, hints: string[]): void {
  const isFifo = ds["FifoQueue"] === true;
  if (isFifo) {
    hints.push(
      `${AdviceIcon.COST} FIFO queues cost 25% more than standard \u2014 use only when message ordering and exactly-once delivery are required`,
    );
  }
  // SQS data-transfer-out reminder — the decomposer emits a DTO line item
  // with description "Data transfer out (only cross-region consumers)" so
  // users see the line in the plan box; this advisor annotation explains
  // when the line actually bills. In-region consumers (the overwhelming
  // common case) pay nothing; the charge only applies if readers live in
  // a different region from the queue.
  hints.push(
    `${AdviceIcon.COST} In-region consumers are free; the data-transfer-out line only applies if your readers are in another region. Watch this if you're fanning out to multi-region consumers.`,
  );
}
