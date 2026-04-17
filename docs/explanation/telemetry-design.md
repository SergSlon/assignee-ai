# Telemetry — design and privacy model

This page documents the design of Assignee.ai's telemetry opt-in. No
telemetry is collected today. The page exists so that when the feature
ships it ships with a published privacy model, not as a retrofit.

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
- Error messages (classification only — see `errorClass` in the CLI
  `audit-log.ts` for the pattern we would reuse here).
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
      with a unit test that rejects any unlisted field.
- [ ] End-to-end test that sends a record with a blocked field (e.g.
      raw intent) and asserts the serialiser drops it.
- [ ] `assignee init` UX reviewed against the Contributor Covenant.
- [ ] `ASSIGNEE_TELEMETRY=0` takes precedence over `true` in config.
- [ ] No telemetry call in any code path that runs before the opt-in
      check.
- [ ] Retention window explicitly documented and enforced in the
      backing store.

## Status

**Design only. No code.** This doc and the checklist land before the
first line of telemetry code. Opening a PR that adds telemetry without
the checklist items above should be blocked in review.
