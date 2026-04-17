/**
 * DynamoDB::Table cost hints — BillingMode tradeoff (provisioned vs on-demand).
 */
import { AdviceIcon } from "../constants.js";
import { DYNAMODB_PROVISIONED_SAVINGS_PCT } from "../../../../pricing/advisory-prices.js";

export function dynamodbCostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
  const billingMode = ds["BillingMode"] as string | undefined;
  if (billingMode === "PROVISIONED" || !billingMode) {
    hints.push(
      `${AdviceIcon.COST} Using provisioned capacity \u2014 consider PAY_PER_REQUEST (on-demand) for unpredictable workloads to avoid over-provisioning`,
    );
  } else {
    hints.push(
      `${AdviceIcon.COST} Using on-demand capacity \u2014 for steady workloads, provisioned capacity with auto-scaling can be ${DYNAMODB_PROVISIONED_SAVINGS_PCT}% cheaper`,
    );
  }
}
