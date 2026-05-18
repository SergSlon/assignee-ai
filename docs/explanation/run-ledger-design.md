# Run-ledger design

> Diátaxis: **explanation** (understanding-oriented). Why Assignee.ai
> tags every resource with a run identifier, what the ledger buys
> today, and why `assignee infra destroy --run-id <uuid>` is a future-work
> sketch rather than a shipped feature (the current build uses the
> existing per-resource `assignee infra destroy <resource>` flow).

## What the run-ledger is

Every `assignee infra plan` (and the matching `assignee infra apply`) generates a
**`runId`** — a UUID created when the LangGraph pipeline instantiates
its `AgentState`. The runId flows through the graph and lands in three
places:

1. **Resource tags** — the mandatory-tag injector at
   [`packages/core/src/utils/tags.ts`](../../packages/core/src/utils/tags.ts)
   (re-exported via `apps/cli/src/utils/tags.ts`) writes
   `assignee-run-id=<uuid>` on every resource it provisions
   (alongside `managed-by=assignee-ai` and `environment=<env>`).
   Resource types that CloudFormation refuses to tag (e.g.
   `AWS::EC2::Route`, `AWS::SNS::Subscription`) are skipped — the
   `NO_TAG_TYPES` set in the same file is the canonical list.
2. **Provision records** — the memory-recorder at
   [`packages/core/src/services/memory/service.ts`](../../packages/core/src/services/memory/service.ts)
   appends a JSONL entry with the runId, resource type, ARN, region,
   desired-state SHA-256 hash, estimated monthly cost, and timestamp.
   The file lives under the user's memory dir (`~/.assignee/memory/` by
   default) and is fire-and-forget — write failures never block the
   apply path. Writes are protected by the `AdvisoryLockPort` and use an
   atomic rename so concurrent CLI invocations never produce a corrupted
   file (see `docs/explanation/invariants.md § Atomic-write + advisory-lock
on memory persistence`).
3. **Checkpoint files** — when the user pauses between plan and apply
   (Ctrl-C after the typed-name confirm) the checkpoint writer at
   [`apps/cli/src/commands/plan/checkpoint-writer.ts`](../../apps/cli/src/commands/plan/checkpoint-writer.ts)
   serialises the graph state into `.assignee/checkpoint-<runId>.json`.
   `assignee infra apply --checkpoint <path>` resumes from that file and
   preserves the original runId for audit continuity.

The three artifacts together form the **run-ledger**: a local,
single-user record of "what got provisioned, when, and by which
intent."

## What the run-ledger is for

### Design-time goals

- **Traceability** — every resource in the AWS account is reachable
  from the run that created it (`aws resourcegroupstaggingapi
get-resources --tag-filters Key=assignee-run-id,Values=<uuid>`). No
  guessing which `assignee` invocation created a particular S3 bucket.
- **Replay and audit** — the desired-state SHA-256 in the provision
  record lets any auditor verify the bytes Assignee asked CCAPI to
  apply, even months later. The intent text is _not_ stored (see
  [`telemetry-design.md`](./telemetry-design.md) for why).
- **Switching-cost reduction** — tag-based ownership means users can
  migrate to Terraform or Pulumi in a single
  `aws resourcegroupstaggingapi` call, without exporting a proprietary
  state file. This is explicitly a positive trust signal of the design.

### Workflow-stickiness goals

A tag-based design that imposes near-zero switching cost is comfortable
for users but hostile to long-term retention if no workflow stickiness
exists. The run-ledger is the one piece of infrastructure that creates
_workflow_ stickiness without _data_ stickiness — the user types
`assignee infra destroy <resource>` instead of hand-writing
`aws cloudformation delete-stack`, and the tag-based lookup "just
works" for every resource assignee touched.

## Current capabilities

The following run-ledger operations work in the current build:

