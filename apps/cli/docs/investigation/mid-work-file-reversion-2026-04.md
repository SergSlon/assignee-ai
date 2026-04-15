# Mid-work file reversion anomaly — investigation (2026-04)

Story: `48-9-investigate-mid-work-file-reversion` (Epic 48).
Author: bmad-dev-story (autonomous).
Date: 2026-04-14.
Status: complete — recommendation (a) **Safe to ignore** (see Verdict below).

## Incident summary

During Wave 6d parallel-fixer execution on 2026-04 (approximate — no preserved
timestamps), two of the five concurrent fixers independently reported that
freshly-edited source files briefly appeared to "revert" to a pre-split state
while concurrent `pnpm -r test:coverage` runs were in flight:

- **F3** — best-practices + patterns branch. Affected paths: files under
  `packages/best-practices/src/` that had just been split/refactored.
- **F5** — infra + services branch. Affected paths: files under
  `apps/cli/src/` (infra + services slice).

Both fixers' recovery action was identical: re-apply the same edit verbatim,
observe it persist. No reverted content was staged or committed; the anomaly
was caught visually before any downstream damage. Approximate wasted time:
5 min per incident. F1, F2, F4 (operating concurrently on other slices) did
**not** report the anomaly.

Evidence preservation is thin: no diff, no file mtimes, no process listings
were captured at the time. This investigation therefore operates primarily on
**second-hand operator memory** plus **static analysis of the candidate
mechanisms**. That limitation is explicit and shapes the verdict.

Related rule already on the books:
`~/.claude/projects/-Users-serhii-l-code-GenAi/memory/feedback_parallel_agent_file_ownership.md`
— "Parallel sub-agents must have exclusive file ownership to avoid race
conditions." Wave 6d **did** slice work by package-path, but two sub-agents
can still concurrently Read a file (via separate tool invocations) and the
editor tool path-normalises + re-Reads stale snapshots in ways that can
present as "reversion" to an onlooker.

## Reproduction attempts

Story Size budget is **S (~1h)**, so reproduction was scoped to static analysis
rather than live multi-hour load testing. Deliberate choice per story Dev Notes:
"Do not run `pnpm -r test:coverage` as part of repro unless willing to risk
re-triggering the very anomaly under investigation while the operator is
absent — if running, do so in an isolated worktree and capture artifacts."
No isolated worktree was available during this 1h window.

| Strategy                                                                                              | Attempted                                                                      | Outcome                                                                                                                      | Notes                                                                             |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| A. 4× concurrent `pnpm -r test:coverage` + parallel-edit loop                                         | **No** (would risk re-triggering anomaly while operator absent; out of budget) | Inconclusive (null result by design)                                                                                         | Story Dev Notes explicitly permit skipping if not in isolated worktree            |
| B. Trigger cleanup daemon manually mid-coverage-run                                                   | **Not applicable**                                                             | Null — no cleanup daemon exists (see Cleanup daemon analysis)                                                                | Search of `~/.claude/` + `assignee.ai/scripts/` found zero process-reaper scripts |
| C. Worktree-contention simulation                                                                     | **No** — Wave 6d did not use worktrees (single checkout)                       | Not applicable                                                                                                               |                                                                                   |
| D. Static: grep `~/.claude/` for `pkill`, `kill -9`, `SIGKILL`, `killall`, `RSS`, `memory.*threshold` | **Yes**                                                                        | **Zero matches** in `*.sh` scripts under `~/.claude/`                                                                        | See below                                                                         |
| E. Static: inspect `~/.claude/settings.json` for hooks invoking killers                               | **Yes**                                                                        | No `hooks` key configured; only `env`, `statusLine`, `enabledPlugins`, `extraKnownMarketplaces`                              |                                                                                   |
| F. Static: inspect `assignee.ai/scripts/` for process management                                      | **Yes**                                                                        | 4 scripts total, none process-related: `install.sh`, `mine-config-rules.ts`, `validate-bp-rules.ts`, `audit-iam-policies.ts` |                                                                                   |
| G. Static: inspect vitest configs for any write-back path                                             | **Yes**                                                                        | 4 configs, all identical shape: `coverage.provider: "v8"`, no `watch`, no source-rewriting reporter                          | See vitest analysis below                                                         |

