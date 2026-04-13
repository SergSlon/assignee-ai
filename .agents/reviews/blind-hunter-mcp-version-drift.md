# Blind Hunter — Story 45.6 MCP version drift monitoring

Scope: shallow specification bugs — tests that pass silently while real bugs slip through.

## Findings

### 1. compareVersions regression to `!== 0` would pass — "behind" is not actually driven by `latest > pinned`

- File: `apps/cli/src/services/__tests__/mcp-version-check.test.ts:281-302` (checkMcpVersions "reports status=behind when latest > pinned")
- Severity: HIGH
- `checkSinglePin` assigns `status` as `cmp === 0 ? "up-to-date" : "behind"`, which treats latest < pinned AS behind. The orchestrator tests only drive latest > pinned and latest === pinned. A rollback scenario (pinned = 1.0.27, latest = 1.0.5 because upstream yanked) would incorrectly report "behind" when we are actually AHEAD. No test catches this directional bug. Story AC #1 specifies "behind" semantically, and the comparison function already returns -1/0/1 correctly — only the call site is wrong.
- Fix: Add a test `checkSinglePin` / `checkMcpVersions` with latest < pinned and assert `status !== "behind"` (e.g., stays up-to-date with a note, or a new `ahead` status). Also update production code to map `cmp === -1` → "behind" instead of `cmp !== 0` → "behind".

### 2. The "uses real checkMcpVersions" doctor test does not distinguish "behind" from "fetch-failed"

- File: `apps/cli/src/commands/doctor.test.ts:578-600`
- Severity: HIGH
- Test mocks `global.fetch` to return `{info:{version:"0.0.0"}}` so every row should parse as `behind`. But it only asserts `section.status === "warn"` and `subs.length > 0`. Both "behind" and "fetch-failed" roll up to warn, so if fetchLatestVersion regressed (e.g., payload parsing broke) and every row became `fetch-failed`, this test would still pass while claiming to verify the real "behind" detection path. The test name implies end-to-end exercise of the real service, but it only verifies "something warn-shaped came out".
- Fix: Assert `section.subs.every(s => s.status === "warn" && s.detail.includes("latest: 0.0.0"))` — i.e., verify the latestVersion text actually drove the conclusion. Also assert none of the detail strings contain "version check failed".

### 3. AbortController timeout wiring is never exercised end-to-end

- File: `apps/cli/src/services/__tests__/mcp-version-check.test.ts:207-225`
- Severity: HIGH
- The "propagates an aborted-signal error" test pre-aborts the controller and has the fetch mock check `signal.aborted`. This verifies `fetchLatestVersion` forwards the signal, but it never exercises `checkSinglePin`'s `setTimeout(() => controller.abort(...), 5000)` wiring. Regressions that matter but pass this suite: (a) removing the setTimeout, (b) passing the wrong ms, (c) creating the AbortController but never wiring it into the fetch, (d) failing to clearTimeout on success so Node's event loop hangs 5s after every run.
- Fix: Add a test using `vi.useFakeTimers()` that: starts `checkSinglePin` via an exported wrapper (or exercises via checkMcpVersions with a fetch mock that returns a never-resolving Promise), calls `vi.advanceTimersByTime(5000)`, awaits and asserts status === "fetch-failed" with a timeout-shaped error. Add a second test that mocks the happy path and spies on `clearTimeout` to prove the timer is cleared on success.

### 4. Dead-branch defensive code in `checkMcpVersions` is untested and masks real regressions

- File: `apps/cli/src/services/mcp-version-check.ts:164-193`
- Severity: MEDIUM
- `checkSinglePin` catches every throw and always returns a fulfilled McpVersionCheckResult, so `outcome.status === "rejected"` at L168 is unreachable in current code. The 25-line defensive block is untested. If a future refactor removes the try/catch inside `checkSinglePin`, the defensive wrapper would silently swallow the regression — the error still becomes `fetch-failed`, so tests keep passing, but now `error: outcome.reason` is stringified without the original clean message. More importantly, parsePin throwing on a malformed pin becomes invisible because the fallback uses `<unknown>` as pinnedVersion, and no test covers that fallback.
- Fix: Either (a) delete the rejected branch and replace with an `assertNever`/assertion, or (b) add a test that mocks `checkSinglePin` (via `vi.spyOn`) to throw synchronously and verifies the fallback row shape. Option (a) is cleaner.

