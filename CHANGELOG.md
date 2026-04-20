# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

## [Unreleased]

### Epic 84 — iteration 1 (2026-04-20)

#### Fixed

- `README.md:13-47` — **the 30-second hero had fabricated output**. User asked to verify, simulate real user actions, and update with real data.

**What was wrong (spot-check vs HEAD `00224af`)**:

1. The HTML comment at lines 15-17 claimed the transcript was "literal" and cited `renderPlanBox in apps/cli/src/utils/display-plan.ts`. Two bugs: (a) the code path is a 13-line re-export shim; canonical is `packages/core/src/utils/display-plan.ts` (294 lines); (b) the transcript was NOT literal — tags and provisioning tail were invented.
2. `Config:` block showed only `Bucket Name   hero-demo-bucket`. Real S3 plan box shows 4 fields: Bucket Name, Block Public Access, Encryption, Versioning — because the plan-generator auto-populates safe defaults.
3. `Estimated Cost: Free (live)` — **wrong**. Real cost for `AWS::S3::Bucket` at HEAD (verified via AWS Pricing MCP live): `$0.0230/GB-month`, plus per-unit rates for PUT/GET/data-transfer.
4. `Findings: All checks passed` — **wrong**. Real BP evaluator flags `5 high, 5 medium (4 fixable)` on a default S3 plan. The hero under-sold the BP engine's value.
5. `Apply now? (AWS::S3::Bucket, est. Free) ▸ Yes` — the message format is right, but `est. Free` is wrong (real prompt shows `est. $0.0230/GB-month`); the `▸ Yes` suffix is an inquirer answer-rendering artifact, fine to keep.
6. Provisioning tail (`✓ Creating AWS::S3::Bucket … done (2.1s) / ARN: arn:aws:s3:::… / Tags: assignee:managed-by=assignee, assignee:created=…`):
   - `Creating … done (2.1s)` output format returned zero matches in the codebase — invented.
   - Tag key format `assignee:managed-by` uses a colon namespace prefix; real keys at `packages/core/src/utils/tags.ts:22-24` are `managed-by` (plain), `assignee-run-id` (hyphen separator), `environment`. No `created` tag exists.

**What I did**:

- Ran `node apps/cli/dist/index.js plan --no-apply "Create an S3 bucket named hero-demo-bucket"` against the live system (AWS account `112233445566` via Bedrock us-east-1, pricing from AWS Pricing MCP). Run-id `fa465600af5a`. Captured both non-TTY `=== Plan ===` plain form and TTY-rendered boxen form via `script -q`.
- Replaced the hero body with the real captured output, abbreviated where needed with explicit `(... N more)` markers so readers know what's elided. No fabricated lines.
- Fixed the comment citation to point at the canonical `packages/core/src/utils/display-plan.ts` and documented the TTY-vs-non-TTY rendering difference.
- Dropped the invented Tags + provisioning tail. Added an honest footnote: tags get injected at apply time from `tags.ts`, listing the real three keys (`managed-by=assignee`, `assignee-run-id=<uuid>`, `environment=poc`). The asciinema-cast plan covering the apply phase still stands for v0.2.

**Process note (session carry-forward)**: same category of lie as Epic 82 — docs claiming to be "literal" or "canonical" when the underlying code has moved or the values are invented. The fix-everything-you-find + simulate-real-user-actions memories both applied here. Running the CLI end-to-end to capture real output is the only reliable way to keep a hero honest; the next asciinema-cast drop at `docs/_assets/hero.cast` should replace even this textual version.

### Epic 83 — iteration 1 (2026-04-20)

#### Fixed

Quinn (BMAD QA) completed the Epic 82 cross-cutting docs audit and returned 6 HIGH + 2 MED + 1 LOW findings. All 6 HIGH verified against HEAD `8864aab` before dispatch. Fixes:

- `docs/testing-guide.md:10,162`: static test counts (`~7595 tests across 303 files`, `168 CLI + 100 core + 11 BP + 24 MCP`) replaced with non-rotting prose that points at `pnpm -r test:coverage` for live numbers. Memory `project_e2e_progress.md` explicitly prohibits recording static test counts; these two lines contradicted that policy. Per-package breakdown in the second line was ~40% below the actual 341/78/33/219/11 split.
- `docs/index.md:82`: same class of drift — Key-metrics "Test files" row dropped the hardcoded `341 / 78 / 33 / 219 / 11` numbers and now says "across 4 packages (cli + mcp-server + core + best-practices) — run `pnpm -r test:coverage` for live counts".
- `apps/mcp-server/e2e-test.mjs:22-35`: **safety gate added**. Docs (testing-guide.md + invariants.md) claimed the script was gated behind `RUN_E2E_MCP=1` but the script had no such check — running `node apps/mcp-server/e2e-test.mjs` would have provisioned real AWS resources unconditionally. Added an explicit early-return that refuses to run unless `RUN_E2E_MCP=1` is set, with exit code 2 and a usage message. Docs↔code now agree.
- `apps/mcp-server/e2e-test.mjs:5-7`: header comment said "Tests ALL 23 resource types + 2 compound patterns"; the `RESOURCE_TYPES` array has **22** entries and live registry has **37** supported types. Updated to "Tests a representative subset — 22 of the 37 first-class resource types plus 2 compound patterns" so the claim matches what the script actually exercises.
- `.husky/pre-push`: **4 enforcement gates added**. `docs/explanation/invariants.md:603-604` claimed `pnpm lint:barrels`, `pnpm lint:shims`, `pnpm doc-lint`, and `pnpm citation-lint` were "wired into the pre-push hook"; `CHANGELOG.md` Epic 58 entries made the same claim about `citation-lint` being "the hard gate". Live hook only ran `lint / check-types / test` — the gates were manual-only. Added all four between `check-types` and `test` so the enforced sequence now matches the invariant claim. Total added runtime <1s (all four are fast grep/node scripts).

#### Method

Same pattern as Epic 82 — every HIGH spot-checked against HEAD before dispatch (`.husky/pre-push` contents, `grep -n RUN_E2E_MCP` over the script, `RESOURCE_TYPES` array size, testing-guide line numbers). 3 parallel one-shot fix subagents with exclusive file ownership. Policy choice on HIGH-4/5: fix the code (add the gates) rather than weaken the claim (admit manual-only), per `feedback_never_weaken_tests` — the same principle extended to doc-claim↔code-enforcement mismatches.

The docs-audit team was shut down gracefully after Quinn's report — 4-member BMAD audit complete; all 4 experts' reports integrated across Epic 82 (Mary + Paige + Winston) and Epic 83 (Quinn).

### Epic 82 — iteration 1 (2026-04-20)

#### Fixed

4-expert BMAD-team docs audit (persistent team via `TeamCreate` on opus-4-7[1m]) found 14 verified drifts across 8 docs beyond Epic 73-75's scope. Every HIGH/CRITICAL spot-checked against HEAD `94be206` before fix-dispatch — zero reviewer hallucinations this round.

**Mary (analyst)**

- `docs/explanation/contributing-a-bp-rule.md:33-38,42,45,64,106,154`: worked-example mis-routed contributors. Prose said `BP-EFS-001` through `BP-EFS-009` exist and told contributors to pick `BP-EFS-010`; live `ls packages/best-practices/efs/` returns only `001`–`003`. Corrected to claim `001`–`003` and new ID `BP-EFS-004`; replaced `BP-EFS-010` → `BP-EFS-004` at 6 sites.
- `docs/explanation/contributing-a-bp-rule.md:58`: sample YAML `lastVerified: "2026-04-16"` (4 days stale) → placeholder `"<YYYY-MM-DD>"` so copy-paste contributors must fill in.

**Paige (tech-writer)**

