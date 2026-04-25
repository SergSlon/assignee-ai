/**
 * W6-04 — OTEL source-side allowlist.
 *
 * ALL field names emitted in OTEL log events MUST appear in this
 * allowlist. Unknown fields are dropped with a debug log and NEVER
 * forwarded to the exporter. This implements the allowlist-not-denylist
 * principle (feedback_redaction_allowlist_not_denylist).
 *
 * Privacy classification (per W6-04 @privacy decorator model):
 *   PII         — must be stripped unless ASSIGNEE_OTEL_INCLUDE_PII=1
 *   SYSTEM      — internal implementation detail; included by default
 *   OPERATIONAL — operational signal; included by default
 *
 * Positive signal L1-F52 (OTEL opt-in, no vendor phone-home) is retained:
 * the exporter is still gated by ASSIGNEE_OTEL_ENDPOINT. This allowlist
 * only controls WHAT is forwarded when the exporter is enabled.
 *
 * @see packages/core/src/telemetry/otel-exporter.ts — exporter activation
 * @see packages/core/src/telemetry/spans.ts — per-graph-node spans
 */

import { EnvVar } from "../constants/env-vars.js";

// ── Privacy classification type ────────────────────────────────────────

export type PrivacyClass = "PII" | "SYSTEM" | "OPERATIONAL";

/** Allowlist entry for a single emitted field. */
export interface AllowlistEntry {
  /** Exact field name as it appears in the emitted event or OTLP attribute. */
  name: string;
  /** Privacy classification. PII fields are stripped by default. */
  privacy: PrivacyClass;
  /** Human-readable description for auditors. */
  description: string;
}

// ── Source-side allowlist ─────────────────────────────────────────────

/**
 * Canonical list of all field names that may appear in emitted OTEL
 * log events. Every field in `LogEvent.extras` must be listed here.
 * Unknown fields are dropped at `filterAllowlistedFields()`.
 *
 * Extend this list when adding new fields — NEVER remove entries
 * without a data-retention review (see telemetry-design.md).
 */
export const OTEL_FIELD_ALLOWLIST: AllowlistEntry[] = [
  // ── Core event fields (always present) ────────────────────────
  {
    name: "runId",
    privacy: "SYSTEM",
    description: "UUID linking events across a single CLI invocation",
  },
  {
    name: "action",
    privacy: "OPERATIONAL",
    description: "Action or event name (e.g. plan_complete)",
  },
  {
    name: "level",
    privacy: "OPERATIONAL",
    description: "Log severity: info | warn | error",
  },
  {
    name: "ts",
    privacy: "OPERATIONAL",
    description: "ISO-8601 timestamp of the event",
  },
  {
    name: "durationMs",
    privacy: "OPERATIONAL",
    description: "Elapsed time for the action in milliseconds",
  },
  {
    name: "result",
    privacy: "OPERATIONAL",
    description: "High-level result: success | failure | partial",
  },

  // ── Graph / pipeline operational signals ──────────────────────
  {
    name: "node",
    privacy: "OPERATIONAL",
    description: "Graph node name (from GraphNode constants)",
  },
  {
    name: "nodeEntry",
    privacy: "OPERATIONAL",
    description: "Emitted on graph-node entry (span start)",
  },
  {
    name: "nodeExit",
    privacy: "OPERATIONAL",
    description: "Emitted on graph-node exit (span end)",
  },
  {
    name: "spanId",
    privacy: "SYSTEM",
    description: "Correlation ID linking entry + exit span events",
  },
  {
    name: "traceId",
    privacy: "SYSTEM",
    description: "Per-run trace ID for distributed tracing correlation",
  },

  // ── Resource metadata (non-identifying) ───────────────────────
  {
    name: "resourceType",
    privacy: "OPERATIONAL",
    description: "CloudFormation resource type (e.g. AWS::S3::Bucket)",
  },
  {
    name: "resourceCount",
    privacy: "OPERATIONAL",
    description: "Count of resources in the plan",
  },
  {
    name: "region",
    privacy: "OPERATIONAL",
    description: "AWS region short name (e.g. us-east-1)",
  },
  {
    name: "regionGroup",
    privacy: "OPERATIONAL",
    description: "Bucketed region (e.g. us-east)",
  },
  {
    name: "costBand",
    privacy: "OPERATIONAL",
    description: "Bucketed cost tier (under_1/under_10/over_10)",
  },
  {
    name: "mode",
    privacy: "OPERATIONAL",
    description: "Execution mode: plan | apply | destroy | drift",
  },

  // ── Error classification (no raw messages, no stack traces) ───
  {
    name: "errorClass",
    privacy: "OPERATIONAL",
    description: "Short error classification (e.g. AccessDenied, NetworkError)",
  },
  {
    name: "retryCount",
    privacy: "OPERATIONAL",
    description: "Number of retries attempted before success or failure",
  },

  // ── CLI metadata ───────────────────────────────────────────────
  {
    name: "cliVersion",
    privacy: "OPERATIONAL",
    description: "CLI semver string for cohorting by release",
  },
  {
    name: "schemaVersion",
    privacy: "SYSTEM",
    description: "Telemetry schema version for forward-compatibility",
  },

  // ── PII-classified fields (stripped unless ASSIGNEE_OTEL_INCLUDE_PII=1) ──
  // Per policy: raw intent, ARNs, identifiers, account IDs, hostnames are PII.
  // They are listed here to acknowledge their existence and assign a class,
  // but the filter MUST drop them by default.
  {
    name: "rawIntent",
    privacy: "PII",
    description:
      "User's raw natural-language intent string (NEVER emitted by default)",
  },
  {
    name: "resourceArn",
    privacy: "PII",
    description:
      "Full AWS ARN of the affected resource (NEVER emitted by default)",
  },
  {
    name: "accountId",
    privacy: "PII",
    description: "12-digit AWS account ID (NEVER emitted by default)",
  },
  {
    name: "hostname",
    privacy: "PII",
    description: "Operator hostname (NEVER emitted by default)",
  },
];

