import { RESOURCE_TYPES } from "@/index.js";

/**
 * Extract an explicit "N days retention" clause for
 * `AWS::Logs::LogGroup`. The plan-generator's downstream comparator
 * raises this value to the BP minimum (30) when necessary and emits
 * a `BP_ADJUSTED_VALUE` advisory. Stored in `elicitedOptions` as an
 * integer (matching the CFN schema type).
 *
 * Epic 94 Wave 2 fixer e94.N5 — required for finding D-05 so the
 * comparator has a concrete asserted value to compare against.
 */
export function extractRetentionDays(
  intent: string,
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.LOGS_LOG_GROUP) return;
  if (!/\bretention\b|\bretain\b/.test(intentLower)) return;
  // Accept "14 days retention" / "14-day retention" / "retention 14
  // days" / "retention of 14 days". Bound the number to 1-3652.
  const patterns: RegExp[] = [
    /\b(\d{1,4})[-\s]*days?\s+retention\b/i,
    /\bretention\s+(?:of\s+)?(\d{1,4})\s*days?\b/i,
    /\bretain\s+(?:for\s+)?(\d{1,4})\s*days?\b/i,
  ];
  for (const re of patterns) {
    const m = re.exec(intent);
    if (!m) continue;
    const n = Number(m[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    elicited["RetentionInDays"] = n;
    return;
  }
}

/**
 * e98.W5.N2 (D-13 sibling D-17) — extract the CloudWatch namespace +
 * metric name from service keywords in the user intent. Before this
 * closed, a `Create an alarm on S3 bucket size` intent fell through to
 * the plugin's `initialValue: "CPUUtilization"` + `"AWS/EC2"` defaults,
 * so the alarm targeted the wrong metric while the rest of the plan
 * looked correct. The SME user who had to diagnose the silent override
 * reported it as D-17 HIGH.
 *
 * Strategy: match a per-service keyword set against the lowered intent
 * and pick the first hit. We intentionally only populate values when
 * both Namespace AND MetricName can be confidently inferred — partial
 * inference falls back to the elicitor so the user sees the gap
 * instead of a silent wrong default.
 *
 * The mapping is deliberately narrow — the ~10 most common "alarm on
 * X" intents AWS customers write. Broader coverage (e.g. full metric
 * catalog) would require a proper metric registry and belongs in a
 * W5.P2 backlog story, not this fix.
 */
interface CloudWatchMetricInference {
  readonly namespace: string;
  readonly metric: string;
  /** Case-insensitive phrases that uniquely identify this (ns, metric). */
  readonly cues: readonly string[];
}

const CLOUDWATCH_METRIC_INFERENCES: readonly CloudWatchMetricInference[] = [
  // S3 — BucketSizeBytes is the canonical "bucket grew too large" alarm.
  {
    namespace: "AWS/S3",
    metric: "BucketSizeBytes",
    cues: ["s3 bucket-size", "s3 bucket size", "bucket size", "bucket-size"],
  },
  // S3 — NumberOfObjects is the counted-item companion alarm.
  {
    namespace: "AWS/S3",
    metric: "NumberOfObjects",
    cues: ["s3 object count", "number of objects", "object count"],
  },
  // SQS DLQ visibility — the #1 SQS reliability alarm.
  {
    namespace: "AWS/SQS",
    metric: "ApproximateNumberOfMessagesVisible",
    cues: [
      "sqs dlq",
      "dead letter queue depth",
      "dead-letter queue depth",
      "dlq depth",
      "messages visible",
      "sqs queue depth",
    ],
  },
  // Lambda Errors — canonical Lambda failure alarm.
  {
    namespace: "AWS/Lambda",
    metric: "Errors",
    cues: ["lambda error", "lambda errors", "lambda failures"],
  },
  // Lambda Throttles — companion of the Errors alarm.
  {
    namespace: "AWS/Lambda",
    metric: "Throttles",
    cues: ["lambda throttle", "lambda throttles"],
  },
  // Lambda Duration — latency alarm.
  {
    namespace: "AWS/Lambda",
    metric: "Duration",
    cues: ["lambda duration", "lambda latency"],
  },
  // RDS CPU — the most common database performance alarm.
  {
    namespace: "AWS/RDS",
    metric: "CPUUtilization",
    cues: ["rds cpu", "database cpu", "db cpu"],
  },
  // RDS FreeStorageSpace — disk-exhaustion alarm.
  {
    namespace: "AWS/RDS",
    metric: "FreeStorageSpace",
    cues: ["rds free storage", "rds storage", "database free storage"],
  },
  // RDS DatabaseConnections — connection-pool-pressure alarm.
  {
    namespace: "AWS/RDS",
    metric: "DatabaseConnections",
    cues: ["rds connection", "database connection"],
  },
  // ALB TargetResponseTime — latency-at-the-edge alarm.
  {
    namespace: "AWS/ApplicationELB",
    metric: "TargetResponseTime",
    cues: ["alb latency", "alb response time", "target response time"],
  },
  // ALB HTTPCode_Target_5XX_Count — backend-error alarm.
  {
    namespace: "AWS/ApplicationELB",
    metric: "HTTPCode_Target_5XX_Count",
    cues: ["alb 5xx", "alb target 5xx", "backend 5xx"],
  },
  // DynamoDB throttled requests.
  {
    namespace: "AWS/DynamoDB",
    metric: "ThrottledRequests",
    cues: ["dynamodb throttle", "ddb throttle", "dynamodb throttled"],
  },
  // EC2 CPU (retains the long-standing default; listed last so more
  // specific service keywords win first when both match).
  {
    namespace: "AWS/EC2",
    metric: "CPUUtilization",
    cues: ["ec2 cpu", "instance cpu"],
  },
];

export function extractCloudWatchAlarmMetric(
  intentLower: string,
  resourceType: string,
  elicited: Record<string, unknown>,
): void {
  if (resourceType !== RESOURCE_TYPES.CLOUDWATCH_ALARM) return;
  for (const entry of CLOUDWATCH_METRIC_INFERENCES) {
    for (const cue of entry.cues) {
      if (intentLower.includes(cue)) {
        elicited["Namespace"] = entry.namespace;
        elicited["MetricName"] = entry.metric;
        return;
      }
    }
  }
}