- `docs/quickstart.md:95`: "MAX_POLL_ITERATIONS=450 safety guard; extended 15-min timeout" — the guard was removed in the H10 fix (`status-poller.ts:34` notes it, `status-poller.test.ts:255` pins the removal), and live `EXTENDED_POLL_TIMEOUT_MS = 20 * 60 * 1000` (20 min, not 15). Fixed.
- `docs/configuration.md:326-338` Internal Constants table: dropped removed `MAX_POLL_ITERATIONS` row; corrected `EXTENDED_POLL_TIMEOUT_MS` value `900000/15 min` → `1200000/20 min`; dropped `POLL_INTERVAL_MS` (it's module-local in `status-poller.ts`, not a global).
- `docs/commands.md:297,300`: baseline path `.assignee/baselines/…` → `~/.assignee/baselines/…` (`baseline-adopt.ts:7` JSDoc is the source of truth).
- `docs/commands.md:602-604`: doctor example MCP pin versions were stale (pricing `1.0.6` → `1.0.27`, documentation `1.1.1` → `1.1.20`, iam `1.0.2` → `1.0.17`; WA-security and billing already correct).

**Winston (architect)**

- `docs/explanation/invariants.md:582-584`: "No circular imports" invariant cited three paths under `packages/core/src/config/barrels/config/` — that path does not exist at HEAD; canonical is `packages/core/src/barrels/config/`. Stripped the duplicate `/config/` segment in all three bullets.
- `docs/architecture.md:167`: Services table row cited `apps/cli/src/services/checkpoint.ts` which does not exist (only the `.test.ts` does). Restructured into three rows pointing at the real checkpoint split — `commands/apply/checkpoint-state.ts`, `commands/plan/checkpoint-writer.ts`, `packages/core/src/schema/checkpoint.ts`.
- `docs/architecture.md:185`: Services table cited `apps/cli/src/services/desired-state-sanitizer.ts` which moved to `packages/core/src/services/desired-state-sanitizer.ts` in Wave-5 Pass H. Path corrected.
- `docs/explanation/run-ledger-design.md:17`: canonical cite for `NO_TAG_TYPES` + tag injector was pointing at the shim `apps/cli/src/utils/tags.ts`; canonical is `packages/core/src/utils/tags.ts:60`. Fixed with shim parenthetical.
- `docs/explanation/run-ledger-design.md:24`: same shim-vs-canonical swap for memory-recorder.
- `docs/explanation/invariants.md:34-36`: deleted the stale "former location" sentence about `apps/cli/src/utils/error-messages.ts` — that file has no ARN pattern today; `ARN_PATTERN` lives in `packages/core/src/utils/redact.ts` (correctly cited elsewhere in the same invariant).
- `docs/integration-architecture.md:73`: internal contradiction — line 20 said `13 cmds`, line 73 said `17 Commander.js commands`. Ground truth is 13 (`grep -nE "program.addCommand\(" apps/cli/src/index.ts` shows 13 real calls; one additional line is a comment). Corrected to 13.

#### Review discipline

Spot-checked every HIGH/CRITICAL against HEAD before dispatch: EFS dir contents, status-poller constants, baseline-adopt JSDoc, barrel path existence, checkpoint/desired-state-sanitizer file locations, integration-architecture both sides of the 13-vs-17 contradiction. Zero findings fabricated this round. Quinn (QA) still running — additional test/coverage-focused findings land in Wave 2 as Epic 83 if she reports.

### Epic 81 — iteration 2 (2026-04-20)

#### Added

- `README.md`: expand the coverage-only badge from iteration 1 into a seven-badge header row visible under the H1. New row: **CI** (push/PR workflow status), **Cross-platform** (weekly+manual matrix workflow status), **Coverage** (existing gist endpoint), **License: MIT** (LICENSE file is MIT), **Node ≥20.11** (matches `package.json` `engines.node`), **TypeScript strict** (links to `packages/typescript-config/strict.json`), **pnpm workspaces** (links to `pnpm-workspace.yaml`). Private-repo policy check: `gh repo view` confirms `visibility: PRIVATE`, so the badge row is visible only to collaborators — matches `feedback_no_public_artifacts` (no public npm/registry URLs until approved) while still giving the team full at-a-glance signal. Node-version badge set to `>=20.11` not `>=22` to match the actual `engines` field; TypeScript link corrected from non-existent `tsconfig.base.json` → `packages/typescript-config/strict.json`.

### Epic 81 — iteration 1 (2026-04-20)

#### Fixed

- `README.md`: restore coverage badge removed in commit `0fe96cd` (refactor). The gist automation at `ci-core.yml` has been updating `gist.githubusercontent.com/SergSlon/f9d960dd5a1defd7b8fbd4656df40915/raw/assignee-ai-coverage.json` on every green main push since it was wired up (verified via badge-step log "Content did not change, not updating gist" — idempotent, the 88.6% value has been steady); README just stopped rendering it. Badge lives directly under the H1.
- `README.md`: reworded the "public artifacts intentionally omitted" paragraph to reflect the actual policy — npm registry links and release badges are omitted until first release, but the coverage badge above is kept for internal visibility since it is served from a **secret** gist (`public: false`) that only repo members can discover via URL.
- `.github/workflows/ci-core.yml`: `schneegans/dynamic-badges-action@v1.7.0` → `@v1.8.0`. Also on the Node.js 20 deprecation list (surfaced in the Epic 80 xplat verify log); missed in Epic 77's first-party-actions bump sweep because I filtered on `actions/*` prefix and left the third-party action at `@v1.7.0`.

Also captures the session milestone: Epic 80 xplat verify `24671447401` on `e4e6077` is the **first green cross-platform run since the workflow was authored** — matrix prepare + ubuntu + macos + **windows** all successful. 8-epic domino chain (76-it2 type-mismatch → 78 BP hash → 79 POSIX assumptions → 80 config/HOME) fully closed.

### Epic 80 — iteration 1 (2026-04-20)

#### Fixed

Six more Windows-only test failures surfaced by Epic 79 — all POSIX-assumption bugs in test fixtures/mocks. Domino pattern continues: each Windows-compat layer reveals the next.

- `packages/core/src/config/user-config-loader.test.ts:27,32`: assertions used hardcoded forward-slash paths (`"/custom/config/dir/config.yaml"`, `".config/assignee/config.yaml"`). Production code uses `path.join` → OS-native separators. Both sides now use `path.join` so the assertion matches Windows backslashes and POSIX forward slashes alike.
- `packages/core/src/config/org-policy-loader.test.ts`: 3 test mocks did `.includes(".assignee/org-policy.yaml")` / `.includes(".config/assignee/org-policy.yaml")` on the raw `filePath` string; on Windows the actual `path.join`-produced string has backslashes, the substring check fails, the mock throws ENOENT, and the test expects content it never gets. Normalize `String(filePath).replace(/\\/g, "/")` before the check.
- `packages/core/src/services/price-cache.test.ts:143`: `beforeEach` sets `process.env.HOME = tempDir` to redirect `os.homedir()`. On Windows `os.homedir()` prefers `USERPROFILE`, not `HOME`, so the cache lands at the real home, the test reads the empty temp dir, and `readdirSync` returns `[]`. Set both `HOME` (POSIX) and `USERPROFILE` (Windows) in `beforeEach`; restore both in `afterEach`.

These are Epic 79's logical continuation — same "once Windows finally runs, years of silent POSIX assumptions surface." After this iteration, Windows failure count should drop to 0 (or expose yet another layer — the pattern has been proving stable at each step).

### Epic 79 — iteration 1 (2026-04-20)

#### Fixed

Three Windows-only test failures surfaced once Epic 78's `.gitattributes` closed the BP manifest hash mismatch and unblocked the rest of the Windows test run. All three were pre-existing assertions that assumed POSIX semantics:

- `packages/core/src/utils/recorder/recorder.test.ts:71`: `mkdtempSync(path.join("/tmp", …))` → `mkdtempSync(path.join(os.tmpdir(), …))`. Hardcoded `/tmp` threw `ENOENT` on Windows (no such directory) and broke 20 tests in the suite. Every other test in the repo already uses `os.tmpdir()`; this one file was an outlier.
- `apps/mcp-server/src/__tests__/mcp-cli-graph-parity.test.ts:137`: assertion `expect(path).toMatch(/services\/graph-init\.ts$/)` normalizes backslashes to forward slashes before matching. `path.join` / `path.resolve` emit OS-native separators (Windows → `\\`); the regex is POSIX-style because the claim being tested is about logical module path, not disk-byte representation.
- `apps/cli/src/services/checkpoint.test.ts:628`: POSIX permission-bit test guarded with `it.skipIf(process.platform === "win32")`. NTFS doesn't support POSIX mode bits; `chmod(0o600)` is a no-op on Windows and `stat.mode & 0o777` always returns `0o666` (438 decimal, not 384). The security guarantee on Windows is carried by NTFS ACLs (which Node.js `fs.chmod` cannot set), so the POSIX mode assertion is wrong to run there. Code under test is unchanged; `saveCheckpoint` still calls `chmod(0o600)` for POSIX callers. Comment block explains the skip so the gap is discoverable.

Together with Epic 78's `.gitattributes`, this closes the full Windows xplat job — the failures were only visible because Epic 76-it2 finally let the matrix dispatch. First-time cross-platform truth-in-testing: every OS cell should now be green.

### Epic 78 — iteration 1 (2026-04-20)

#### Fixed

- Add `.gitattributes` at repo root. Git on Windows defaults to `core.autocrlf=true`, which rewrites LF → CRLF on checkout. The BP manifest integrity hash in `packages/best-practices/src/integrity.ts` reads YAML bytes raw and feeds them into SHA-256, so checkout-time line-ending rewriting produces a different hash than the on-disk manifest — `__tests__/manifest-freshness.test.ts` fails with `expected '636a1827…' to be 'f89aeb47…'` on Windows only. Surfaced by the Epic 76-it2 xplat verify run (24668814167, 2026-04-20) — the first time the matrix actually dispatched since the workflow was written. Without the matrix dispatching, the Windows bug hid for months. `.gitattributes` now forces LF for every hash-sensitive / determinism-critical file type (YAML, JSON, TS/JS, MD, shell scripts, husky hooks) and pins binary file types so Git doesn't touch them. `git add --renormalize .` is a no-op on this dev machine (macOS default is LF); Windows CI runners get clean LF checkouts from this commit forward.

### Epic 77 — iteration 1 (2026-04-20)

#### Fixed

- Bump every GitHub Actions pin across all workflow files (active + disabled) off the Node.js-20 runtime that GitHub will remove on 2026-09-16 (warned in the `ci (ubuntu-latest / node 22)` log during the Epic 75 push watch). New pins:
  - `actions/checkout@v4` → `@v6` (5 call-sites across `ci-core.yml`, `mock-fixture-drift.yml`, `nightly-e2e.yml`, `release.yml.disabled`, `test-actions.yml.disabled`)
  - `actions/setup-node@v4` → `@v6` (same 5 call-sites)
  - `actions/upload-artifact@v4` → `@v7` (4 call-sites — `ci-core.yml`, `mock-fixture-drift.yml`, `nightly-e2e.yml`, `release.yml.disabled`)
  - `actions/download-artifact@v4` → `@v8` (1 call-site in `release.yml.disabled`)
  - `pnpm/action-setup@v4` → `@v5` (5 call-sites)
  - `aws-actions/configure-aws-credentials@v4` → `@v6` (1 call-site in `mock-fixture-drift.yml`)
  - `softprops/action-gh-release@v2` → `@v3` (1 call-site in `release.yml.disabled`)
  - `schneegans/dynamic-badges-action@v1.7.0` unchanged (not on the Node-20 runtime deprecation list).
- Disabled workflows (`release.yml.disabled`, `test-actions.yml.disabled`) are bumped in the same commit so that whoever re-enables them doesn't inherit silently-broken pins.
- Epic 76-it1 + it2 already ran the manual `gh workflow run ci-cross-platform.yml` verify dance; Epic 77 will re-use the same pattern to confirm the upgraded pins run cleanly across the full ubuntu/macos/windows matrix.

### Epic 76 — iteration 2 (2026-04-20)

#### Fixed

- `.github/workflows/ci-core.yml`: `node` input type `number` → `string` (+ inline comment explaining the caller contract). The real reason the weekly cross-platform matrix never dispatched: `ci-cross-platform.yml`'s `prepare` job emits `fromJson`-parsed strings (`["22"]`), so passing `matrix.node = "22"` to a reusable workflow declaring `type: number` silently fails type validation and no downstream job spawns. `ci.yml` passes `node: 22` as an unquoted literal which GitHub auto-coerces to the new string type, so no change is required at that caller. Verified by a manual workflow_dispatch immediately after push (Epic 76-it1's fix was incidental polish; it-2 closes the actual bug).
- `.github/workflows/ci-cross-platform.yml`: update the comment to attribute the failure correctly and point to Epic 76-it2.

