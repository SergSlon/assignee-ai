# Reviewer: ACCEPT — qa (Quinn) — f11-generalisation

## Verdict

**ACCEPT with non-blocking follow-ups.** The F11 generalisation
correctly extends `filterAdviceContradictingFindings` from one
finding-family to three, the conservative-filter posture holds, the
predicate-pair contract is clean, and the 48 tests exercise the
declared behaviour. The wiring in `advice-generator.ts:184` correctly
reads `state.bpFindings ?? []` so the new families flow through the
same code path as the original BP-EC2-015 check.

No BLOCKERs found. Audit-doc acceptance criteria (F11 generalisation
update at lines 397-422) are met: both BP-EC2-002 (EBS encryption) and
BP-S3-001..004 (PublicAccessBlock family) get the contract, the
negative-lookbehind correctly exempts pro-block prose, and the
"copy-paste exercise" contract is documented in the file header.

The findings below are HIGH / MED / LOW non-blockers — none gate the
landing, but they are real edge-case gaps the planner should put on
the deferred-backlog before this filter widens further.

---

## Findings

### HIGH-1 — Instance-prefix substring matching false-positives on doc URLs

**Where**: `advice-filters.ts:256-261` (`namesPreviousGenInstance`).

**Evidence**: The function uses `String.prototype.includes(prefix)`
for prefixes like `c3.`, `m4.`, `i2.`. An advice line containing a
URL fragment like `https://docs.aws.amazon.com/path/c3.html` or
`see Sect c3. of the guide` will match and be filtered when
BP-EC2-015 fires. Reproduced locally:

```
"see https://example.com/c3.html" → matches (incorrect, would be dropped)
"server.t2.micro.local"           → matches (acceptable — actually IS a t2.micro)
```

**Why HIGH not BLOCKER**: only fires when BP-EC2-015 has actually
fired (plan involves an EC2 with previous-gen type), AND the advice
line happens to contain a doc URL whose path component starts with a
previous-gen token followed by `.`. Realistic LLM output does include
doc URLs occasionally. Conservative-filter posture says "when in
doubt, KEEP" — this violates that posture in the doc-URL case.

**Proposed fix**: tighten to a word-boundary regex per prefix:

```ts
const PREV_GEN_INSTANCE_REGEX =
  /\b(?:t[12]|m[1-4]|c[134]|r[34]|i2)\.(?:nano|micro|small|medium|large|x?large|\d*xlarge)\b/i;
```

Or at minimum require a known sizing suffix after the dot.

**Effort**: S — single regex swap + extend existing edge-case test.

---

### HIGH-2 — CamelCase canned ACLs not caught (false negative)

**Where**: `advice-filters.ts:317-328` (`S3_PUBLIC_ACCESS_PATTERNS`).

**Evidence**: The pattern targets `public-read` / `public-read-write`
(lowercase-hyphen) but the AWS SDK / SDK-generated docs / Java/JS
SDK constants frequently surface CamelCase variants. LLMs trained
on SDK code regularly emit:

```
"Use the PublicRead canned ACL"
"Set the bucket ACL to PublicReadWrite"
"acl: 'public-read'"        ← caught
"acl: PublicReadWrite"      ← MISSED
```

Adversarial probe confirmed: `"Set the bucket ACL to PublicRead"`
passes both patterns and would NOT be filtered.

**Why HIGH not BLOCKER**: filter is by design CONSERVATIVE (keep when
in doubt), so a missed contradiction is the documented failure mode.
But this is the single most common phrasing the LLM would produce
when paraphrasing AWS SDK calls — the original F11 failure mode is
exactly this class of paraphrase.

**Proposed fix**: add `/\b(?:PublicRead|PublicReadWrite)\b/i` to
`S3_PUBLIC_ACCESS_PATTERNS`. Doesn't need a lookbehind because
CamelCase tokens almost never appear inside pro-block prose
(SDK-style code references are rarely negated in natural-language
advice).

**Effort**: S — one regex + one test.

---

### MED-1 — Double-negation prose bypasses the lookbehind in both directions

**Where**: `advice-filters.ts:324` (S3 public-read lookbehind).

**Evidence**: The lookbehind `(?<!\b(?:deny|block|disallow|prevent|
restrict)\s+)` is a 1-word window. Double-negation patterns either
escape the filter when they shouldn't, or get filtered when they
shouldn't:

| Input                                  | Filter says | Semantic intent                                                                                   |
| -------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------- |
| `"do not block public-read"`           | KEEP        | pro-grant (BUG)                                                                                   |
| `"never block public-read"`            | KEEP        | pro-grant (BUG)                                                                                   |
| `"you shouldn't block public-read"`    | KEEP        | pro-grant (BUG)                                                                                   |
| `"block of code that has public-read"` | DROP        | code-narration (FP)                                                                               |
| `"stop blocking public-read"`          | DROP        | pro-grant — actually correct (lookbehind matches "block" not "blocking", so it fires by accident) |

The lookbehind treats any of the 5 negation verbs immediately before
`public-read` as pro-block intent — but English allows another
negation in front (`do not block`, `never block`, `shouldn't block`)
that flips the meaning back to pro-grant.

**Why MED not HIGH**: the LLM emitting "do not block public-read" as
advice is rare — modern instruction-tuned LLMs tend to write
direct prescriptions, not double-negations. Mostly a curiosity.
"block of code" code-narration false-positive is the more realistic
failure mode but still niche.

**Proposed fix**: either widen the lookbehind to skip a preceding
negation chain (regex gets ugly fast) or document the limitation
in the function comment and rely on the planner / human eyeball to
catch double-negations. I'd lean **document, defer**.

**Effort**: S to document, M to fix robustly.

---

### MED-2 — Multi-predicate-single-line not explicitly tested

**Where**: `advice-filters.test.ts:597-627` ("multiple findings
firing together").

**Evidence**: The existing multi-finding test drops THREE separate
lines, one per predicate. The reviewer prompt explicitly flagged
the case "a line mentions `t2.micro` AND `Encrypted: false` in the
same line — both predicates fire independently and the line is
filtered once". The behaviour is correct (the `Array.filter`
callback returns `false` on the first matching predicate via short-
circuit OR) but no test asserts it. Future refactor could break
this invariant without test signal.

**Proposed fix**: add one test:

```ts
it("drops a single line that matches multiple predicates", () => {
  const findings = [
    { practiceId: "BP-EC2-015", title: "current generation" },
    { practiceId: "BP-EC2-002", title: "EBS volumes should be encrypted" },
  ];
  const lines = [
    "Use a t2.micro instance with Encrypted: false to save cost.",
    "Keep this advice.",
  ];
  expect(filterAdviceContradictingFindings(lines, findings)).toEqual([
    "Keep this advice.",
  ]);
});
```

**Effort**: trivial — single test.

---

### MED-3 — `isS3PublicAccessFinding` title-fragment requires `startsWith("s3 bucket")`

**Where**: `advice-filters.ts:307`.

**Evidence**: The title-fragment fallback hard-codes
`lower.startsWith("s3 bucket")`. All 4 current rules conform (verified
by reading `packages/best-practices/s3/BP-S3-{001..004}.yaml`). But:

- A future custom rule like `"S3 PublicAccessBlock must be enabled"`
  (no `bucket` prefix) would NOT match the fallback even though it's
  semantically the same family.
- A custom rule like `"Bucket should disallow public ACLs"` (no `S3`
  prefix) would NOT match.

The id-based set covers the 4 known rules so this is only an issue
for unrecognised practice IDs. The original BP-EC2-015 fallback
uses a looser substring check (`includes("current generation
instance type")`); BP-EC2-002 fallback uses two-token AND
(`"ebs" + "encrypt"`). The S3 fallback is the most rigid of the
three.

**Why MED not HIGH**: the 4 known rules all satisfy the predicate;
the fallback only matters for rules we don't yet have. Conservative-
keep posture means a miss here drops back to "advice line preserved"
— no contradiction emitted, just no insurance.

**Proposed fix**: relax to `lower.includes("s3") && lower.includes(
"bucket")` OR `lower.includes("publicaccessblock")`. Or document
that future S3 public-access rules MUST register their practiceId
in `BP_S3_PUBLIC_ACCESS_IDS`.

**Effort**: S — relax one predicate + document the contract in the
file header.

---

### LOW-1 — `Encrypted` family misses "Encrypted to false" / "Encrypted = no" / "Encryption: disabled"