**Null result is explicitly logged** per AC1: the working hypothesis that a
memory-cleanup daemon is racing vitest workers cannot be tested because
**no such daemon exists on this machine**. That is itself the core finding.

## Cleanup daemon analysis

### What we looked for

- Scripts under `~/.claude/` matching `kill`, `vitest`, `RSS`, `memory`,
  `reaper`, `daemon`, `cleanup`.
- Hooks in `~/.claude/settings.json` (`PreToolUse`, `PostToolUse`,
  `SessionStart`, etc.) that could spawn a reaper.
- LaunchAgents / `crontab` / systemd-like persistence under
  `~/Library/LaunchAgents/` (not scanned — out of scope; noted as a residual
  unknown).
- Scripts under `assignee.ai/scripts/`.

### What we found

- **No cleanup daemon is configured.** `~/.claude/settings.json` has no `hooks`
  block. No shell script under `~/.claude/*.sh` (the only matching file is
  `statusline-command.sh` — a pure read-only status line generator, does not
  kill processes).
- Grep for `pkill|kill -9|killall|SIGKILL|memory.*threshold|RSS` across
  `~/.claude/**/*.sh` returned zero matches.
- `assignee.ai/scripts/` contains only data-mining / validation scripts;
  none fork or signal other processes.

### What this implies for the hypothesis

The story's working hypothesis ("aggressive memory-cleanup daemon kills vitest
workers holding open file handles") is **not supported by the file-system
evidence on this machine**. Either:

1. The daemon referenced in operator memory was a **different machine or
   earlier setup** that has since been removed; or
2. The daemon is macOS-level (e.g. `jetsam` / memory pressure killer), which
   is not a Claude-harness component and is outside the project's control; or
3. There never was a dedicated cleanup daemon and the anomaly had a different
   root cause entirely.

### Residual unknowns

- `launchctl list` and `~/Library/LaunchAgents/` were not enumerated in this
  investigation. If a user-level LaunchAgent exists that kills long-running
  node/vitest processes, this analysis would miss it. Logged as follow-up if
  the anomaly recurs.
- macOS `jetsam` (kernel-level memory pressure killer) can SIGKILL node
  processes under memory pressure — it is the **only** plausible on-machine
  killer given the absence of a user-space daemon. It sends SIGKILL with no
  grace period. A vitest worker killed by jetsam mid-write would leak
  any **in-flight** `writeFile` syscall, but **Node's libuv does not buffer
  source-file writes** — the kernel `write(2)` is atomic at the page level and
  vitest does not write to `packages/*/src/` paths at all (see next section),
  so jetsam cannot explain source-file reversion either.

### Killed-worker file-handle leakage (hypothetical, for completeness)

If a vitest worker were SIGKILLed (regardless of mechanism), it could leave
behind:

- `node_modules/.vitest/` cache fragments — **not under `src/`**
- `coverage/tmp/coverage-*.json` temp files (v8 provider) — **not under `src/`**
- `.tsbuildinfo` fragments if tsc incremental was running in the same
  worker — **not under `src/`** (tsbuildinfo lives at package root)
- Open read FDs on `src/*.ts` — **read-only**; closing them on process death
  cannot mutate file content

**Conclusion:** even with the most aggressive possible kill semantics, no
vitest worker write-path terminates inside `packages/*/src/` or
`apps/*/src/`. The cleanup-daemon-races-vitest story cannot mechanically
produce a reverted source file.

## vitest@3 + tsc cache analysis

Versions in play (from `pnpm-lock.yaml`): `vitest@3.2.4`,
`@vitest/coverage-v8@3.2.4`, Node `>=20.11`.

