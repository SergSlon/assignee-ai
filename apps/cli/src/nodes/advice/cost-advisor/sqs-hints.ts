/**
 * SQS::Queue cost hints — FIFO surcharge + data-transfer-out clarification.
 */
import { AdviceIcon } from "../constants.js";
import { SQS_FIFO_SURCHARGE_PCT } from "../../../constants/advisory-prices.js";

export function sqsCostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
  const isFifo = ds["FifoQueue"] === true;
  if (isFifo) {
    hints.push(
      `${AdviceIcon.COST} FIFO queues cost ${SQS_FIFO_SURCHARGE_PCT}% more than standard \u2014 use only when message ordering and exactly-once delivery are required`,
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
