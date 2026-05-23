# Reviewer: ACCEPT — qa (Quinn) — wizard-audit-suite

## Verdict

ACCEPT with follow-up. No BLOCKERs. The harness lands a working snapshot-diff
regression suite that faithfully encodes the doc's "Suggested next step": PTY
driver + sanitised goldens + `pnpm wizard-audit` + informational CI job.
However, several HIGH-severity determinism and CI-targeting gaps will cause
false positives or silently miss real drift once the suite is in use — they
should be cleaned up in a follow-up before anyone trusts the green/red
signal as load-bearing.

## Findings

### BLOCKER

(none.)

### HIGH

1. **`paths:` filter misses `apps/cli/src/commands/init.ts`** —
   `.github/workflows/wizard-audit.yml:25` lists
   `apps/cli/src/commands/init/**` (the directory) but NOT the sibling file
   `apps/cli/src/commands/init.ts` (~248 lines), which is the actual top-level
   command that registers `--wizard`, dispatches `--global`, prints the
   OIDC line, and reads `AWS_PROFILE`/`ASSIGNEE_OIDC_ADAPTER`. The wizard
   prompt order, the banner, and the help text all live in this file or
   its direct dependencies (`utils/first-run.ts`). A PR that changes the
   wizard's entry surface will not trigger the audit. Fix: add the
   explicit file path (`apps/cli/src/commands/init.ts`) and
   `apps/cli/src/utils/first-run.ts` (the welcome-banner source — the
   snapshot's first 25 lines come from it) to the `paths:` filter.

2. **`buildEnv` strips `AWS_*` but not `ASSIGNEE_*`** —
   `apps/cli/scripts/wizard-audit.mjs:106-124`. The repo defines 81 distinct
   `ASSIGNEE_*` env vars (`packages/core/src/constants/env-vars.ts` +
   sibling modules). Several directly affect wizard output that's pinned in
   the snapshots: `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` /
   `ASSIGNEE_READER_ACCESS_KEY_ID` / `ASSIGNEE_AUDITOR_ACCESS_KEY_ID` feed
   the "Assignee roles available: none (operator, reader, auditor all
   unset)" line on screen 1; `ASSIGNEE_OIDC_ADAPTER` feeds the OIDC line
   (currently snapshotted as "not configured. Set ASSIGNEE*OIDC_ADAPTER to
   enable."); `ASSIGNEE_AUTO_FIX` could pre-select the auto-fix radio.
   Any developer with these set in their shell hits drift on every local
   run. Fix: extend the env-strip loop to also drop keys starting with
   `ASSIGNEE*` (preserving only what the harness explicitly sets).

3. **macOS `/private/var` symlink-sanitisation runs in the wrong order** —
   `apps/cli/scripts/wizard-audit.mjs:80-90`. Order of replacements:
   (1) `projectDir`, (2) `tmpHome`, (3) `/private/var/.../tmpHome`,
   (4) `/private/var/.../projectDir`. The `/private/var` _parent_ path
   gets substituted BEFORE the `/private/var` _project_ path. So a
   capture containing `/private/var/folders/xy/.../project/foo` becomes
   `<TMP_HOME>project/foo` (step 3 replaces the prefix), and step 4 no
   longer matches because the prefix is gone — the output reads
   `<TMP_HOME>project/foo` instead of `<TMP_PROJECT>/foo`. macOS PTYs
   freely emit either `/var` or `/private/var` form; CI (Linux) never
   does. Result: snapshots captured on a Mac that happen to surface the
   `/private/var` form will diverge between macOS-update runs and any
   Linux-update run. Fix: swap the order — sanitise `/private/var`
   project form (longest) BEFORE `/private/var` home form.

4. **Harness never inspects `result.code` or `result.stderr`** —
   `apps/cli/scripts/wizard-audit.mjs:163-176, 251-268`. The child's
   exit code is returned in the result object but every caller ignores
   it; stderr is captured but never written to disk or printed. A python
   crash mid-capture (segfault, KeyboardInterrupt-equivalent, ENOENT on
   `node`) that writes a few SCREEN N blocks and dies will be silently
   accepted as the golden under `--update`, or diffed as a normal drift
   without telling the operator the underlying process exploded. Fix:
   if `result.code !== 0` AND `result.stdout` doesn't end with
   `[driver] exit code: 0`, treat it as ERROR (print stderr, count as
   drift, do NOT write the golden under `--update`).

5. **Snapshot screen 2 of global wizard is missing the answered region
   value** — `apps/cli/__fixtures__/wizard-snapshots/dev-init-global-wizard.snapshot.txt:38-39`:

   ```
   ◇  Default AWS region
   │
   ```

   versus project wizard which echoes `│  us-east-1` after the same
   ENTER. Either (a) the global wizard genuinely fails to echo the
   answered region (real UX bug; pin via a separate finding in the
   audit doc), or (b) pty-driver.py's per-screen line-dedupe at
   `apps/cli/scripts/pty-driver.py:131-139` is collapsing `│  us-east-1`
   because some other line on the same screen has the same stripped
   content. Either way the snapshot does NOT faithfully capture what a
   real user sees — and we're now pinning the buggy/corrupted form as
   the golden. Worth a one-line investigation before declaring the
   suite a faithful regression check.

### MEDIUM

6. **Description text claims "6-prompt global wizard" but snapshot has 4
   prompts** — `apps/cli/scripts/wizard-audit.mjs:59` says `exercises
6-prompt global wizard` but
   `dev-init-global-wizard.snapshot.txt` shows 4 SCREEN blocks. The
   audit doc itself drifts on this number (line 9-13 says "6 prompts",
   line 574 says "4 prompts"). Mostly a comment hygiene issue, but a
   reviewer reading the code expects the description to match reality.

7. **No process-group / signal-cascade handling for timeout** —
   `apps/cli/scripts/wizard-audit.mjs:149-154`. SIGKILL to `python3`
   kills python but `pty-driver.py` spawns `node` via `pty.fork()`,
   which puts node in a new session. Once python dies, node MAY become
   orphaned (depends on whether the kernel sends SIGHUP via PTY-close
   semantics). Worst case: a hung node process leaks into the test
   environment. Fix: spawn python with `detached: true` + track the
   process group, then `process.kill(-child.pid, "SIGKILL")` on
   timeout.

8. **Welcome banner emits a hardcoded URL pinned in the golden** —
   snapshot line 25 contains `https://github.com/SergSlon/assignee-ai`,
   sourced from `apps/cli/src/utils/first-run.ts:131`. Per the repo's
   `feedback_no_public_artifacts` memory, public URLs are not yet
   approved — pinning this URL in a checked-in fixture means a rename
   of the repo will cascade into a snapshot-drift error. Low likelihood
   but worth knowing.

9. **`unifiedDiff` is line-position-aligned, not LCS-based** —
   `apps/cli/scripts/wizard-audit.mjs:189-200`. The comment is honest
   ("not RFC-compliant"), but inserting one line near the top of a
   wizard's output will mark every subsequent line as `-/+` noise.
   Reviewers reading the CI step-summary diff will see a wall of
   spurious changes for a one-line UX tweak. Fix: pull in a small LCS
   helper (or shell out to `diff -u`); the diff is the only
   user-visible failure artefact, so quality matters here.

10. **Step-summary code-fence breaks if the captured log contains
    ` ``` ` (three backticks)** —
    `.github/workflows/wizard-audit.yml:90-93`. The wizard output today
    is clean ASCII so this is theoretical, but any future UX change
    that pipes shell commands or doc snippets into the wizard prompt
    text would corrupt the GitHub step-summary markdown. Fix: replace
    the triple-backtick wrapper with a `<pre>` block or escape
    backticks before cat.

11. **Sanitiser leaves `[driver] exit code: <N>` line in goldens for
    any non-zero exit code** — `apps/cli/scripts/wizard-audit.mjs:100-104`
    has a comment promising "normalise non-zero exits so the test can
    assert on the code separately" but no code follows. Either remove
    the misleading comment or add the actual normalisation. The
    snapshots both pin `exit code: 0` — fine for the current happy
    path but the comment will read as a lie if anyone debugs a
    non-zero capture.

12. **Setup-python step is unnecessary on `ubuntu-latest`** —
    `.github/workflows/wizard-audit.yml:56-58`. GitHub's
    ubuntu-latest image ships with python3.12 by default. The
    additional `setup-python@…` step adds 10-15s of overhead and pulls
    a SHA-pinned action this repo uses nowhere else. Either remove
    the step (simpler) or document why it's there (cross-runner
    portability for future macos-latest matrix entry).

### LOW

13. **`AWS_PROFILE` env-strip is redundant** —
    `apps/cli/scripts/wizard-audit.mjs:111`. Condition
    `key.startsWith("AWS_") || key === "AWS_PROFILE"` — the second
    half is dead code, the first half already catches it.

14. **`--filter foo` with no remaining argv hits a footgun** —
    `apps/cli/scripts/wizard-audit.mjs:215`. If the user runs
    `pnpm wizard-audit --filter` (no value), `argv[filterIdx + 1]`
    is `undefined` → filter is undefined → all cases run. Silent
    fallback; not what the user typed. Fix: error out if `filterIdx`
    is the last argv.

15. **No coverage for non-TTY first-run welcome path** —
    `apps/cli/src/utils/first-run.ts:92-99` has a non-TTY branch
    emitting `Assignee v<v> - first run, auto-detecting
environment...`. The PTY-driven harness always exercises the TTY
    branch. If the non-TTY branch regresses, this suite won't catch
    it. Worth noting in the doc as an explicit out-of-scope item
    (or covered by `e94-init-non-tty.test.ts`).

16. **`extraEnv` in `CASES` is defined but never consumed** —
    `apps/cli/scripts/wizard-audit.mjs:54, 61`. Both cases set
    `extraEnv: {}` but `runCase` never merges `testCase.extraEnv`
    into the `env` object. Either delete the field or wire it in.
    Future cases will assume it works.

17. **Tmp HOME leaks on timeout** —
    `apps/cli/scripts/wizard-audit.mjs:151-154`. The reject-path on
    timeout doesn't `rmSync(tmpHomeBase)`. macOS `/tmp` gets
    purged at boot so eventually fine, but a developer who
    triggers 20 timeouts in a debug loop leaks 20 dirs.

18. **`@see _backlog/...#suggested-next-step` anchor is stale** —
    `apps/cli/scripts/wizard-audit.mjs:30`. The doc's "Suggested next
    step" section was replaced with "Regression suite (landed
    2026-05-23)" on this very PR. The anchor points at content that
    no longer exists. Update to `#regression-suite-landed-2026-05-23`.

19. **`process.env` is passed through unfiltered apart from AWS\_\*
    strip** — `apps/cli/scripts/wizard-audit.mjs:107`. `TERM`,
    `LANG`, `LC_ALL`, `TZ` all leak through. `LC_ALL=ko_KR.UTF-8`
    could produce locale-translated `[NONE]` or date-format
    surprises in error paths. Fix: instead of cloning `process.env`
    and pruning, build a minimal env from scratch with the explicit
    keys needed (PATH, HOME, NODE, etc.).

## What's tested / what's not

### Tested (well)

- `dev init --wizard` 4-prompt project flow (region → profile → env
  → auto-fix) — pins F1 (banner-no-`[region=…]` post-fix), F2
  (AWS_PROFILE warning post-fix), F3 (env-prompt hint), F7
  (auto-fix label set + ordering).
- `dev init --global --wizard` 4-prompt global flow — pins F4
  (parity disclosure landed, prompts now match), F5 (placeholder
  rendering — `e.g. mycompany-` text content).
- First-run welcome banner content (welcome line + numbered
  next-steps + `infra plan --help` hint + missing-creds `[NONE]`
  marker).
- OIDC adapter status line content.

### NOT tested / weak coverage

- **F5 visual** — F5's fix was to render the placeholder in `chalk.dim()`
  (visual differentiation). The PTY driver strips ANSI escapes
  (`pty-driver.py:53-62`), so the dim formatting is lost — the
  snapshot pins only the text content, not the colour. If someone
  regresses `chalk.dim()` → `chalk.cyan()` the snapshot stays
  identical and the F5 fix silently rots.
- **F13** — per-line cost-source markers like `(live)` / `(cached
4d ago)`. The audit suite excludes all cost/pricing output paths
  by design (no AWS); F13's regression cannot be detected here.
  Acceptable — should be covered by unit tests on the renderer.
- **F11 insurance** — Advice/Findings cross-check filter is a
  Bedrock-dependent path; the audit suite cannot exercise it.
- **F14** — `infra plan --wizard` is the very case the doc
  identified as broken-then-fixed. The harness deliberately
  excludes it (Bedrock cost), so any re-regression of F14 (wizard
  again becoming a no-op for resolvable intents) will NOT surface
  in this suite.
- **F15** — `CI=1` spinner suppression. The harness sets `CI=1`
  (line 118), but neither snapshotted command exercises a spinner
  (both are pure-local wizards). If F15 regresses, this suite
  won't notice.
- **Non-TTY init path** (covered separately by
  `e94-init-non-tty.test.ts` — out of scope for this suite, but
  worth a one-line note in the harness header).

Net: the suite is a sharp tool for the four wizard-text regressions
it does cover, and an explicit non-tool for the Bedrock/AWS/cost-rendering
findings. That matches the audit doc's stated exclusions. Good.

## Recommendation

**Accept with follow-up.** Land as-is — the suite delivers what the
doc promised and is `continue-on-error: true`, so the worst-case
blast radius of any false positive is a noisy step-summary, not a
merge block.

Open a single follow-up story to address the HIGH findings before
anyone treats green/red on this job as load-bearing:

1. Fix the `paths:` filter (add `init.ts` + `first-run.ts`).
2. Strip `ASSIGNEE_*` env vars in `buildEnv`.
3. Swap the macOS `/private/var` sanitisation order (or collapse
   into a single sanitise-then-symlink-aware pass).
4. Wire `result.code` + stderr inspection into the result handling.
5. Investigate the missing `│  us-east-1` echo on screen 2 of the
   global wizard golden — confirm it's a real UX gap, not a
   pty-driver dedupe artefact.

The MEDIUM/LOW findings can ride a future polish pass without
blocking initial landing.

## Coordinator response (pre-commit, 2026-05-23)

The HIGH findings were addressed in the same landing commit rather
than deferred:

- **HIGH #1 (paths filter)** — added explicit
  `apps/cli/src/commands/init.ts` and
  `apps/cli/src/utils/first-run.ts` entries to
  `.github/workflows/wizard-audit.yml:24-34`.
- **HIGH #2 (`ASSIGNEE_*` env strip)** — extended the env-wipe loop
  in `apps/cli/scripts/wizard-audit.mjs` to drop both `AWS_*` and
  `ASSIGNEE_*` keys, plus pinned `LANG`/`LC_ALL` so locale doesn't
  drift between contributors.
- **HIGH #3 (`/private/var` sanitiser order)** — swapped the
  replacement order so the `/private/var` _project_ form is
  substituted before the `/private/var` _home_ form; comment
  updated to make the longest-first rule explicit.
- **HIGH #4 (result.code / stderr ignored)** — `runCase` results now
  flow through a `droveCleanly` check that requires both
  `result.code === 0` and the `[driver] exit code: 0` trailer
  before a snapshot is written or compared. Crashed/incomplete
  captures fall through to an ERROR path that prints stderr
  (truncated) and refuses to overwrite the golden under `--update`.
- **HIGH #5 (global wizard missing `│  us-east-1` echo)** —
  investigated. Confirmed real UX bug: `global-wizard.ts:51-54`
  uses `clack.text({ placeholder: DEFAULT_AWS_REGION })` (no
  default value), whereas `project-wizard.ts:54-57` uses
  `initialValue` (does have a default). ENTER on the global wizard
  yields the empty string which line 60 coerces to `undefined`.
  Filed as **F20** in `_backlog/wizard-ux-audit-2026-05-22.md` and
  deferred to the next audit-fix sweep — the regression suite's
  golden continues to pin the current (buggy) behaviour so the
  eventual fix surfaces as drift. The fix is a one-line swap
  (`placeholder:` → `initialValue:`).

MEDIUM/LOW addressed in-line:

- MED #6 (description claimed "6-prompt global wizard" but
  snapshot has 4 prompts) — comment corrected to "4-prompt".