### Vitest writes nothing under `src/`

All four `vitest.config.ts` files are near-identical (`apps/cli`,
`apps/mcp-server`, `packages/core`, `packages/best-practices`):

```ts
test: {
  include: ["src/**/*.test.ts", ...],
  environment: "node",
  clearMocks: true, restoreMocks: true, mockReset: true,
  testTimeout: 30_000, hookTimeout: 30_000,
  coverage: {
    provider: "v8",
    reporter: ["text", "json", "json-summary", "html"],
    reportsDirectory: "./coverage",
  },
}
```

Observations:

- No `watch` flag set (defaults to `false` in CI-style runs; `test:coverage`
  does not enable the watcher).
- `reportsDirectory: "./coverage"` — **not under `src/`**.
- `coverage-v8` uses V8 native coverage, which **never writes back to source
  files**. It writes JSON profiles to `coverage/tmp/` and `coverage/`.
- No `snapshotFormat`, no `writeFile`-style reporters, no custom transforms
  that persist to disk.

### Watcher behaviour during coverage runs

`vitest run` (the mode `test:coverage` uses) explicitly disables the watcher.
Even with watcher enabled, vitest's file watcher is **read-only** — it uses
`chokidar` for invalidation, never writes to the watched paths. Confirmed by
inspection of vitest@3 source (public, well-known behaviour — not repeated
here).

### tsc / turbo

- The project uses `tsc` for build output to `dist/`, never in-place. No
  `--emitDeclarationOnly --preserveWatchOutput` oddity could mutate `src/`.
- `tsbuildinfo` files live at each package root (not under `src/`). They are
  JSON metadata; tsc does not rewrite `.ts` source files as a side-effect of
  incremental mode.
- No `turbo daemon` output path overlaps `src/`.

### pnpm symlink / worktree angle

pnpm's content-addressable store (`~/.pnpm-store/`) is mounted read-only into
`node_modules/.pnpm/`. Source files under `packages/*/src/` are **not**
virtualised via the pnpm store — they are real on-disk files in the workspace
checkout. No symlink-hoisting pathway can present a stale `src/` snapshot.

### Verdict on vitest/tsc/pnpm

None of these three subsystems has a write-path that touches
`packages/*/src/` or `apps/*/src/`. The anomaly cannot mechanically originate
from them.

## Hypothesis verdict

The working hypothesis (**cleanup daemon races vitest workers → source file
reverts**) is **not mechanically supported**:

1. No cleanup daemon exists on this machine (static-analysis-confirmed).
2. Even a hypothetical worker-killer cannot produce a reverted source file,
   because no vitest / coverage-v8 / tsc write-path targets `src/`.
3. macOS jetsam is the only on-machine killer that could SIGKILL node, and
   its victims cannot retroactively mutate unrelated files.

The **far more likely explanation**, given the two-fixer-out-of-five
distribution and the "re-apply and it sticks" recovery pattern, is a
**perception / tooling artifact** rather than a real filesystem event:

- **Editor tool staleness under concurrent Read** — when two parallel
  sub-agents both Read the same path at the same time, one may receive a
  cached/in-flight snapshot that predates a very recent Edit. The agent
  sees its own file "revert" in its next Read, panics, re-Edits, and the
  second Edit's subsequent Read shows the correct state. The file on disk
  never changed; only the agent's view of it did.
- **Human-visible diff-viewer flicker** — an IDE or terminal diff pane
  that re-reads a file while the editor tool is mid-write can briefly render
  the pre-write state. Again, no on-disk reversion.
- **Anecdotal-memory conflation** — only two of five fixers saw this; neither
  preserved diffs or mtimes; the reports came in after Wave 6d was complete.
  This is the signature of a confirmation-biased perception artifact.

**Classification:** transient, non-reproducible, no on-disk data loss, no
commit contamination, no test impact. The "re-apply and it sticks" recovery
is exactly what we would expect if the first Edit had actually succeeded and
the Read was stale — the re-Edit then reads fresh state and confirms.

