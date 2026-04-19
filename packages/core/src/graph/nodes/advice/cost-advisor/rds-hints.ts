/**
 * RDS::DBInstance cost hints — budget-class alternatives + Multi-AZ doubling warning.
 */
import { CfnKey } from "@/index.js";
import {
  RDS_LARGE_CLASS_PREFIXES,
  RDS_BUDGET_ALTERNATIVES,
  AdviceIcon,
} from "../constants.js";

export function rdsCostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
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
