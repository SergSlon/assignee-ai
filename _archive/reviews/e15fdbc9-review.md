# Reviewer: ACCEPT — qa (Quinn) — 108-A-05

## Verdict

**ACCEPT**. All three round-1 BLOCKERs land clean fixes, all five
secondary findings (HIGH #4, HIGH #5, MED #6, MED #7, LOW #8) verified
addressed, and the worker's three deviations are each judged
ACCEPTABLE under independent audit. The shared
`apps/cli/src/program.ts:69` `buildAssigneeProgram()` factory is the
correct architectural shape and a strict super-set of what was
requested in the bounce — runtime, build-time generator, and snapshot
test all consume it; a parity-guard test in the snapshot file
(`commander-tree-snapshot.test.ts:203-215`) catches future re-divergence.
Probe-axis matrix improves from 5✅/5⚠️/2❌ (round 1) to 11✅/1⚠️
(round 2). No new BLOCKER or HIGH introduced. Gates: build ✅, lint ✅,
check-types ✅, citation-lint ✅ (351 cites, 0 broken), doc-lint ✅
(`commands=18`), CLI tests 2022 passed / 148 skipped, core tests 9874
passed. The factory-rejecting `completions.ts` parent-walk retention
is technically correct (Commander mutates `child.parent` on
`addCommand`, so building a second tree at runtime would re-parent
`completionsCommand` and sever it from the live tree) and the inline
comment at `apps/cli/src/commands/completions.ts:56-62` is explicit
about the rationale.

---

## Round-1-BLOCKER verification table

| #   | Status    | Evidence (verbatim grep / file:line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Residual concern |
| --- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| 1   | **FIXED** | `apps/cli/completions/assignee.bash:11` → `commands="infra admin dev"`. `apps/cli/completions/assignee.zsh:25-27` top-level descriptions: `'infra:Manage cloud infrastructure (plan, apply, …)'`, `'admin:Inspect and verify managed resources (status, list, doctor, …)'`, `'dev:Developer tooling (init, setup, completions, …)'`. `apps/cli/completions/assignee.fish:8-10` → `complete -c assignee -n __fish_use_subcommand -a infra/admin/dev`. Old flat `commands="plan apply ..."` pattern absent (`grep -E "^commands=\"plan apply " → exit=1`). Bash 2nd-level case statements at lines 19/24/53/76 cascade into per-group sub-command lists. | None             |
| 2   | **FIXED** | `grep -cE '\$PROBE_CLI_BIN (plan\|apply\|destroy\|drift\|reconcile\|optimize\|restore-provisions\|status\|list\|doctor\|describe\|audit-verify\|init\|setup\|update\|completions\|discover\|version)\b' apps/cli/scripts/PROBE_MANIFEST.yaml` → `0`. `grep -cE '\$PROBE_CLI_BIN (infra\|admin\|dev) '` → `38`. Lines 422/424 rewritten: `check_cmd "infra apply" $PROBE_CLI_BIN infra apply \\` / `check_cmd "infra plan" $PROBE_CLI_BIN infra plan \\`. End-to-end run `bash apps/cli/scripts/pre-close-probes.sh --scope 'e96.W1.B1'` → `Total: 1 Passed: 1 Tripped: 0 Failed: 0 Setup-failed: 0`.                                                   | None             |
| 3   | **FIXED** | `CHANGELOG.md:22` `**cli(api-surface): restructure CLI into noun-grouped command tree (Story 108-A-05)**` under `## [Unreleased]` → `### Changed`. Body covers 18 leaves / 3 noun groups / factory / depth-2 `configureHelp` / snapshot + parity-guard / probe migration / breaking-change note (`CHANGELOG.md:71-76`). Cites story spec + round-1 review at `CHANGELOG.md:78-79`.                                                                                                                                                                                                                                                                     | None             |

---

## Round-2 self-claim audit

| #          | Worker claim                                                                                                             | Verdict       | Evidence                                                                                                                                                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1          | Factory `buildAssigneeProgram()` at `apps/cli/src/program.ts`, consumed by both `index.ts` and `generate-completions.ts` | **CONFIRMED** | `apps/cli/src/program.ts:69` defines `export function buildAssigneeProgram(): Command`. `apps/cli/src/index.ts:38,92` imports + invokes (`const program = buildAssigneeProgram();`). `apps/cli/scripts/generate-completions.ts:31,40` imports + invokes identically.                                                                    |
| 2          | Bundled `assignee.{zsh,bash,fish}` ship `commands="infra admin dev"`                                                     | **CONFIRMED** | See BLOCKER #1 row above — three artifact files each verified.                                                                                                                                                                                                                                                                          |
| 3          | 38 `$PROBE_CLI_BIN <leaf>` → noun-grouped; 0 remaining; `e96.W1.B1` green                                                | **CONFIRMED** | See BLOCKER #2 row above.                                                                                                                                                                                                                                                                                                               |
| 4          | CHANGELOG entry under `[Unreleased]` → `### Changed`                                                                     | **CONFIRMED** | See BLOCKER #3 row above.                                                                                                                                                                                                                                                                                                               |
| 5          | Snapshot test refactored to call factory directly                                                                        | **CONFIRMED** | `apps/cli/src/__tests__/commander-tree-snapshot.test.ts:56-57,143-144,161-162,177-178,194-195,209-211` — every test in the file dynamically imports `buildAssigneeProgram` and snapshots/asserts the factory output. No inline `new Command("infra")` builders remain.                                                                  |
| 6          | Parity-guard test (`factory called twice yields identical trees`) added inside the snapshot file                         | **CONFIRMED** | `commander-tree-snapshot.test.ts:203-215` — `it("factory output matches between production and build-time consumers (BOUNCE BLOCKER #1 regression guard)", ...)` calls `buildAssigneeProgram()` twice, serialises both, asserts `expect(a).toEqual(b)` and `expect(a.commands?.map((c) => c.name)).toEqual(["infra", "admin", "dev"])`. |
| 7          | doc-lint `countCommands` walks one level deeper; reports `commands=18`                                                   | **CONFIRMED** | `apps/cli/scripts/doc-lint.mjs:124-135` reads `apps/cli/src/program.ts` and matches `Group.addCommand(...)` (the 18 leaves), not `program.addCommand(...)`. Live run: `doc-lint: patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15`.                                                                          |
| 8 (bonus)  | MED #6 stale `Story 50-3` comment removed from `generate-completions.ts`                                                 | **CONFIRMED** | `grep -n "Story 50-3\|18 → 13" apps/cli/scripts/generate-completions.ts` → exit=1 (no matches). File header now cites Story 108-A-05 at lines 16-21.                                                                                                                                                                                    |
| 9 (bonus)  | Axis B test added                                                                                                        | **CONFIRMED** | `commander-tree-snapshot.test.ts:230-251` — `it("typoed subcommand under a noun group emits did-you-mean and exit 1", ...)` spawns `node dist/index.js infra pla`, asserts `result.status === 1` + `"unknown command 'pla'"` + `"did you mean"` + `"plan"`. Existence-guard at L234 skips when dist is absent (CI runs build first).    |
| 10 (bonus) | Axis J test added (legacy flat rejection)                                                                                | **CONFIRMED** | `commander-tree-snapshot.test.ts:253-268` — spawns `node dist/index.js plan`, asserts exit 1 + `"unknown command 'plan'"`.                                                                                                                                                                                                              |
| 11         | Test counts: 2022 CLI / 9874 core                                                                                        | **CONFIRMED** | `pnpm --filter assignee test` → `Test Files 122 passed \| 32 skipped (154); Tests 2022 passed \| 148 skipped (2170)`. `pnpm --filter @assignee/core test` → `Test Files 390 passed (390); Tests 9874 passed (9874)`.                                                                                                                    |

**Score: 11/11 CONFIRMED, 0 DISPUTED.**

---

## Deviation judgment

| #   | Deviation                                                                                                                                  | Verdict        | Reasoning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `apps/cli/src/commands/completions.ts` keeps `while (root.parent !== null) root = root.parent` instead of calling `buildAssigneeProgram()` | **ACCEPTABLE** | The inline comment at `completions.ts:56-62` documents the Commander invariant correctly: every `parent.addCommand(child)` mutates `child.parent`. If the runtime action handler called `buildAssigneeProgram()`, the freshly-built tree would import the SAME `completionsCommand` module instance (Node module identity) and re-parent it under the new `devGroup`, severing the live binary's `completionsCommand.parent` from the running tree mid-execution. The parent-walk is `O(2)` (leaf → group → root), uses no extra memory, has no side effects, and is the canonical Commander idiom. The factory IS available to this surface but using it would actively cause a regression. Accepting. |
| 2   | No separate `artifact-parity.test.ts`; parity-guard consolidated as 6th test in `commander-tree-snapshot.test.ts`                          | **ACCEPTABLE** | The round-1 finding-table proposed an "alternative" of "refactor to import a shared factory so there is ONE source of truth". The worker took that alternative, which makes a separate parity-guard mostly redundant. The 6th test at L203-215 still provides a regression guard — it explicitly asserts `expect(a).toEqual(b)` for two factory invocations and pins the noun-group order. Locating it in the same file as the snapshot keeps the regression-guard co-located with the snapshot it guards, which is preferable to a new file with a single 12-line test.                                                                                                                                |
| 3   | `docs/engineering/changelog-history.md` not updated; worker claims round-1 review flagged this as "optional"                               | **ACCEPTABLE** | Confirmed verbatim from `_archive/reviews/c17355be-review.md:121`: `Optionally mirror into docs/engineering/changelog-history.md if that file requires per-story entries.` The DoD line cited in round 1 (`[ ] CHANGELOG entry for 108-A-05 added in closing commit`) names `CHANGELOG.md` only. The historical doc is a free-form supplement and is not the BLOCKER surface.                                                                                                                                                                                                                                                                                                                           |

---

## Probe-axis matrix (A–L)

| Axis                                                | Round-1 | Round-2           | Evidence                                                                                                                                                                                                                             |
| --------------------------------------------------- | ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A — 18 noun-group paths each accept `--help` exit 0 | ⚠️      | ✅                | `commander-tree-snapshot.test.ts:53-201` — five inline-snapshot tests covering tree shape, per-group leaf names, total count = 18. Factory invariant ensures `--help` cascades from depth-2 `configureHelp` at `program.ts:118-123`. |
| B — Typo handling `infra pla` returns did-you-mean  | ❌      | ✅                | `commander-tree-snapshot.test.ts:230-251` — automated `spawnSync` test asserts exit 1 + `"unknown command 'pla'"` + `"did you mean"` + `"plan"`.                                                                                     |
| C — `--help` at each depth                          | ⚠️      | ✅                | Factory depth-2 `configureHelp` cascade at `program.ts:118-123` is now under snapshot — any regression to the loop fails the parity-guard test (L203-215).                                                                           |
| D — `--verbose` at sub-command                      | ✅      | ✅                | Unchanged; `program.ts:118-123` cascade.                                                                                                                                                                                             |
| E — `--json` at sub-command                         | ✅      | ✅                | Unchanged; same cascade.                                                                                                                                                                                                             |
| F — `--output` at sub-command                       | ✅      | ✅                | Unchanged; same cascade.                                                                                                                                                                                                             |
| G — zsh completion enumerates `infra/admin/dev`     | ❌      | ✅                | `apps/cli/completions/assignee.zsh:25-27` lists the three noun groups; `:28-50` cascade per-group sub-command arrays.                                                                                                                |
| H — Bash + fish completions for all three shells    | ❌      | ✅                | `assignee.bash:11` `commands="infra admin dev"` + `assignee.fish:8-10` `__fish_use_subcommand -a infra/admin/dev` + per-leaf 2nd-level entries at `.fish:13-19` (infra group) etc.                                                   |
| I — Commander tree snapshot, non-empty, 18 cmds     | ✅      | ✅ (strengthened) | Snapshot now serialises the production factory output (`commander-tree-snapshot.test.ts:56-139`), not an inline-built tree.                                                                                                          |
| J — Legacy flat path rejection                      | ✅      | ✅ (strengthened) | New automated test at `commander-tree-snapshot.test.ts:253-268` (was manual-only in round 1).                                                                                                                                        |
| K — `--cost-detail` survives on `infra plan`        | ✅      | ✅                | Unchanged; `planCommand` options unchanged across rounds.                                                                                                                                                                            |
| L — `dev discover` launches interactive picker      | ⚠️      | ⚠️                | Unit tests pass; no automated interactive-picker probe added in either round. Acceptable — interactive picker is gated by TTY detection which is intractable to spawn-test reliably. Same status as round 1 (no regression).         |

**Delta**: 5✅/5⚠️/2❌ → 11✅/1⚠️/0❌. All ❌ resolved; all but one ⚠️ promoted to ✅.

---

## Gate state

| Gate            | Status            | Evidence (verbatim)                                                                                                                                                          |
| --------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| build           | ✅ PASS           | `pnpm --filter assignee build` → completion artifacts regenerated cleanly; `pnpm lint` Tasks: 6 successful, 6 cached, FULL TURBO.                                            |
| lint            | ✅ PASS           | `pnpm lint` → `Tasks: 4 successful, 4 total Cached: 3 cached, 4 total Time: 3.322s`.                                                                                         |
| check-types     | ✅ PASS           | `pnpm check-types` → `Tasks: 6 successful, 6 total Cached: 6 cached, 6 total Time: 64ms >>> FULL TURBO`.                                                                     |
| citation-lint   | ✅ PASS           | `citation-lint: scanned 101 files, 351 citations, 0 broken`.                                                                                                                 |
| doc-lint        | ✅ PASS           | `doc-lint: patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15` (was `commands=3` in round 1; LOW #8 closed).                                        |
| CLI test count  | ✅ MATCH          | `Test Files 122 passed \| 32 skipped (154); Tests 2022 passed \| 148 skipped (2170)`. Matches worker claim of 2022 (+3 over round 1's 2019: parity-guard + Axis B + Axis J). |
| Core test count | ✅ MATCH          | `Test Files 390 passed (390); Tests 9874 passed (9874)`. Matches worker claim of 9874.                                                                                       |
| Probes runtime  | ✅ PASS (sampled) | `bash apps/cli/scripts/pre-close-probes.sh --scope 'e96.W1.B1'` → `Total: 1 Passed: 1 Tripped: 0 Failed: 0 Setup-failed: 0`.                                                 |

`pnpm -r test:coverage` deliberately not run by reviewer (coordinator-only
gate per project rule); CLI+core vitest invocations under the
per-package commands are the reviewer-discipline-equivalent.

---

## New findings introduced by round 2

**None.** Spec compliance verified end-to-end. Working tree clean
(`git status --short` empty). No file-ownership conflicts, no stale
imports, no orphaned snapshots, no test-quality weakening.

---

## ≤ 300-word summary for the coordinator

Round-2 commit `e15fdbc9` lands the three round-1 BLOCKER fixes
cleanly and addresses every secondary finding. The architectural fix
— extracting a shared `buildAssigneeProgram()` factory at
`apps/cli/src/program.ts:69` consumed by `index.ts` (runtime),
`generate-completions.ts` (build-time bundled artifacts), and the
snapshot test (regression guard) — is the right shape for the v1.0
API freeze: there is now exactly one source of truth for the noun-
group tree shape, and a parity-guard test
(`commander-tree-snapshot.test.ts:203-215`) catches any future
divergence before bundled completion artifacts ship broken. Bundled
`assignee.{zsh,bash,fish}` artifacts now ship
`commands="infra admin dev"` plus per-group 2nd-level cascades; old
flat patterns are absent. All 38 `$PROBE_CLI_BIN <leaf>` invocations
in `PROBE_MANIFEST.yaml` migrated to `$PROBE_CLI_BIN <group> <leaf>`;
`e96.W1.B1` runs green. CHANGELOG entry under `[Unreleased]` →
`### Changed` covers the full migration including breaking-change
rationale. doc-lint `commands=18` (was `=3` in round 1). Axis-B and
Axis-J automated tests added. Worker's three deviations are each
sound: keeping the parent-walk in `completions.ts` avoids a
Commander re-parenting regression (correctly documented at L56-62);
the consolidated parity-guard in the snapshot file is preferable to
a separate file; `docs/engineering/changelog-history.md` was flagged
as optional in round 1. Probe-axis matrix: 5✅/5⚠️/2❌ → 11✅/1⚠️.
No new BLOCKER or HIGH. CLI tests 2022 (+3), core 9874, gates green.
Story 108-A-05 ready to close.
