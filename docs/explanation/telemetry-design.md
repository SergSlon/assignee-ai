# Telemetry — design and privacy model

This page documents the design and current implementation of Assignee.ai's
internal observability pipeline and the forward-looking opt-in usage telemetry.

## Two distinct telemetry surfaces

Assignee.ai has two separate telemetry surfaces that share the same
privacy model but serve different purposes:

1. **Pipeline observability** (implemented) — per-graph-node spans and
   structured log events emitted during a CLI or MCP server run. Used
   for debugging and performance analysis. Stays local unless an operator
   explicitly configures an OTEL exporter endpoint.

2. **Usage telemetry** (not yet implemented) — aggregated, anonymised
   event records sent to a Assignee-operated endpoint to drive
   product decisions. Gated behind an explicit opt-in prompt.
   See "Usage telemetry shipping milestone" below.

---

## Pipeline observability (implemented)

### Architecture

The pipeline observability layer lives in `packages/core/src/telemetry/`
and consists of four components:

| File                             | Purpose                                                                                   |
| -------------------------------- | ----------------------------------------------------------------------------------------- |
| `telemetry-port.ts`              | `TelemetryPort` hexagonal port + `emitFiltered` helper + opt-in gate                      |
| `telemetry-event-schema.ts`      | `TelemetryEvent` data shape (`event_name`, `timestamp`, `node_id`, `tenant_id`, `extras`) |
| `otel-allowlist.ts`              | `OTEL_FIELD_ALLOWLIST` with `@privacy: PII/SYSTEM/OPERATIONAL` per field                  |
| `spans.ts`                       | Per-graph-node span emitter (entry + exit events, duration backfill)                      |
| `in-memory-telemetry-adapter.ts` | Ring-buffer adapter (cap 1 000 events); used in tests and dev                             |
| `otel-exporter.ts`               | HTTP/OTEL export when `ASSIGNEE_OTEL_ENDPOINT` is set                                     |

### Per-node spans

`spans.ts` wraps 13 of the 14 graph nodes with entry + exit `SpanEvent`
records. The `HUMAN_APPROVAL` node is excluded — it blocks indefinitely
on user input and has no meaningful entry/exit timing. Each span carries:

- `spanId` — 16-hex random identifier.
- `traceId` — the run's `runId`, so every span in one CLI invocation
  belongs to one trace.
- `node` — matches the `GraphNode` constant string.
- `durationMs` — backfilled on the exit span.

Spans are emitted via `exportLogEvent` (OTEL/HTTP when the exporter is
enabled) and always appear in the local JSONL log at `debug` level.

### Field filtering pipeline

`emitFiltered` applies three passes before the adapter ever sees an event:

1. **`isTelemetryEnabled()` gate** — no-op when `ASSIGNEE_TELEMETRY_ADAPTER`
   is absent or empty (L1-F52 invariant: no vendor phone-home by default).
2. **`filterAllowlistedFields`** (W6) — drops any key in `extras` not
   present in `OTEL_FIELD_ALLOWLIST`. PII-classified fields are also
   dropped unless `ASSIGNEE_OTEL_INCLUDE_PII=1`.
3. **`filterSensitiveElicitedFields`** (W1) — redacts values that were
   produced from a `ResourceField` with `sensitive: true`. This pass runs
   after the allowlist check so credentials never reach the adapter even
   when they pass the allowlist filter on field name alone.

Adapters always receive pre-scrubbed events. They must not apply
additional field-level filtering.

### Activating pipeline observability

| Env var                      | Effect                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `ASSIGNEE_TELEMETRY_ADAPTER` | Non-empty → enable adapter. Only `in-memory` adapter exists today.           |
| `ASSIGNEE_OTEL_ENDPOINT`     | Non-empty → forward scrubbed events to an HTTP OTEL collector endpoint.      |
| `ASSIGNEE_OTEL_INCLUDE_PII`  | Set to `1` to include PII-classified fields (e.g. for private on-prem OTEL). |

---

## Usage telemetry shipping milestone

- **Current state**: Not implemented. Zero usage-telemetry code in the repo.
  No runtime code reads `telemetry.enabled` or `ASSIGNEE_TELEMETRY` (the
  usage-telemetry config key, distinct from `ASSIGNEE_TELEMETRY_ADAPTER`).
