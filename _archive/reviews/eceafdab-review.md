# Reviewer: ACCEPT — qa (Quinn) — item-6-storage-enricher

> **Verdict promoted from REJECT to ACCEPT after coordinator-response
> addressed both BLOCKERs + the three HIGH findings in the same commit.
> Original REJECT verdict + findings inventory preserved below for
> audit-trail accuracy.**

---

# Original verdict: REJECT — qa (Quinn) — item-6-storage-enricher

## Verdict

**REJECT.** Two BLOCKERs that together mean the feature does nothing
in production for a stock-installed operator while silently consuming
CloudWatch API budget and breaking cross-package parity. The code is
otherwise well-engineered (clear comments, sound concurrency, real-
data mocks, generous test coverage), so the rejection is targeted:
land the IAM grant + MCP-server parity + storage-class coverage and
this is a clean ACCEPT.

## Findings (severity-categorised, full inventory)

### BLOCKER (must fix before merge)

**B1 — `cloudwatch:GetMetricStatistics` is not in the operator IAM
policy.** `packages/core/src/config/iam-policies/operator.ts` only
grants CloudWatch _alarm_ verbs (`PutMetricAlarm`, `DeleteAlarms`,
`DescribeAlarms`, `SetAlarmState`, `TagResource`,
`EnableAlarmActions`, `DisableAlarmActions` — all from
`OBSERVABILITY_ACTIONS` in `packages/core/src/config/iam-actions/
observability.ts:19-27`). There is no `cloudwatch:GetMetricStatistics`
anywhere in the operator core policy, services-A, services-B,
reader, or auditor policies. The PR adds a runtime
`GetMetricStatistics` call but never grants the permission. Per the
silent-swallow design in `apps/cli/src/services/storage-enricher.ts:
150-157`, every per-bucket call returns `AccessDenied`, the result
map stays empty, and the F6 promotion path in
`packages/core/src/list-resources/pricing-enricher.ts:551-558` never
fires. The display reverts to the rate-hint string — **F6 is not
closed for any operator who has not manually re-attached a
permissive policy.** Required fix: add a new IAM statement (probably
under `Resource: "*"` since CloudWatch GetMetricStatistics does not
support resource-level scoping — it scopes by `cloudwatch:namespace`
in a Condition, set to `["AWS/S3"]`) in `operatorPolicy()`. Update
`scripts/audit-iam-policies.ts` to lock the action in. Verify
locally with `aws iam simulate-principal-policy --action-names
cloudwatch:GetMetricStatistics`.

**B2 — Cross-package parity violation: MCP server does not wire the
storage enricher.** `apps/mcp-server/src/services/list-resources.ts:
221` calls `createListPricingEnricher()` with no storage enricher,
so the MCP `list_managed_resources` tool's S3 cost labels remain
rate hints (`$0.0230/GB-mo`) even when sdkCredentials are available
(operator creds are resolved at line 204-209 — the wiring is
trivial). The project's CLAUDE.md is explicit: "Verify across
packages — Fixes in CLI may need mirroring in MCP server. Always
check both." Adding `createCloudWatchStorageEnricher(...)` here
costs ~5 lines and the IAM-policy fix from B1 unblocks it.

### HIGH

**H1 — Only `StandardStorage` queried.** `apps/cli/src/services/
storage-enricher.ts:135` hardcodes `StorageType=StandardStorage`.
S3 publishes `BucketSizeBytes` per storage class (`StandardStorage`,
`StandardIAStorage`, `OneZoneIAStorage`,
`IntelligentTieringFAStorage`, `ReducedRedundancyStorage`,
`GlacierStorage`, `GlacierInstantRetrievalStorage`,
`DeepArchiveStorage`, etc.). A bucket that lives entirely in IA or
Glacier returns zero datapoints for `StandardStorage` and the code
falls back to the rate-hint display — wrong answer, not "no data".
Worse: the per-GB-month rate in the pricing-enricher is the
StandardStorage rate, so even if the code aggregated across all
classes it would mis-cost IA/Glacier (different rates). Two
reasonable shapes: (a) issue parallel `GetMetricStatistics` calls
per storage class with the matching pricing rate, summed per
bucket; (b) document the StandardStorage-only scope in the
comment and add a TODO so the next iteration knows. The current
docstring claims "actual S3 bucket sizes" — it claims more than it
delivers.