**Where**: `advice-filters.ts:276-283`.

**Evidence**: Adversarial probe shows these phrasings escape the
filter (all KEPT):

- `"Set Encrypted to false in BlockDeviceMappings"` — uses verb
  preposition `to`, not `:` or `=`.
- `"Encrypted = no"` / `"Encrypted: 0"` — non-`false` falsy tokens.
- `"Encryption: disabled"` — property name `Encryption` (no `-ed`
  past tense) + value `disabled`.

**Why LOW**: realistic LLM advice almost always uses the literal AWS
CFN property `Encrypted: false` (because the LLM is paraphrasing CFN
docs). "Encrypted to false" is plausible but rarer than the colon-
form. "Encryption: disabled" doesn't appear in any AWS docs.
Conservative posture forgives this — no FP risk, just FN gap.

**Proposed fix**: add a 4th pattern
`/\bencrypted\s+to\s+(?:false|no|0|off)\b/i` if/when an LLM output
in the wild shows this phrasing. Don't speculate-code now.

**Effort**: defer.

---

### LOW-2 — `Disable BlockPublicAcls` (no `: false`) not caught

**Where**: `S3_PUBLIC_ACCESS_PATTERNS` second regex requires
`[:=]\s*false`.

**Evidence**: `"Disable BlockPublicAcls on the bucket"` →
filter says KEEP. Semantically "Disable X" means "set X to false"
but the regex only catches the literal property-value form.

**Why LOW**: the LLM has to paraphrase the config block to produce
this; most LLM advice quotes the literal CFN snippet, which
exercises the `: false` form. Conservative-keep posture, no FP.

**Proposed fix**: add
`/\bdisable\s+(?:BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|
RestrictPublicBuckets)\b/i` if observed in the wild.

**Effort**: defer.

---

### LOW-3 — Audit-doc cross-link uses line 252 but actual location is line 334

**Where**: `_backlog/wizard-ux-audit-2026-05-22.md:399-400`.

**Evidence**: The Generalisation-update subsection says

> `filterAdviceContradictingFindings`
> (`packages/core/src/graph/nodes/advice/advice-filters.ts:252`)

The actual `export function filterAdviceContradictingFindings` is at
line 334 (predicates start ~250 but the exported entry-point is 334).
Minor citation drift.

**Why LOW**: doc-text accuracy only — doesn't affect runtime
behaviour or future code-search lookups (the function name is
greppable).

**Proposed fix**: update the line anchor to `:334` in the audit doc.

**Effort**: trivial.

---

### LOW-4 — `i2.` prefix is the only storage-optimised previous-gen entry; doc-comment lists "i2" but not the absent `d2.`/`h1.`

**Where**: `advice-filters.ts:245-247`.

**Evidence**: The comment on line 245 says "Storage optimised: i2
(current is i3, i4i)". AWS also has `d2.*` (HDD-dense) and `h1.*`
(HDD-throughput) which are previous-gen / retired families and
deserve filtering by the same logic. The original BP-EC2-015 yaml
probably lists them in its rule body; the filter does not.

**Why LOW**: d2 and h1 are HDD-storage-optimised — extremely niche
workload, LLM would basically never recommend them. Even if missed,
conservative-keep posture means no FP, just a tiny FN gap.

**Proposed fix**: optionally add `"d2.", "h1."` to
`PREVIOUS_GEN_INSTANCE_PREFIXES`. Defer unless observed.

**Effort**: trivial.

---

## What's tested / what's not

### Tested (48 tests, well-scoped)

- BP-EC2-015 id-match drop + title-fragment fallback + multiple
  prefixes + case-insensitivity + previous-gen-prose-without-token
  conservative-keep + empty-input edge case.
- BP-EC2-002 `Encrypted: false` (colon, equals, JSON, space-padded)
  - unencrypted prose (4 nouns) + disable/skip/turn-off encryption
  - title-fragment fallback + pro-encryption KEEP + cross-finding
    isolation (KEEP when only BP-EC2-015 fires, not BP-EC2-002).
- BP-S3-001..004 each id matches + public-read / public-read-write
  drops + literal `: false` and `= false` for all 4 properties +
  JSON-quoted property name + title-fragment custom rule + KEEP
  pro-block prose (all 5 lookbehind verbs) + KEEP topic-mention
  ("Public access is already blocked") + cross-finding isolation.