### Epic 76 — iteration 1 (2026-04-20)

#### Fixed

- `.github/workflows/ci-cross-platform.yml`: the `prepare` job emitted the node-version matrix with leading whitespace (`awk 'NF {print "  " $1}'` → `["  22"]`). Passing `"  22"` to `actions/setup-node` in the downstream `matrix` reusable-workflow call broke dispatch: every scheduled weekly run (cron Mondays 07:00 UTC) ended with only the `prepare` job green and the overall run marked `failure` without any matrix job even starting. Surfaced by `gh run list` on 2026-04-20 (run 24657895247 on `fcfd4f8`). Replaced with `awk '{gsub(/[[:space:]]/,""); if (length($0)) print $0}'` so scheduled and dispatch runs alike emit `["22"]` / `["20","22","24"]` without padding. Sanity-tested both paths locally.

### Epic 75 — iteration 1 (2026-04-20)

#### Fixed

- `docs/resource-types.md`: add row 37 to the Resource Type Table for `AWS::RDS::DBSubnetGroup` (plugin `rds-db-subnet-group`). Intro already claims "37 AWS resource types"; table had only 36 rows since the type was added to `SUPPORTED_TYPES_ARRAY` on 2026-04-13. Closes Zone C re-sweep CRITICAL.
- `docs/commands.md:535` and `docs/aws-bootstrap.md:35,126`: path citations `packages/core/src/config/iam-policies.ts` → `packages/core/src/config/iam-policies/` (directory with per-role generators `operator.ts` / `reader.ts` / `auditor.ts` behind an `index.ts` barrel). The `.ts` file was split into a directory; three doc call-sites carried the old path. Closes Zone D re-sweep MED (flagged as out-of-Zone-D scope but actionable).
- `packages/core/src/constants/env-vars.ts`: add `ASSIGNEE_ENABLE_REMOTE_MCP` to the `EnvVar` registry under "Remote MCP opt-in". Closes Zone B re-sweep CRITICAL — the var was declared as a raw string literal at `config/mcp-servers.ts:58` and referenced by raw string in tests, violating the zero-magic-strings policy (Story 42.10). `mcp-servers.ts:58` now uses `EnvVar.ASSIGNEE_ENABLE_REMOTE_MCP` via the registry.

#### Review discipline

- epic-75-it1 re-sweep ran the same 5 zones (ZA/ZB/ZC/ZD/ZE). Zones A + E: zero findings (steady-state across Epic 73/74 fixes confirmed holding). Zone D: zero in owned files — surfaced the iam-policies path drift as an out-of-scope note. Zones B + C: one CRITICAL each, both verified at spot-check. Cumulative reviewer-agent hallucinations caught across Epic 57+: ~11 (unchanged this round — reviewers correctly flagged 3 real issues and the coordinator verified all three against HEAD before accepting). Pattern: the re-sweep surface is narrower than the initial sweep (deep-read mandate catches what tight lanes skipped; second pass catches what first pass missed plus anything added between commits).

### Epic 74 — iteration 1 (2026-04-20)

#### Fixed

- `docs/configuration.md`, `docs/troubleshooting.md`: replace references to the removed `assignee whoami` command with `assignee doctor --short` (Story 50-3 replacement). Four call-sites updated (configuration.md:22,26; troubleshooting.md:86,312).
- `docs/configuration.md`: drop `preferences.output_format` and `preferences.verbosity` from the live-keys sentence at line 22 and the "Verifying the resolution" example at line 26 — Story 50-7 removed both fields from `ConfigPreferences`; prose now matches the existing caveat at line 132.
- `docs/configuration.md`, `docs/commands.md`: remove `assignee clean`/`assignee clean --baselines --confirm` call-sites. The `clean` command does not exist at HEAD; log pruning is driven by `autoPruneLogsIfDue` in `apps/cli/src/services/cleanup/orchestrator.ts` (1-hour throttle via `.last-prune` marker), and adopted baselines are dropped by deleting the JSON file under `.assignee/baselines/`.
- `docs/configuration.md`: add a "planned — not yet implemented" note to the `llm` Section. Per-node LLM routing is ENV-var-only today (`ASSIGNEE_LLM_*`); the `.assignee/config.yaml` `llm:` block is not wired into the config schema. Precedence paragraph reworded to reflect env-var-only reality.
- `docs/index.md`: Key metrics row 82 test-file count `307 (72/24/200/11)` → `341 (78/33/219/11)`; counts drifted by 34 files since the row was last refreshed. Numbers match vitest `Test Files` output across all four packages (authoritative over `find` because vitest picks up `.spec.ts` + `.test.ts`).
- `docs/architecture.md:128,131`: Pricing strategy and decomposer counts updated from `23` each to `37` each (matches `pnpm doc-lint`: `patterns=10 types=37 strategies=37 decomposers=37`). Same underlying drift as Epic 73's `docs/index.md:77-78` fix.

