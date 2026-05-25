# F6-followup-2: Intelligent-Tiering sub-dimension coverage gap

Cross-reference: `_archive/reviews/05f8053e-review.md` (Quinn ACCEPT, non-blocking observation).

## Gap

S3 Intelligent-Tiering publishes **5 separate `StorageType` dimensions** on
the `BucketSizeBytes` CloudWatch metric:

- `IntelligentTieringFAStorage` (Frequent Access tier — default)
- `IntelligentTieringIAStorage` (Infrequent Access tier)
- `IntelligentTieringAAStorage` (Archive Access tier — opt-in)
- `IntelligentTieringAIAStorage` (Archive Instant Access tier)
- `IntelligentTieringDAAStorage` (Deep Archive Access tier — opt-in)

The current `S3StorageClass` enum (added in F6-ITEM-3 commit `05f8053e`)
covers only `IntelligentTieringFAStorage`. Long-lived IT buckets where
auto-tiering has moved bytes to IA / AIA / DAA tiers will silently
under-cost — those bytes are invisible to the enricher, so the $/mo
total is computed only from the FA tier.

**Same gap existed pre-F6-ITEM-3** (the single-class path also only
queried FA) — this is NOT a regression introduced by ITEM-3. The
breakage is "pre-existing + perpetuated by the new multi-class shape".

## Storage size-overhead gap (same scope)

AWS also publishes three `*SizeOverhead`-style dimensions for every
storage class:

- `*SizeOverhead` (incomplete multipart upload byte usage)
- `*ObjectOverhead` (object metadata / version overhead)
- `*StagingStorage` (cross-region replication staging buffer)

None of these are queried; same conservative-keep fallback to rate-hint
display when total bytes are zero. For typical buckets the overhead
sum is <1% of object bytes, but for buckets with heavy multipart usage
or aggressive object versioning, the omission can swing the displayed
$/mo by 5-15%.

## Proposed fix

1. Extend `S3StorageClass` enum with the 4 missing IT sub-tiers:
   `INTELLIGENT_TIERING_IA`, `INTELLIGENT_TIERING_AA`,
   `INTELLIGENT_TIERING_AIA`, `INTELLIGENT_TIERING_DAA`.
2. Add the corresponding `TimedStorage-INT-IA-ByteHrs` /
   `TimedStorage-INT-AA-ByteHrs` /
   `TimedStorage-INT-AIA-ByteHrs` /
   `TimedStorage-INT-DAA-ByteHrs` usagetypes to
   `pricing-filter-values.ts`.
3. Bucket-storage-overhead dimensions: lower priority, optional —
   file as a separate followup if the IT fix alone surfaces complaints.
4. Tests: an IT bucket with bytes spread across all 5 IT tiers; assert
   total $/mo = sum of per-tier contributions.

Effort: ~1 hour + Quinn review. No interface change.

## Acceptance

- IT bucket whose CloudWatch dimensions report non-zero bytes on all 5
  IT tiers shows total $/mo summing all 5 contributions.
- Existing FA-only IT bucket regression test still passes.
- Quinn review confirms parity with the F6-ITEM-3 multi-class pattern.
