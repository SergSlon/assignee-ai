# Telemetry — design and privacy model

This page documents the design of Assignee.ai's telemetry opt-in. No
telemetry is collected today. The page exists so that when the feature
ships it ships with a published privacy model, not as a retrofit.

## Shipping milestone

- **Current state**: Not implemented. Zero telemetry code in the repo
  today. `rg "telemetry" apps/cli/src apps/mcp-server/src packages/core/src --type ts`
  returns only the OTel exporter scaffold at
  `packages/core/src/telemetry/otel-exporter.ts`, which is for BP rule
  authorship — not usage telemetry. No runtime code reads
  `telemetry.enabled` or `ASSIGNEE_TELEMETRY`.
- **Milestone**: **v0.2.2** — _after_ the v0.2 npm-publish ships. The
  first cohort of OSS users gets a known-good install (plan / apply /
  destroy, config precedence, drift detection) for a release or two
  before any data-collection prompt appears. Shipping telemetry with
  the first public publish risks a trust flap that would cost more
  than the usage data is worth.
- **Why deferred to v0.2.2 specifically**: Operators should see the
  tool work end-to-end on their own infrastructure before being asked
  to opt in to anything. A v0.2 that prompts for telemetry on first
  run is indistinguishable, to a suspicious operator reading the
  install script, from a tool that phones home by default.
- **What's ready today** (design-frozen, no code):
  - Privacy model — the rest of this page.
  - Opt-in schema — config key name (`telemetry.enabled`) and the
    env-var-overrides-config rule (`ASSIGNEE_TELEMETRY=0` wins;
    `ASSIGNEE_TELEMETRY=1` alone does nothing).
  - Never-collect allowlist — the fields enumerated under
    "What is NEVER collected" below.
- **What's NOT ready** (the v0.2.2 implementation PR must land all of
  these together or none of them):
  - Wire-up code for a telemetry sink.
  - OTel exporter integration for usage events (distinct from the
    BP-authorship scaffold that already exists).
  - `assignee init` prompt branch that writes
    `telemetry.enabled` to `~/.assignee/config.yaml`.
  - Config-loader logic that honors `telemetry.enabled` and the
    `ASSIGNEE_TELEMETRY` env-var precedence rule.
  - Every item in the "Review checklist for future implementers"
    section below.

Until v0.2.2 ships, this document is a design artifact only.
Reviewers of any PR that adds telemetry code before v0.2 npm-publish
completes should block the PR on these grounds alone.

## Default

**Off.** The CLI does not send any telemetry to any third party unless
the operator explicitly opts in. The absence of a `telemetry.enabled`
key in config is treated as "off", not "ask later".

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

## What is collected if enabled

Every record is a single JSON object with these fields and nothing else:

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

## What is NEVER collected

- Raw natural-language intent (the user's English sentence).
- Resource ARNs, identifiers, or names.
- AWS account IDs, user ARNs, or IAM role names.
- Operator hostname, IP address, or MAC address.
- File paths, filesystem layout, or checkpoint contents.
- Error messages (classification only — see `errorClass` in the MCP
  server `apps/mcp-server/src/utils/audit-log.ts` for the pattern we
  would reuse here).
- Stack traces.
- Any field derived from the operator's desiredState JSON.

## Where it would go

When telemetry ships, the endpoint will be under a domain owned by
the maintainer and operated with:

- TLS 1.3 termination.
- Short retention (90 days hot; 12 months in anonymised rollups).
- No third-party pixel trackers, ad networks, or session replay.
- A public privacy policy at `/privacy` that predates the first record.

No endpoint exists today. This page will be updated with the real URL
before the first record is sent.

## Why this matters

Assignee.ai is an Infrastructure-as-Code tool. Operators give it AWS
credentials. The project's trust story depends on keeping the CLI's
network surface small, legible, and opt-in. Telemetry that ships
without a pre-published policy, or that expands beyond the allowlisted
fields above, would violate that trust and the CLI would lose the
"local-first credentials, local-first inference" differentiator that
L10 review identified as a moat.

## Disabling

- Flip `telemetry.enabled: false` in `~/.assignee/config.yaml`.
- Export `ASSIGNEE_TELEMETRY=0` (wins over the config value).
- Uninstall the CLI. Telemetry is disabled immediately in all three
  cases; no "disable takes effect at next launch" UX.

## Review checklist for future implementers

Before the first telemetry PR merges:

- [ ] Privacy policy page published at a stable URL.
- [ ] Field allowlist schema in `packages/core/src/telemetry/schema.ts`
      (v0.2.2 target — does not exist yet) with a unit test that
      rejects any unlisted field.
- [ ] End-to-end test that sends a record with a blocked field (e.g.
      raw intent) and asserts the serialiser drops it.
- [ ] `assignee init` UX reviewed against the Contributor Covenant.
- [ ] `ASSIGNEE_TELEMETRY=0` takes precedence over `true` in config.
- [ ] No telemetry call in any code path that runs before the opt-in
      check.
- [ ] Retention window explicitly documented and enforced in the
      backing store.

## Design-only rule

**Design only. No code.** This doc and the checklist land before the
first line of telemetry code. Opening a PR that adds telemetry without
the checklist items above should be blocked in review. See
"Shipping milestone" at the top of this page for the v0.2.2 window in
which implementation is expected to land.
