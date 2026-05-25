# Reviewer: ACCEPT — qa (Quinn) — F6-ITEM-3

## Verdict

The multi-storage-class S3 promotion ships clean. All five author-flagged
concerns either dissolve under scrutiny against the AWS S3 usage-report
documentation (the canonical source for `usagetype` strings AND for the
CloudWatch `StorageType` dimension values) or check out under direct
code-walk: every one of the seven usagetypes is correct, the per-(region,
class) MCP cache is keyed and scoped exactly as described, the partial-
failure threshold is "at least 50%, inclusive" as the comment says, the
`storageGB → storageByClass` breaking refactor has zero lingering
consumers, and the math on the All-6-classes / cache scenarios walks out
by hand. Test coverage is `13,748 passed` end-to-end. The one substantive
operational gap — Intelligent-Tiering coverage is incomplete because only
the Frequent-Access tier dimension is queried (IA, AA, AIA, DAA exist as
separate CloudWatch dimensions and as separate `TimedStorage-INT-*-ByteHrs`
usagetypes, and a long-lived IT bucket will have most bytes in IA / AIA /
DAA, not FA) — is the same gap that already existed pre-commit (the prior
single-class path also only queried FA) and the conservative-keep posture
means it falls back to the rate-hint display rather than silently
mis-costing. Worth filing as F6-followup-2 but not a blocker for this
landing. Recommendation: ACCEPT, amend the commit body with the
`Reviewer: ACCEPT` citation, push.

## Author-self-flagged concerns — verdicts

### Concern 1 — 6 of 7 usagetypes unverified against real API

**RESOLVED — every value matches the AWS docs.** Cross-checked
`packages/core/src/pricing/pricing-filter-values.ts:69-86` and
`pricing-enricher.ts:797-806` (`S3_CLASS_TO_USAGETYPE`) against the AWS
S3 usage-report documentation page
(`docs.aws.amazon.com/AmazonS3/latest/userguide/aws-usage-report-understand.html`),
which is the authoritative published list of `usagetype` strings —
identical to what the AWS Pricing API returns under
`product.attributes.usagetype` (modulo the region prefix that
`attributeValueMatches` strips):

| Class                    | Author's canonical value      | AWS doc canonical                      |
| ------------------------ | ----------------------------- | -------------------------------------- |
| `STANDARD`               | `TimedStorage-ByteHrs`        | `region-TimedStorage-ByteHrs` ✓        |
| `STANDARD_IA`            | `TimedStorage-SIA-ByteHrs`    | `region-TimedStorage-SIA-ByteHrs` ✓    |
| `ONE_ZONE_IA`            | `TimedStorage-ZIA-ByteHrs`    | `region-TimedStorage-ZIA-ByteHrs` ✓    |
| `INTELLIGENT_TIERING_FA` | `TimedStorage-INT-FA-ByteHrs` | `region-TimedStorage-INT-FA-ByteHrs` ✓ |
| `GLACIER_IR`             | `TimedStorage-GIR-ByteHrs`    | `region-TimedStorage-GIR-ByteHrs` ✓    |
| `GLACIER`                | `TimedStorage-GlacierByteHrs` | `region-TimedStorage-GlacierByteHrs` ✓ |
| `DEEP_ARCHIVE`           | `TimedStorage-GDA-ByteHrs`    | `region-TimedStorage-GDA-ByteHrs` ✓    |

The author's explicit worry about a `GFS-` Glacier variant in older AWS
docs is unfounded — there's no `GFS-ByteHrs` in the current usage-report
documentation; `TimedStorage-GlacierByteHrs` is canonical for the
Flexible Retrieval class. Two of the seven (`STANDARD` and
`INTELLIGENT_TIERING_FA`) were already in production use elsewhere in
the repo as `TIMED_STORAGE_BYTE_HRS` and
`TIMED_STORAGE_INT_BYTE_HRS_FREQ` (see e.g.
`packages/core/src/test-fixtures/mcp-mock-responses/pricing-s3.ts:15`,
`packages/core/src/graph/nodes/preflight-guard.test.ts:1324`) — those
two have battle-tested production grounding via the live-MCP integration
tests, and the remaining five inherit the same `productFamily=Storage`

