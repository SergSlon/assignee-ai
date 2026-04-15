import { RESOURCE_TYPES } from "../../config/resource-types.js";
import { CfnKey, CloudWatchStatistic } from "../../config/cfn-keys.js";
import { isArnOfService } from "../../config/aws-partition.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::CloudWatch::Alarm.
 * commonFields: AlarmName, MetricName, Namespace, Threshold, ComparisonOperator,
 *   AlarmActions (6 fields — ≤10 as required).
 * advancedFields: Statistic, Period, EvaluationPeriods, OKActions,
 *   InsufficientDataActions, Dimensions, TreatMissingData, DatapointsToAlarm.
 *
 * Progressive disclosure: Statistic, Period, EvaluationPeriods are in advancedFields
 * with sensible defaults (Average, 300s, 3 periods).
 */
export const cloudWatchAlarmPlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
  commonFields: [
    {
      name: CfnKey.ALARM_NAME,
      required: true,
      question: {
        type: "string",
        label: "Alarm name",
        placeholder: "my-alarm",
        hint: "Descriptive name for this alarm. Use a naming convention like <service>-<metric>-<threshold> (e.g., api-latency-p99-500ms). Must be unique within your AWS account per region.",
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return "Alarm name is required";
          const s = String(value);
          if (s.length > 255)
            return "Alarm name must be 255 characters or fewer";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.METRIC_NAME,
      required: true,
      question: {
        type: "string",
        label: "Metric name",
        placeholder: "CPUUtilization",
        initialValue: "CPUUtilization",
        hint: "The CloudWatch metric to monitor. Common metrics: CPUUtilization, Errors, ApproximateNumberOfMessagesVisible, TargetResponseTime, DatabaseConnections.",
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return "Metric name is required";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.NAMESPACE,
      required: true,
      question: {
        type: "enum",
        label: "Metric namespace",
        options: [
          { value: "AWS/EC2", label: "AWS/EC2 — EC2 instances" },
          { value: "AWS/RDS", label: "AWS/RDS — RDS databases" },
          { value: "AWS/Lambda", label: "AWS/Lambda — Lambda functions" },
          { value: "AWS/SQS", label: "AWS/SQS — SQS queues" },
          {
            value: "AWS/ApplicationELB",
            label: "AWS/ApplicationELB — Application Load Balancer",
          },
          { value: "Custom", label: "Custom namespace (enter manually)" },
        ],
        initialValue: "AWS/EC2",
        hint: "The namespace that contains the metric. AWS services publish to their own namespace (e.g., AWS/EC2). Custom applications can publish to any namespace.",
      },
    },
    {
      name: CfnKey.THRESHOLD,
      required: true,
      question: {
        type: "string",
        label: "Threshold value",
        placeholder: "80",
        initialValue: "80",
        hint: "The value to compare the metric against. Examples: CPU at 80%, error count at 1, queue depth at 0, latency at 1 second.",
        validate: (value: unknown) => {
          if (
            value === undefined ||
            value === null ||
            String(value).trim() === ""
          )
            return "Threshold is required";
          const n = Number(value);
          if (Number.isNaN(n)) return "Threshold must be a number";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.COMPARISON_OPERATOR,
      required: true,
      question: {
        type: "enum",
        label: "Comparison operator",
        options: [
          {
            value: "GreaterThanThreshold",
            label: "Greater than threshold",
          },
          {
            value: "GreaterThanOrEqualToThreshold",
            label: "Greater than or equal to threshold",
          },
          {
            value: "LessThanThreshold",
            label: "Less than threshold",
          },
          {
            value: "LessThanOrEqualToThreshold",
            label: "Less than or equal to threshold",
          },
        ],
        initialValue: "GreaterThanThreshold",
        hint: "How the metric value is compared to the threshold. Most alarms use 'greater than' (e.g., CPU > 80%) or 'less than' (e.g., healthy hosts < 2).",
      },
    },
    {
      name: CfnKey.ALARM_ACTIONS,
      question: {
        type: "multi",
        label: "Alarm actions (SNS topic ARNs)",
        placeholder: "arn:aws:sns:us-east-1:123456789012:my-topic",
        hint: "SNS topic ARNs to notify when the alarm triggers. Without actions, alarms only change state — no notifications are sent. Comma-separated for multiple topics.",
        options: [],
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.trim() === "") return undefined;
          const arns = s.split(",").map((a) => a.trim());
          for (const arn of arns) {
            if (arn && !isArnOfService(arn, "sns"))
              return `Invalid SNS topic ARN: ${arn}. Must be an SNS topic ARN (e.g. arn:aws:sns:<region>:<account>:<topic>)`;
          }
          return undefined;
        },
      },
    },
  ],
  advancedFields: [
    {
      name: CfnKey.STATISTIC,
      question: {
        type: "enum",
        label: "Statistic",
        options: [
          {
            value: CloudWatchStatistic.AVERAGE,
            label: CloudWatchStatistic.AVERAGE,
          },
          { value: CloudWatchStatistic.SUM, label: CloudWatchStatistic.SUM },
          {
            value: CloudWatchStatistic.MINIMUM,
            label: CloudWatchStatistic.MINIMUM,
          },
          {
            value: CloudWatchStatistic.MAXIMUM,
            label: CloudWatchStatistic.MAXIMUM,
          },
          {
            value: CloudWatchStatistic.SAMPLE_COUNT,
            label: CloudWatchStatistic.SAMPLE_COUNT,
          },
        ],
        initialValue: CloudWatchStatistic.AVERAGE,
        hint: "The statistic applied to the metric. Average is best for utilization metrics (CPU, memory). Sum for count-based metrics (errors, invocations). Maximum for peak detection.",
      },
    },
    {
      name: CfnKey.PERIOD,
      question: {
        type: "string",
        label: "Period (seconds)",
        placeholder: "300",
        initialValue: "300",
        hint: "The period in seconds over which the metric is aggregated. 300 (5 min) is standard. Use 60 (1 min) for faster detection. Periods < 60s are high-resolution and cost approximately 3x more than standard resolution.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1)
            return "Period must be a positive integer (seconds)";
          if (n < 10) return "Minimum period is 10 seconds";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.EVALUATION_PERIODS,
      question: {
        type: "string",
        label: "Evaluation periods",
        placeholder: "3",
        initialValue: "3",
        hint: "Number of consecutive periods the metric must breach the threshold before the alarm fires. Higher values reduce false positives (e.g., 3 means 15 min at 5-min periods). Minimum 2 recommended.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1)
            return "Evaluation periods must be a positive integer";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
    {
      name: CfnKey.OK_ACTIONS,
      question: {
        type: "multi",
        label: "OK actions (SNS topic ARNs)",
        placeholder: "arn:aws:sns:us-east-1:123456789012:my-topic",
        hint: "SNS topic ARNs to notify when the alarm returns to OK state. Useful for auto-remediation or 'all clear' notifications.",
        options: [],
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.trim() === "") return undefined;
          const arns = s.split(",").map((a) => a.trim());
          for (const arn of arns) {
            if (arn && !isArnOfService(arn, "sns"))
              return `Invalid SNS topic ARN: ${arn}. Must be an SNS topic ARN (e.g. arn:aws:sns:<region>:<account>:<topic>)`;
          }
          return undefined;
        },
      },
    },
    {
      name: CfnKey.INSUFFICIENT_DATA_ACTIONS,
      question: {
        type: "multi",
        label: "Insufficient data actions (SNS topic ARNs)",
        placeholder: "arn:aws:sns:us-east-1:123456789012:my-topic",
        hint: "SNS topic ARNs to notify when the alarm enters INSUFFICIENT_DATA state. This happens when the metric stops publishing (e.g., instance terminated).",
        options: [],
        validate: (value: unknown) => {
          if (!value) return undefined;
          const s = String(value);
          if (s.trim() === "") return undefined;
          const arns = s.split(",").map((a) => a.trim());
          for (const arn of arns) {
            if (arn && !isArnOfService(arn, "sns"))
              return `Invalid SNS topic ARN: ${arn}. Must be an SNS topic ARN (e.g. arn:aws:sns:<region>:<account>:<topic>)`;
          }
          return undefined;
        },
      },
    },
    {
      name: CfnKey.DIMENSIONS,
      question: {
        type: "string",
        label: 'Dimensions (JSON: [{"Name":"...","Value":"..."}])',
        placeholder: '[{"Name":"InstanceId","Value":"i-1234567890abcdef0"}]',
        hint: 'JSON array of Name/Value pairs to filter the metric. Without dimensions, the alarm monitors the aggregate metric across all resources. Example: [{"Name":"QueueName","Value":"my-dlq"}]',
        validate: (value: unknown) => {
          if (!value || !String(value).trim()) return undefined;
          try {
            const parsed = JSON.parse(String(value));
            if (!Array.isArray(parsed))
              return "Dimensions must be a JSON array";
            for (const dim of parsed) {
              if (!dim.Name || !dim.Value)
                return "Each dimension must have Name and Value";
            }
            return undefined;
          } catch {
            return "Invalid JSON format";
          }
        },
      },
    },
    {
      name: CfnKey.TREAT_MISSING_DATA,
      question: {
        type: "enum",
        label: "Treat missing data as",
        options: [
          {
            value: "missing",
            label: "missing — Maintain current state",
          },
          {
            value: "breaching",
            label: "breaching — Treat as threshold breach",
          },
          {
            value: "notBreaching",
            label: "notBreaching — Treat as within threshold",
          },
          {
            value: "ignore",
            label: "ignore — Do not evaluate",
          },
        ],
        initialValue: "missing",
        hint: "How the alarm handles periods with no data. 'missing' keeps current state (safest default). 'breaching' is useful for health-check alarms where no data means the system is down.",
      },
    },
    {
      name: CfnKey.DATAPOINTS_TO_ALARM,
      question: {
        type: "string",
        label: "Datapoints to alarm (M of N)",
        placeholder: "3",
        hint: "Number of breaching datapoints within EvaluationPeriods required to trigger the alarm (M of N pattern). Defaults to same as EvaluationPeriods. Example: 2 of 3 evaluation periods must breach.",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 1)
            return "DatapointsToAlarm must be a positive integer";
          return undefined;
        },
      },
      toCfn: (v: unknown) => {
        const n = Number(v);
        return isNaN(n) ? undefined : n;
      },
    },
  ],
  defaults: {
    [CfnKey.STATISTIC]: CloudWatchStatistic.AVERAGE,
    [CfnKey.PERIOD]: "300",
    [CfnKey.EVALUATION_PERIODS]: "3",
    [CfnKey.TREAT_MISSING_DATA]: "missing",
  },
  configHints: [
    "SQS Dead Letter Queue depth alarm: Namespace=AWS/SQS, MetricName=ApproximateNumberOfMessagesVisible, ComparisonOperator=GreaterThanThreshold, Threshold=0. Fires when any message lands in the DLQ.",
    "Lambda error alarm: Namespace=AWS/Lambda, MetricName=Errors, ComparisonOperator=GreaterThanThreshold, Threshold=1, Statistic=Sum. Detects function failures.",
    "RDS CPU alarm: Namespace=AWS/RDS, MetricName=CPUUtilization, ComparisonOperator=GreaterThanThreshold, Threshold=80. Alerts before database performance degrades.",
    "ALB latency alarm: Namespace=AWS/ApplicationELB, MetricName=TargetResponseTime, ComparisonOperator=GreaterThanThreshold, Threshold=1. Detects slow backend responses.",
    "Period × EvaluationPeriods = total evaluation window. With Period=300 and EvaluationPeriods=3, the alarm evaluates 15 minutes of data before triggering.",
    "AlarmActions must be an SNS topic ARN (arn:aws:sns:<region>:<account>:<topic-name>). Without AlarmActions, the alarm only changes state — no notifications are sent.",
  ],
};