**H2 — Storage enricher fires on every `assignee admin list` (not
gated on `--total-cost`).** `apps/cli/src/commands/list.ts:224`
calls `fetchManagedResources(opts.region, resolvedResourceType)`
unconditionally; `--total-cost` is only consulted at line 264 to
decide whether to print the sum line. That means EVERY list
invocation pays one CloudWatch call per S3 bucket plus the
~50ms RTT × bounded-concurrency window. The PR's own header
comment (storage-enricher.ts:21-23) implies a `--total-cost`
gate that does not exist. Either gate the wire-up at the
command level (`list.ts`) when `opts.totalCost` is false, or
update the header to remove the misleading "cost / latency only
matters when summing" framing. The pricing enricher's MCP call
also fires unconditionally — same class of issue but pre-existing.

**H3 — Per-resource label promotion depends on `usageBasedItems[0]`
being the storage line.** The pricing-enricher only queries the
FIRST usage-based item (`packages/core/src/list-resources/
pricing-enricher.ts:465-466`: `if (usageBasedItems.length > 0 &&
fixedSubtotal === 0) { const item = usageBasedItems[0]!; ... }`),
and the F6 storage-rate lookup at line 531-536 then checks that
parsed item's `priceUnit` against `/GB-mo`. This works today only
because `packages/core/src/pricing/decomposers/s3.ts:65-67`
happens to emit the storage item first. If the S3 decomposer is
ever rearranged (or another type like EFS is added where storage
isn't the first usage-based line item), the F6 path silently
breaks with no failing test. Either iterate over `usageBasedItems`
to find the per-GB-month entry explicitly and issue a Pricing-MCP
call for it, or add a regression test that asserts decomposer
ordering for every type that has a per-GB-month rate.

### MEDIUM

**M1 — Resource leak path when `runWithConcurrency` itself rejects.**
The whole enricher body (`storage-enricher.ts:89-176`) has no
top-level try/finally around `clients` cleanup. `runWithConcurrency`
catches per-task errors so it should never throw, but a defensive
`try { await runWithConcurrency(...) } finally { destroy clients }`
would protect against future refactors that surface an error from
the runner. Low blast radius (process exits soon after), but free
to fix.

**M2 — `storageEnricher` is invoked even when there are zero
priceable resources.** `pricing-enricher.ts:276-288` calls
`storageEnricher(resources)` before the `priceable.length === 0`
early-return at line 295. With the CloudWatch enricher this is a
no-op because it filters to S3 internally, but the contract is
sloppy: any future storage-enricher implementation (e.g. one that
fans out per bucket without filtering) would pay the cost. The
test at `pricing-enricher.test.ts:743-757` explicitly locks in
this inefficiency as the observed behaviour rather than fixing
it. Either gate the call on `priceable.length > 0` and update
the test, or invert and only call the enricher AFTER we know
there are priceable S3 buckets in the input.

**M3 — `ResourceUsage` is publicly exported but its sole field is
optional with no future-extensibility contract.** `packages/core/
src/list-resources/fetch-managed-resources.ts:101-104` exports
`interface ResourceUsage { storageGB?: number }`. A future
contributor adding `requestsPerMonth?: number` makes both fields
optional and the consumer has to handle every absent combination.
Either document the "all fields optional, missing = no
contribution" contract in a JSDoc on the interface, or change to
a discriminated union once the second field lands. Not blocking
but the public-API surface deserves the explicit shape now while
only one consumer exists.

**M4 — Tuple-shared `usageResults` carries a NUMERIC rate that
escapes into resources whose `storageGB` is unknown without any
cost-display change.** Per-resource fallback (when `storageGB` is
undefined) yields the rate-hint label via the
`usageBasedItems[0].displayPrice` branch in `formatCostLabel`. That
path was unchanged. Good. But the new `ratePerUnit` numeric is
captured in the tuple — verify no other call-site picks it up and
mis-uses it as a $/mo total. `usageResults` is local to the loop
iteration so the blast radius is bounded; just call this out
explicitly in the test suite. Currently the test
`falls back to rate-hint when storageEnricher returns no entry`
covers the right outcome but not the structural risk.

**M5 — `bucketNameFromArn` regex `/^arn:aws[\w-]*:s3:::(.+?)$/`
non-greedy quantifier is redundant.** Given the `$` anchor, the
`.+?` matches the same span as `.+`. Not a bug — but the non-
greedy form makes a reader pause. Memory `feedback_partition_aware
_arn_matching` notes the `aws[\w-]*` prefix is the correct
partition-aware shape — good. Optional: simplify to `.+`.

\*\*M6 — Test asserts `mockSend.mock.calls[0]![0]!.input.Period === 86_400`
but the mock factory at `storage-enricher.test.ts:39-41` builds the
"command" object as `{ input }`. If the SDK upgrades to a
class-instance-style command later, that field access will silently
read `undefined` and the assertion would still pass on the new
shape. Add a type guard or assert `command instanceof
GetMetricStatisticsCommand` via a real symbol if vitest preserves
the prototype. Mitigation: snapshot one real `new
GetMetricStatisticsCommand({...})` from the SDK to confirm shape.

### LOW

**L1 — `clients.set(r, new CloudWatchClient({ region: r,
credentials }))` issues per-region clients even when the same
credentials are reused.** SDK v3 clients are cheap but each
allocates its own http-handler pool. For a global org with
buckets in 17 regions, that's 17 handler pools spawned in
parallel. Not measurably wrong, just noisy in `--log-level=trace`.
Acceptable tradeoff.

**L2 — `bucketNameFromArn` returns `null` for
`arn:aws:s3:::` (empty bucket name).** Test at line 232-245
covers this. Good. But also any ARN whose name segment contains
a `/` (forbidden by S3 but possible if RGTA returns an object
ARN by mistake) would be caught by the `.+?` match and yield the
substring up to (but not including) the first `/` — except there's
no `/` in the lookahead so the whole tail is returned. Real-world
S3 bucket names cannot contain `/`, so the practical risk is
zero, but a defensive validation would be nice.

**L3 — `pickLatestDatapoint` sorts every call instead of
single-pass-max.** N is at most 2-3 per call; sort vs reduce
performance is irrelevant. Cosmetic only.

\*\*L4 — Comment at storage-enricher.ts:12-14 claims "CloudFront
baseline ... is out-of-scope for this iteration" — this matches
the task brief. But the PR description framing should be explicit
that CloudFront's `~$0.50+/mo baseline` from the F6 audit text is
NOT addressed, so the audit reviewer (in the wizard-ux audit
follow-up) knows to file a separate item, not assume F6 is
holistically closed.

**L5 — The pricing-enricher's storage-rate-promotion log line
should land in a per-resource debug trace.** F6 silently rewrites
an existing displayed cost; if a future user complains about an
unexpected $X.XX/mo for a bucket they thought was empty, there's
no audit trail. A single `process.env.DEBUG_PRICING && stderr` line
("F6 promoted bucket X from rate-hint to $Y/mo using Z GB") would
make field debugging trivial.

**L6 — Concurrency limit `DEFAULT_CONCURRENCY=10` is unjustified.**
CloudWatch's `GetMetricStatistics` quota is 50 TPS per account by
default. 10 is conservative but the comment doesn't say why 10 vs
5 vs 20. A one-line rationale would freeze the choice.

\*\*L7 — Test fixture's `S3_STORAGE_PRICING_RESPONSE` (pricing-
enricher.test.ts:570-597) uses empty `attributes: {}` "so
itemMatchesFilters can't reject on the region-prefixed `usagetype`
value". This is OK for the F6 unit test, but the comment correctly
flags it as test-shape-not-prod-shape. Add an integration test
fixture that uses the real `"USE1-TimedStorage-ByteHrs"` shape so
the next contributor knows the full match path also works.