#### Review discipline

- epic-74-it1 deep docs sweep ran 5 zone reviewers (ZA root+index, ZB tutorials/how-to, ZC reference, ZD architecture, ZE explanation) in parallel with exclusive file ownership. Coordinator spot-check rejected 4 reviewer claims as hallucinations before accepting any finding: Zone A's README "14 commands" ambiguity (actual 13), Zone B's "archive path does not exist" (archive has 313 files), Zone C's "37→38 types drift" (live registry is 37; doc is correct), Zone D's "185→190 BP rules" (manifest has 185; doc is correct), and Zone E's "BP-S3-001.yaml orphan" (file is a test fixture under `__tests__/fixtures/valid/`, intentionally excluded from manifest). Cumulative reviewer-agent hallucinations caught across Epic 57+: ~11.

### Epic 73 — iteration 1 (2026-04-20)

#### Fixed

- `docs/index.md`: Pricing strategies and decomposers rows in the Key metrics table listed `23` each; live registries have `37` each (confirmed by `pnpm doc-lint`). Updated both rows to `37` and rolled the "as of" date to 2026-04-20 (closes L8 HIGH from epic-73-it1 review — stale metric drift surfaced by on-demand 7-lane review after 17 no-delta iterations).

### Epic 67 — iteration 1 (2026-04-20)

#### Fixed

- `.husky/pre-push`: run `pnpm lint` before `pnpm check-types` + `pnpm test` so ESLint --max-warnings 0 (which CI also enforces) catches unused-import / warning-level regressions locally before push (closes the gap that let Epic 65's CI Lint fail).

### Epic 66 — iteration 1 (2026-04-19)

#### Fixed

- `apps/cli/src/__tests__/version.test.ts`: drop unused `loadMcpPinsOrFallback` static import that leaked from Epic 65-it1-01 (the test exercises it via dynamic `await import()` inside a `vi.resetModules()` block). Closes CI Lint regression on run 24637134402.

### Epic 65 — iteration 1 (2026-04-19)

#### Fixed

- `apps/cli/src/commands/version.ts`: defensive try/catch around MCP_PINS dynamic import; warn + empty-fallback on failure (closes L3-001 MED).
- `packages/core/src/config/help-hints.ts`: empty-array guard in `renderClarifierExampleList()` so output never becomes `, etc.` (closes L3-L1 LOW).
- `apps/cli/src/services/clarifier.ts`: `.trim()` safety hoist (L3-L2 LOW).

#### Tests

- 2 new unit tests covering version.ts MCP_PINS failure + help-hints empty-array guard.

### Epic 63 — iteration 1 (2026-04-19)

#### Docs

- CHANGELOG: Epic 62-it1 subsection backfill (3c3300a)

### Epic 64 — iteration 1 (2026-04-19)

#### Docs

- CHANGELOG: Epic 63 + Epic 64 self-entries (this commit) — breaks recurring 1-iteration lag pattern.
- `docs/explanation/invariants.md`: new "CHANGELOG self-entry on epic close" invariant block.
- Memory: `feedback_changelog_self_entry.md` codifies process change.

### Epic 62 — iteration 1 (2026-04-19)

#### Docs

- **CHANGELOG Unreleased gained Epic 60-it1 + Epic 61-it1
  subsections citing `0445450`, `014ea96`, `6af6b2b`, and
  `c45706b`.** Closes the changelog-lag finding for Epic 60 and
  Epic 61 so future readers can trace the free-tier extraction,
  exports-collapse continuation, and version/signal observability
  fixes without git archaeology. (commit `f1bc3ab`)
- **`packages/core/src/config/help-hints.ts` and
  `apps/cli/src/services/clarifier.ts` gained reciprocal `@see`
  JSDoc cross-refs between `renderClarifierExampleList` /
  `BEGINNER_EXAMPLE_TYPES` and the clarifier consumer.** Renames on
  either side now surface the matching call-site so the curated
  beginner-example list stays discoverable. (commit `970622d`)

#### Tests

- **New token-based drift guard in
  `packages/core/src/config/__tests__/help-hints.test.ts` derives
  the canonical service token from each curated
  `BEGINNER_EXAMPLE_TYPES` label and asserts at least one
  `SUPPORTED_TYPES_ARRAY` entry contains it.** Map-free
  complement to the existing curator-maintained `labelToCfn`
  guard — catches registry renames even when the test's hand-
  written map is stale. (commit `970622d`)

### Epic 61 — iteration 1 (2026-04-19)

#### Fixed

- **`apps/cli/src/commands/version.ts` emits `console.warn` before
  the `"0.0.0"` fallback on `package.json` parse failure.** Operators
  now see explicit visibility into corrupted-install conditions
  rather than a silent zero-version masquerade. (commit `c45706b`)
- **`apps/cli/src/index.ts` signal handler emits `console.error`
  before the re-entrant `SIGINT` hard-exit.** Adds debuggability for
  orphaned processes that previously vanished without trace on the
  second Ctrl-C. (commit `c45706b`)

#### Tests

- **2 new unit tests covering the warn-then-fallback and
  error-before-hard-exit paths.** `version.ts` now exports
  `readPackageVersion` so the parse-failure branch is directly
  testable without filesystem stubs at the command boundary.
  (commit `c45706b`)

### Epic 60 — iteration 1 (2026-04-19)

#### Refactored

- **`packages/core/src/utils/free-tier.ts` 299 → 150 LOC via
  pure-data extraction to `free-tier/maps.ts` (130 LOC, NEW).** The
  free-tier coverage tables move into a side-effect-free data
  module; the remaining IO wrapper is a thin shape adapter over the
  pure helper. (commit `0445450`)
- **`packages/core/package.json` exports 14 → 6 — apps shims
  rewired to consume from the broader `@assignee/core` +
  `@assignee/core/graph` barrels.** Continues the Epic 59-it1
  surface-shrink trajectory; deep sub-paths collapse into two
  load-bearing barrels. (commit `014ea96`)

#### Added

- **`analyzeResource` + cost-optimizer types + 15 wizard helpers +
  `MCP_PINS` + instance-family registry + `resolveFieldConfigs`
  promoted to the root barrel.** Replaces the deep sub-path
  consumers retired by the exports-collapse above; apps now import
  the full surface from `@assignee/core`. (commit `014ea96`)

#### Docs

- **CHANGELOG Unreleased gained the Epic 59-it1 subsection citing
  `eac3529` + `4fc81c5`.** Closes the changelog-lag finding for
  Epic 59 so future readers can trace the `@/*` migration and
  exports-collapse without git archaeology. (commit `6af6b2b`)

### Epic 59 — iteration 1 (2026-04-19)

#### Refactored

- \*\*`packages/core/package.json` exports 28 → 14 (closes L4-005 MED
  - L4-L2 LOW).\*\* Deleted 15 zero-consumer sub-path entries
    (`./testing`, `./aws`, `./utils/display`, `./utils/logger`,
    `./services/memory`, `./services/s3-upload`,
    `./utils/memory-recorder`, `./utils/security-posture`,
    `./resource-plugins`, `./utils/resolve-arn`, `./utils/free-tier`,
    `./services/price-cache`, `./config/user-config-loader`,
    `./config/project-config-loader`, `./config/org-policy-cache`);
    each verified via cross-workspace grep before removal. The 13
    remaining sub-paths are load-bearing apps shims; further collapse
    to ≤10 is deferred to a follow-up that lifts the apps-no-touch
    constraint. (commit `eac3529`)
- **~336 deep relative imports → `@/*` tsconfig path aliases
  across `packages/core` + `packages/best-practices` (closes L4-L2
  LOW).** 133 files rewired; `baseUrl: "."` + `paths: {"@/*":
["src/*"]}` added to both tsconfigs. Zero 3+-level relatives
  remain in either package. (commit `eac3529`)

#### Added

- **`tsc-alias` runtime wiring for `packages/core` build.** `tsc`
  does not rewrite path aliases in emitted JS; apps crashed with
  `ERR_MODULE_NOT_FOUND '@/config'` on first build. Build script
  now runs `tsc && tsc-alias` so the `@/*` alias resolves at
  runtime across the monorepo. (commit `eac3529`)
- **`vite-tsconfig-paths` vitest plugin wired in
  `packages/core/vitest.config.ts`.** Without it, vitest emits
  `ERR_MODULE_NOT_FOUND` for `@/…` imports under test. Installed
  as devDep in `@assignee/core` only (best-practices has no `@/`
  imports yet). (commit `eac3529`)

#### Docs

- **CHANGELOG Unreleased section gained Epic 57-it1 + Epic 58-it1
  subsections (closes HIGH CHANGELOG-lag finding).** Back-fills
  the iteration history for the two previous epics that shipped
  without changelog entries. (commit `4fc81c5`)
- **`docs/explanation/invariants.md` gained 2 invariant blocks.**
  "No circular imports across `barrels/config` sub-barrels"
  documents the Epic 56-it2 split enforced by `pnpm lint:barrels`;
  "Path-alias resolution requires tsc-alias post-build" records
  the runtime-rewrite invariant introduced by the Epic 59-it1
  `@/*` migration. (commit `4fc81c5`)

### Epic 58 — iteration 1 (2026-04-19)

#### Refactored

- **`phase1-gate.ts` 315 → 78 LOC via 6 sub-modules (closes L7-L1
  LOW + L4-006 MED).** Story-by-story decomposition: `invocation-
builder.ts` assembles the resumable-gate `continue` payload,
  `failure-class.ts` classifies gate outcomes, `bp-blocked.ts`
  handles BP-rule denials, `post-check.ts` runs the after-apply
  verification, `log-helpers.ts` centralises structured logging,
  and `types.ts` pins the shared shape. Outer gate becomes a
  10-line dispatch over the new helpers. (commit `adfb33b`,
  follow-up `ae65636`)
- **`free-tier.ts` pure `getFreeTierMaps()` extraction (closes
  L4-004 MED).** The 67-LOC MCP duplicate collapses to a 25-LOC
  shape-adapter over the pure helper — MCP + CLI now share one
  source of truth for free-tier coverage data, with an IO wrapper
  `getFreeTierNoteWithConfig()` in core for caller convenience.
  (commit `e690fe0`)
- **Plugin registry OCP compliance (closes L4-L1 LOW).** Dropped
  37 re-exports from `resource-plugins/index.ts`; new plugins now
  register via the canonical registry API rather than the
  barrel's implicit re-export surface, restoring
  open-for-extension / closed-for-modification. (commit
  `aefd39a`)
- **`iam-actions.ts` shim + test relocated to core (closes L4-L5
  LOW).** Stale CLI shim inlined into its single consumer; the
  accompanying test moved to `packages/core/src/**/__tests__/`.
  (commit `aefd39a`)

#### Added

- **`apps/cli/src/commands/version.ts` + `program.addCommand()`
  wiring (closes L3-L1 LOW).** Refactor pulls `version` out of
  the `program.command("version")` inline block into a dedicated
  command module exporting `versionCommand`, registered via
  `program.addCommand()` so the shell-completion generator
  discovers it. `assignee completions bash|zsh|fish` now emit
  `version` alongside the other 12 commands without a manual
  allow-list entry. (commit `fd6697a`)
- **`pnpm lint:barrels` circ-check gate (closes L4-L4 LOW).**
  New `apps/cli/scripts/check-config-barrel-circular.mjs` grep-
  based gate fails CI if `barrels/config/constants.ts`,
  `barrels/config/resources.ts`, or `barrels/config/help-
hints.ts` import from one another. Keeps the Epic 56-it2
  `barrels/config` split structurally enforced. (commit
  `aefd39a`)

#### Architecture

- **4 CLI tests relocated to
  `packages/core/src/graph/nodes/__tests__/` (closes L4-006 MED
  remainder).** Tests that exercised core graph-node behaviour
  but lived in `apps/cli/src/**` moved to the canonical core
  location; `./graph/nodes/*` wildcard export deleted from
  `packages/core/package.json` in the same commit so the public
  surface no longer leaks internal module paths. (commit
  `899bc7a`)

#### Tooling

- **New `pnpm lint:barrels` script wired in root
  `package.json`.** Invoked from the pre-push hook alongside
  `pnpm lint:shims` and `pnpm doc-lint`. (commit `aefd39a`)

### Epic 57 — iteration 1 (2026-04-19)

#### Docs

- **`CHANGELOG.md` Epic 55 + Epic 56 entries (closes L8-H1
  HIGH).** Added the missing `### Epic 55 — iteration 1
(2026-04-19)` and `### Epic 56 — iteration 1 / iteration 2`
  subsections so the Unreleased block accurately reflects the
  last three iterations' work. Entries follow the established
  Refactored / Added / Security / Docs / Tooling structure with
  commit-SHA citations on every bullet. (commit `2ab7931`,
  prettier follow-up `bf8fba8`)
- **`CHANGELOG.md` `[0.1.0]` placeholder polish (closes L8-L1
  LOW).** Trailing `<!-- date filled at v0.2 publish -->` inline
  comment cleaned up ahead of the first public `v0.2` cut.
  (commit `2ab7931`)
- **`README.md` read-a-plan-box numbering fix (closes L8-L2
  LOW).** Cosmetic list-numbering drift in the "How to read an
  assignee plan" box corrected so every step increments. (commit
  `2ab7931`)