- MED #11 (misleading "normalise non-zero exits" comment with no
  matching code) — replaced with the actual HIGH #4 implementation;
  stale comment removed.
- LOW #13 (`AWS_PROFILE` env-strip redundant) — collapsed into the
  `AWS_*` prefix check.
- LOW #14 (`--filter` with no argument silently falls back to all
  cases) — added an explicit argv-length check that errors out
  with exit 2.
- LOW #16 (`extraEnv` field defined but never consumed) — removed
  from the `CASES` definitions.
- LOW #17 (tmp HOME leaks on timeout / error paths) — extracted
  `cleanupTmpHome` and wired it into the timeout + child-error
  branches alongside the existing close-event branch.
- LOW #18 (`@see _backlog/...#suggested-next-step` anchor stale) —
  updated to point at the new
  `#regression-suite-landed-2026-05-23` heading.

MEDIUM/LOW deferred for a future polish pass:

- MED #7 (process-group / signal-cascade on timeout).
- MED #9 (LCS-based diff renderer for readability).
- MED #10 (step-summary code-fence escaping for backticks in
  captured output).
- MED #12 (setup-python step unnecessary on ubuntu-latest).
- LOW #15 (non-TTY first-run path not exercised — covered by
  `e94-init-non-tty.test.ts` instead).
- LOW #19 (build a minimal env from scratch rather than clone +
  prune — the prune approach is now defensible after the
  `LANG`/`LC_ALL` pin + `ASSIGNEE_*` strip).

Net: the HIGH cluster is closed at landing; MEDIUM/LOW deferrals are
small-effort polish items that can ride a follow-up PR without
blocking the suite's usefulness today.