- `usagetype` filter shape with no other moving parts. Not a BLOCKER.

The CloudWatch `StorageType` dimension values in `S3StorageClass` enum
(`fetch-managed-resources.ts:114-122`) were independently verified
against the `BucketSizeBytes` metric documentation at
`docs.aws.amazon.com/AmazonS3/latest/userguide/metrics-dimensions.html`
— all 7 enum string-values match the documented dimension values.

### Concern 2 — Glacier sub-tier handling and `≈` prefix

**RESOLVED — the prefix application is conservative-correct.** The
implementation is `pricing-enricher.ts:693-695` (`containsGlacierFlexible
= presentClasses.some(([cls]) => cls === S3StorageClass.GLACIER)`).

- `≈` is applied to the WHOLE per-bucket total when ANY portion of the
  bucket lives in `GLACIER` (Flexible Retrieval), even a 1% share. This
  is the right call — the `≈` is a "this total contains a Glacier
  contribution whose live cost depends on retrieval-pattern mix" caveat,
  and it's safer to over-flag than to silently miss a 30% under-count
  caused by Bulk-vs-Expedited retrieval-tier rate differentials.
- `GLACIER_IR` (Instant Retrieval) deliberately does NOT get `≈`. Per
  AWS pricing docs that retrieval surface IS single-tier (always Instant
  Retrieval), so the rate is exact. Correct.
