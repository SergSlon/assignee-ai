# Reviewer: ACCEPT — qa (Quinn) — EPIC-106-1

**Commit**: `8ec6d02a` — fix(process): reviewer-bypass hook hardening with evidence-file linkage
**Base**: `ebd0731f` (origin/main pre-Epic-106)
**Story**: `_bmad-output/implementation-artifacts/epic-106-1-reviewer-bypass-hook-hardening.md`
**Bootstrap exception**: this commit used `Reviewer: ACCEPT — bootstrap — EPIC-106-1` per closure criterion #8; the hook's literal allowlist at `.husky/pre-push:49` accepts it exactly once.

## Gate-criteria verification

1. **Strict ACCEPT format enforced** — `.husky/pre-push:56` regex `^Reviewer: ACCEPT — .+ \(.+\) — [^ ]+ — see _archive/reviews/[a-f0-9]+-review\.md`. Audit utility mirrors it at `reviewer-evidence-audit.ts:51`. ✓

2. **Evidence-file format enforced** — first line must match `# Reviewer: ACCEPT — <role> (<persona>) — <story_id>` per hook line 80 (`^# Reviewer: ACCEPT — .+ \(.+\) — [^ ]+`) and audit util line 89. Body free-form. ✓

3. **SKIP passthrough** — hook line 37 `^Reviewer: SKIP — ` returns 0 (no evidence file required). ✓

4. **PENDING blocks** — hook line 42 returns 2; main loop at line 209-211 surfaces it as `[PENDING — review not complete]`. ✓

5. **Audit CLI utility** — `scripts/reviewer-evidence-audit.ts` with `--since` (default `HEAD~30`) and `--limit`. Walks `git log <since>..HEAD --no-merges --format=%H`. Exits 0 on pass, 1 on any failure. ✓

6. **CI workflow** — `.github/workflows/ci.yml:49-68` adds `reviewer-evidence-audit` job, scoped `if: github.event_name == 'pull_request'`, `fetch-depth: 0`, runs `pnpm reviewer-evidence-audit --since origin/main`. ✓

7. **`_archive/reviews/` directory** — `.gitkeep` + `README.md` documenting required first-line header and pre-push hook enforcement. ✓

8. **Bootstrap exception literal** — `.husky/pre-push:49` uses `grep -qF "Reviewer: ACCEPT — bootstrap — EPIC-106-1"` (FIXED string match, not regex). Cannot be reused for SOME-OTHER-STORY at hook level. Audit utility intentionally accepts any `bootstrap — <story_id>` (test at `reviewer-evidence-audit.test.ts:76-85` documents this — hook is the restriction layer). ✓

## Probe-plan coverage (Variations A-J)

