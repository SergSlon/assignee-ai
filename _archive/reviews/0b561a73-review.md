# Reviewer: ACCEPT — qa (Quinn) — 108-A-07

**Commit**: `0b561a73` — chore(lint): drift-guard for noun-grouped CLI paths (Story 108-A-07 closure)
**Reviewer**: Quinn (BMAD QA persona)
**Date**: 2026-05-25
**Scope**: 4 files (+233 / -0): `CHANGELOG.md`, `_backlog/108-A-07-...md`, `apps/cli/scripts/doc-lint.d.mts`, `apps/cli/src/__tests__/doc-lint.test.ts`

---

## TL;DR

ACCEPT. The author's central claim is honest: the drift-guard runtime
(`FLAT_PATH_PATTERN`, `checkFileForFlatPaths`, `runFlatPathCheck`,
`skipFlatPathCheck` param) **was already present** in
`apps/cli/scripts/doc-lint.mjs` at HEAD before this commit, having been
introduced in commit `d452e18b` (the prior 108-A-07 bulk-work commit
merged via PR `642a9b4a`). This commit adds the four corresponding
TypeScript declarations plus 10 new unit-test `it()` blocks (13
`expect` calls) plus CHANGELOG + backlog-closure paperwork. Scope is
honestly described.

One small paperwork miss (LOW): the backlog file still contains the
unresolved placeholder `<fill in after commit>` on line 104 — see
Finding 1. Recommend amend-with-ACCEPT-citation-and-push to also
populate the SHA.

---

## Evidence: was the runtime actually there?

YES. Verified via four independent checks:

1. `git log --all --oneline -- apps/cli/scripts/doc-lint.mjs | head` →
   most recent change before this commit is `642a9b4a` / `d452e18b`
   ("feat(docs+source): complete noun-grouped path migration (Story
   108-A-07)"). Commit `0b561a73` does NOT appear because it doesn't
   touch the file.
2. `git show 0b561a73 -- apps/cli/scripts/doc-lint.mjs` → empty (no
   diff). Confirms the closure commit does not modify the runtime.
3. `grep -n "FLAT_PATH_PATTERN\|checkFileForFlatPaths\|runFlatPathCheck"
apps/cli/scripts/doc-lint.mjs` → matches at lines 381, 447–448, 479,
   502, 514, 549, 565, 567, 592, 605. The runtime block spans lines
   ~455–610 as the author described.
4. `git log -S "FLAT_PATH_PATTERN" -- apps/cli/scripts/doc-lint.mjs` →
   confirms the symbol was introduced in `d452e18b` (the prior 108-A-07
   commit), not in `0b561a73`.

No hallucination. The closure commit is what it says: types + tests +
paperwork on top of pre-existing runtime.

---

## Evidence: type-decl parity

Read `.mjs` and `.d.mts` side-by-side. Six runtime `export`s, six
matching `.d.mts` declarations:

| Runtime export (`.mjs`)                           | `.d.mts` declaration                                                             |
| ------------------------------------------------- | -------------------------------------------------------------------------------- |
| `countReadmePatternRows` (line 168)               | line 1 — `(string) => number \| null`                                            |
| `extractIntegrationArchitectureCounts` (line 199) | lines 3–13 — `(string) => Array<{label, expect, actual}>`                        |
| `runDocLint` (line 375)                           | lines 15–39 — full input record with the new `skipFlatPathCheck?: boolean` param |
| `FLAT_PATH_PATTERN` (line 479)                    | line 45 — `RegExp`                                                               |
| `checkFileForFlatPaths` (line 549)                | lines 54–57 — `(absPath, repoRoot) => Promise<string[]>`                         |
| `runFlatPathCheck` (line 592)                     | lines 60–65 — `(repoRoot) => Promise<string[]>`                                  |

Parity confirmed. Signatures match the runtime (JSDoc on the runtime
matches the param/return types in the `.d.mts`). Minor: `RegExp` does
not express the `g` flag, but TypeScript has no narrow type for that;
acceptable.

---

## Evidence: test honesty (10 new `it()` blocks, 13 `expect` calls)

