# Reviewer: ACCEPT — qa (Quinn) — 108-A-07

## Verdict

Round-2 commit `84489fa7` cleanly resolves all 12 test failures and both HIGH drift-guard regressions from round 1. Mechanical assertion bumps (F-01..F-07) are flat→noun-grouped flips with no weakening. F-08 + F-09 regex extensions use non-capturing optional `(?:infra|admin|dev)\s+` prefix preserving existing capture-group indices (`m[1]` = leaf cmd, `m[3]` = flag for F-08; `m[1]` = leaf, `m[2]` = flag for F-09) — both drift-guards remain forward-compatible with the legacy flat surface AND now match the noun-grouped CLI. Allowlist key `destroy --all` works unchanged because `tripleKey()` builds from the LEAF capture, not the full triple. Test counts match worker's claim exactly. Soft gates all green. No new findings.

## Round-1 BLOCKER resolution table

| F#    | Status | Evidence                                                                                                                                                                        |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-01  | FIXED  | `apply-destroy-reconcile-json.test.ts:411`: `"Run \`assignee plan --wizard\`"`→`"Run \`assignee infra plan --wizard\`"`                                                         |
| F-02  | FIXED  | `describe.test.ts:464`: `"Run \`assignee list\`...\`assignee list --json\`"`→`"Run \`assignee admin list\`...\`assignee admin list --json\`"`                                   |
| F-03  | FIXED  | `list.test.ts:334`: `` `assignee list --help` `` → `` `assignee admin list --help` ``                                                                                           |
| F-04a | FIXED  | `checkpoint.test.ts:434`: `/Run \`assignee plan\`/`→`/Run \`assignee infra plan\`/`                                                                                             |
| F-04b | FIXED  | `checkpoint.test.ts:447`: `/Run \`assignee plan\`/`→`/Run \`assignee infra plan\`/`                                                                                             |
| F-05  | FIXED  | `plan-json-arg-errors.test.ts:44`: `/assignee plan "[^"]+"/` → `/assignee infra plan "[^"]+"/`                                                                                  |
| F-06  | FIXED  | `status.test.ts:499`: `` `assignee status --help` `` → `` `assignee admin status --help` ``                                                                                     |
| F-07a | FIXED  | `hint-registry.test.ts:30`: `'assignee plan'` → `'assignee infra plan'`                                                                                                         |
| F-07b | FIXED  | `hint-registry.test.ts:39`: `` `assignee plan` `` → `` `assignee infra plan` ``                                                                                                 |
| F-08  | FIXED  | `help-hints-flag-existence.test.ts:180`: tripleRegex extended with `(?:(?:infra\|admin\|dev)\s+)?` non-capturing prefix; capture-group indices unchanged (m[1]=leaf, m[3]=flag) |
| F-09  | FIXED  | `display-plan-box.test.ts:287`: pairRegex extended with same `(?:(?:infra\|admin\|dev)\s+)?` non-capturing prefix; cmd capture = leaf, preserving KNOWN_FLAGS lookup keys       |

## Drift-guard sanity (synthetic regression tests)

**F-08 (help-hints-flag-existence):**

- PASS `assignee infra plan --json` → cmd=plan flag=--json
- PASS `assignee plan --json` → cmd=plan flag=--json (legacy flat still matches — forward-compat)
- PASS `assignee admin doctor --verbose` → cmd=doctor flag=--verbose
- PASS `assignee dev init --shell zsh` → cmd=init flag=--shell
- PASS `some other phrase --json` → NO-MATCH (negative — guard still bites)

**F-09 (display-plan-box):**

- `assignee infra plan --json` → cmd=plan flag=--json ✓
- `assignee infra apply --skip-preflight` → cmd=apply flag=--skip-preflight ✓
- `assignee admin status` → NO-MATCH (expected — no `--flag`, pair regex requires both)
- `assignee plan --json` → cmd=plan flag=--json (legacy flat still matches)

Both regexes remain sharp on negatives. The "admin status" no-flag case is correct behaviour — the pair regex requires a flag.

## Allowlist correctness — VERIFIED

Worker claim: `KNOWN_WAVE_3B_DRIFTS = ['destroy --all']` works unchanged because `tripleKey()` builds from `m[1]` (leaf) + `m[3]` (flag), not the full `assignee <group> <leaf>` triple.

- `KNOWN_WAVE_3B_DRIFTS` at `help-hints-flag-existence.test.ts:219` is `"destroy --all"`.
- `tripleKey()` at line 222: `` `${t.command} ${t.flag}` `` — uses extracted cmd (m[1]) + flag (m[3]).
- Cited source `iam-role-inventory.ts:8`: `\`assignee infra destroy --all\``— regex extracts`command=destroy flag=--all`→ tripleKey =`"destroy --all"` → matches allowlist entry.
- Additional reference at `iam-role-inventory.ts:198`: `\`assignee infra destroy\`` — no flag, won't match tripleRegex, irrelevant to allowlist.

Allowlist requires no change. VERIFIED.

## Gate state (independently re-verified)

| Gate                                             | Result                                                                      |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `pnpm --filter assignee build`                   | green (shell completions generated)                                         |
| `pnpm lint`                                      | green (4/4 tasks, 1 cached)                                                 |
| `pnpm check-types`                               | green (6/6 tasks, FULL TURBO)                                               |
| `pnpm citation-lint`                             | 102 files / 353 citations / 0 broken                                        |
| `pnpm doc-lint`                                  | patterns=13 types=38 strategies=38 decomposers=38 commands=18 graphNodes=15 |
| Migration grep (docs/ + README.md, ex-\_archive) | 0 (no regression from round-1)                                              |

## Test counts

| Suite                               | Worker claim                         | Verified                                   |
| ----------------------------------- | ------------------------------------ | ------------------------------------------ |
| `pnpm --filter assignee test`       | 2022 passed / 0 failed / 148 skipped | **2022 passed / 0 failed / 148 skipped** ✓ |
| `pnpm --filter @assignee/core test` | 9874 passed / 0 failed               | **9874 passed / 0 failed** ✓               |

## New findings introduced by round 2

None.
