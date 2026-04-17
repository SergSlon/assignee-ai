/**
 * Lambda::Function cost hints — memory over-provisioning threshold.
 */
import { CfnKey } from "../../../../index.js";
import {
  LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB,
  AdviceIcon,
} from "../constants.js";

export function lambdaCostHints(
  ds: Record<string, unknown>,
  hints: string[],
): void {
  const memorySize = ds[CfnKey.MEMORY_SIZE] as number | undefined;

  if (memorySize && memorySize > LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB) {
    hints.push(
      `${AdviceIcon.COST} Lambda memory is set to ${memorySize}MB \u2014 test with lower memory if your function isn't CPU-bound (Lambda CPU scales linearly with memory)`,
    );
  }
}
