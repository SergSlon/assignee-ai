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

| File                                                         | Purpose                                                                                   |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/core/src/ports/telemetry-port.ts`                  | `TelemetryPort` hexagonal port + `emitFiltered` helper + opt-in gate                      |
| `packages/core/src/telemetry/telemetry-event-schema.ts`      | `TelemetryEvent` data shape (`event_name`, `timestamp`, `node_id`, `tenant_id`, `extras`) |
| `packages/core/src/telemetry/otel-allowlist.ts`              | `OTEL_FIELD_ALLOWLIST` with `@privacy: PII/SYSTEM/OPERATIONAL` per field                  |
| `packages/core/src/telemetry/spans.ts`                       | Per-graph-node span emitter (entry + exit events, duration backfill)                      |
| `packages/core/src/telemetry/in-memory-telemetry-adapter.ts` | Ring-buffer adapter (cap 1 000 events); used in tests and dev                             |
| `packages/core/src/telemetry/otel-exporter.ts`               | HTTP/OTEL export when `ASSIGNEE_OTEL_ENDPOINT` is set                                     |

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
   is absent or empty (the no-vendor-phone-home-by-default invariant).
2. **`filterAllowlistedFields`** — drops any key in `extras` not
   present in `OTEL_FIELD_ALLOWLIST`. PII-classified fields are also
   dropped unless `ASSIGNEE_OTEL_INCLUDE_PII=1`. The PII gate is an
   **exact-equality** check against the literal string `"1"`: setting
   the variable to `true`, `yes`, `on`, or simply exporting it bare
   (no value) does **not** enable PII pass-through. The check is
   strict by design so a typoed env-var value fails closed.
3. **`filterSensitiveElicitedFields`** — redacts values that were
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

## Usage telemetry — design intent only

- **Current state**: Not implemented. Zero usage-telemetry code in the repo.
  No runtime code reads `telemetry.enabled` or `ASSIGNEE_TELEMETRY` (the
  usage-telemetry config key, distinct from `ASSIGNEE_TELEMETRY_ADAPTER`).
- **Status**: Design intent for any future productisation. Out of scope
  for this course-submission build.
- **Why deferred**: Operators should see the tool work end-to-end on their
  own infrastructure before being asked to opt in to anything. A first
  release that prompts for telemetry on first run is indistinguishable from
  a tool that phones home by default.

---

## Default

**Off.** The CLI does not send any usage telemetry to any third party unless
the operator explicitly opts in. The absence of a `telemetry.enabled` key
in config is treated as "off", not "ask later".

---

## Opt-in path (design intent — not yet wired in CLI)

> The flow below describes how the opt-in prompt would behave once
> the usage-telemetry path is built. None of it is wired in `assignee
init` today — the CLI does not ask, does not write `telemetry.enabled`,
> and does not read `ASSIGNEE_TELEMETRY`.

1. `assignee init` would ask once: _"Opt in to anonymous usage telemetry?"_
   with a link to this document. Default answer is **no**.
2. The answer would be written to `~/.assignee/config.yaml` under
   `telemetry.enabled: true | false`. Users could edit the file later, or
   run `assignee init --reset-telemetry` to be asked again.
3. `ASSIGNEE_TELEMETRY=0` in the environment would override the config
   value to `false`, no matter what the config says. `ASSIGNEE_TELEMETRY=1`
   would have no effect on its own — explicit opt-in must happen in config
   so that an environment variable alone cannot enable data collection.

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

The `sensitive: true` marker on `ResourceField` and the `OTEL_FIELD_ALLOWLIST`
`@privacy: PII` classification both enforce this — the same field-filtering
pipeline that guards the local observability layer gates the usage-telemetry path.

---

## Where it would go (future intent only)

If usage telemetry were ever shipped, the endpoint would be operated
with:

- TLS 1.3 termination.
- Short retention (e.g. 90 days hot; 12 months in anonymised rollups).
- No third-party pixel trackers, ad networks, or session replay.
- A public privacy policy that predates the first record.

No endpoint exists today, no domain has been registered for it, and no
privacy policy has been written. This page would be updated with
concrete URLs before the first record is sent.

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
      (does not exist yet) with a unit test that rejects any unlisted
      field.
- [ ] End-to-end test that sends a record with a blocked field (e.g.
      raw intent) and asserts the serialiser drops it.
- [ ] `assignee init` UX reviewed against the Contributor Covenant.
- [ ] `ASSIGNEE_TELEMETRY=0` takes precedence over `true` in config.
- [ ] No telemetry call in any code path that runs before the opt-in check.
- [ ] Retention window explicitly documented and enforced in the backing store.
