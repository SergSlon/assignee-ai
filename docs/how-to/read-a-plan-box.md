# How to read a plan box

You ran `assignee plan "..."` (for example, `assignee plan "an EC2 box for
my homelab"`) and the CLI dropped a cyan-bordered "Plan" frame into your
terminal. This guide explains every section so you can decide whether to
accept, refine, or reject the plan.

## What you see

The plan box is rendered by `renderPlanBox` (canonical source:
`packages/core/src/utils/display-plan.ts`). On a TTY it appears inside a
boxen frame titled `Plan`; on a non-TTY pipe it falls back to a plain
`=== Plan === / ============` block with identical contents. The fields
below are emitted in this order.

### Compound prelude (only for compound patterns)

When your intent matched a multi-resource pattern (for example, "VPC with
public and private subnets"), the box opens with a queue listing:

```
Compound:        <Pattern Name> (<N> resources)
  ▸ 01. <ResourceType> — <displayName>
    02. <ResourceType> — <displayName>
    ...
```

The `▸` marker points to the resource the current plan slice is for. The
remaining numbered rows are queued and will get their own plan boxes in
sequence.

### Resource Type, Region, Config

- `Resource Type:` — the AWS::Service::Resource being planned (for example
  `AWS::EC2::Instance`).
- `Region:` — the target region. If you are using a Bedrock cross-regional
  inference profile (`us.*`, `eu.*`, `ap.*`), the suffix
  `(cross-regional inference: us.*)` is appended.
- `Config:` — a pretty-printed summary of the desired state the LLM
  produced from your intent. This is what will be sent to CloudControl on
  apply.

### Estimated Cost (and breakdown)

`Estimated Cost:` is fetched live from the Pricing MCP — there are zero
hardcoded dollar amounts. The line is suffixed with provenance:

- `(live)` — fetched fresh from the AWS Pricing API.
- `(estimated)` — fallback estimate when live pricing was unavailable.
- `Free` — the resource is in the AWS free tier or has no chargeable
  dimension.
- `N/A` — pricing could not be resolved.

For supported resource types a multi-line breakdown follows: per-line-item
fixed costs, a `Subtotal (fixed)` row, then per-unit usage-based rates
(for example, S3 PUT/GET requests) and a `Prices fetched at <ts>`
timestamp. A `Some prices unavailable` warning indicates partial fetch
failure (you can still apply; cost may be higher than shown).

### Findings, hints, and applied fixes

- `Auto-fixed:` — best-practice violations that the auto-fix pass already
  rewrote in your config (each line shows `field: old -> new (BP-id: title)`).
- `Findings` — remaining best-practice findings the auto-fixer could not
  or should not change automatically, grouped by severity.
- `* N findings can be auto-fixed. Run \`assignee init\` to enable.` —
  shown when auto-fix is disabled but auto-fixable findings remain.
- Memory hints, free-tier notes, and contextual advice may also appear.

### Run ID (verbose only)

`Run ID:` shows the workflow ID under `--verbose`. It is the tag value
that ties this plan to its eventual apply/destroy in the run ledger.

## What to do next

After the box, the CLI prints `Apply now?` (only on a TTY when
`--no-apply` was not passed):

- **Accept** — confirm the prompt, or run `assignee apply` later. The
  same desired state will be provisioned via CloudControl.
- **Reject** — decline the prompt and refine your intent ("…with 50 GB
  storage and a public IP"), then re-run `assignee plan`.
- **Inspect more** — re-run with `--verbose` for the run ID and extra
  diagnostics, or check `docs/reference/commands.md` for related flags.