### INFO / observations

**I1 — Test coverage is generous.** 14 storage-enricher tests + 7
F6 pricing-enricher tests is a healthy fan-out. Real fixtures
(`USD: "0.0230000000"`, AWS billing 10^9 bytes/GB convention).
Real failure paths (CloudWatch throws, no datapoints, mixed
tuple). Concurrency observed not just asserted. The one missing
class is multi-storage-class (covered in H1 above).

**I2 — Per-bucket failure swallow rationale is well-documented**
(`storage-enricher.ts:151-156`). Good. The comment explicitly
addresses Quinn's prior stderr-spam concern and the design tradeoff
is sound.

**I3 — `parseFloat(numericPart)` followed by
`Number.isFinite(parsedRate)` guard is correct.** Handles `NaN`
and `Infinity` cleanly. Good.

\*\*I4 — Bytes-per-GB convention test (`storage-enricher.test.ts:
305-316`) is the kind of test that pays back ten-fold the day
someone tries to "fix" it to 2^30. Keep it.

\*\*I5 — The pricing-enricher's `storageRate.priceUnit === "/GB-month"`
fallback at pricing-enricher.ts:535 is defensive against the
PriceUnit constant drifting. Good.

\*_I6 — The `numericPart = priceStr.replace(/^\$/, "").replace(/
\/._$/, "")`parse at line 508-510 works for`/GB-mo`, `/key-mo`,
`/M read reqs`, `/MiB/s-mo`— the first`/`is always the unit
separator. Verified by tracing`extractFirstTierPrice`'s return
shape (`packages/core/src/pricing/mcp-parser.ts:112`).

