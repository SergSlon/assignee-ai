/**
 * S3::Bucket cost hints — lifecycle, Intelligent-Tiering, and replication traps.
 */
import { CfnKey } from "@assignee/core";
import { AdviceIcon } from "../constants.js";
import { S3_INTELLIGENT_TIERING_SAVINGS_PCT } from "../../../../pricing/advisory-prices.js";

export function s3CostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
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
      `${AdviceIcon.COST} Intelligent-Tiering saves ~${S3_INTELLIGENT_TIERING_SAVINGS_PCT}% vs Standard for access patterns >128KB; breaks even around 30 days per object. Worse than Standard for objects accessed <1/month due to the monitoring fee.`,
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
