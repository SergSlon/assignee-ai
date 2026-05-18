# Reviewer: BOUNCE — qa (Quinn) — 108-A-07

## Verdict

The user-facing string migration is largely complete and the new
`FLAT_PATH_PATTERN` drift-guard works correctly — Domains 1/2/3 grep
counts match the worker's claim (0 / 0 / 1). The five "soft" gates
(build, lint, check-types, citation-lint, doc-lint) all pass, and
historical CHANGELOG blocks were correctly preserved. **However, the
worker's claim #8 ("Test assertion sync — 18 files") is materially
incomplete**: a second wave of test assertions still references flat
paths, and `pnpm --filter assignee test` shows **7 CLI failures** and
`pnpm --filter @assignee/core test` shows **5 core failures** — 12
total test regressions caused by source migrating to noun-grouped
strings while the matching test assertions were not updated. Claim
#10 ("Pre-close-probes 40/3/0") was confirmed independently, but the
worker's gate list omitted `pnpm test` entirely, which is the gate
that catches assertion drift. This is exactly the partial-completion
trap that the original 108-A-05 finding flagged, recurring one layer
deeper. Worker must update the 12 failing assertions (mechanical,
~50 lines of test code) and re-run package tests cleanly. **Bounce
back for a second pass.**

## Worker self-claim audit

| #   | Claim                                                                  | Verdict             | Evidence                                                                                                                                                            |
| --- | ---------------------------------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Domain 1 (docs+README) flat-path = 0                                   | CONFIRMED           | grep returned 0; verified manually                                                                                                                                  |
| 2   | Domain 2 (source user-facing) = 0                                      | CONFIRMED           | grep returned 0; verified manually                                                                                                                                  |
| 3   | Domain 3 (full sweep ex tests) = 1 hit in doc-lint comment             | CONFIRMED           | only hit is `apps/cli/scripts/doc-lint.mjs:473` comment                                                                                                             |
| 4   | New `FLAT_PATH_PATTERN` drift-guard + clean `pnpm doc-lint`            | CONFIRMED           | regex at `doc-lint.mjs:479-480`, hook at `:448-449`, doc-lint passes                                                                                                |
| 5   | `discover-data.ts` reabsorbed with `LEAF_TO_GROUP` cleaner form        | CONFIRMED           | `apps/cli/src/commands/discover/discover-data.ts:191-225` emits `assignee ${group} ${cmd} --help`, e.g. `assignee infra plan --help`                                |
| 6   | F-05 CHANGELOG B-04 dedup landed in PR #111                            | NOT-REGRESSED       | branch did not modify CHANGELOG.md (`git diff` empty)                                                                                                               |
| 7   | F-06 safety-ref pre-push guard landed in `e4a472c7`                    | OUT-OF-SCOPE        | not re-verified; not in this branch's scope                                                                                                                         |
| 8   | Test assertion sync (18 files)                                         | **DISPUTED**        | 18 files were updated, but **12 additional test assertions** still reference flat-path strings; CLI test failures = 7, core test failures = 5 (details in Findings) |
| 9   | All gates: build / lint / check-types / citation-lint / doc-lint clean | PARTIALLY CONFIRMED | all five named gates pass; **`pnpm test` was omitted from the list and is failing**                                                                                 |
| 10  | Pre-close-probes 40 PASS / 3 tripped / 0 FAIL                          | CONFIRMED           | `bash apps/cli/scripts/pre-close-probes.sh` → "Total: 43 Passed: 40 Tripped (known-open): 3 Failed: 0"                                                              |

## Defensive grep results

| Domain | Command-scoped target                                               | Expected                   | Measured                                                 |
| ------ | ------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| 1      | `docs/ README.md` minus `_archive`/`_drafts`                        | 0                          | **0**                                                    |
| 2      | `error-messages/`, `commands/setup/`, `first-run.ts`, `display*.ts` | 0                          | **0**                                                    |
| 3      | Full repo, `*.md`/`*.ts`/`*.mjs` ex tests/\_archive/dist            | 1 (doc-lint regex comment) | **1** (exact match: `apps/cli/scripts/doc-lint.mjs:473`) |

The migration of user-facing strings is correctly executed — no flat-
path text remains in any document or non-test source file scanned.

## Drift-guard regex sanity test

```
node -e "const r = /\\bassignee (plan|apply|destroy|drift|reconcile|optimize|restore-provisions|status|list|doctor|describe|audit-verify|init|setup|update|completions|discover|version)\\b/g; const s = 'assignee plan something'; console.log(r.test(s) ? 'MATCH' : 'NO-MATCH')"
→ MATCH
```

The drift-guard regex correctly matches a synthetic flat-path
regression. Static structure of the guard:

- `FLAT_PATH_PATTERN` defined at `apps/cli/scripts/doc-lint.mjs:479`
- 18 leaf commands enumerated in the alternation
- `FLAT_PATH_SCAN_SURFACES` covers `docs/`, `README.md`, `apps/cli/src/utils/error-messages`, `apps/cli/src/utils/first-run.ts`, `apps/cli/src/commands`, `packages/core/src/config/help-hints.ts`
- `FLAT_PATH_SKIP_PATTERNS` excludes tests / fixtures / archives / CHANGELOG / dist
- Hook invocation at `runFlatPathCheck(repoRoot)` (line 448) wired into the main lint loop

Guard is sound and would catch a regression on user-facing surfaces.

## Risk-area probes

1. **Reference pages regeneration** ✅ — 39 files under `docs/reference/`, all auto-generated by `scripts/generate-reference-pages.ts` and emitting `assignee infra plan "..."` examples. Spot-checked `docs/reference/apigatewayv2-api.md:24` → `assignee infra plan "Create a WebSocket API"` (noun-grouped). Generator source uses `assignee ${group} ${cmd}` template.
2. **CHANGELOG.md historical preservation** ✅ — `git diff origin/main..1c2a5f00 -- CHANGELOG.md` returns zero lines. Historical `## [0.x]` blocks untouched.
3. **Axis J flat-path-rejection test** ✅ — `apps/cli/src/__tests__/commander-tree-snapshot.test.ts:253-268` is untouched. Still spawns the binary with `[cliDist, "plan"]` (flat) and asserts `expect(combinedErr).toContain("unknown command 'plan'")`. Correctly preserved.
4. **Pattern descriptions** ✅ — grep of `packages/core/src/services/patterns/` for pattern descriptions with flat paths returns 0 hits. Patterns clean.
5. **`discover-data.ts` resolution** ✅ — coordinator took the worker's `LEAF_TO_GROUP` form. `buildCommandItems()` correctly emits `assignee infra plan --help`, `assignee admin list --help`, etc. exampleIntent values for dev-discover command-category items.
6. **Citation-lint independence** ✅ — `pnpm citation-lint` returns `scanned 102 files, 353 citations, 0 broken` after the migration. Cross-doc links not regressed.

## Gate state

| Gate                                        | Status      | Evidence                                                                       |
| ------------------------------------------- | ----------- | ------------------------------------------------------------------------------ |
| `pnpm --filter assignee build`              | ✅ PASS     | Shell completion scripts generated                                             |
| `pnpm lint`                                 | ✅ PASS     | 4/4 tasks successful                                                           |
| `pnpm check-types`                          | ✅ PASS     | 6/6 tasks successful                                                           |
| `pnpm citation-lint`                        | ✅ PASS     | 102 files / 353 citations / 0 broken                                           |
| `pnpm doc-lint`                             | ✅ PASS     | patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15    |
| `pnpm --filter assignee test`               | ❌ **FAIL** | Test Files 6 failed / 116 passed / 32 skipped — **7 individual test failures** |
| `pnpm --filter @assignee/core test`         | ❌ **FAIL** | Test Files 3 failed / 387 passed — **5 individual test failures**              |
| `pnpm --filter @assignee/mcp-server test`   | ✅ PASS     | 722 tests passing                                                              |
| `bash apps/cli/scripts/pre-close-probes.sh` | ✅ PASS     | 43 total / 40 passed / 3 tripped / 0 failed                                    |

CLI test count: 116 passed (down from baseline because 6 files have at least one regressed assertion; total individual passing tests would have been higher pre-migration since the failures are pure assertion drift).

## Findings table