- **Milestone**: **v0.2.2** — after the v0.2 npm-publish ships. The first
  cohort of OSS users gets a known-good install (plan / apply / destroy,
  config precedence, drift detection) for a release or two before any
  data-collection prompt appears.
- **Why deferred to v0.2.2**: Operators should see the tool work end-to-end
  on their own infrastructure before being asked to opt in to anything. A
  v0.2 that prompts for telemetry on first run is indistinguishable from a
  tool that phones home by default.

---

## Default

**Off.** The CLI does not send any usage telemetry to any third party unless
the operator explicitly opts in. The absence of a `telemetry.enabled` key
in config is treated as "off", not "ask later".

---

## Opt-in path

1. `assignee init` asks once: _"Opt in to anonymous usage telemetry?"_
   with a link to this document. Default answer is **no**.
2. The answer is written to `~/.assignee/config.yaml` under
   `telemetry.enabled: true | false`. Users can edit the file later, or
   run `assignee init --reset-telemetry` to be asked again.
3. `ASSIGNEE_TELEMETRY=0` in the environment overrides the config value
   to `false`, no matter what the config says. `ASSIGNEE_TELEMETRY=1`
   has no effect on its own — explicit opt-in must happen in config so
   that an environment variable alone cannot enable data collection.

---

## What would be collected if enabled

Every usage-telemetry record is a single JSON object with these fields
and nothing else:

| Field            | Example              | Purpose                                                      |
| ---------------- | -------------------- | ------------------------------------------------------------ |
| `event`          | `plan.succeeded`     | Bucketed event name from a closed enum                       |
| `resource_type`  | `AWS::S3::Bucket`    | CloudFormation type name from `SUPPORTED_TYPES_ARRAY`        |
| `region_group`   | `us-east`            | Bucketed region (no finer than cardinal direction + country) |
| `cost_band`      | `under_10_per_month` | Bucketed cost estimate, never the exact dollar figure        |
| `success`        | `true`               | Did the operation succeed                                    |
| `duration_band`  | `under_30s`          | Bucketed wall-clock duration                                 |
| `cli_version`    | `0.1.0`              | For cohorting by release                                     |
| `schema_version` | `1`                  | For forward-compatibility                                    |

That's the complete shape. Any field outside this allowlist is dropped
at serialisation time. The serialiser is deliberately strict — adding a
new field requires editing the schema, and the schema is the
contribution-diff reviewers look at first.

---

## What is NEVER collected

- Raw natural-language intent (the user's English sentence).
- Resource ARNs, identifiers, or names.
- AWS account IDs, user ARNs, or IAM role names.
- Operator hostname, IP address, or MAC address.
- File paths, filesystem layout, or checkpoint contents.
- Error messages (classification only).
- Stack traces.
- Any field derived from the operator's desiredState JSON.

The `sensitive: true` marker on `ResourceField` (W1) and the `OTEL_FIELD_ALLOWLIST`
`@privacy: PII` classification (W6) both enforce this — the same field-filtering
pipeline that guards the local observability layer gates the usage-telemetry path.

---

## Where it would go

When usage telemetry ships, the endpoint will be under a domain owned by
the maintainer and operated with:

- TLS 1.3 termination.
- Short retention (90 days hot; 12 months in anonymised rollups).
- No third-party pixel trackers, ad networks, or session replay.
- A public privacy policy at `/privacy` that predates the first record.

No endpoint exists today. This page will be updated with the real URL
before the first record is sent.

---

## Disabling

- Flip `telemetry.enabled: false` in `~/.assignee/config.yaml`.
- Export `ASSIGNEE_TELEMETRY=0` (wins over the config value).
- Uninstall the CLI. Telemetry is disabled immediately in all three cases.

---

## Review checklist for future implementers

Before the first usage-telemetry PR merges:

- [ ] Privacy policy page published at a stable URL.
- [ ] Field allowlist schema in `packages/core/src/telemetry/schema.ts`
      (v0.2.2 target — does not exist yet) with a unit test that
      rejects any unlisted field.
- [ ] End-to-end test that sends a record with a blocked field (e.g.
      raw intent) and asserts the serialiser drops it.
- [ ] `assignee init` UX reviewed against the Contributor Covenant.
- [ ] `ASSIGNEE_TELEMETRY=0` takes precedence over `true` in config.
- [ ] No telemetry call in any code path that runs before the opt-in check.
- [ ] Retention window explicitly documented and enforced in the backing store.
