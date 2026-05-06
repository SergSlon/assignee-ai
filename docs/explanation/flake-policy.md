# Flake policy

Every test in the suite runs once, then retries once on failure before being
reported red. This document explains why that is the right escape valve for
timing jitter, what the flake-rate SLO is, and how a genuinely unreliable
test gets quarantined.

---

## The contract

- Tests run **once by default**, then **retry once** on failure before being
  reported as red (`retry: 1` in each `vitest.config.ts`).
- A test that flakes more than once per 10 runs is considered **quarantined** —
  its presence in the suite is temporary debt, not a stable gate.
- **Never weaken an assertion** to stop a flaking test. Fix the code or
  quarantine the test; do not mask the signal.

The assertion-weakening prohibition is not a style guide preference. It is a
hard invariant. Weakening `expect(x).toBe(3)` to `expect(x).toBeGreaterThan(0)`
to silence a flaky test hides a real bug behind a passing CI badge. The
`feedback_never_weaken_tests` memory documents why this invariant exists.

---

## SLO

| Metric                    | Target                                                       |
| ------------------------- | ------------------------------------------------------------ |
| Observed flake rate       | ≤ 0.1 % of test executions per full run                      |
| Maximum retries to pass   | 1 (a test that needs 2+ retries is unreliable by definition) |
| Quarantine resolution SLA | Before the epic that owns the test closes                    |

With the current full suite (run `pnpm -r test:coverage` for the live
count) a 0.1 % rate means a handful of flakes per full run on average.
Above that threshold the flake inventory is an incident, not background noise.

---

## Why `retry: 1` is the right escape valve

CI runners are shared VMs. A `setTimeout`-based assertion that resolves in
12 ms on a developer laptop can take 80 ms under load on a shared runner.
That single timing jitter on a 9 500-test suite means guaranteed red CI at
some run frequency.

The tradeoffs:

| Option                         | Effect                                                              |
| ------------------------------ | ------------------------------------------------------------------- |
| **retry: 0** (the old default) | Any timing jitter → red CI; temptation to weaken assertions grows   |
| **retry: 1** (current policy)  | One cheap re-run absorbs jitter; real bugs still fail both attempts |
| **retry: 2+**                  | Hides real bugs behind multiple retry attempts; do not do this      |
| **Weakening assertions**       | Masks the root cause permanently; forbidden                         |

One retry is cheap. If a test fails both the original attempt and the one
retry, it is almost certainly a real bug or a genuinely flaky test — both
deserve attention, not suppression.

---

## Quarantine process

When a test flakes consistently (fails in CI but passes locally, or fails
more than once in 10 runs):

1. **Identify.** Look for the test in the CI retry log (`##[warning]` lines
   emitted by vitest's verbose reporter on a retry) or run locally with
   `--reporter=verbose`.

2. **Open an issue.** File a GitHub issue with the `flaky-test` label.
   Include:
   - Test file path + line number.
   - Observed failure rate (e.g., "3 out of 5 CI runs" or "fails on
     `pnpm -r test:coverage` but not `pnpm test`").
   - Root-cause hypothesis (timer, file-system race, singleton state leak, …).

3. **Gate the test.** Tag it with `it.skipIf(process.env["SKIP_FLAKY"] === "1")`
   so it can be excluded from a CI run while investigation is in progress.
   Do not use `it.skip` unconditionally — that silences the test forever and
   loses the failure signal in local runs.

   > **Cache-key caveat.** `SKIP_FLAKY` is **not** declared in `turbo.json`'s
   > `tasks.test.env` (or `tasks.test:coverage.env`). Operators flipping this
   > gate locally should clear the turbo cache manually (`pnpm turbo run test
--force` or `rm -rf node_modules/.cache/turbo`); otherwise turbo will
   > replay the previous cached result and the gate flip will appear to do
   > nothing. Promoting `SKIP_FLAKY` into the cache keys is a follow-up.

4. **Resolve before epic-close.** The `flaky-test` label is a block on
   epic-close. A quarantined test is a candidate for the next quality
   iteration, not a permanent state. The resolution is either a
   root-cause fix or a deliberate deletion of the test with a comment
   explaining why the coverage gap is acceptable.

---

## Inventory

Current quarantined tests: **none.**

Add entries here as they accrue:

| Test file | Issue | Root-cause hypothesis | Quarantined since |
| --------- | ----- | --------------------- | ----------------- |
| _(empty)_ | —     | —                     | —                 |

---

## Enforcement

- **Pre-push hook** runs `pnpm test` (not `pnpm -r test:coverage`) — `retry: 1`
  applies there too. A test that was flaky in CI but passes locally with retries
  is still caught on push.
- **CI** runs `pnpm -r test:coverage` per `feedback_run_coverage_before_push` —
  retries apply in CI as well.
- **Nightly E2E** (`nightly-e2e.yml`) does **not** apply retries. Real-AWS
  resources are involved; a retry could leak cost or leave orphaned resources.
  That workflow treats first-attempt failure as final and pages the on-call.

---

## When to raise `retry` beyond 1

You should not. If `retry: 1` is insufficient — meaning the test consistently
needs two or more retries to pass — the test is fundamentally unreliable. The
correct response is to quarantine it (see above) or rewrite it so it does not
depend on timing. Raising `retry: 2+` in the vitest config hides real bugs and
is therefore forbidden by the same principle that forbids weakening assertions.

---

**Source memory.** `feedback_never_weaken_tests.md` · `feedback_run_coverage_before_push.md`
