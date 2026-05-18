# Reviewer: BOUNCE — qa (Quinn) — windows-residual-sweep

## Verdict

BOUNCE. The worker addressed Cats 2-4 correctly and made the right
production fix in `safe-output-path.ts`, but the experimental:false
flip is **premature** for two reasons. (1) Cat 1's existing acceptance
and rejection tests still assert `resolvedPath` against POSIX-shaped
literal strings (e.g. `expect(result.resolvedPath).toBe("/home/etc/passwd")`)
that cannot match what Node returns on Windows (`D:\home\etc\passwd`
or `\home\etc\passwd`). The latest weekly run 26011086607 on main
proves it: 7 of the 7 windows-failures in `safe-output-path.test.ts`
were `AssertionError: expected 'D:\home\etc\passwd' to be '/home/etc/passwd'`
— the FAILURE WAS ON THE `resolvedPath` LITERAL, not on the
inside-CWD logic the worker fixed. (2) Run 26011086607 also shows an
8th Windows-only failure: `restore-provisions.test.ts > restoreProvisions

> restored file has 0o600 mode`— a 0o600 mode assertion with no`skipIf`guard. The backlog's category list was incomplete (it even
warned this in its own §5: "vitest stopped at first package failure,
possibly more"); the worker treated the 4 enumerated categories as
exhaustive and missed the 5th. With`experimental:false` flipped, the
> weekly cross-platform workflow will FAIL on Windows the moment this
> lands.

## Per-category resolution