- Multi-finding: three findings drop three separate lines, one
  unrelated line preserved.
- Empty findings → all advice preserved.

### Not tested (gaps)

1. **One advice line matching TWO predicates simultaneously** (MED-2).
2. **CamelCase canned ACLs** `"PublicRead"` / `"PublicReadWrite"`
   (HIGH-2) — assertion would currently fail, hence not yet covered.
3. **Doc-URL false-positive** for `c3.html` style fragments (HIGH-1)
   — assertion would currently fail.
4. **Double-negation prose** `"do not block public-read"` (MED-3)
   — assertion would currently fail.
5. **`Encrypted to false`** verb-preposition variant (LOW-1).
6. **`Disable BlockPublicAcls`** without `: false` (LOW-2).
7. **Future S3 rule whose title doesn't start with "S3 bucket"**
   (MED-3 surface).

---

## Recommendation

**ACCEPT and land as-is** — the change closes the audit-doc's stated
follow-up scope (BP-EC2-002 + BP-S3-001..004), the contract is
documented and copy-paste-extensible, and the conservative posture
means missed contradictions are never _worse_ than the pre-PR
baseline (which had only the EC2-015 check).

**Open a follow-up issue** capturing HIGH-1 (instance-prefix word-
boundary tightening) + HIGH-2 (CamelCase ACL coverage) + MED-2
(single-line-matches-two-predicates test). These three should be
batched as a 30-minute polish PR when the next finding family
extension is queued. The MED-3 / LOW-\* items can defer until an LLM
sample-in-the-wild shows the phrasing.

**One thing the coordinator should know before push**: HIGH-1 is
the genuine "could surface visibly" risk — if a wizard plan's
advice line happens to cite an AWS doc URL containing `/c3.` or
`/m4.` _and_ the plan emits BP-EC2-015, that line gets silently
dropped. Low probability per session, but visible to the user when
it happens. Worth tightening in the next iteration.

## Coordinator response (pre-commit, 2026-05-23)

HIGH findings + the cheap MED + the cheap LOW were addressed in the
same landing commit rather than deferred to a follow-up:

- **HIGH-1 (instance-prefix substring FP on doc URLs)** — replaced
  the `PREVIOUS_GEN_INSTANCE_PREFIXES` substring array with a
  word-boundary regex
  `/\b(?:t[12]|m[1-4]|c[134]|r[34]|i2)\.(?:nano|micro|small|medium|large|x?large|\d+xlarge)\b/i`.
  Now requires a real instance size after the dot, so `/c3.html`,
  `m4.png`, `t2.json` doc-URL fragments are no longer filtered.
  Added two regression tests: one explicit doc-URL KEEP case, one
  `Nxlarge`-size-variant DROP case.
- **HIGH-2 (CamelCase ACL coverage)** — added
  `/\b(?:PublicRead|PublicReadWrite)\b/` (no `i` flag — CamelCase is
  literal; lowercase tokens are caught by the hyphen-form regex)
  with one test that drops three SDK-style phrasings
  (`"PublicRead canned ACL"`, `"PublicReadWrite to enable uploads"`,
  `"BucketCannedACL.PublicRead"`).
- **MED-2 (single-line-matches-two-predicates not tested)** —
  added a multi-predicate test that asserts one line containing
  both `t2.micro` AND `Encrypted: false` is dropped exactly once.
- **LOW-3 (audit-doc cross-link to line 252)** — corrected to
  line 337 (the actual exported function location after the
  reorganisation).

MED-1 (double-negation prose) + MED-3 (S3 title-fragment rigidity) +
LOW-1 (extra `Encrypted` variants) + LOW-2 (`Disable BlockPublicAcls`
without `: false`) + LOW-4 (`d2./h1.` storage-optimised additions)
deferred per Quinn's "defer unless observed in the wild" advisory —
conservative-filter posture means each one is a false-negative gap
(missed contradiction), never a false-positive (wrongly-filtered good
advice), so they are safe to land in a future polish pass when a
real LLM sample motivates them.

Test count: 52 advice-filter tests (was 48 before this commit's
review-response additions). All passing locally; full
`pnpm test` run = 9911 tests passed.
