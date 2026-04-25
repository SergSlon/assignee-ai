# Run-ledger design

> Diátaxis: **explanation** (understanding-oriented). Why Assignee.ai
> tags every resource with a run identifier, what the ledger buys us
> today, and why `assignee destroy --run-id <uuid>` is a **v0.2
> milestone** rather than a v0.1 feature (v0.1 uses the existing
> per-resource `assignee destroy <resource>` flow).

## What the run-ledger is

Every `assignee plan` (and the matching `assignee apply`) generates a
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
   `assignee apply --checkpoint <path>` resumes from that file and
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
  state file. This is explicitly a positive trust signal, documented in
  the Epic 50 L10 review (at `_bmad-output/planning-artifacts/_archive/research/epic-50/L10-moat.md` in the workspace planning archive).

### Workflow-stickiness goals

The L10 moat review (at `_bmad-output/planning-artifacts/_archive/research/epic-50/L10-moat.md` in the workspace planning archive)
identifies the flip side: near-zero switching cost is fatal for
retention. The run-ledger is the one piece of infrastructure that
creates _workflow_ stickiness without _data_ stickiness — the user
types `assignee destroy <resource>` instead of hand-writing
`aws cloudformation delete-stack`, and the tag-based lookup "just
works" for every resource assignee touched.

## Current capabilities

As of Story 50-10, the following run-ledger operations work today:

| Operation                                          | Command                                                                                                         | Source of truth             |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Enumerate resources from a run via the AWS tag API | `aws resourcegroupstaggingapi get-resources --tag-filters Key=assignee-run-id,Values=<uuid>`                    | Resource Groups Tagging API |
| List every managed resource in the account         | `assignee list`                                                                                                 | `managed-by` tag            |
| Destroy a single resource by ARN or name           | `assignee destroy <arn-or-name>`                                                                                | Resource resolver + CCAPI   |
| Resume a paused plan                               | `assignee apply --checkpoint .assignee/checkpoint-<runId>.json`                                                 | Checkpoint file             |
| Replay a past intent                               | _not implemented_ — provision records carry the desired-state hash, not the raw intent. Deliberate — see below. | —                           |

## What is deferred — `assignee destroy --run-id <uuid>`

A natural extension is `assignee destroy --run-id <uuid>`: "undo
everything this run created, in one call." The design implications:

1. **Re-introduces multi-resource destroy.** Story 50-3 explicitly cut
   `--all` and `--include-iam` because the safety allowlist was a tacit
   admission that bulk-destroy was too dangerous for v1 — the guard
   prevented `AssigneeOperator`/`Reader`/`Auditor` IAM from being
   swept, which meant the flag was always one blind `--include-iam`
   away from a self-lockout.
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

The safer path forward: **the run-id-sticky destroy ships in
v0.2** (the next public milestone), with the learnings from Story
50-3 and the workflow-stickiness data from the OSS launch informing
the UX. v0.1 — the current pre-public source build — ships the
_read-only_ audit trail plus the existing per-resource
`assignee destroy <resource>` primitive; that is the deliberate
OSS-launch gate and no separate "future epic" disclaimer is needed.

## What the design WILL look like (sketch, non-binding)

When v0.2 lands `assignee destroy --run-id <uuid>`, the shape will
probably be:

```text
$ assignee destroy --run-id 0f8e1c…

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

This sketch is non-binding — revisit when the implementation epic
lands.

## Related reading

- [`oss-vs-saas.md`](./oss-vs-saas.md) — the run-ledger is OSS forever;
  drift detection on top is the future SaaS anchor.
- [`invariants.md`](./invariants.md) — destroy-time invariants that any
  future multi-resource path must preserve.