- **`README.md` `Advanced overrides` env-var section (closes
  L8-002 MED + L8-L3/L4 LOW).** New subsection documents
  `ASSIGNEE_NO_CLARIFIER` (disable clarifying-question turn for
  non-interactive flows), `ASSIGNEE_MCP_MAX_ACTIVE_APPLIES`
  (raise 100 active-applies cap for hosted MCP), and the
  `HEADLINE_SHORTHANDS` silent no-op warning. Aligns user-visible
  documentation with the Epic 56-it2 env-override surface.
  (commit `ceef3fb`)

### Epic 56 — iteration 2 (2026-04-19)

#### Refactored

- **`apps/cli/src/aws-resource-discovery/` sub-path deleted (closes
  L4-005a MED).** Five legacy CLI discovery shims removed in favour of
  the canonical `@assignee/core/aws-resource-discovery` barrel. No
  runtime impact — call-sites already imported from core. (commit
  `1b4321c`)
- **`packages/core/src/config/barrels/config.ts` split (closes L4-008
  MED).** 361-LOC aggregate barrel replaced with a thin re-exporter
  plus three sub-barrels (each ≤ 200 LOC). Public surface of
  `@assignee/core/config` preserved — every `import {x} from
"@assignee/core/config"` continues to resolve to the same symbol.
  (commit `1b4321c`)
- **`resource-provisioner.ts` 326 → 172 LOC (closes L7-003 MED).**
  Three in-file helpers extracted into `resource-provisioner/`
  sub-directory: `companion-skip.ts` (skip-if-companion predicate),
  `redirect-guard.ts` (unsupported-redirect classifier), and
  `create-error-handler.ts`. 17 new unit tests. (commit `77ff64e`)
- **`option-elicitor/orchestrator.ts` body 188 → 119 LOC (closes
  L7-001 MED).** `runWizardPasses` helper extracted into a dedicated
  module (117 LOC) with 5 focused tests. (commit `5d66293`)
- **`option-elicitor/prompt-loop.ts` while-body 172 → 76 LOC (closes
  L7-002 MED).** Split into three sub-modules —
  `review-handler.ts`, `back-handler.ts`, `field-gates.ts` — so the
  outer loop is a policy dispatcher. 46 new tests across 4 files.
  (commit `7682dc4`)

#### Added

- **`ASSIGNEE_MCP_MAX_ACTIVE_APPLIES` and `ASSIGNEE_NO_CLARIFIER` env
  overrides (closes L3-L1 LOW).** Operators can now raise the 100
  active-applies cap in hosted MCP deployments and disable the
  clarifying-question turn for fully non-interactive CLI flows.
  (commit `e3bc140`)
- **`version` subcommand now appears in generated shell completions
  (closes L3-L2 LOW).** `assignee completions bash|zsh|fish` emit
  `version` alongside the other 12 commands. (commit `e3bc140`)
- **`renderClarifierExampleList` SSO helper (closes L3-L3 LOW).**
  Intent-parser clarifier examples now render through a single
  source of truth, matching the `renderSupportedTypesHint` /
  `renderPatternsHint` pattern introduced in Epic 54. (commit
  `e3bc140`)