### 5. compareVersions: missing tests for different-length comparisons with non-zero trailing components

- File: `apps/cli/src/services/__tests__/mcp-version-check.test.ts:86-89`
- Severity: MEDIUM
- Covered: `1.0` === `1.0.0`, `2` === `2.0.0`. Missing: `1.0.0` vs `1.0.0.1` (len differs AND trailing is non-zero — current code returns -1, correct, but untested), `1.0.1` vs `1.0` (returns 1, untested), and `1.10` vs `1.2` (double-digit minor on asymmetric-length input). A regression that swapped `len = Math.max` → `Math.min` would pass all current tests.
- Fix: Add three cases: `expect(compareVersions("1.0.0","1.0.0.1")).toBe(-1)`, `expect(compareVersions("1.0.1","1.0")).toBe(1)`, `expect(compareVersions("1.10","1.2")).toBe(1)`.

### 6. runMcpVersionScript has no mixed-result test

- File: `apps/cli/src/services/__tests__/mcp-version-check.test.ts:478-539`
- Severity: MEDIUM
- Tests cover all-up-to-date, single-behind, and all-fetch-failed. No test for the realistic mixed case (some up-to-date + some behind + some fetch-failed). The `upToDate/behind/failed` counters are computed from three separate `.filter().length` calls; a regression that miscounts (e.g., filters by the wrong status) would only be caught in a mixed scenario.
- Fix: Add a test with 3 rows (one of each status), assert summary line contains `"1 up-to-date, 1 behind, 1 fetch-failed (3 total)"`, and that code === 1 (because any behind → 1).

### 7. parsePin: "split on LAST @" guarantee not asserted with a multi-@ input

- File: `apps/cli/src/services/__tests__/mcp-version-check.test.ts:41-49`
- Severity: LOW
- Test name says "splits on the LAST @" but the input only contains one `@`. If the implementation regressed from `lastIndexOf` to `indexOf`, this test would still pass. No MCP package currently has `@` in its name, but the story's Dev Notes explicitly call out "lastIndexOf" as a design decision — so the guarantee deserves a direct assertion.
- Fix: Add `expect(parsePin("foo@bar@1.0.0")).toEqual({packageName:"foo@bar", pinnedVersion:"1.0.0"})`.

### 8. Drift row rollup test does not prove the warn came from the drift row

- File: `apps/cli/src/commands/doctor.test.ts:544-564`
- Severity: LOW
- "rolls up to warn when one MCP is behind even if others are ok" asserts `section.status === "warn"` but does not assert WHICH sub-row is warn vs. ok. If a regression made ALL rows warn (e.g., the up-to-date branch accidentally set status: "warn"), the test still passes. The "2/3 up-to-date" counter in the name does catch it, but only if no one also regresses the counter computation.
- Fix: Add `expect(section.subs.map(s => s.status)).toEqual(["ok","warn","ok"])` so the exact per-row shape is verified, not just the rollup.

## Summary

Eight findings: three HIGH (directional compareVersions bug untested, doctor integration test indistinguishable from failure path, timer/abort wiring untested), two MEDIUM (dead defensive branch, missing length-asymmetric compareVersions cases), one MEDIUM (script mixed-result gap), two LOW (parsePin multi-@, rollup row-shape assertion).

The HIGH findings are the important ones: #1 lets a wrong-direction status slip through, #2 lets the real doctor integration silently flip to the fetch-failed path, and #3 means the core 5-second timeout — the entire point of the AbortController scaffolding — has zero coverage.