Test file: `apps/cli/src/__tests__/doc-lint.test.ts` lines 273–429.

### `describe("FLAT_PATH_PATTERN regex")` — 3 `it`, 3+ `expect`s

1. **`matches every guarded flat-leaf command`** — iterates the
   18-leaf array `[plan, apply, destroy, drift, reconcile, optimize,
restore-provisions, status, list, doctor, describe, audit-verify,
init, setup, update, completions, discover, version]`, calls
   `FLAT_PATH_PATTERN.exec("assignee ${leaf}")`, expects non-null.
   Matches backlog file line 51 verbatim — 18 leaves, no missing
   alternation entries.
2. **`does NOT match noun-grouped invocations at the regex level`** —
   passes `"assignee infra plan"`, `"assignee admin status"`,
   `"assignee dev init"` etc. Confirms the regex on its own does NOT
   match (the noun-group filter is implemented as a substring check in
   `checkFileForFlatPaths`, not in the regex itself — the test
   correctly probes regex-level behaviour, not the full filter).
3. **`does NOT match unrelated words that start with guarded leaf
names`** — `"planner"`, `"applied"`, `"destroyer"`, etc. Confirms
   `\b` word-boundary works. Note: `restore-provisions` and
   `audit-verify` contain hyphens — Test 1 exercises both as positive
   matches (`assignee restore-provisions` / `assignee audit-verify`
   both expected to match). Negative cases for these hyphenated forms
   are not explicitly tested but the regex alternation literal
   includes the full hyphenated string, so `\b` only fires at the
   start/end of the full match.

### `describe("checkFileForFlatPaths")` — 7 `it`, 10 `expect`s

1. **`flags a markdown file containing "assignee plan"`** — writes
   real tmp file, calls `checkFileForFlatPaths`, expects 1 error
   matching `/flat-path CLI invocation.*assignee plan/` AND
   `/108-A-07 drift-guard/`. Tests the production error-message format,
   not a tautology.
   2–4. **Negative tests** for `"assignee infra plan"`,
   `"assignee admin status"`, `"assignee dev init"` — confirms the
   line-prefix `\bassignee (infra|admin|dev)\s+$` filter at line 573
   correctly suppresses these. Tests the production filter, not a
   regex round-trip.
2. **`flags multiple flat-path hits across lines`** — 3-line fixture
   with 3 distinct flat-paths; expects `errors.toHaveLength(3)`. Tests
   the per-line loop (lines 562–582 of the runtime).
3. **`skips *.test.ts files`** — writes a `.test.ts` filename and
   confirms it returns `[]`. Tests `shouldSkipFlatPathScan` against
   the `.test.ts` skip pattern at line 508.
4. **`includes line number in error message`** — 3-line fixture with
   the hit on line 2; expects `/:2:/` in the error. Tests the
   `${i + 1}` line-number formatting at line 577.

Tests exercise production code paths, not tautologies. Real tmp
files (`mkdtemp` + `writeFile`), real `checkFileForFlatPaths`
invocations, real error-message regex assertions. Compliant with
project rules ("All mocks must use real data").

### Test run

```
$ pnpm --filter @assignee/cli exec vitest run src/__tests__/doc-lint.test.ts
 ✓ src/__tests__/doc-lint.test.ts (22 tests) 130ms
 Test Files  1 passed (1)
      Tests  22 passed (22)
```

22 = 12 pre-existing + 10 new. All pass.

---

## Evidence: `pnpm doc-lint` clean

```
$ pnpm doc-lint
doc-lint: patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15
```

Zero flat-path errors on HEAD. Author's claim verified.

---

## Findings

### Finding 1 (LOW / paperwork) — unresolved SHA placeholder in backlog closure

**File**: `_backlog/108-A-07-noun-grouped-path-migration-completion.md:104`

```
**Closing commit**: `<fill in after commit>` (placeholder — amend after commit).
```

The closure section was written before the commit landed and includes
an explicit "amend after commit" instruction. The commit has now
landed as `0b561a73`, but the placeholder was never resolved. Future
readers will see a literal `<fill in after commit>` and have no SHA to
trace back to.