| Operation                                          | Command                                                                                                         | Source of truth             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Enumerate resources from a run via the AWS tag API | `aws resourcegroupstaggingapi get-resources --tag-filters Key=assignee-run-id,Values=<uuid>`                    | Resource Groups Tagging API |
| List every managed resource in the account         | `assignee admin list`                                                                                           | `managed-by` tag            |
| Destroy a single resource by ARN or name           | `assignee infra destroy <arn-or-name>`                                                                          | Resource resolver + CCAPI   |
| Resume a paused plan                               | `assignee infra apply --checkpoint .assignee/checkpoint-<runId>.json`                                           | Checkpoint file             |
| Replay a past intent                               | _not implemented_ — provision records carry the desired-state hash, not the raw intent. Deliberate — see below. | —                           |

## What is deferred — `assignee infra destroy --run-id <uuid>`

A natural extension is `assignee infra destroy --run-id <uuid>`: "undo
everything this run created, in one call." The design implications:

1. **Re-introduces multi-resource destroy.** A previous iteration cut
   `--all` and `--include-iam` because the safety allowlist was a tacit
   admission that bulk-destroy was too dangerous — the guard prevented
   `AssigneeOperator`/`Reader`/`Auditor` IAM from being swept, which
   meant the flag was always one blind `--include-iam` away from a
   self-lockout.
2. **Requires per-resource typed-name confirmation.** The current
   single-flow typed-confirm (`destroy/typed-confirm.ts`) demands the
   resource identifier to be typed back. Multiplying that over a run
   with N resources means either N typed confirms (UX-hostile for
   N > 3) or a new "bulk" confirm mode (re-introduces the
   blast-radius problem).
3. **Dependency ordering.** CCAPI does not destroy resources in the
   right dependency order by default. A run that provisioned a VPC +
   subnets + route tables + NAT gateway + EIPs must be destroyed in
   reverse dependency order or the deletes fail mid-way and leave
   half-destroyed state. The [destroy pre-delete hooks](./invariants.md)
   for IGW/RouteTable handle the single-resource case; a multi-resource
   flow needs a topological sort + rollback-on-error policy that we
   have not designed yet.

A safer path forward, sketched as future work: ship `assignee infra destroy
--run-id <uuid>` once the dependency-ordering and bulk-confirm UX
questions below have been resolved. The current build ships the
_read-only_ audit trail plus the existing per-resource
`assignee infra destroy <resource>` primitive — that is deliberate, and
this section is a future-work sketch, not a committed feature for
this course-submission build.

## What the design might look like (sketch, non-binding)

If `assignee infra destroy --run-id <uuid>` were implemented, the shape
might be:

```text
$ assignee infra destroy --run-id 0f8e1c…

  Preview: 7 resources tagged assignee-run-id=0f8e1c…
    1. arn:aws:s3:::my-app-data         (S3 bucket, ~$0.50/mo)
    2. arn:aws:ec2:…:vpc/vpc-0ab…       (VPC, free)
    3. arn:aws:ec2:…:subnet/subnet-…    (Subnet × 2, free)
    5. arn:aws:ec2:…:natgateway/nat-…   (NAT Gateway, ~$32/mo)
    6. arn:aws:ec2:…:internet-gateway/… (IGW, free)
    7. arn:aws:ec2:…:eip/…              (EIP, ~$3/mo)

  Estimated monthly savings: ~$35.50
  Destroy order: 1 → 7 → 6 → 5 → 4 → 3 → 2 (topological)

  Type 'destroy 7 resources' to confirm:
```

Key properties of the future design:

- **Single typed-confirm, not per-resource.** The confirm phrase is
  `destroy N resources` — short enough to type, long enough that a
  keyboard-cat-on-the-prompt can't trigger it.
- **Topological sort up front.** Show the user the destroy order
  before they confirm so a bad ordering is visible.
- **Dry-run default when N > 3.** Force the user to pass `--yes`
  explicitly for bulk destroys, the opposite of the single-destroy
  default.
- **No `--include-iam` flag.** IAM destruction remains single-resource-
  only forever — the self-lockout risk is not worth the convenience.

This sketch is non-binding — revisit if the feature is ever
implemented.

## Related reading

- [`oss-vs-saas.md`](./oss-vs-saas.md) — the run-ledger is open;
  drift detection on top is sketched as future productisation work.
- [`invariants.md`](./invariants.md) — destroy-time invariants that any
  future multi-resource path must preserve.
