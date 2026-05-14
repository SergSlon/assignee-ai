# Reviewer: ACCEPT — qa (Quinn) — EPIC-106-5

**Commit (pre-amend)**: `fdd76e79` — feat(s3): NoncurrentVersionExpirationInDays via "delete old versions" extractor
**Base**: `ddf141ef` (pre-EPIC-106-3/4 merge; coordinator will rebase)
**Story**: `_bmad-output/implementation-artifacts/epic-106-5-s3-noncurrent-version-extractor.md`

## Gate-criteria verification

1. **Closure 1 — noncurrent keyword family + N days extraction** — `s3-lifecycle-extractor.ts:76-92`:
   - Keyword detector covers `\bold\s+(?:object\s+)?versions?\b`, `\bnon-?current(?:\s+versions?)?\b`, `\bprevious\s+versions?\b`
   - 5 noncurrent-specific patterns including canonical `"delete (old|noncurrent|previous) versions? after N days"`
   - 3 fallback patterns for generic "after N days" near the noncurrent keyword
   - Sets `elicited["LifecycleNoncurrentExpirationDays"] = String(noncurrentDays)`. ✓

2. **Closure 2 — single rule with NoncurrentVersionExpirationInDays emitted** — `cfn-emitter.ts:139-167`:
   - Rule Id = `delete-old-versions-after-${days}d` when noncurrent-only.
   - `Status: "Enabled"`, no `Transitions` or `ExpirationInDays` for Variation A.
   - `NoncurrentVersionExpirationInDays = N` is the SOLE field. ✓

3. **Closure 3 — no current-version expiration for pure noncurrent** — Guard `if (!hasNoncurrentKeyword)` at line 135; when noncurrent keyword present, currentDays only set if intent has BOTH explicit clauses (Variation C). ✓

4. **Closure 4 — PD-4 regression preserved** — Pre-existing assertions unchanged (zero deletions). `expireOnly` branch verbatim — bare `lifecycle 30d` emits Id `assignee-default-lifecycle` + `ExpirationInDays=30` identically. ✓

5. **Closure 5 — 5 variation coverage A-E** — All present in 40-extractor + 17-cfn-emitter test surface. ✓

## Adversarial checks

- **Variation C "BOTH" disambiguator** — `n !== noncurrentDays` check at extractor:156 prevents self-collision when intent has only one number. ✓
- **Rule Id discriminator** — `cfn-emitter.ts:142-147` — preserves PD-4 stable Id when expireOnly+noncurrent both present. ✓
- **Auto-versioning idempotency** — `cfn-emitter.ts:160-163` — `if (!transformed[CfnKey.VERSIONING_CONFIGURATION])` only sets when absent. User-supplied config preserved. ✓
- **Wizard-key cleanup** — `cfn-emitter.ts:221` — new key deleted alongside pre-existing cleanup. `tocfn-exhaustive.test.ts` updated. ✓
- **PD-4 regression-guard isolation** — `if (!hasNoncurrentKeyword)` at extractor:135 — PD-4 path runs only when noncurrent absent. Provable preservation. ✓

## Test-weakening check

`git diff` extractor test: 4 deletions are DOCSTRING comments. Zero assertion deletions. Zero `it.skip`/`xit`/`describe.skip`. `cfn-emitter.test.ts`: +76/-0. **No weakening.** ✓

## File-ownership verification

- `s3-lifecycle-extractor.ts` (+161/-57) ✓
- `s3-lifecycle-extractor.test.ts` (+149/-4 — comment-only deletions) ✓
- `cfn-emitter.ts` (+69/-23) ✓
- `cfn-emitter.test.ts` (+76/-0) ✓
- `tocfn-exhaustive.test.ts` (+2) ✓
- `cfn-keys/keys-services.ts` (+1) + `cfn-keys/keys-wizard.ts` (+2) ✓
- `CHANGELOG.md` (+11) ✓

## Build + tests

- `pnpm build`: green (FULL TURBO).
- Targeted: 40/40 + 120/120 + 17/17 = 177/177 pass in 3.65s.
- Broader sanity: 744/744 across plan-generator + intent-parser + cfn-keys. No regression.
- No live AWS, no new deps.

## mcp-server mirror

`grep -rn "extractS3Lifecycle\|LifecycleNoncurrentExpirationDays\|NONCURRENT_VERSION_EXPIRATION_IN_DAYS" apps/mcp-server/src` returns zero. Consumed via shared core graph pipeline. ✓

## Informational nits (non-blocking)

1. **Redundant versioning regex** at `s3-lifecycle-extractor.ts:184-186` — second regex is strict subset of first. Cosmetic cleanup candidate.

2. **Variation C rule-Id choice** — when BOTH current+noncurrent days present, Id is `"assignee-default-lifecycle"` (inherited from `expireOnly`). Preserves PD-4 namespace but could surprise user reading plan output. Optional rename candidate.

3. **Fallback noncurrent-day-extraction** at extractor:104-119 — generic "after N days" anywhere in intent could mis-extract days from unrelated clause. Variation C's `n !== noncurrentDays` partially mitigates. Tighten if real-world dogfood surfaces.

## Verdict

ACCEPT — extends PD-4 cleanly without regression. Single-rule emission avoids rule-multiplication. Auto-versioning safety net idempotent. All 5 variations covered with 177/177 broader owned tests passing. No test weakening. No mcp-server mirror needed.
