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
 * W1-01 (Epic 100): `filterSensitiveElicitedFields()` extends the
 * allowlist filter with plugin-driven elicited-field markers. Any value
 * in `event.extras` that was produced from a `sensitive: true` field is
 * stripped at OTEL emit time. The mechanism is additive — the existing
 * W6 unknown-field and PII-gate logic runs first; sensitive-marker
 * scrubbing runs after as a second pass on the permitted subset.
 *
 * Cross-reference: W6 P010 OTEL cluster owns field-classification;
 * W1 owns the field-level `sensitive` marker on ResourceField. Do NOT
 * duplicate each other's logic — compose via this module.
 *
 * @see packages/core/src/telemetry/otel-exporter.ts — exporter activation
 * @see packages/core/src/telemetry/spans.ts — per-graph-node spans
 */

import { EnvVar } from "../constants/env-vars.js";
import {
  stripSensitiveFromElicited,
  ELICITED_REDACTED_VALUE,
} from "../utils/redact.js";

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

// ── W1-01 (Epic 100): sensitive elicited-field filter ─────────────────────────

/**
 * Second-pass filter that drops values originating from `sensitive: true`
 * plugin fields from an already-allowlist-filtered `extras` map.
 *
 * Call this AFTER `filterAllowlistedFields()` — the allowlist pass gates
 * on field NAME (unknown = drop; PII = drop unless opted in). This pass
 * gates on the VALUE being a sensitive elicited-option that slipped through
 * under a non-PII field name.
 *
 * Design: caller supplies `sensitiveNames` — the set of field names from the
 * current plugin invocation that are marked `sensitive: true`. The function
 * delegates to `stripSensitiveFromElicited()` from `utils/redact.ts` so both
 * layers share one implementation and one sentinel string.
 *
 * @param extras - Already-allowlist-filtered extras map.
 * @param sensitiveNames - Set of field names carrying credential material for
 *   this invocation. Empty set = no-op (pre-W1 callers are unaffected).
 * @returns A new object with sensitive-field values replaced by "[REDACTED]".
 */
export function filterSensitiveElicitedFields(
  extras: Record<string, unknown>,
  sensitiveNames: ReadonlySet<string>,
): Record<string, unknown> {
  if (sensitiveNames.size === 0) return extras;
  return stripSensitiveFromElicited(extras, sensitiveNames);
}

// ── scrub-logs-for-upload integration (W6 gap closure) ───────────────────────

/**
 * Re-export of `ELICITED_REDACTED_VALUE` for downstream consumers
 * (e.g. scrub-logs-for-upload.ts) that need to know the sentinel string
 * used by the sensitive-marker layer.
 */
export { ELICITED_REDACTED_VALUE };

/**
 * Line-level log content redactor for CI artefact upload (W6 / scrub-logs-for-upload.ts).
 *
 * `scrub-logs-for-upload.ts` tries to import `mod.redactLogContent` from this
 * module. This function applies the OTEL field allowlist (which already
 * covers unknown fields and PII) as a best-effort line-by-line scrub of raw
 * log content. For each line that parses as a JSON log event with an `extras`
 * object, it runs `filterAllowlistedFields` to drop unknown/PII fields.
 * Lines that are not valid JSON, or events without `extras`, pass through
 * unchanged.
 *
 * NOTE: This is a log-text scrubber, not a re-emission filter. The canonical
 * field-level redaction happens at emit time in `filterAllowlistedFields` and
 * `filterSensitiveElicitedFields`. This function is the CI artefact safety-net
 * for log files that were written before W1/W6 emit-time filters were active.
 *
 * @param content - Raw log file content (newline-delimited JSON or plain text).
 * @returns Scrubbed content string.
 */
export function redactLogContent(content: string): string {
  if (!content) return content;
  const lines = content.split("\n");
  const scrubbed = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return line; // Not JSON — pass through
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return line;
    }
    const extras = parsed["extras"];
    if (extras && typeof extras === "object" && !Array.isArray(extras)) {
      const filteredExtras = filterAllowlistedFields(
        extras as Record<string, unknown>,
        false, // never include PII in CI artefacts
      );
      return JSON.stringify({ ...parsed, extras: filteredExtras });
    }
    return line;
  });
  return scrubbed.join("\n");
}