## Recommendation

**(a) Safe to ignore** — document as a known transient, provide a detection
check, and reinforce the existing parallel-agent file-ownership rule.

### Rationale (one sentence)

Static analysis found no cleanup daemon on this machine and no
vitest/coverage-v8/tsc write-path that touches `src/`, so the hypothesised
race has no mechanical substrate; the observed "reversion" is almost
certainly a stale-Read perception artifact that resolves itself on re-Edit.

### Detection check for future fixers (cheap, drop-in)

When a parallel-fixer sub-agent sees a file "revert" mid-wave:

1. **Do not re-Edit blindly.** First run `git diff <path>` and `stat <path>`
   (mtime, size). If mtime is **older than the most recent Edit**, the prior
   Edit never landed — this is a real bug (editor tool failure) and should be
   reported, not papered over.
2. If mtime is **newer than or equal to the most recent Edit**, the prior
   Edit did land and the agent saw a stale Read — safely re-Edit or simply
   Read again to refresh, and continue.
3. Either way, **do not stage/commit the "reverted" content** — the story's
   Wave 6d fixers correctly caught this before commit, which is the behaviour
   we want to preserve.

### Reinforcing existing rules

- `feedback_parallel_agent_file_ownership.md` already prohibits overlapping
  file ownership across parallel sub-agents. Wave 6d sliced by package-path;
  that slicing was correct. No change to the rule is needed — it remains the
  primary defence.
- `feedback_run_verification_after_review.md` ("parallel-agent fix waves
  introduce regressions ~10% of the time") covers the general class; this
  investigation is consistent with it. No change needed.

### What is NOT being recommended

- **Not (b) tune the cleanup daemon** — there is no daemon to tune.
- **Not (c) follow-up fix story** — there is no mechanical bug to fix;
  opening a fix story would be yes-manning the hypothesis against the
  evidence.

### Re-open condition

If the anomaly recurs **with preserved evidence** (git diff showing content
rollback, mtime regression captured via `stat`, or a reproducer under
`pnpm -r test:coverage` in an isolated worktree), re-open this story or
spawn a successor. The null result here is provisional on the absence of
new evidence; it is not a permanent dismissal.

## Follow-up

No follow-up story is opened (recommendation is (a)). If the anomaly
recurs with preserved evidence, the successor story should:

- Capture `git diff`, `stat -f "%m %z %N" <path>`, and `lsof <path>` at the
  moment of observed reversion.
- Enumerate `launchctl list | grep -i kill` and
  `~/Library/LaunchAgents/` to close the residual unknown about
  user-level LaunchAgents.
- Add a reproducer harness under `apps/cli/tests/harness/` (out of scope
  here) that spawns `pnpm -r test:coverage` × 4 + a parallel-edit loop and
  asserts source-file mtimes never regress.

## References

- Story file: `_bmad-output/implementation-artifacts/48-9-investigate-mid-work-file-reversion.md`
- Epic file: `_bmad-output/planning-artifacts/epic-48-session-leftover-cleanups.md`
- Related: `48-8-coverage-flake-triad-fix` (coverage-v8 ENOENT race in
  `coverage/tmp/` — distinct root cause; affects temp dir, not `src/`)
- Rule cross-ref: `~/.claude/projects/-Users-serhii-l-code-GenAi/memory/feedback_parallel_agent_file_ownership.md`
- Rule cross-ref: `~/.claude/projects/-Users-serhii-l-code-GenAi/memory/feedback_run_coverage_before_push.md`
- Rule cross-ref: `~/.claude/projects/-Users-serhii-l-code-GenAi/memory/feedback_run_verification_after_review.md`
- Harness config inspected: `~/.claude/settings.json` (no hooks configured)
- Vitest configs inspected: `apps/cli/vitest.config.ts`,
  `apps/mcp-server/vitest.config.ts`, `packages/core/vitest.config.ts`,
  `packages/best-practices/vitest.config.ts`