| #    | Severity    | Category                 | File:Line                                                                        | Evidence                                                                                                                                                                                                                                                                                                                | Fix                                                                                                                                                                                                                      | Effort                                                                  |
| ---- | ----------- | ------------------------ | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------ |
| F-01 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/commands/describe.test.ts:464`                                     | Asserts ``"Run `assignee list`to see all managed resources, or`assignee list --json                                                                                                                                                                                                                                     | jq`to find a specific run id or ARN."``; received`assignee admin list`                                                                                                                                                   | Update both occurrences in the expected string to `assignee admin list` | 1 line |
| F-02 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/commands/list.test.ts:334`                                         | `StringContaining("``assignee list --help``")`; source now emits `assignee admin list --help`                                                                                                                                                                                                                           | Update to `assignee admin list --help`                                                                                                                                                                                   | 1 line                                                                  |
| F-03 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/commands/status.test.ts:499`                                       | `toContain("``assignee status --help``")`; source emits `assignee admin status --help`                                                                                                                                                                                                                                  | Update to `assignee admin status --help`                                                                                                                                                                                 | 1 line                                                                  |
| F-04 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/services/checkpoint.test.ts:434, :447`                             | Regex `/Checkpoint file not found.*Run `assignee plan`/` and `/Checkpoint expired.*TTL 1h.*Run `assignee plan`/`; source emits `assignee infra plan`                                                                                                                                                                    | Update both regexes to `assignee infra plan`                                                                                                                                                                             | 2 lines                                                                 |
| F-05 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/commands/plan/__tests__/plan-json-arg-errors.test.ts:44`           | Regex `/assignee plan "[^"]+"/`; source emits `Usage: assignee infra plan "..."`                                                                                                                                                                                                                                        | Update regex to `assignee infra plan `                                                                                                                                                                                   | 1 line                                                                  |
| F-06 | **BLOCKER** | test-assertion-drift     | `apps/cli/src/commands/apply-destroy-reconcile-json.test.ts:411`                 | Asserts ``"→ Run `assignee plan --wizard` to remediate..."``; source emits `assignee infra plan --wizard`                                                                                                                                                                                                               | Update to `assignee infra plan --wizard`                                                                                                                                                                                 | 1 line                                                                  |
| F-07 | **BLOCKER** | test-assertion-drift     | `packages/core/src/errors/hint-registry.test.ts:30, :39`                         | Two cases (`StateMismatch`, `NotFound`) assert hint strings containing `re-run 'assignee plan'` and `Re-run ``assignee plan```; source emits `assignee infra plan`                                                                                                                                                      | Update both to `assignee infra plan`                                                                                                                                                                                     | 2 lines                                                                 |
| F-08 | **HIGH**    | drift-guard-coverage-gap | `packages/core/src/config/__tests__/help-hints-flag-existence.test.ts:240, :298` | Source scan for `assignee <cmd> --<flag>` triples returns 0 (was >10) because the scanner regex `/assignee\s+(\w[\w-]*)\s+(--[\w-]+)/` no longer matches noun-grouped form `assignee infra apply --checkpoint`; also `KNOWN_WAVE_3B_DRIFTS` allowlist has stale `'destroy --all'` entry that no longer matches anything | Extend the source-scanner regex to capture optional noun-group prefix (e.g. `/assignee\s+(?:infra\s+\|admin\s+\|dev\s+)?(\w[\w-]*)\s+(--[\w-]+)/`); update allowlist entry from `destroy --all` to `infra destroy --all` | ~10 lines + allowlist update                                            |
| F-09 | **HIGH**    | drift-guard-coverage-gap | `packages/core/src/utils/display-plan-box.test.ts:305`                           | The "every `assignee <cmd> ... --<flag>` suggestion references a real flag" guard now sees lines like `assignee infra apply --checkpoint ...` and reports `unknown subcommand 'infra'` because the test's `KNOWN` map keys are leaf names (`apply`, `destroy`) not group-prefixed                                       | Extend the guard's parser to strip optional `infra `/`admin `/`dev ` noun-group prefix before resolving the command                                                                                                      | ~5 lines                                                                |

**Total: 7 BLOCKER, 2 HIGH, 0 MED, 0 LOW.** All issues are mechanical
test-assertion or drift-guard-parser updates; no logic changes.

## Preserved flat-path strings (sanity check)

The worker correctly preserved flat-path strings in these contexts:

| Location                                                         | String                                                                            | Rationale                                                                                                         | Verdict                           |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `apps/cli/src/__tests__/commander-tree-snapshot.test.ts:248,267` | `unknown command 'plan'` / `unknown command 'pla'`                                | Axis J: legacy flat-path rejection test — assertion MUST still use the flat form because it's testing rejection   | ✅ correct                        |
| `apps/cli/src/commands/json-stderr-filter.test.ts:92,176,184`    | `assignee plan --help`, `assignee apply  [region=us-east-1]`                      | Test fixtures simulate stderr text produced by external callers; not assertions against current source output     | ✅ acceptable                     |
| `apps/cli/scripts/doc-lint.mjs:473`                              | `assignee plan`, `assignee setup` in jsdoc comment explaining `FLAT_PATH_PATTERN` | The regex literal documenting what the guard catches                                                              | ✅ correct (and self-documenting) |
| `CHANGELOG.md` historical `[0.x]` blocks                         | Various flat-path examples in past entries                                        | Historical narrative — not instructional going forward                                                            | ✅ correct                        |
| Test file `runCli(["plan", ...])` positional args                | Programmatic argv arrays                                                          | These are programmatic CLI invocations, not user-facing strings; the runCli helper bypasses the noun-group router | ✅ correct                        |

No flat-path string was incorrectly preserved that should have been
migrated. The omission is purely in test assertions (which should
have been updated to match the migrated source).
