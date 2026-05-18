# Backlog: Cross-platform Windows residual test failures

**Source**: `ci-cross-platform.yml` weekly schedule — runs 25664600629
(2026-05-17), 26008200415 / 26009926378 / 26010451776 / 26011086607
(2026-05-18 manual dispatches across the multi-PR sweep).
**Effort**: M (per-test domain investigation; not a mechanical sweep)
**Blocking for**: none currently — windows-latest is `experimental: true`
in the matrix, so the cross-platform workflow's overall conclusion is
SUCCESS even with the failures below. Promote to `experimental: false`
only after these clear.

## Background — what's already fixed

The 2026-05-17/05-18 sweep landed 4 broad-spectrum cross-platform PRs
that resolved the largest classes of Windows incompatibility:

- **PR #112** — Windows ESM dynamic-import path (3 scripts wrapped with
  `pathToFileURL`) + langsmith `CVE-2026-45134` suppression for
  scheduled-run determinism.
- **PR #113** — Test mock regex `path` separators tightened to match
  both `/` and `\` (2 sites in resource-provisioner tests).
- **PR #114** — Windows mode-skip on 9 `0o600`/`0o700` file-mode
  assertions (NTFS doesn't enforce POSIX permission bits) +
  `path.startsWith("/")` → `path.isAbsolute()` portability.

Each of these resolved a layer of failures and revealed the next layer.
The next layer (this backlog) is **per-test domain bugs** that need
individual investigation, not mechanical mass-fixes.

## Remaining Windows-only failures (from run 26011086607)

### 1. `apps/cli/src/utils/safe-output-path.test.ts`

~4 tests fail with `expected false to be true`:

- `validateOutputPath — acceptance > accepts a deeply nested subdir path (a/b/c/out.json)` (line 92)
- `validateOutputPath — acceptance > accepts an absolute path that resolves inside CWD` (line 98)
- `validateOutputPath — acceptance > accepts a path that is exactly CWD (edge: outputting to the dir itself is technically inside)` (line 105)
- Likely additional siblings in the same describe block

**Diagnosis**: `validateOutputPath` likely uses string-prefix comparison
to check "resolved path is inside CWD". On Windows the resolved path
uses backslashes while the comparison uses forward slashes, or the
drive-letter casing differs from expectation. Fix is in the
production code in `apps/cli/src/utils/safe-output-path.ts` (NOT in the
test) — needs the same `path.relative()` + `!resolved.startsWith("..")`
idiom that's portable.

### 2. `packages/core/src/audit/audit-log.test.ts` — fsync EPERM (15 tests)

```
× appendAuditRecord > creates the log file on first write 236ms (retry x1)
  → EPERM: operation not permitted, fsync
```

15 tests in the audit-log suite fail with `EPERM: operation not permitted,
fsync`. The OS temp directory on the Windows runner may be on a file
system that doesn't support `fsync` (or the operation needs admin
privileges). Production code paths that call `fsync` need either:

- a try/catch + downgrade to non-fsync write on EPERM, OR
- a test-fixture that uses a different temp path that supports fsync, OR
- skip the audit-log tests on Windows with explicit rationale.

The production behavior is correct (fsync IS the right call on POSIX);
the test environment is the issue.

### 3. `packages/core/src/audit/hmac-chain.test.ts` — 1 residual failure

After PR #114's 0o600 mode skip, one test still fails on Windows. Not
yet diagnosed; likely another platform-specific test-data issue in a
different `it()` block in the same file. Check the post-PR-#114 run
26011086607 log for the specific test name + assertion.

### 4. `apps/cli/src/config/aws-credentials.test.ts` — token-length validation (1 test)

```
[assignee] WARNING: ASSIGNEE_OPERATOR_SESSION_TOKEN contains a session
token of length 9, which is outside the expected range [100, 4096].
```

One test in the credentials suite emits a warning about a session-token
length that suggests the test fixture's mock token didn't survive
encoding round-trip on Windows (possibly CRLF / line-ending normalization
when reading from a fixture file). Needs specific investigation of the
fixture loading path.

### 5. Possibly more — vitest stopped at first package failure

The Windows run failed in `apps/cli` test:coverage. Other packages
(`@assignee/best-practices`, `@assignee/mcp-server`) may have residual
failures that didn't surface because turbo's `--continue` wasn't used.
Use `pnpm -r test:coverage --continue` to enumerate the full failure
surface in one run.

## Acceptance criteria

1. Cross-platform workflow (`ci-cross-platform.yml`) returns SUCCESS
   on `windows-latest` for all 3 OS / Node combinations.
2. `experimental: true` flipped to `false` for windows-latest in the
   matrix include block (`.github/workflows/ci-cross-platform.yml:91`).
3. Each fixed test is verified to still pass on macOS + Linux (no
   POSIX regression).
4. Production code fixes (e.g. `validateOutputPath`) come with their
   own test coverage that exercises the Windows path shape on Linux
   via `path.win32.resolve()` so future regressions are caught
   without needing a real Windows runner.

## Sequencing

- **Depends on**: none beyond the merged PRs #112/#113/#114.
- **Unblocks**: promotion of `windows-latest` to non-experimental status,
  which is a soft requirement for v1.0 publish if the published package
  needs to be officially Windows-supported. (If Windows support is
  explicitly out of scope for v1.0, this backlog can be deferred to v1.1.)

## Process learning (carry-over to Bob's retro)

Each Windows fix revealed the next layer of failure because vitest
stops at the first failing test. To prevent this multi-iteration
discovery pattern next time, the very first cross-platform sweep
should run `pnpm -r test:coverage --continue` (or equivalent) locally
in a Windows VM / WSL to enumerate ALL failures up front, then bundle
them into a single fix wave.
