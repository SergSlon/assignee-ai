import { CfnKey, CloudWatchStatistic } from "../../../config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";

export const defaults: ResourcePlugin["defaults"] = {
  [CfnKey.STATISTIC]: CloudWatchStatistic.AVERAGE,
  [CfnKey.PERIOD]: "300",
  [CfnKey.EVALUATION_PERIODS]: "3",
  [CfnKey.TREAT_MISSING_DATA]: "missing",
};

export const configHints: ResourcePlugin["configHints"] = [
  "SQS Dead Letter Queue depth alarm: Namespace=AWS/SQS, MetricName=ApproximateNumberOfMessagesVisible, ComparisonOperator=GreaterThanThreshold, Threshold=0. Fires when any message lands in the DLQ.",
  "Lambda error alarm: Namespace=AWS/Lambda, MetricName=Errors, ComparisonOperator=GreaterThanThreshold, Threshold=1, Statistic=Sum. Detects function failures.",
  "RDS CPU alarm: Namespace=AWS/RDS, MetricName=CPUUtilization, ComparisonOperator=GreaterThanThreshold, Threshold=80. Alerts before database performance degrades.",
  "ALB latency alarm: Namespace=AWS/ApplicationELB, MetricName=TargetResponseTime, ComparisonOperator=GreaterThanThreshold, Threshold=1. Detects slow backend responses.",
  "Period × EvaluationPeriods = total evaluation window. With Period=300 and EvaluationPeriods=3, the alarm evaluates 15 minutes of data before triggering.",
  "AlarmActions must be an SNS topic ARN (arn:aws:sns:<region>:<account>:<topic-name>). Without AlarmActions, the alarm only changes state — no notifications are sent.",
];