- **`pnpm lint:shims` guardrail (closes L4-007a MED).** New
  `no-new-cli-shims` script fails CI when a new `apps/cli/src/**`
  file re-exports from `@assignee/core` without adding genuine CLI
  behaviour — keeps the shim deletion permanent. (commit `1b4321c`)

#### Security

- **`pnpm audit` 9 moderate advisories → 0 (closes L5-001..L5-004
  MED).** `pnpm.overrides` pins `langsmith@^0.5.19` (GHSA-fw9q-39r9-c252
  and GHSA-rr7j-v2q5-chgv — prototype pollution plus streaming token
  redaction bypass) plus `hono@^4.12.14` and `@hono/node-server`.
  ARN canonicalization unified through `ARN_PATTERN_SOURCE` (no regex
  duplication). `operatorCredentials` field marked `@deprecated`
  across 7 audited call-sites ahead of removal in v0.2. (commit
  `19d8194`)

#### Fixed

- **Empty-string `AWS_REGION` coalesce (closes P2-05 LOW).** Treating
  `AWS_REGION=""` the same as unset avoids a silent fallback to
  `us-east-1` when a shell sources an empty var. (commit `e3bc140`)
- **`list` / `status` error-guard on unrecognised `--resource-type`
  (closes L3-L4 LOW).** CLI now rejects unknown types with an
  actionable message that re-renders the supported-types hint.
  (commit `e3bc140`)
- **`HEADLINE_SHORTHANDS` silent no-op warning (closes P2-02 LOW).**
  Displaying a shorthand that resolves to itself now emits a single
  debug warning so the drift can be grepped. (commit `e3bc140`)

#### Docs

- **`CHANGELOG.md` `[0.1.0]` placeholder tidied (closes L8-L1 LOW).**
  Stale `<!-- date filled at v0.2 publish -->` inline comment cleaned
  up ahead of the first public `v0.2` cut. (commit `e3bc140`)
- **Audit-log + unicode-fallback + active-applies notes in
  `docs/explanation/` (closes L8-L2/L3/L4 LOW).** Three narrative
  gaps closed in-place; invariants file untouched. (commit
  `e3bc140`)

### Epic 56 — iteration 1 (2026-04-19)

#### Added

- **`--resource-type <type>` on `assignee list` and `assignee status`
  (closes L3-001 HIGH — MCP↔CLI parity).** CLI now accepts the same
  `--resource-type` filter as the MCP `list_managed_resources` tool.
  Validated against `SUPPORTED_TYPES_ARRAY` via
  `renderSupportedTypesHint` so drift is impossible by construction.
  (commit `2c8db8e`)
- **`pnpm doc-lint` script (closes L3-002 MED).** New
  `apps/cli/scripts/doc-lint.mjs` verifies that the README
  pattern-table row count equals `defaultPatternRegistry.size()` and
  that `docs/integration-architecture.md` pattern enumeration matches
  the registry. Six drift-guard parity assertions wired across MCP
  fixture tests. 11 new unit tests. (commit `ddc5f03`)

#### Refactored

- **Destroy-resource barrel adoption + 4 of 5 CLI shims deleted
  (closes L4-001, L4-002, L4-003 MED).** CLI call-sites migrated to
  `@assignee/core/destroy-strategies`; four legacy CLI re-export
  shims removed. MCP `DEFAULT_REGION` switched to a lazy per-tool
  resolve so region-snapshot timing cannot race with env-writer
  setup. Two new MCP region-resolution tests. (commit `d6f6838`)
- **`iam-policies` inline + 2 further CLI shims deleted + KEEP
  rationale comments on stable barrels (closes L7-004/005/006 MED).**
  `cfn-keys.ts` and `resource-types.ts` gain `KEEP` header comments
  explaining why they stay in `apps/cli` despite the shim-deletion
  sweep. (commit `b637cb4`)

#### Docs

- **Narrative + positioning polish (closes 7 MED + 5 LOW).**
  `apps/cli/package.json` description aligned with the MCP-server
  neutral framing; `docs/index.md` key-metrics date refreshed;
  seven `wiki/competitors/*.md` BP-rule counts corrected 186 → 185;
  README Onboarding-prereq row, sunk-cost reframe, price-as-moat
  line, and LLM cross-link added. (commit `2cca0ce`)

#### Tooling

- **`doc-lint.d.mts` declaration added (close-out follow-up).**
  `tsc --noEmit` now passes on the pre-push hook after story 04's
  `.mjs` import was wired through a proper ambient declaration —
  no more blanket `@ts-ignore`. (commit `042821f`)

### Epic 55 — iteration 1 (2026-04-19)

#### Security

- **`LlmAdapter` sanitize-by-default — prompt-injection by
  construction (closes L5-001 + L5-002 HIGH class).**
  `stripPromptBoundaryTags` is now applied inside
  `LlmAdapter.generateText` and `generateStructured` before
  `redactSensitive`, so no caller can accidentally forward an
  un-sanitised user-intent to Bedrock. Eliminates the entire
  user-intent-boundary-tag injection vector documented in Epic 54 as
  a library-level invariant rather than a per-call-site wrap. 11 new
  adapter-redaction tests. (commit `b72298f`)

#### Added

- **MCP ↔ CLI `createGraph` parity test (closes L10-002 HIGH).**
  New `mcp-cli-graph-parity.test.ts` pins 5 assertions on the
  canonical graph — same nodes, same edges, same entry node, same
  terminal node, same conditional routing — preventing MCP and CLI
  from silently diverging on the 13-node pipeline.
  (commit `b72298f`)
- **`logToolAudit` shared helper (post-epic-55 cleanup batch).**
  Common 95 % of `logApplyAudit` + `logDestroyAudit` extracted into
  `apps/mcp-server/src/utils/log-tool-audit.ts`. Both tool handlers
  now thin-wrap the shared helper; tool-specific telemetry lands in
  a reserved `extras` field that is NOT persisted to the JSONL trail
  (six-field schema preserved). 6 new tests covering the full union
  of 11 classifications. (commit `d34a902`)

#### Refactored

- **`citation-lint` scope expanded to the canonical root + `.github/`
  set (closes L8-B1 BLOCKER).** `apps/cli/scripts/citation-lint.mjs`
  now scans `docs/`, top-level `AGENTS.md` / `CONTRIBUTING.md` /
  `SECURITY.md` / `CODE_OF_CONDUCT.md`, and `.github/**/*.md`
  (PULL_REQUEST_TEMPLATE, workflows/README). Citation count
  93 → 107, broken count 0. `pnpm citation-lint` is now the hard
  gate for the entire externally-visible doc surface. (commit
  `f18e332`)
- **`setup-arn-builder` helper + `iam-policies` barrel inline
  (post-epic-55 cleanup batch).** Partition-aware ARN construction
  unified into a single helper (`aws`/`aws-cn`/`aws-us-gov`); stale
  IAM-policy re-export barrel inlined into the sole consumer.
  (commit `d34a902`)
- **Real-timer sweep — four vitest sites migrated to fake timers
  (post-epic-55 cleanup batch).** Saves ~155 ms per test run.
  Different technique per site (`vi.useFakeTimers()`,
  `process.hrtime.bigint()` spy, `toFake:["setTimeout"]`, microtask
  yields) documented inline. (commit `446ee63`)
- **`destroy-resource/handler-steps.ts` dedupes `StepResult<T>`
  (post-epic-55 cleanup batch).** Local type definition removed in
  favour of the shared `apps/mcp-server/src/utils/step-result.ts`
  utility shipped in Epic 54 Wave 2. -8 LOC, zero semantic change.
  (commit `446ee63`)

#### Docs

- **`docs/explanation/invariants.md` gains three utility-doc blocks
  (closes L8-002 / L8-003 / L8-004 HIGH).** `StepResult<T>` discrim
  contract, `help-hints` SSO rendering rules, and `prompt-sanitize`
  boundary-tag allowlist documented as first-class invariants. The
  Epic 54 utilities are now discoverable via the invariants page
  rather than only through the source files. (commit `f18e332`)
- **`README.md` pattern table extended to 10 rows (closes L3-001 +
  L3-002 HIGH).** Added missing `vpc-public-only` row with
  description sourced from `pattern-templates/patterns/vpc-networking/
compose.ts`; stripped static "23 types / 6 patterns" claims and
  replaced with anchor links to the canonical sections. README
  L73 reviewer-claim softened to "every rule cites its source"
  (was a broader factual overreach). (commit `f18e332`)
