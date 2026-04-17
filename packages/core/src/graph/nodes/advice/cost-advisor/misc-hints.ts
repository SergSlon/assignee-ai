/**
 * One-line cost hints for resource types whose advice is a single
 * callout — NAT Gateway, ALB, CloudWatch Alarm, ECS cluster, Logs
 * log-group, EFS mount target. Grouped here to keep the dispatcher
 * focused on routing, not on per-resource text.
 */
import { AdviceIcon } from "../constants.js";
import {
  AdvisoryPriceId,
  NAT_GATEWAY_MONTHLY_APPROX,
  ALB_MONTHLY_APPROX,
  CW_ALARM_PER_MONTH,
  CW_HIGH_RES_ALARM_MULTIPLIER,
  CW_LOGS_INGESTION_PER_GB,
  type EnrichedPriceMap,
} from "../../../../pricing/advisory-prices.js";
import { enrichedLabel } from "./enriched-label.js";

export function natGatewayHint(
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const natLabel = enrichedLabel(
    enriched,
    AdvisoryPriceId.NAT_GATEWAY_MONTHLY,
    NAT_GATEWAY_MONTHLY_APPROX,
    (v) => `~$${v.toFixed(2)}/mo`,
  );
  hints.push(
    `${AdviceIcon.COST} NAT Gateway costs ${natLabel} fixed + data processing fees \u2014 consider VPC endpoints for S3/DynamoDB to reduce data transfer through NAT`,
  );
}

export function albHint(hints: string[], enriched?: EnrichedPriceMap): void {
  const albLabel = enrichedLabel(
    enriched,
    AdvisoryPriceId.ALB_MONTHLY,
    ALB_MONTHLY_APPROX,
    (v) => `~$${v.toFixed(2)}/mo`,
  );
  hints.push(
    `${AdviceIcon.COST} ALB costs ${albLabel} fixed + LCU charges \u2014 for simple routing, consider using API Gateway instead`,
  );
}

export function cwAlarmHint(
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const alarmLabel = enrichedLabel(
    enriched,
    AdvisoryPriceId.CW_ALARM_PER_MONTH,
    CW_ALARM_PER_MONTH,
    (v) => `$${v.toFixed(2)}/alarm/month`,
  );
  hints.push(
    `${AdviceIcon.COST} Standard alarms cost ${alarmLabel} \u2014 high-resolution alarms (period < 60s) cost ${CW_HIGH_RES_ALARM_MULTIPLIER}x more`,
  );
}

export function ecsClusterHint(hints: string[]): void {
  hints.push(
    `${AdviceIcon.COST} ECS cluster itself is free \u2014 costs come from the underlying EC2 instances or Fargate tasks`,
  );
}

export function logsLogGroupHint(
  hints: string[],
  enriched?: EnrichedPriceMap,
): void {
  const logsLabel = enrichedLabel(
    enriched,
    AdvisoryPriceId.CW_LOGS_INGESTION_PER_GB,
    CW_LOGS_INGESTION_PER_GB,
    (v) => `$${v.toFixed(2)}/GB`,
  );
  hints.push(
    `${AdviceIcon.COST} CloudWatch Logs ingestion costs ${logsLabel} \u2014 set a retention period to avoid unbounded storage costs`,
  );
}

export function efsMountTargetHint(hints: string[]): void {
  hints.push(
    `${AdviceIcon.COST} EFS mount targets are free \u2014 storage and NFS data transfer are billed on the parent AWS::EFS::FileSystem. One mount target per AZ is required for multi-AZ access.`,
  );
}