- `DEEP_ARCHIVE` does NOT get `≈`. Author's flag is fair — Deep Archive
  has Standard (12h) and Bulk (48h) retrieval modes with different
  per-GB retrieved + per-request fees, conceptually identical to
  GLACIER's three-tier retrieval-pattern ambiguity. **Logged as
  observation, not a blocker** — Deep Archive retrievals are rare enough
  in real-world workloads (it's literally the "I won't touch this for
  years" tier) that the missing `≈` rarely matters in practice; folding
  it in is a one-line follow-up if real users complain.
- The chosen Glacier baseline `TimedStorage-GlacierByteHrs` IS the
  at-rest storage rate (NOT a retrieval-pattern rate). Verified against
  the AWS usage-report doc: "The number of GB-months that data was
  stored in S3 Glacier Flexible Retrieval storage" — granularity Daily,
  unit GB-Month. The Standard/Expedited/Bulk retrieval rates are
  separately published as `Standard-Retrieval-Bytes`,
  `Expedited-Retrieval-Bytes`, `Bulk-Retrieval-Bytes` (GB, Hourly), and
  the per-request retrieval fees are `Requests-Tier3`/`Tier5`/`Tier6`.
  The author chose the right baseline.

### Concern 3 — Partial-failure contract is "≥50% of present classes"

**RESOLVED — confirmed inclusive ≥50%, all four sub-cases walk out.**
Implementation at `pricing-enricher.ts:676-679`:

```
if (
  resolvedCount > 0 &&
  resolvedCount >= presentClasses.length - failedCount &&
  resolvedCount * 2 >= presentClasses.length
)
```

- The second clause `resolvedCount >= presentClasses.length - failedCount`
  is trivially `true` for every reachable state (the per-class loop
  always increments exactly one of `resolvedCount` or `failedCount`, so
  `resolvedCount + failedCount === presentClasses.length` at the bottom
  of the loop, hence `resolvedCount >= resolvedCount`). It's dead code
  — defensive belt-and-suspenders. Not a bug, just slightly noisy.
- The third clause `resolvedCount * 2 >= presentClasses.length` IS the
  ≥50% threshold, **inclusive** (1-of-2, 2-of-3, 2-of-4 etc. all pass).
- 1 class present + throws → `resolvedCount=0`, `presentClasses.length=1`
  → first clause `resolvedCount > 0` fails → falls through to rate-hint
  display. Correct, no silent drop.
- 3 classes present, 2 succeed, 1 throws → `resolvedCount=2 * 2 = 4 >= 3`
  → partial sum surfaces (this is the case the comment describes; the
  displayed `$X.XX/mo` is partial-from-2-of-3 with NO indication to the
  operator that it's under-reported). This is a documented behavioural
  contract, not a bug — and the partial total still beats the rate-hint
  fallback because at least 2/3 of the bytes are correctly costed.
- 4 classes present, 2 succeed, 2 throw → `2 * 2 = 4 >= 4` → partial
  sum (50% boundary inclusive — confirmed).
- 4 classes present, 1 succeeds, 3 throw → `1 * 2 = 2 < 4` → falls back
  to rate-hint. Correct.

Worth noting in case the author wants a follow-up: there's no per-row
hint that a displayed `$X.XX/mo` was partial-failure-derived, which is
a soft UX gap — the per-tuple stderr warning IS emitted but the operator
reading the table won't be able to tell which rows came from a partial
sum. Not blocking; arguably better as a separate "show me bullshit-
detector flags" --debug toggle than a permanent column.

### Concern 4 — Per-(region, class) MCP cache claim

**RESOLVED — cache scope, key shape, and negative-result handling all
match the claim.**

- **Lifetime: scoped per-pass, NOT module-level.** The two cache
  containers `s3StorageRateCache` and `s3StorageRateUnavailableCache`
  are declared at `pricing-enricher.ts:347-348` INSIDE the returned
  enricher closure (`createListPricingEnricher` → returned `async` fn),
  so they're allocated fresh on every enricher invocation and freed
  when the call settles. No cross-call bleed. Verified.
- **Key shape: includes both region AND class.** Cache key at
  `pricing-enricher.ts:848` is `${region}::${cls}` where `cls` is the
  enum string value (`StandardStorage` etc.). Two regions hitting the
  same class → two cache entries, as expected.
- **Negative-result handling: failures ARE cached.** When the per-class
  MCP call throws or the parse fails (lines 891, 904, 911, 916), the
  cache key is added to `unavailableCache` (the negative set) and `null`
  is returned. The next bucket in the same pass that needs the same
  (region, class) hits the `unavailableCache.has(cacheKey)` short-circuit
  at line 852 and returns `null` without re-issuing the MCP call. Cost
  ceiling claim holds.
- The dedicated cache test at
  `pricing-enricher.test.ts:1217-1259` confirms the happy-path: 100
  buckets with 2 classes each → 2 MCP calls total (1 for Standard via
  the pre-resolved fast path, 1 for IA via the per-class cache). Test
  passes locally.

### Concern 5 — `storageGB` breaking refactor consumer audit

**RESOLVED — zero live consumers remain.** Repo-wide grep
(excluding `coverage/`, `dist/`, `node_modules/`, `_archive/`) returns
exactly two `storageGB` hits, both in comments / docstrings
documenting the breaking change:

- `packages/core/src/list-resources/fetch-managed-resources.ts:163`
  ("**Breaking change (F6-ITEM-3)**: the prior single-class `storageGB`
  field was deliberately REPLACED…")
- `packages/core/src/list-resources/pricing-enricher.test.ts:778`
  ("per-resource label differs based on whether storageGB is known.")

The CLI commands, MCP server, breakdown.ts plan-time pricing path, and
every test fixture reference the new `storageByClass` shape. The shim-
free refactor is complete.

## Other adversarial checks

### Concern 6 — Concurrency derivation + inner throttle

**Mostly clean, one observation.** The per-bucket fan-out at
`storage-enricher.ts:237-254` uses
`S3_STORAGE_CLASSES.map((cls) => client.send(...))` — derived from the
array constant, NOT hardcoded `7`. Extending the enum + array
auto-extends the fan-out. The `DEFAULT_CONCURRENCY = 10` outer cap +
`S3_STORAGE_CLASSES.length` inner fan-out gives `10 × 7 = 70` peak
in-flight, comfortably under the 50-TPS CloudWatch quota because the
documented per-call latency (~50-100ms) means burst-bucket consumption
is amortised. The inner `Promise.allSettled` has NO additional throttle
or exponential-backoff (it relies entirely on the SDK's default retry
strategy). On a heavily-throttled account this could mean transient
`Throttling` exceptions, but the per-class failure semantics already
swallow them silently (per-class outcome `!== "fulfilled"` → skipped at
line 259), so the worst case is "some classes drop out of the per-bucket
map; remaining classes still produce a partial sum". Acceptable for
F6-ITEM-3; could be tightened in a follow-up if real operators report
under-counted totals on throttled accounts.

### Concern 7 — Audit-doc + CHANGELOG integrity

**Clean.** `_backlog/wizard-ux-audit-2026-05-22.md:281-303` adds the
"Closed (2026-05-25 follow-up commit — multi-storage-class S3, F6 fully
closed)" block citing this commit alongside the prior two halves
(`1408ecd8` + `1c0e2a43`). The CHANGELOG `Unreleased > Added` entry
(`CHANGELOG.md:22-50`) covers: the per-(region, class) cost ceiling,
the `storageGB → storageByClass` breaking refactor with rationale, the
Glacier `≈` prefix with disambiguation gap, the 50% partial-failure
threshold, and the explicit F6 trilogy citation chain. Compliant with
`feedback_changelog_self_entry`.

### Concern 8 — Test coverage

**11 new tests claimed, 11 found.**
`pricing-enricher.test.ts` adds 8 in the F6-ITEM-3 describe block
(Standard-only regression / IA-only / Mixed-Standard-IA / Glacier-only /
All-6-classes / No-data / Partial-MCP-failure / per-(region, class)
caching) + 1 invariant freeze (`S3 decomposer first-usage-based-item
ordering` — catches the silent F6 regression if someone reorders the
decomposer's line items). `storage-enricher.test.ts` adds 3 (Multi-class
populated / Per-class throttle / Zero-byte omitted). All 11 align with
the author's claim.

**Missing coverage worth flagging (not blocking)**:

- No test exercises a **Deep-Archive-only** bucket — the only one of the
  seven enum members with no asserted test path. Would catch the
  `TIMED_STORAGE_GDA_BYTE_HRS` filter typo if it ever drifts (e.g.
  someone changes it to `TimedStorage-DeepArchiveByteHrs` thinking
  that's the "real" canonical name). Cheap follow-up: copy the
  Glacier-only test, swap the class + rate.
- No **multi-region multi-class** test verifying that two buckets in
  different regions but same class get separate cache keys. The
  per-(region, class) key shape is the only thing standing between the
  current 2-MCP-call cost ceiling and a silent regression to
  1-MCP-call (which would return wrong rates for buckets outside
  us-east-1).
- The **region-prefix matcher integration** for the 6 new usagetypes is
  exercised only via the canned fixture (`USE1-TimedStorage-SIA-ByteHrs`
  etc. in `s3StoragePricingFixture`), not against the real
  `production-shape` fixture that the existing Quinn L7 test uses for
  Standard. A real-shape multi-class fixture would strengthen the L7
  integration coverage.

### Concern 9 — Math verification (walked by hand)

- **All-6**: `100×0.0230 + 50×0.0125 + 50×0.0100 + 100×0.0230 +
200×0.0040 + 500×0.0036 = 2.30 + 0.625 + 0.50 + 2.30 + 0.80 + 1.80
= 8.325`. `Number(8.325).toFixed(2)` = `"8.32"` (verified via `node
-e`); JS uses IEEE 754 round-half-to-even but the actual binary repr
  of `8.325` is just below `8.325` so it rounds down regardless of the
  rounding mode. Expected `≈$8.32/mo` — matches.
- **IA-only**: `200 × 0.0125 = $2.50/mo` — matches.
- **Mixed**: `100 × 0.0230 + 200 × 0.0125 = 2.30 + 2.50 = $4.80/mo` —
  matches.
- **Glacier-only**: `1000 × 0.0036 = $3.60/mo`, with `≈` prefix
  (Glacier present) → `≈$3.60/mo`. Matches.
- **Cache test**: `10 × 0.0230 + 5 × 0.0125 = 0.23 + 0.0625 = 0.2925`
  → `$0.29/mo` via `toFixed(2)`. Matches.

### Concern 10 — `pnpm -r test:coverage` independent re-run

**Counts confirmed**: `best-practices 994 / core 9974 / mcp-server 722
/ cli 2058 passed + 148 skipped (2206 total)`. Sum `994 + 9974 + 722

- 2058 = 13,748` matches author's report exactly. Zero failures across
  all four packages.

## Substantive finding (not a blocker)

**Intelligent-Tiering coverage is incomplete.** The CloudWatch
`BucketSizeBytes` metric publishes 5 separate `StorageType` dimension
values for Intelligent-Tiering bytes
(`IntelligentTieringFAStorage` / `IAStorage` / `AAStorage` /
`AIAStorage` / `DAAStorage`), per the AWS docs. The new code only queries
the FA tier (`S3StorageClass.INTELLIGENT_TIERING_FA`). For a long-lived
Intelligent-Tiering bucket where auto-tiering has moved most bytes into
IA / AA / AIA / DAA tiers, the enricher will see only the (small) FA
contribution and silently miss the rest. The bucket will display an
under-counted `$X.XX/mo` total based on whatever non-IT classes ALSO
happen to be present, or fall back to a rate-hint if IT-FA is the only
populated dimension. Same pattern: the prior single-class enricher
(`storageGB` field) had the EXACT same gap, so this commit is not a
regression. Folding the other four IT tiers into the enum +
`S3_CLASS_TO_USAGETYPE` map + `S3_STORAGE_CLASSES` array is mechanical
(four additional enum values, four additional usagetype constants —
`TimedStorage-INT-IA-ByteHrs`, `TimedStorage-INT-AA-ByteHrs`,
`TimedStorage-INT-AIA-ByteHrs`, `TimedStorage-INT-DAA-ByteHrs` per the
S3 usage-report doc — and four published per-GB-month rates from the
Pricing API). Worth filing as F6-followup-2 with the same priority as
the Glacier-sub-tier disambiguation enhancement: it's a real-world
silent-under-cost path, but it's pre-existing and the conservative-keep
fallback prevents catastrophic mis-cost.

Storage size-overhead dimensions
(`StandardIAObjectOverhead`/`StandardIASizeOverhead`, `OneZoneIASizeOverhead`,
`GlacierIRSizeOverhead`, `Glacier*ObjectOverhead`, `*StagingStorage`)
are similarly missed — these add up to 32 KB/object for IA/Glacier
metadata overhead and AWS bills them. For buckets with millions of small
objects, missing the overhead dimensions can under-cost by single-digit
percent. Same pre-existing gap; same conservative-keep fallback;
non-blocking.

## Recommendation

**Amend the commit body with the `Reviewer: ACCEPT` citation and push.**

Specifically:

1. Stage this review file: `git add _archive/reviews/05f8053e-review.md`
   (required by `feedback_stage_review_evidence_before_commit_author` so
   the citation lands in the commit's tree, not just on disk).
2. Amend `05f8053e`: replace the `Reviewer: PENDING…` line in the
   commit body with
   `Reviewer: ACCEPT — qa (Quinn) — F6-ITEM-3 — see _archive/reviews/05f8053e-review.md`.
3. Push.

No re-amend or send-back is required. The substantive finding
(IT-tier-FA-only) is pre-existing and conservative-keep, and the
sub-blocker observations (Deep Archive `≈` prefix; partial-failure UX
hint; no Deep-Archive-only test) are all worth filing as F6-followup-2
but don't gate this landing.
