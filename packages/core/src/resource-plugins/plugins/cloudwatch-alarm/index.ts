import { RESOURCE_TYPES } from "@/config/resource-types.js";
import type { ResourcePlugin } from "../../types.js";
import { commonFields, advancedFields } from "./fields.js";
import { defaults, configHints } from "./config.js";

export { commonFields, advancedFields, defaults, configHints };

/**
 * ResourcePlugin for AWS::CloudWatch::Alarm.
 * commonFields: AlarmName, MetricName, Namespace, Threshold,
 *   ComparisonOperator, AlarmActions (6 fields — ≤10 as required).
 * advancedFields: Statistic, Period, EvaluationPeriods, OKActions,
 *   InsufficientDataActions, Dimensions, TreatMissingData, DatapointsToAlarm.
 *
 * Progressive disclosure: Statistic, Period, EvaluationPeriods are in
 * advancedFields with sensible defaults (Average, 300s, 3 periods).
 */
export const cloudWatchAlarmPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  commonFields,
  advancedFields,
  defaults,
  configHints,
};