| #   | Category                                                                          | Status      | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | --------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `safe-output-path.test.ts` (4 acceptance + 2 rejection + ... = 7 actual failures) | **PARTIAL** | Production `isInsideCwd` fix is correct and well-reasoned (path.relative + !startsWith(".." ) + !isAbsolute). Lines 28, 42, 82, 88, 94, 100, 107 still have hardcoded POSIX-shaped `result.resolvedPath` assertions (`"/home/etc/passwd"`, `${CWD}/drift.json`). On Windows runners, Node's `path.resolve` produces drive-prefixed backslash-shaped paths (`D:\home\etc\passwd`), so these `.toBe(POSIX_STRING)` assertions cannot succeed. The new POSIX regression-guard block at lines 137-225 verifies the LOGIC but does NOT replace these failing assertions. Latest weekly Windows run shows: `expected 'D:\home\etc\passwd' to be '/home/etc/passwd'` for line 27:33 (rej1), `expected 'D:\etc\passwd' to be '/etc/passwd'` for 41:33 (rej3), and acceptance tests 79-105 likewise. **Fix needed**: rewrite the assertions to use `path.resolve(CWD, rawPath)` dynamically, or split into POSIX-only `it.skipIf(process.platform === "win32")` describes. |
| 2   | `audit-log.test.ts` EPERM (15 tests)                                              | **FIXED**   | `audit-log.ts:213-260` wraps both `fileFd.sync()` and `dirFd.sync()` in narrow `code === "EPERM"` try/catch with re-throw for any other code. Production change is minimal and correct. New `audit-log-fsync-eperm.test.ts` proves no-throw + warning + valid entry returned. Real Windows runner that throws EPERM on fsync will now succeed because the downgrade is universal across the 15 callers. (Minor: test 4 is `expect(true).toBe(true)` sentinel — not a regression, but worth filling in via a custom-error-code mock to verify the re-throw branch is actually exercised, not just inspected.)                                                                                                                                                                                                                                                                                                                                                      |
| 3   | `hmac-chain.test.ts` SEC-026 file-mode warning (1 test)                           | **FIXED**   | Single skip at line 188 (`{ skip: process.platform === "win32" }`) on the test `SEC-026: emits file-mode warning on every cache-miss when mode is wrong`. Production code `hmac-chain.ts:283` already had `process.platform !== "win32"` suppression. Skip is the correct response: the assertion expects 3 warnings, production correctly emits 0 on Windows, so a guard not a fix is appropriate. Diff shows only 1 net new skip (counts went from 5→6 skipIf occurrences; 5 pre-dated PR #114).                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 4   | `aws-credentials.test.ts` (apps/cli) token-length (1 test)                        | **FIXED**   | beforeEach extended with `*_SESSION_TOKEN` deletes for OPERATOR/READER/AUDITOR. The pollution source identified in the diff is the core package's aws-credentials test setting a 9-char "tinytoken" SESSION_TOKEN; on Windows vitest worker env-var reuse leaks across files. The 3-line addition is symmetric and complete.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## experimental:false flip risk assessment

**The flip is PREMATURE.** Concrete evidence beyond the 4 cats:

1. **Missing 8th failure**: `apps/cli/src/commands/restore-provisions.test.ts:186` asserts `expect(stat.mode & 0o777).toBe(0o600)` with no `it.skipIf(process.platform === "win32")` guard. On Windows NTFS `chmod` is a no-op, so the file lands with default ACL-derived mode bits (typically 0o666) and the assertion fails. PR #114 supposedly skipped 9 mode assertions but missed this one. Latest weekly Windows run 26011086607 confirms this exact test in the FAIL list. The pattern was further established by the explanatory comment at `apps/cli/src/services/checkpoint.test.ts:640-646` which describes the same issue and has the proper `it.skipIf` — this test should follow the same pattern.

2. **Sentinel acceptance**: Worker's claim "POSIX run counts all 0 failures" is true but not load-bearing — POSIX has always passed. The relevant evidence is Windows-runner pass, which has not been demonstrated. The new POSIX `path.win32.relative()` regression-guard tests at safe-output-path.test.ts:148-225 validate the FIX LOGIC but operate on synthetic Windows-shaped strings; they don't catch the `resolvedPath` assertion mismatch in the EXISTING tests because those existing tests still use POSIX-shaped literals.

3. **Defensive sweep heuristic**: All other production `.sync()` calls are absent (only in audit-log.ts, both now guarded). All production `fs.chmod` calls in restore-provisions.ts, restore-provisions-audit-log.ts, env-writer.ts are already wrapped in try/catch with "best-effort on Windows" comments — production is correct; only tests are wrong.

4. **Heuristic on assertion shape**: `grep "stat\.mode & 0o777\).*toBe\(0o" apps/cli` finds `restore-provisions.test.ts:191` (unguarded), `env-writer.test.ts:382, 400` (need verification), `checkpoint.test.ts:637` (already guarded). The audit set for safe is not just the 4 documented categories — every unguarded mode assertion is a Windows landmine.

## Gate state (re-verified)

| Gate                                             | Status | Notes                                                                       |
| ------------------------------------------------ | ------ | --------------------------------------------------------------------------- |
| `pnpm --filter assignee build`                   | PASS   | turbo cached, completion scripts regenerated                                |
| `pnpm lint`                                      | PASS   | 4/4 tasks                                                                   |
| `pnpm check-types`                               | PASS   | 6/6 cached                                                                  |
| `pnpm citation-lint`                             | PASS   | 102 files, 353 cites, 0 broken                                              |
| `pnpm doc-lint`                                  | PASS   | patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15 |
| safe-output-path.test (POSIX)                    | PASS   | 21/21                                                                       |
| audit-log.test (POSIX)                           | PASS   | 35/35                                                                       |
| audit-log-fsync-eperm.test (POSIX)               | PASS   | 4/4                                                                         |
| hmac-chain.test (POSIX)                          | PASS   | 75/75                                                                       |
| aws-credentials.test (POSIX)                     | PASS   | 12/12                                                                       |
| `pnpm --filter assignee test` (full POSIX)       | PASS   | 2029 passed / 148 skipped (2177)                                            |
| `pnpm --filter @assignee/core test` (full POSIX) | PASS   | 9878 passed (9878)                                                          |

## Test-count stability

CLI baseline +7 (2022 → 2029) explained by the 7 new POSIX
regression-guard tests in `safe-output-path.test.ts:137-225`. Core
baseline +4 (9874 → 9878) explained by the 4 new tests in
`audit-log-fsync-eperm.test.ts`. No POSIX regressions; no test
file was deleted or had assertions weakened.

## Findings table

| Severity | Category                                      | File:line                                                            | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                          | Fix                                                                                                                                                                                                                                                                          | Effort                        |
| -------- | --------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| BLOCKER  | Cat 1 incomplete                              | `apps/cli/src/utils/safe-output-path.test.ts:28,42,82,88,94,100,107` | Hardcoded POSIX-shaped `resolvedPath` literals (e.g. `"/home/etc/passwd"`, `${CWD}/drift.json`). Latest Windows weekly run 26011086607: `AssertionError: expected 'D:\home\etc\passwd' to be '/home/etc/passwd'` at line 27:33; 6 sibling failures with the same root cause. Worker's production fix corrects `ok:true/false` decisions but does NOT change these literal assertions.                                                             | Replace literal strings with `path.resolve(CWD, rawPath)` so the expected value tracks the host's path module, OR wrap the existing describe in `describe.skipIf(process.platform === "win32")` and rely on the new POSIX regression-guard block for Windows-shape coverage. | S (10-line refactor)          |
| BLOCKER  | Missed 5th category (not in backlog)          | `apps/cli/src/commands/restore-provisions.test.ts:186-192`           | `it("restored file has 0o600 mode", async () => { ... expect(stat.mode & 0o777).toBe(0o600); })` — no Windows skip guard. Latest weekly Windows run 26011086607 lists this exact test among the 8 failures. Backlog file §5 explicitly warned "vitest stopped at first package failure — possibly more"; the worker should have run `pnpm -r test:coverage --continue` (or inspected the latest weekly run) before flipping `experimental:false`. | Wrap in `it.skipIf(process.platform === "win32")` with rationale comment matching the pattern at `apps/cli/src/services/checkpoint.test.ts:628-646`.                                                                                                                         | XS (3-line skip + comment)    |
| MED      | EPERM re-throw branch unverified              | `packages/core/src/audit/audit-log-fsync-eperm.test.ts:147-157`      | Test 4 is `expect(true).toBe(true)` sentinel with comment "We document this as a known limitation and rely on the production code review". The narrow `code === "EPERM"` check is correct on inspection, but a real test of the re-throw branch (e.g. inject EACCES or ENOSPC) would catch any future widening of the catch.                                                                                                                      | Add a second describe with a separate `vi.mock` that throws `code: "EACCES"` and assert `appendAuditRecord` rejects.                                                                                                                                                         | S (additional describe block) |
| LOW      | Worker's commit body assertion mismatch       | commit message                                                       | "POSIX run counts all 0 failures: safe-output-path 21/0, audit-log 35/0, audit-log-fsync-eperm 4/0, hmac-chain 75/0, aws-credentials 12/0" — all verified accurate; "all soft gates green" — all verified accurate. Worker did NOT claim Windows verification was performed; the experimental:false flip was based on logical-fix reasoning, not on a green Windows CI run.                                                                       | Before the next attempt: trigger a `workflow_dispatch` on `ci-cross-platform.yml` against this branch with the flip in place; require GREEN windows-latest before merge.                                                                                                     | XS (one CI dispatch)          |
| LOW      | env-writer.test.ts mode assertions un-audited | `apps/cli/src/utils/env-writer.test.ts:382,400`                      | `expect(stat.mode & 0o777).toBe(0o700)` — same NTFS-is-a-no-op vulnerability pattern. Not in latest Windows run because vitest stopped at first package failure, but if Cat 1 + Cat 5 get fixed and Windows continues, these become the next landmine.                                                                                                                                                                                            | Same `it.skipIf` pattern. Worth fixing in this commit for completeness so the experimental:false flip doesn't bounce again next week.                                                                                                                                        | XS                            |

## Required actions before re-review

1. Fix the 7 hardcoded `resolvedPath` literals in
   `safe-output-path.test.ts:28,42,82,88,94,100,107` OR wrap the
   existing acceptance + rejection describes in
   `describe.skipIf(process.platform === "win32")` and rely on the
   new POSIX regression-guard block for cross-platform coverage.
2. Add `it.skipIf(process.platform === "win32")` to
   `restore-provisions.test.ts:186`.
3. Audit `env-writer.test.ts:382, 400` for the same pattern; skip on
   Windows if asserting POSIX mode bits.
4. Trigger `workflow_dispatch` of `ci-cross-platform.yml` on the
   fix branch (with `experimental:false` already flipped) and require
   a GREEN windows-latest job before merge.
5. (Optional, MED) Replace the `expect(true).toBe(true)` sentinel in
   `audit-log-fsync-eperm.test.ts:147-157` with a real EACCES/ENOSPC
   injection that asserts re-throw.

When the worker returns with these landed, run the full review again.
The shape of fixes 1-3 is mechanical (~30 LOC total); the
workflow_dispatch on the fix branch is the proper CI-parity gate.