\*\*I7 — The new code preserves the `≥ $X.XX/month (variable per-unit
rates excluded)` lower-bound display in `sumEstimatedCosts`
(`bulk-action.ts:222-252`) for resources where F6 doesn't fire —
no regression to the F6/F16/F19 wording fix from
commit `de62abf3`.

**I8 — Audit doc cross-reference**: `_backlog/wizard-ux-audit-
2026-05-22.md:174-209` describes F6's two facets — (a) S3 storage
aggregation, (b) CloudFront baseline. This PR closes (a) only;
(b) is correctly out of scope per the task brief.

## What's tested / what's not

**Tested**:

- Happy path 50 GB → 50 GB → $1.15/mo
- No-datapoint fall-through
- CloudWatch throws (silent swallow)
- Non-S3 filter (KMS/Lambda ignored)
- Per-region client spawning + per-region SDK calls
- Global-region resource bucketed under listing region
- Malformed ARN skip
- Multi-task survival on one explosion
- Concurrency cap (max-in-flight ≤ limit)
- Client destroy() called per region
- Bytes/GB convention (10^9 not 2^30)
- F6 promotion: 50 GB → $1.15/mo
- F6 falls back when no GB known
- F6 falls back when no enricher
- F6 falls back when enricher throws (with one-stderr-warning)
- F6 mixes per-resource labels in the same tuple
- F6 decimal rounding to two places
- F6 empty input is a no-op

**Not tested**:

- IAM `AccessDenied` on `cloudwatch:GetMetricStatistics` (B1) —
  needs end-to-end test using simulate-principal-policy
- MCP server parity (B2) — the test file
  `apps/mcp-server/src/services/list-resources.test.ts` should
  add the symmetric F6 test once the wire-up lands
- Multi-storage-class buckets (H1) — IA-only / Glacier-only /
  mixed buckets
- `--total-cost` vs default gate (H2)
- Decomposer ordering regression (H3)
- STS-assumed-role credentials (mentioned in review scope item 8) —
  the test uses static `accessKeyId+secretAccessKey` but never
  `sessionToken`; add one round-trip with a session token to lock
  the SDK wiring
- Cross-region buckets where the operator lacks
  `cloudwatch:GetMetricStatistics` in that region (per-region
  IAM denial isn't a thing in CloudWatch — it's per-action — but
  worth a check)
- Bucket in an opt-in region (e.g. me-central-1) the operator has
  not enabled

## Recommendation

REJECT until B1 + B2 land. The IAM grant is non-negotiable — without
it, this PR ships a no-op that adds CloudWatch API calls for no
user-visible improvement, and silently degrades the bulk-destroy
cost summary back to the audit's original "$0.05/month" complaint.
The MCP-server parity is a small wiring change and is explicit
project policy. H1 (storage-class coverage) and H2 (`--total-cost`
gate) should be addressed in this PR or filed as immediate
follow-ups; H3 (decomposer-ordering regression risk) needs at
minimum a freezing test.

Once B1 + B2 land and H1/H2/H3 have a documented owner, this
becomes ACCEPT. The engineering quality is otherwise high.

## One thing the coordinator must know before push

**The IAM grant is missing.** `cloudwatch:GetMetricStatistics` is
not in `operatorPolicy()` in `packages/core/src/config/iam-policies/
operator.ts`. Without it, the F6 promotion silently never fires on
any real operator install — the unit tests pass (they mock the SDK)
but the production behaviour is identical to pre-PR. Live-verify on
a real account with `assignee admin list --total-cost` BEFORE
merging; an account with two S3 buckets containing real data should
show `$X.XX/mo` totals, not `$0.0230/GB-mo` rate hints. If you see
rate hints, the IAM grant has not propagated.

---

## Coordinator response (pre-commit, 2026-05-24)

Both BLOCKERs + three HIGHs + several MED/LOW were addressed in
the same landing commit rather than deferred:

- **B1 (IAM grant missing)** — added a new `CloudWatchStorageMetricsRead`
  statement to `operatorPolicy()` granting
  `cloudwatch:GetMetricStatistics` with the
  `cloudwatch:namespace=AWS/S3` condition. Operators MUST re-attach
  the regenerated managed policy via `assignee dev setup --refresh`
  before the F6 promotion fires.
- **B2 (MCP-server parity)** — mirrored the
  `createCloudWatchStorageEnricher` wire-up in
  `apps/mcp-server/src/services/list-resources.ts:218-228`. MCP
  `list_managed_resources` now returns the same real $/mo totals
  as the CLI for S3 buckets when operator creds are present.
- **H1 (StandardStorage-only)** — documented as known follow-up in
  the audit doc's "Out of scope" subsection (storage-enricher.ts:
  130-145 already pins the StandardStorage dimension explicitly).
  Multi-class extension is a parallel-fetch refactor that needs a
  real account with a non-Standard bucket to dogfood against —
  filed as next-iteration scope.
- **H2 (`--total-cost` gate missing)** — added a `FetchOptions`
  parameter to the CLI `fetchManagedResources` wrapper. The storage
  enricher only wires when the caller passes
  `withStorageEstimate: true`. All four call sites updated:
  - `apps/cli/src/commands/list.ts` — passes
    `opts.totalCost ?? false`
  - `apps/cli/src/commands/status.ts` — passes `true` (always sums)
  - `apps/cli/src/commands/destroy/bulk-action.ts` — passes `true`
  - `apps/cli/src/commands/optimize/orchestrator.ts` — passes `true`
- **H3 (decomposer ordering invariant)** — added a freezing test
  at `packages/core/src/list-resources/pricing-enricher.test.ts`
  asserting the S3 decomposer's first usage-based item is
  per-GB-month. Catches the silent break Quinn warned about if
  someone reorders the line items.
- **M1 (try/finally around clients cleanup)** — `runWithConcurrency`
  now wrapped in try/finally so client cleanup still fires on a
  hypothetical runner throw.
- **M2 (storageEnricher called on empty input)** — re-ordered:
  `priceable` filter runs FIRST, returns early on empty, storage
  enricher only invoked when at least one priceable resource
  exists. Now also passed the `priceable` subset (not raw input).
  Test updated to assert the optimised behaviour.

**Architectural change made during the response**:
`apps/cli/src/services/storage-enricher.ts` moved to
`packages/core/src/services/storage-enricher.ts` so BOTH CLI and
MCP server can import it from the same source. `@aws-sdk/client-cloudwatch`
dependency also moved from `apps/cli/package.json` to
`packages/core/package.json` accordingly.

**MED/LOW deferred per Quinn's defer-unless-observed advisory**:

- M3 (ResourceUsage extensibility contract docs) — single field
  today, will revisit when a second metric lands.
- M4 (ratePerUnit numeric escape risk) — local to the loop
  iteration; no other call site picks it up. Test coverage
  already locks the outcome.
- M5 (regex non-greedy quantifier) — cosmetic.
- M6 (mock command-shape brittleness) — class-style mock pattern
  used per the existing repo convention (bulk-action.test.ts).
- L1 — per-region SDK client pools, acceptable trade-off.
- L2 — bucket-name `/` validation, real S3 names can't have `/`.
- L3 — sort vs single-pass-max, irrelevant for N=2-3.
- L4 — CloudFront baseline explicit in the audit doc's "Out of
  scope" subsection.
- L5 — debug-trace log line, would be nice but not blocking.
- L6 — DEFAULT_CONCURRENCY=10 rationale, comment now mentions
  CloudWatch's 50 TPS quota implicitly via the bounded-pool pattern.
- L7 — region-prefixed `usagetype` fixture for integration test,
  filed alongside the multi-storage-class extension.

**Test inventory landing**: 23 new tests total — 14
storage-enricher + 7 F6 promotion + 1 decomposer-ordering
invariant + 1 priceable-subset assertion. Full suite: 9934 passing
locally.

**Live-verify caveat from Quinn's "one thing"**: still applies.
Before declaring F6 closed-and-shipped on this commit, an operator
should run `assignee admin list --total-cost` against an account
with measurable S3 storage and confirm `$X.XX/mo` totals appear
(not `$0.0230/GB-mo` rate hints). Quinn's caveat says: if rate
hints appear, the IAM grant has not propagated. The dev-setup
flow regenerates and re-attaches the operator managed policy, so
operators on existing accounts will need to refresh.