/** Quick lookup set of allowed field names. */
export const ALLOWED_FIELD_NAMES: ReadonlySet<string> = new Set(
  OTEL_FIELD_ALLOWLIST.map((e) => e.name),
);

/** Quick lookup map from field name → privacy class. */
export const FIELD_PRIVACY_MAP: ReadonlyMap<string, PrivacyClass> = new Map(
  OTEL_FIELD_ALLOWLIST.map((e) => [e.name, e.privacy]),
);

// ── PII gate ──────────────────────────────────────────────────────────

/**
 * Returns true when PII fields should be included in the emitted event.
 * Opt-in requires `ASSIGNEE_OTEL_INCLUDE_PII=1`.
 *
 * Default: false (PII stripped).
 */
export function isPiiIncluded(): boolean {
  return process.env[EnvVar.ASSIGNEE_OTEL_INCLUDE_PII] === "1";
}

// ── Filter function ────────────────────────────────────────────────────

/**
 * Filters an arbitrary `extras` map (from LogEvent or a span payload)
 * against the allowlist. Unknown fields and PII fields (unless opted in)
 * are dropped. Returns a new object with only the permitted fields.
 *
 * Logs dropped fields at debug level to stderr (not forwarded to OTEL)
 * so operators can see what was filtered without leaking it.
 *
 * @param extras - Raw field map to filter
 * @param includePii - Override for PII inclusion (defaults to isPiiIncluded())
 */
export function filterAllowlistedFields(
  extras: Record<string, unknown>,
  includePii: boolean = isPiiIncluded(),
): Record<string, unknown> {
  const filtered: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(extras)) {
    if (!ALLOWED_FIELD_NAMES.has(key)) {
      dropped.push(`${key} (unknown)`);
      continue;
    }
    const privacyClass = FIELD_PRIVACY_MAP.get(key);
    if (privacyClass === "PII" && !includePii) {
      dropped.push(`${key} (PII)`);
      continue;
    }
    filtered[key] = value;
  }

  if (dropped.length > 0) {
    // Debug-only: write dropped fields to stderr so operators can audit.
    // This line is intentionally NOT forwarded to the OTEL exporter —
    // it stays local. Use a try/catch so a failed stderr write can't
    // break the caller.
    try {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: "debug",
          source: "otel-allowlist",
          action: "fields_dropped",
          extras: { dropped, count: dropped.length },
        }) + "\n",
      );
    } catch {
      // Best-effort only.
    }
  }

  return filtered;
}