- **A — valid ACCEPT + evidence** — `auditCommit` test at line 178-190; ok status. ✓
- **B — missing evidence file** — `validateEvidenceFile` line 120-128 (`reason.includes("missing")`); `auditCommit` line 192-201 (`status="missing-file"`); CLI integration line 282-328 (`expect(threw).toBe(true)`). ✓
- **C — malformed header** — `validateEvidenceFile` line 130-143 + 145-155 (rejects "Some random title" AND missing parenthesised persona); `auditCommit` line 203-215 (`status="malformed-header"`). ✓
- **D — DC-2 fabricated attack** — `parseAcceptToken` line 45-52 explicitly tests the literal DC-2 fabricated body: `Reviewer: ACCEPT — qa (Quinn) — no blockers; 6 variations cover the spec` returns null. Also tests bare `Reviewer: ACCEPT` (line 54-58) and missing parenthesised persona (line 60-66). Hook regex requires the ` — see _archive/reviews/<hex>-review.md` suffix that the DC-2 string lacks. **Attack provably blocked.** ✓
- **E — SKIP passthrough** — hook test line 378-404 + isolated pattern match at line 400. ✓
- **F — PENDING blocking** — hook test line 406-413 (pattern doesn't match ACCEPT/SKIP, does match PENDING). ✓
- **G — net-new branch first-push gap** — `.husky/pre-push:144-168` handles `remote_sha = "0000..."` by computing range `$local_sha --not refs/remotes/origin/<default>` with origin/HEAD probe + fallback to main/master/develop/trunk + fail-closed on no default ref. The prior `-n 50` silent-exemption fallback (BH-001) is removed per the inline comment at line 137-139. ✓
- **H — bootstrap exception accepted once** — `parseAcceptToken` test line 68-74 accepts; hook test path at line 49 uses `grep -qF` literal-string match (cannot be regex-generalised). ✓
- **I — audit detects deletions** — CLI invocation test at line 282-328 simulates a commit pointing at a non-existent evidence file (`deadbeef-review.md`), confirms exit 1. ✓
- **J — CI integration** — workflow file present at `.github/workflows/ci.yml:49-68`; integration test indirectly verified via the CLI exit-code tests above. ✓

## File-ownership verification

Owned files per story spec, all present:

- `.husky/pre-push` — hook tightening (+123/-10) ✓
- `scripts/reviewer-evidence-audit.ts` — NEW utility (220 LOC) ✓
- `scripts/reviewer-evidence-audit.test.ts` — 19 tests, all pass ✓
- `package.json` — single-line script entry ✓
- `.github/workflows/ci.yml` — audit job appended (+20 LOC) ✓
- `_archive/reviews/.gitkeep` — empty marker ✓
- `_archive/reviews/README.md` — format docs ✓
- `CHANGELOG.md` — single entry under `[Unreleased]` (+13 LOC) ✓

No other files touched. No tests weakened.

## Adversarial checks (extra-rigor per dev-dc2 incident)

- **DC-2 attack vector**: fabricated `Reviewer: ACCEPT — qa (Quinn) — no blockers; ...` literal fails BOTH hook regex (no `— see _archive/reviews/<sha>-review.md` suffix) AND audit `ACCEPT_STRICT_RE`. Provably blocked. ✓
- **POSIX/sh compatibility**: hook uses only `grep -qE`/`grep -qF`/`grep -E`/`sed`/`head -n`/`printf '%s'`/`case ... esac`/`[ ... ]`/`read`/`echo`. No bash 4+ features (`[[ ]]`, associative arrays, `mapfile`, `${var:0:N}`). Short SHA derived via `git log -1 --format=%h --abbrev=8` (line 198) with a portable `cut -c1-8` fallback. Compatible with macOS bash 3.2 and Alpine `/bin/sh`. ✓
- **Tag-push security**: hook line 107-130 fixes MASTER-004 regression — tags pointing to commits not yet on `origin/<default>` now fall through to single-commit reviewer-evidence check on the tagged SHA itself. Previous blanket tag exemption (which would have let `git tag <unreviewed-sha> && git push origin <tag>` bypass the gate) is closed. ✓
- **rev-list error handling**: line 174-185 captures exit code separately because `set -e` does not propagate inside `$(...)`. Force-pushes that make `remote_sha` unreachable, shallow clones, etc. now fail closed instead of silently passing with zero commits checked. ✓
- **Merge-commit skip**: line 190-192 correctly skips multi-parent commits — they carry no reviewer token by convention. ✓
- **Bootstrap literal cannot generalise**: `grep -qF` is FIXED string match. A dev trying `Reviewer: ACCEPT — bootstrap — SOME-OTHER-STORY` does not match the exact literal `EPIC-106-1` substring. ✓
- **No new external deps**: audit utility uses only `node:child_process`, `node:fs`, `node:path` + vitest (already present). ✓

## Grandfathering note

Pre-bootstrap epic-105 commits (CP-1, SX-4, CP-2, RG-1, CP-3, DC-1, DC-2) carry `Reviewer: ACCEPT — qa (Quinn) — <STORY> — verified ...` tokens without the `— see _archive/reviews/...` suffix. The audit utility's `ACCEPT_STRICT_RE` requires that suffix, so `parseAcceptToken` returns null and the commits show `no-accept-token` status. Per spec line 81, retroactive `pnpm reviewer-evidence-audit --since main~30` is EXPECTED to surface these as "pre-audit" failures. CI scope (`--since origin/main`) only covers PR-delta commits, so grandfathered commits do not cause CI noise on new PRs. The spec acknowledges this explicitly; behaviour matches design intent.

## Build + tests

- `pnpm build`: green (`>>> FULL TURBO`, 4/4 cached).
- `pnpm exec vitest run scripts/reviewer-evidence-audit.test.ts`: 19/19 pass in 1.13s.
- Hook script (POSIX `sh`): syntactically valid (verified via `sh -n .husky/pre-push`).
- No live AWS calls; no test weakening; no `it.skip`/`xit`/`describe.skip` introduced.

## Informational nits (non-blocking)

- The audit utility's `parseAcceptToken` accepts bootstrap tokens generically (`Reviewer: ACCEPT — bootstrap — <any-story-id>`); only the hook's `grep -qF "Reviewer: ACCEPT — bootstrap — EPIC-106-1"` literal restricts the bootstrap allowance to this story. If a developer ever uses `--no-verify` to bypass the hook OR if the hook is removed/edited, the audit utility alone would not catch a `bootstrap — SOME-OTHER-STORY` token. Worth tightening in a future paydown: change audit's `ACCEPT_BOOTSTRAP_RE` to a literal exact match for `bootstrap — EPIC-106-1`, OR add a defense-in-depth allowlist constant shared between hook and audit util. Not gate-blocking — hook is the primary enforcement layer.

- The story spec at line 23 says the bootstrap format is `Reviewer: ACCEPT — bootstrap — <story_id>` but the actual commit body uses `Reviewer: ACCEPT — bootstrap — EPIC-106-1 — pre-merge bootstrap; qa Quinn evidence file written separately after review at _archive/reviews/<short-sha>-review.md`. The literal hook check matches via `grep -qF "Reviewer: ACCEPT — bootstrap — EPIC-106-1"` (substring), so the long suffix doesn't break anything — but reads as if the commit was hedging by including evidence-file-like text. Hook behaviour is correct; cosmetic only.

## Verdict

ACCEPT — every closure criterion met. Hook + audit utility close the DC-2 fabricated-ACCEPT class. Bootstrap exception is literal, scoped, documented, and cannot generalise at the hook layer. POSIX compatibility verified. CI integration correct. 19/19 tests pass.