- **`CHANGELOG.md` Epic 53 / Epic 54 section labels corrected.** The
  Wave-1 sweep relabelled the mis-labelled "Epic 53 it1" block
  (which contained Epic 54 work) to "Epic 54 it1" and added a new
  "Epic 53 it1" section above it with the actual Epic 53 commits.
  (commit `f18e332`)

### Epic 54 — iteration 1 (2026-04-18 → 2026-04-19)

#### Refactored

- **Three god-function decompositions via StepResult (Wave 3 — closes
  L7-H1, L7-H2, L7-H3).** `apps/mcp-server/src/tools/plan-resource.ts`
  201 → 88 LOC (-56%); inner arrow 145 → 30 LOC, nesting ≤3.
  Extracted seven phase helpers under `plan-resource/` (`guardContext`,
  `enrichDescriptionWithEnv`, `buildInitialGraphState`,
  `checkExecutionStatus`, `serializeFinalState`,
  `persistCheckpointAndRespond`, `buildUnexpectedErrorResponse`) plus
  `error-envelope.ts`. `apps/mcp-server/src/tools/apply-plan/handler.ts`
  228 → 114 LOC; four duplicated 6-field auditLog envelopes consolidated
  into a single `logApplyAudit` helper plus `failWithAudit` reducer;
  five StepResult helpers in new `handler-steps.ts`. `apps/cli/src/services/bedrock-logging.ts`
  261 → 59 LOC; `setupBedrockLogging` body 163 → 30 LOC; five
  `ensure-*.ts` phase helpers + two support modules (`build-clients.ts`,
  `read-restriction-policy.ts`) under new `bedrock-logging/`
  sub-directory; partition-aware ARN builders preserved for
  `aws`/`aws-cn`/`aws-us-gov`. (commit `1cc223c`)

#### Added

- **`apps/mcp-server/src/utils/step-result.ts` reusable handler-step
  utility.** `StepResult<TContext>` discriminated union with
  `continueStep`, `continueVoid`, `doneStep`, `isContinue`, `isDone`
  helpers — mirrors the existing `destroy-resource/handler-steps.ts`
  shape so MCP tool handlers share one composition primitive. 25 LOC
  - 36 lines JSDoc + 12 co-located test scenarios. (commit `01f7866`)
- **`packages/core/src/config/help-hints.ts` single source of truth
  for help-hint rendering (closes L3-H1, L3-H2, L3-H3 + L2-001 +
  L2-002).** Exports `HINT_MAX_COLUMNS`, `HintStyle`,
  `getSupportedTypeCount` / `getSupportedTypes` / `getPatternCount`,
  `renderSupportedTypesHint('cli'|'short'|'mcp')`,
  `renderPatternsHint('cli'|'short'|'mcp')`. Counts derived at call
  time from `SUPPORTED_TYPES_ARRAY` + `defaultPatternRegistry` so the
  drift class observed across the prior three epics is impossible by
  construction. Three call-sites migrated:
  `apps/cli/src/config/constants/help.ts` (`SUPPORTED_TYPES_HINT` and
  `PATTERNS_HINT` are now thin wrappers), `intent-parser.ts` (inline
  20-line constant replaced with `renderSupportedTypesHint('short')`),
  `apps/mcp-server/src/tools/plan-resource.ts:115` (hardcoded
  "Supported types: S3, Lambda…" replaced with
  `renderSupportedTypesHint('mcp')`). Drift-guard test asserts
  registry parity. Two-line CLI patterns hint enforces 100-column
  wrap. (commit `01f7866`)

#### Security

- **`packages/core/src/llm/prompt-sanitize.ts` boundary-tag strip
  (closes L5-H1).** New `stripPromptBoundaryTags(raw)` with
  `BOUNDARY_TAG_ALLOWLIST` of nine tags (`user_intent`, `system`,
  `assistant`, `human`, `user`, `tool`, `context`, `instructions`).
  Single regex strips opening AND closing forms (allowlist, not
  denylist); second regex strips triple-backtick fences. Tolerant of
  attributes, whitespace, and self-closing forms; leaves TS generics,
  inequalities, HTML tags, and ARNs untouched. `llm-helpers.ts:133`
  replaces the old one-sided `</user_intent>/gi` regex. Step 6b
  follow-up mirrored the wrap to three additional `userIntent`
  call-sites (`advice-generator.ts:189`, `display-docs.ts:51`,
  `other-handler.ts:161-163` — both `userDesc` and `userIntent`
  fields). (commits `01f7866` + `b37aa1e`)
- **`LlmAdapter` outbound prompt redaction (closes L5-H2).**
  `packages/core/src/llm/adapter.ts` now wraps outbound prompt in
  `redactSensitive` at BOTH send-sites (`generateStructured` and
  `generateText`). Reuses the canonical allowlist redactor — partition
  aware, no regex duplication. 11 new adapter-redaction tests against
  realistic ARNs (`aws`/`aws-cn`/ISO partitions) and 12-digit account
  IDs. Invariants preserved: `callsite:"plan_generator"` token-cost
  attribution, Bedrock region-error hints, lazy credential resolution.
  (commit `01f7866`)

#### Docs

- \*\*Full-repo citation sweep + moat/disruption rewrite + quickstart
  13-node mirror (Wave 1 — closes L8-B1 + L1-H1 + L8-H1..H4 + L10-H1
  - L10-H2).\*\* `docs/configuration.md` dead `mcp-intelligence-audit.md`
    cross-link removed; `apps/cli/src/test-fixtures/mcp-mock-responses/`
    references repointed to `packages/core/src/test-fixtures/mcp-mock-responses/`
    in `README.md` + `docs/testing-guide.md`; nonexistent
    `apps/cli/scripts/check-mcp-versions.ts` paragraph removed from
    `docs/mcp-servers.md`; `docs/testing-guide.md` MCP E2E row repointed
    to `apps/mcp-server/e2e-test.mjs`; gitignored `_bmad-output/_archive`
    link dropped from `docs/explanation/contributing-a-bp-rule.md`;
    `docs/architecture-flows.md` header repaired after the
    `architecture.md` archive; `docs/explanation/telemetry-design.md`
    `audit-log.ts` pointer corrected to `apps/mcp-server/src/utils/`;
    `docs/explanation/oss-vs-saas.md` pattern IDs corrected (removed
    invented `s3-static-site` + `rds-with-vpc`; count 9 → 10).
    `docs/quickstart.md:100-107` ASCII pipeline diagram corrected to
    the 13-node graph (advice_generator inserted between plan_generator
    and bp_evaluator). README disruption-risk section reframed as a
    three-row table (HCP Terraform + cost preflight; Amazon Q + CCAPI;
    Spacelift Intent + env0); MCP section opens with the "MCP is not
    the moat" lede; new five-row bundle-durability mini-table
    (BP auto-fix / cost preflight / local-first no-state / HITL gate /
    MCP parity). Hero transcript byte-unchanged. Workspace-root
    `presentation/index.html` opportunistically corrected to 13-node /
    MIT / 37 types / 10 patterns / 185 rules. (commit `d6e352d`)

#### Tooling

- **`pnpm check-types` tightened to include test files (closes
  Epic 54 it1 close-out finding).** `apps/mcp-server/src/utils/__tests__/step-result.test.ts`
  guarded against `Object is possibly 'undefined'` on
  `result.response.content[0]` access — captured to a const, asserted
  defined before access. Production `tsconfig.build.json` excludes
  tests, so `pnpm build` did not catch this; the pre-push
  `tsc --noEmit` run did. Strengthening, not weakening — per the
  project's "fix code, not assertions" rule. (commit `7e0cc53`)

### Epic 53 — iteration 1 (2026-04-17 → 2026-04-18)

#### Docs

- **Cited-path drift Wave 1 + Step 6c sweep (closes 5 BLOCKER + 5
  HIGH L8 findings).** Five BLOCKER cited-path-integrity findings and
  five HIGH owner-placeholder + 13-node-pipeline drift items closed
  through a Wave-1 docs sweep plus a Step-6c scope-completion follow-up
  (5 inline fixes for sibling docs missed by the per-file Wave-1
  pass). Cross-reference: `_bmad-output/planning-artifacts/epic-53-final-summary.md`.
  (commits `8497c50`, `1b7d34e`)

#### Refactored

