/**
 * EC2::Instance cost hints — ARM (Graviton) equivalents + Spot eligibility.
 */
import { CfnKey } from "@assignee/core";
import {
  ARM_EQUIVALENTS,
  SPOT_ELIGIBLE_PREFIXES,
  AdviceIcon,
} from "../constants.js";
import {
  ARM_GRAVITON_SAVINGS_PCT,
  SPOT_SAVINGS_UP_TO_PCT,
} from "../../../../pricing/advisory-prices.js";

export function ec2CostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
  const instanceType = ds[CfnKey.INSTANCE_TYPE] as string | undefined;
  if (!instanceType) return;

  // Suggest ARM (Graviton) alternatives for x86 instance types
  for (const [x86Prefix, armPrefix] of Object.entries(ARM_EQUIVALENTS)) {
    if (instanceType.startsWith(x86Prefix)) {
      const armEquivalent = instanceType.replace(x86Prefix, armPrefix);
      hints.push(
        `${AdviceIcon.COST} Consider ${armEquivalent} (ARM/Graviton) instead of ${instanceType} \u2014 typically ~${ARM_GRAVITON_SAVINGS_PCT}% cheaper with comparable performance`,
      );
      break;
    }
  }

  // Suggest spot for dev/test workloads
  if (SPOT_ELIGIBLE_PREFIXES.some((p) => instanceType.startsWith(p))) {
    hints.push(
      `${AdviceIcon.COST} For dev/test workloads, consider Spot Instances \u2014 up to ${SPOT_SAVINGS_UP_TO_PCT}% cheaper (but can be interrupted)`,
    );
  }
}