**Fix**: amend the backlog file to read `**Closing commit**: \`0b561a73\``.
Same amend can carry the Reviewer ACCEPT citation, so this is a single
amend + force-push (sanctioned amend-after-push per the project rule
when the citation is the trigger).

**Severity**: LOW. The CHANGELOG entry and `## Closure` header date
(`2026-05-25`) already provide enough breadcrumbs to find the commit
via `git log --grep 108-A-07`. Not a blocker.

### Finding 2 (LOW / cosmetic) — assertion-count wording inconsistency

**File**: `_backlog/108-A-07-...md:101–102` says `13 new assertions`;
`CHANGELOG.md:22-32` doesn't quantify; coordinator briefing says
`10 unit tests`.

Both metrics are factually correct (`grep -c "it("` = 10,
`grep -c "expect("` = 13 inside the new describe block). The backlog
narrative uses `expect` count, the CHANGELOG and briefing use `it`
count. A future reader reconciling the two could be momentarily
confused.

**Fix** (optional, not required for ACCEPT): unify on one metric or
clarify ("10 `it()` blocks containing 13 `expect()` assertions").

**Severity**: LOW. Honest, just inconsistent.

### Finding 3 (LOW / cosmetic) — closure narrative phrasing

The closure section says "What remained — and lands in this commit —
is the **drift-guard regex** in `apps/cli/scripts/doc-lint.mjs`".
Strictly read, this implies the regex itself lands in this commit.
The regex itself landed in `d452e18b` / `642a9b4a`. The same
paragraph clarifies "the rewrite work the backlog described had
already landed across earlier 108-A-\* stories", which arguably covers
the regex too, but the sentence is mildly self-contradicting.

**Fix** (optional): rephrase to "What remained — and lands in this
commit — are the **type declarations, unit tests, and CHANGELOG entry**
for the drift-guard regex that landed in commit `d452e18b`."

**Severity**: LOW. Minor wording slippage, not a deceit. The CHANGELOG
wording is cleaner.

---

## What I did NOT find

- No missing exports in `.d.mts` (six-for-six parity).
- No tautological tests (every assertion exercises production code).
- No missing leaves in the 18-element alternation (matches backlog
  line 51 verbatim).
- No fraudulent claims about pre-existing runtime — the runtime is
  genuinely present in `doc-lint.mjs` at lines 455–610 from prior
  commit `d452e18b`.
- No regression in the rest of the test file (12 pre-existing tests
  still pass).
- No issue with `.test.ts` skip pattern leaking e2e files — e2e files
  are named `*.test.ts` and caught by the skip rule.
- No issue with `_backlog/**` leakage — `FLAT_PATH_SCAN_SURFACES`
  (lines 487–496) does not include `_backlog/`, so the backlog file's
  own flat-path examples don't trigger the lint.

---

## Verdict & recommendation

**ACCEPT** — the closure commit is small, honest, and well-tested.
The runtime claim is verified; type-decl parity is exact; tests
exercise production code paths; CHANGELOG attribution is honest.

**Recommended next action**: **amend-with-ACCEPT-citation-and-push**.

The amend should:

1. Resolve the `<fill in after commit>` placeholder to `0b561a73` (or
   the post-amend SHA — circular but acceptable, or use `0b561a73` to
   preserve the original-author intent and accept the cosmetic
   half-stale-after-amend artifact).
2. Add `Reviewer: ACCEPT — qa (Quinn) — 108-A-07 — see _archive/reviews/0b561a73-review.md`
   to the commit body.
3. Stage `_archive/reviews/0b561a73-review.md` BEFORE the amend
   (per the `reviewer-evidence-audit` CI rule).
4. `git push --force-with-lease` (sanctioned amend-after-push, citation
   evidence trigger).

If the placeholder fix is deferred to a follow-up commit (acceptable
alternative — LOW finding doesn't block), the standard non-amend
ACCEPT-citation flow applies: stage evidence file, new commit with
`Reviewer: ACCEPT` + placeholder fix, push.

No FIX-REQUIRED items. No BLOCKER items. The "is the runtime real"
question — the central adversarial scrutiny lens — resolves cleanly
in favor of the author.