- **README/moat narrative + phase1-gate + resource-provisioner +
  destroy-resource + llm-plan god-function decompositions (Wave 3 —
  closes 10 HIGH).** Two-wave refactor pass: Wave 3a took the README
  moat scorecard, the phase-1 gate handler, and the resource-provisioner
  reducer (8 HIGH closures); Wave 3b finished the destroy-resource and
  llm-plan god-function pair (2 HIGH closures). Public surfaces
  unchanged; invariants preserved. (commits `92550d9`, `488490c`)

#### Fixed

- **Help-hint drift, MCP redaction, CI permissions, CLI package
  metadata (Wave 2 — closes 7 HIGH).** Help-hint label drift across
  CLI + MCP unified to a single rendering path; MCP redaction tightened
  to the canonical allowlist redactor (no regex duplication); CI
  workflow permissions narrowed to least-privilege; CLI package
  metadata corrected ahead of the (still-deferred) `npm publish`.
  (commit `8a50433`)

#### Tests

- **`extractAuditIdentifier` parse-fail branch covered (floor
  recovery).** New MCP test asserts the JSON-parse fallback path that
  surfaces as a structured audit error rather than a swallowed throw.
  Closes the floor-coverage regression introduced when the inline
  helper was extracted in Epic 51. (commit `e92d4e0`)

### Epic 52 — iteration 1 (2026-04-17 → 2026-04-18)

#### Added

- **Clarifying-question turn for ambiguous NL intents (Epic 52-1).**
  When the intent parser cannot confidently choose a resource type or
  the user's request is under-specified, the CLI now asks a single
  short clarifying question before planning instead of guessing.
  `--yes`, `--quick`, and `POLICY_BLOCKED` paths bypass the clarifier
  so non-interactive flows remain fully autonomous.
- **Update-notifier banner (Wave H1).** `assignee` now prints a
  one-line hint when a newer version is available. This is a no-op
  while the packages remain `private: true`; it activates once
  `v0.2.x` lands on npm.
- **Architecture patterns: full registry coverage in help (Story
  53-it1-05).** `assignee --help` and `plan --help` now advertise all
  ten compound patterns (`serverless-api`, `three-tier-web`,
  `container-service`, `message-processing`, `static-website`,
  `efs-with-vpc`, `vpc-networking`, `vpc-public-only`,
  `scheduled-lambda`, `lambda-with-exec-role`) with counts derived
  from the runtime registry. The resource-type hint now enumerates
  every entry in `SUPPORTED_TYPES_ARRAY` (37 types) — previously it
  displayed a curated subset missing EFS, KMS, CloudFront, the
  EventBridge family, `S3::BucketPolicy`, and `RDS::DBSubnetGroup`.

#### Changed

- **MCP IAM role parity (Epic 52-2).** Consolidated the managed-
  resource fetch path so the MCP server now returns the same IAM
  role inventory as the CLI's `assignee list`. `fetchManagedResources`
  was de-duplicated across the two packages and the long-standing
  operator-vs-reader role gap in the MCP surface is closed.

#### Fixed

- **MCP active-applies cap (Wave G1).** The in-process `activeApplies`
  `Set` is now bounded at 100 entries so a leaked apply during a long-
  running MCP session no longer grows the Set unboundedly. Protects
  against release-time memory drift in hosted MCP deployments.

#### Security

- **env-writer hardened + operator-creds warn-once (Wave E1).**
  `assignee init` / `setup` now create the `.assignee/` parent
  directory with `0o700` permissions on first write (previously
  inherited the umask default, which could be world-readable on some
  shells). The operator-credentials warning is emitted at most once
  per command to reduce noise without hiding the risk.

### Epic 51 — iteration 1 (2026-04-17)

#### Docs

- **License unification (L1-B1).** `docs/explanation/oss-vs-saas.md`
  and `docs/explanation/contributing-a-bp-rule.md` now consistently
  describe the project as MIT-licensed; all `Apache-2.0` references
  replaced to match the root `LICENSE`.
- **Stale path citations (L1-H1..H3, L8-H1).** Updated README, docs/
  architecture.md, docs/integration-architecture.md,
  docs/resource-types.md, and docs/explanation/invariants.md to
  reflect the post–Wave-5 module layout — the canonical graph now
  lives at `packages/core/src/graph/` and the MCP server imports
  `createGraph` directly from `@assignee/core/graph` (no runtime
  dependency on the `assignee` CLI package). Removed the deleted
  `apps/cli/src/services/bulk-destroy.ts` references; pointed the
  compound static-website destroy ordering at
  `packages/core/src/destroy-strategies/`.
- **Invariants pruning (L8-H1).** Deleted the "Safety allowlist in
  bulk-destroy" invariant — Story 50-3 removed the production
  bulk-destroy subtree that the allowlist guarded, so the invariant
  is no longer enforced by any code.
- **Docs index refresh (L10-H4).** `docs/index.md` key-metrics table
  re-dated to 2026-04-17; test-count row rephrased to match the
  README's "full unit suite across 4 packages" framing (307 test
  files total: 72 CLI + 24 MCP + 200 core + 11 BP).

#### Best-practice library

- **Rule count drift (L10-H1).** README, docs, and architecture pages
  now cite **185** BP rules (matching `packages/best-practices/manifest.json`)
  instead of the stale "186 + 1 pending re-manifest" hedge; manifest
  regenerated in-place (content-identical, timestamp refreshed).
- **Contributor on-ramp (L10-H2).** Added a prominent contribution
  call-out near the README's feature bullets linking to
  `docs/explanation/contributing-a-bp-rule.md`.

#### Run-ledger

- **Destroy stickiness (L10-H3).** `docs/explanation/run-ledger-design.md`
  now states the explicit OSS-launch gate: v0.1 uses the existing
  per-resource `assignee destroy` flow; `destroy --run-id <uuid>` ships
  in v0.2. No code changes — documentation-only clarification.

### Added

- Root legal and community files: `LICENSE` (MIT), `SECURITY.md`,
  `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
  and this `CHANGELOG.md` (Story 50-8).
- Exit-code contract unified across `docs/commands.md` and
  `docs/troubleshooting.md`; CLI integration test
  (`apps/cli/src/__tests__/exit-codes.test.ts`) asserts the actual
  emitted exit code for each error class.
- Wired exit code `10` for policy/safety aborts (`UserCancelledError`,
  `StateGuardError`, `MissingRequiredFieldsError`) and exit code `11`
  for MCP startup failures (`ErrorCode.MCP_STARTUP_FAILED`). Previously
  all errors emitted exit `1`.

### Changed

- `docs/index.md` re-categorises `docs/commands.md` from How-to to
  Reference — it is lookup-style information, not a task recipe.
- `docs/explanation/invariants.md` no longer references the
  maintainer's local auto-memory directory path; filenames remain as
  internal grep hints.
- `README.md` disclaimer updated to note the project is now MIT-licensed
  (source available) even though `npm publish` is deferred.

### Removed

- `docs/stories/` — relocated to
  `_bmad-output/implementation-artifacts/_archive/done-stories/`.
- `docs/mcp-intelligence-audit.md` — relocated to
  `_bmad-output/planning-artifacts/_archive/`.

## [0.1.0]

Initial internal development baseline. Not published to npm.

### Added

- `assignee` CLI with 13 commands: `plan`, `apply`, `destroy`,
  `drift`, `reconcile`, `list`, `status`, `optimize`, `init`, `setup`,
  `doctor`, `completions`, `version`.
- `@assignee/mcp-server` exposing the pipeline to AI coding agents
  (Cursor, Claude Code, Windsurf) via MCP.
- `@assignee/core` shared library: ports, schemas, destroy strategies,
  checkpoint store, pricing, testing utilities.
- `@assignee/best-practices` — 185 YAML best-practice rules with
  SHA-256 manifest integrity.
- Support for 37 AWS resource types, 10 compound architecture patterns.
- 13-node LangGraph pipeline: intent_parser → schema_fetcher →
  option_elicitor → compound_dispatcher → plan_generator → bp_evaluator
  → fix_applicator → preflight_guard → human_approval →
  resource_provisioner → status_poller → result_formatter →
  advice_generator.
- AWS MCP server integrations: pricing, documentation, IAM,
  well-architected-security, billing-cost-management.
- Drift detection, reconcile, cost-rightsizing optimizer (Graviton
  swap recommendations).

[Unreleased]: https://github.com/assignee-ai/assignee.ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/assignee-ai/assignee.ai/releases/tag/v0.1.0
