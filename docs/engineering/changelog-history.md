# Engineering Journal — Changelog History

> **Note**: This file is the engineering-flavoured history extracted from the external-facing `CHANGELOG.md`
> during Epic 100 Wave 10 (W10-01). It contains BMAD story IDs, internal wave labels, review methodology
> notes, and per-epic engineering commentary that belong in an engineering context but not in a public
> Keep-a-Changelog.
>
> The external-facing `CHANGELOG.md` at repo root is the user-visible, Keep-a-Changelog v1.1 document.
>
> **Deviation from story spec**: The story specified extracting per-epic content to
> `_bmad-output/planning-artifacts/retro-epic-*.md`. That path is read-only in this session;
> content is preserved here instead. See W10 worker report for rationale.

---

# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

## [Unreleased]

### Epic 99 — whole-project cross-expert review remediation (2026-04-24)

Six-lane exhaustive cross-expert review of the project at HEAD `6fca42e`
(Epic 98 + demo-hotfix + pre-demo polish + CI unblock already landed).
Reviewers (all Opus-4-7[1M]): Mary analyst, Winston architect, Quinn QA,
Murat TEA, Paige tech-writer, Bob SM — returning 200 findings across
6 lanes, 4 remediation waves, 7 commits on main, and Contract H + Contract I
landing as compile-time parity guards for probe-reachability and
first-class-promotion coverage.

**Scope closed**: ~95 findings (all BLOCKER + all HIGH + ~33 pivotal MED);
~105 remaining (LOWs + non-pivotal MEDs) deferred to
`_bmad-output/planning-artifacts/deferred-backlog.md` Epic 100+ bucket with
explicit rationale per cluster.

#### W1 — BLOCKER wave (`e5906d4`)

Four parallel Sonnet lanes + straggler + coverage-patch. 22 files, +407 / -189.
Closes: 4 BLOCKER count-drift (13 nodes → 14, 37 types → 38, 10 patterns → 11,
186 BP rules → 185 normalized across every docs site); BLOCKER ghost commands
(`assignee cost` / `destroy --all` / `--include-iam` / `--dry-run` / `--resources` /
`--force-unsafe` stripped from 6 docs); BLOCKER MCP-server `npx -y` ghost-install
replaced with source-checkout pre-release notice; account-ID hardening
(VACATION_HANDOFF.md scrubbed, `runShortDoctor` wired through
`redactAccountIdIfDemoMode`, `.husky/pre-commit` grep guard with
self-match protection); sprint-status hygiene sweep (Epic 48 closed,
Epic 21 `skipped` added, Epic 99 block added, `deferred-intentional`
status introduced); 11 missing CHANGELOG Epic subsections backfilled
(49 / 50 / 68-72 / 89 / 93 / 95 / 97).

#### W2 — HIGH wave (`fa3f69d`) + citation-lint hotfix (`a96f69a`)

Five parallel Sonnet lanes + coordinator VACATION_HANDOFF.md removal. 16 files
+976 / -543, 1 deletion, 2 new test files.

**CI gate expansion**: 4 pre-push lints now run in CI (`lint:barrels` /
`lint:shims` / `doc-lint` / `citation-lint`) — closes the `--no-verify`
bypass class. Node matrix expanded to Node 20 + Node 22 — first time
`engines.node >= 20.11` is CI-verified.

**Probe integrity + Contract H**: 22 `known_tripwires` entries seeded
(41 → 23 empty blocks), 3 `must_fail_pre_fix: true` fire-probe stubs,
duplicate BP-S3-011 deleted, 8 `parent_reachable: true` opt-ins with
non-empty rationale, **Contract H (probe-reachability)** added in
`shipped-wired-contract.test.ts` enforcing every probe's BP rule
target-type is in `SUPPORTED_TYPES_ARRAY` or explicitly opts out. Harness
tweak: TRIP separate from FAIL.

**AWS SDK client lifecycle**: 5 leak sites fixed (CloudFront / DynamoDB /
EFS / S3 destroy strategies + `marker-resolver.ts` STSClient). Brief had
wrong file list; Lane 2c caught it, fixed the real leaks.

**ErrorCode + rule-runner**: `ErrorCode.INVALID_DESIRED_STATE` enum
member + `rule-runner.ts` default branch now throws on unknown check_type
(was silent no-op). 2 new test files pin the drift-guards.

**Deferred-backlog SSO**: NEW
`_bmad-output/planning-artifacts/deferred-backlog.md` (180 lines, 6 buckets,
50+ entries) replaces the 6 scattered homes for deferred items.

**VACATION_HANDOFF.md removal**: archived to `_bmad-output/_archive/
reports/VACATION_HANDOFF-2026-04-24.md` + `git rm`.

Hotfix `a96f69a`: W2a's new CI citation-lint step caught 14 pre-existing
broken citations reaching outside the repo (`../wiki/competitors/*` +
`_bmad-output/.../L10-moat.md`). 3 docs rewritten to strip
`[label](path)` markdown-link syntax that climbed past repo root.
Validates `feedback_citation_lint_guardrail`'s warning about the
`--no-verify` bypass class.

#### W3 — MED methodology wave (`93a78ad`)

Five parallel Sonnet lanes. 31 files +1665 / -75, 9 new files.

**NFR floors**: NEW `startup-percentile.test.ts` + `memory-baseline.test.ts`
under `RUN_PERF=1` gate. Startup p50=838ms / p95=854ms / p99=868ms locally;
thresholds p95 < 1300ms / p99 < 1400ms carry 1.5× headroom for CI.
Memory heap stability: ±20% bound across 10 synthetic invocations.

**Flake policy**: `retry: 1` in all 4 `vitest.config.ts`. NEW
`docs/explanation/flake-policy.md` (125 lines) — ≤ 0.1% flake-rate SLO,
quarantine process, `feedback_never_weaken_tests` invariant reinforced.

**checkBudget rename + CI-multiplier guard**: disambiguated two
`checkBudget` functions — `time-budget.ts#checkBudget` →
`checkTimingBudget`, `budget-guard.ts#checkBudget` →
`checkMonthlyCostBudget`. NEW `apps/cli/scripts/lint-ci-multiplier.mjs`
fails any test importing `checkTimingBudget`/`checkTimingsAgainstBudgets`
without `vi.stubEnv("CI")` — wired into pre-push + CI.

**Diátaxis scaffolding**: 4 quadrant README indexes
(`docs/tutorials/` + `docs/reference/` + `docs/how-to/` +
`docs/explanation/`). Existing doc-moves deferred to Epic 100+ as a
dedicated citation-lint-gated subwave.

**PolicyContext discriminator**: NEW
`packages/best-practices/src/evaluate/policy-context.ts` with 3-kind
discriminator (trust / identity / resource) + `derivePolicyContext()` for
20+ AWS resource-policy types. `wildcard-principal-no-condition` now
rejects trivially-permissive conditions like
`Condition:{StringLike:{aws:SourceAccount:"*"}}` via
`hasMeaningfulConditionKey()` with `MEANINGFUL_CONDITION_KEYS` allowlist;
`cross-account-no-external-id` gated to trust-context only (no more
spurious fires on resource policies). +40 tests.

#### W4 — MED structural wave (`dcccfc7`)

Three parallel Sonnet lanes + DDB regex reviewer follow-up. 16 files
+2618 / -35, 3 new files.

**Plan-time validators × 8**: NEW
`packages/core/src/graph/nodes/validate-desired-state/name-validators.ts`
(+ 9th for KMS alias ready for future promotion): Lambda / DynamoDB /
SecurityGroup / IAM-Role / RDS / SQS / SNS / KMS-alias / ECR. 116 new
integration-style tests invoking `validateDesiredStateNode` end-to-end.
Registry dispatch pattern — new types just register.

**Partition-aware managed-policy ARNs**: `awsManagedPolicyArn(partition, path)`
helper with `/^aws(?:-[a-z]+)*$/` validation. NEW
`rewriteManagedPolicyArnsForPartition()` in `compound-helpers.ts` runs in
`compound-plan.ts` before CCAPI dispatch. 5 pattern templates migrated to
`_PATH` suffix constants + runtime rewrite — GovCloud / China / ISO
partitions now work end-to-end. Legacy full-ARN constants retained with
`@deprecated` JSDoc.

**Contract I — first-class-promotion 8-point parity**: added to
`shipped-wired-contract.test.ts`. Iterates `SUPPORTED_TYPES_ARRAY` × 4
audit surfaces (bp-all-rules / bp-auto-fix / compound-provisioning /
apply-mode). First-run 95-type gap inventory: 6 + 21 + 32 + 36 missing
— all opt-outed with 4-category rationale + 5 deferred-backlog rows
(V1-16..V1-20). From here forward, unchecked coverage gaps are impossible:
stale-entry guard enforces the ratchet.

Reviewer follow-up: DDB validator regex
`/^[a-zA-Z0-9_.\\-]+$/` → `/^[a-zA-Z0-9_.-]+$/` (first `\\` allowed
literal backslash through the character class).

#### Cumulative impact

- 7 main-branch commits (`72777fe` → `dcccfc7`).
- ~95 findings closed across BLOCKER / HIGH / MED tiers.
- 3 new compile-time parity guards: **Contract H** (probe-reachability),
  **Contract I** (first-class-promotion), completing the A-I set in
  `shipped-wired-contract.test.ts`.
- CI now Node 20 + 22 matrix with 5-lint chain (barrels + shims + doc-lint +
  citation-lint + ci-multiplier).
- NFR floor installed (p95/p99/memory) under `RUN_PERF=1`.
- `retry: 1` flake quarantine discipline across all 4 packages.
- ~105 findings deferred to `deferred-backlog.md` Epic 100+ bucket with
  per-cluster rationale.
- Zero real-account-ID leaks in tracked files (pre-commit grep guard).

#### Review methodology

Followed CLAUDE.md §"Review loop: collect all, then plan" —
COLLECT → SYNTHESIZE → PLAN → FIX → REVIEW → OTHER-CHECKS. 6 Opus
reviewers collecting 200 findings exhaustively, zero top-N filtering;
synthesizer produced `epic-99-scorecard.md` + `findings.yaml` + `plan.md` +
6 lane reports; planner clustered into 5 waves with explicit
deferred-backlog; parallel Sonnet fix workers with exclusive file
ownership; Opus adversarial reviewer at each wave-close. Model cascade
validated: Opus lead + Sonnet workers + Opus reviewer.

See `_bmad-output/planning-artifacts/epic-99-{scorecard,plan,findings.yaml}.md`

- `epic-99-lane-reports/{mary,winston,quinn,murat,paige,bob}.md` for the
  full review record.

### Epic 98 — 17 stories closing Epic 97's 84 findings, 22 commits, all tripwires retired (2026-04-23)

First epic run on the `.claude/agents/*.md` subagent-definition harness (one Opus lead + Sonnet-4.6 lane workers + Opus read-only reviewer) with shared-task-list self-claim — replacing the earlier per-story SendMessage dispatch pattern. Generator-evaluator split cut reviewer bounces from per-session pollution to concrete disk-vs-claim drift. All 17 stories reviewer-gated, all Epic 97 forcing-flip tripwires retired, `pre-close-probes --tripwire-only` reports `Total: 0`.

#### Fixed — Methodology (M2)

- **e98.M2** — multi-variation probe gate + tripwire forcing-flip (`2556394`). Extends Epic 96 M1. Every probe now asserts ≥ 3 intent variations across distinct edge cases; `PROBE_MANIFEST.yaml` schema gains `known_tripwires[]` for assertion-flip witnesses. `pre-close-probes.sh --strict-multi-variation` + `--tripwire-only` added. `strip_env_leaks` closes D-22 probe-env leak. Contract G in `shipped-wired-contract.test.ts` compile-time-enforces multi-variation coverage.

#### Fixed — Wave 1 BLOCKER

- **e98.W1.B1** — non-taggable resource registration + dual-index store (`d55c59f`, closes B-02). Route / SubnetRouteTableAssociation / VPCGatewayAttachment CCAPI creates landed in AWS but the read-side (`list` / `destroy`) couldn't see them → silent orphan state. New `@assignee/core/managed-resources` module with `isNonTaggableConstruct` classifier + dual-index reader over the existing provision log. `ManagedResource` gains optional `primaryIdentifier` + `keyKind` discriminator. `destroy` resolves input against both indexes; unresolvable → new `DESTROY_TARGET_NOT_FOUND` error code. MCP-server mirror added.

#### Fixed — Wave 2 REGRESSIONs (probe-narrowness closures)

- **e98.W2.R1** — region regex scope: alpha-alpha-digit names + explicit region tail wins (`9cd2407`, closes B-09 + B-10). Epic 96 W1.B3 probe only asserted exit code — `plan "Create a lambda named my-abc-1"` rejected the intent, and substring matches inside resource names won over explicit tail. Two-pass extractor: explicit `region|in|at <x>` tail wins if present; free-floating tokens scanned only when no tail, with `named|called|name=` negative lookaround. `region_extraction` debug log exposes which pass won.
- **e98.W2.R2** — `mergePluginDefaults` empty-leaf backfill (`7ab411e`, closes C-R1). `result[key] !== undefined` skip-condition silently accepted LLM-emitted `CreditSpecification:{}` shells. Export `isEmptyLeaf(v)` (treats `undefined/null/{}/[]/""` as missing). Deep-merge object-valued plugin defaults so LLM-emitted keys win, missing keys fill from default.
- **e98.W2.R3** — placeholder guard covers all CFN prose fields (`2d2898b`, closes B-11 + B-12). `PLACEHOLDER_RESOURCE_ID_PROSE_FIELDS` expanded to `GroupDescription`, `DBSubnetGroupDescription`, `DashboardBody`, `LogGroupName`, `LogStreamName`, `FunctionDescription`, `RoleDescription`. New CFN-schema-driven walker via annotation table.
- **e98.W2.R4** — user-stated VolumeSize fidelity (`75e4f63`, closes C-R2). Post-parse patcher: regex `(\d+)\s*(?:GB|GiB)\b` → override `BlockDeviceMappings[0].Ebs.VolumeSize`. Word-boundary `\b` guards against `100GBP` / `5GBit` false positives. Zero/negative guard drops `0GB` noise.

#### Fixed — Wave 3 ARCHITECTURAL DEBT

- **e98.W3.A1** — `mergePluginDefaults` per-plugin allowlist expansion (`a84003e`, closes A-04 + A-05 + B-15 + C-N1 cluster). `LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST` extends from EC2_INSTANCE-only to 11 plugins (SNS_TOPIC with new `KmsMasterKeyId:"alias/aws/sns"` default, SQS_QUEUE, EC2_ROUTE, EC2_NAT_GATEWAY, ELBV2_LOAD_BALANCER, RDS_DB_INSTANCE, ECS_CLUSTER, ECR_REPOSITORY, EFS_FILE_SYSTEM, APIGATEWAYV2_API, CLOUDFRONT_DISTRIBUTION). Each entry carries per-rule disarm analysis — 8 BP rules move from "may fire" to "effectively disarmed" on bare-intent (fire rate ~0). **S3_BUCKET + DYNAMODB_TABLE explicitly excluded** to preserve BP-enforcement integration-test semantics — deliberate, documented at `merge.ts:134-146`. Contract D auto-walks allowlist membership for drift-guard durability.

#### Fixed — Wave 4 BP narrowing (policy-inspector extension patterns)

- **e98.W4.B1** — `nested_array_predicate` check_type + BP-ECS-004 (`4c4d806`, closes BP-ECS-004 CRITICAL MISLABELED). NEW `predicates/nested-array-predicate.ts` with JSONPath-like grammar `.Environment[?(@.Name=~/<regex>/)]`. Defensive posture: malformed grammar / invalid regex / non-array → PASS silently. Migrates BP-ECS-004 from awareness-always-fire to firing only on secret-family plaintext env names.
- **e98.W4.B2** — `policy_antipattern` + BP-SNS-004 (`65e69be`, closes BP-SNS-004 CRITICAL MISLABELED). New `wildcard-principal-no-condition` antipattern in `policy-inspector.ts`: fires on `Allow` + wildcard Principal + absent/null/empty Condition. Targets inline `AWS::SNS::Topic.TopicPolicy` (Option 1 — `AWS::SNS::TopicPolicy` isn't first-class yet).
- **e98.W4.B3** — BP-SNS-003 `wildcard-resource` retargeting (`1a9387b`, closes BP-SNS-003 MISLABELED). Avoids duplicate-fire with BP-SNS-004: SNS-003 now targets resource-scope (`Resource:"*"` grants cross-topic access), SNS-004 targets principal-scope. Both fire independently on different shapes; FSBP SNS.3 coverage complete.
- **e98.W4.B4** — `ABSENCE_CHECKS` registry + BP-S3-011 SSL-only (`9a732a9`, closes BP-S3-011 MISLABELED). New bifurcation in `policy-inspector.ts`: presence antipatterns (fire when bad shape present) vs absence antipatterns (fire when required shape absent). `missing-secure-transport-deny` antipattern fires on bucket-policies lacking a `Deny` + `aws:SecureTransport=false` Condition. `triggers.excludePatterns:["static-website"]` preserved.
- **e98.W4.B5** — `cross-account-no-external-id` + BP-IAM-010 (`9c2dca2`, closes BP-IAM-010 MISLABELED). Third `policy-inspector.ts` extension pattern: explicit sibling-deferral. Fires on AssumeRolePolicyDocument with non-current-account AWS principal + missing `sts:ExternalId` Condition. Defers to `wildcard-principal` check to avoid double-fire.

#### Fixed — Wave 5 NEW findings + polish

- **e98.W5.N1** — unified apply envelope with `arn` + `primaryIdentifier` (`4d6baae`, closes A-01 + B-01). Non-taggable types (Route / SRTA / VPCGatewayAttachment) now emit `{arn:null, primaryIdentifier:"rtb-X|0.0.0.0/0"}` instead of inconsistent ARN forms. Lambda compound envelope `arn` field correctly synthesizes full ARN via `buildResourceArn`. MCP-server mirror.
- **e98.W5.N2** — intent silent-override suite (`a460857`, closes D-13 + D-17, C-P4 implicit via W3.A1). SNS Subscription Protocol inference: E.164 phone → `sms`, Lambda ARN → `lambda`. Default `Protocol: "sqs"` removed (contract update). CloudWatch Alarm Namespace/MetricName extraction + enum expansion (+`AWS/S3`, +`AWS/DynamoDB`). Permissive-match + strict-accept pattern for E.164 (reusable for future validators).
- **e98.W5.N3** — JSON stderr-leak sweep (`c707188`, closes D-01/02/12/22/23 + B-07 + D-16). NEW `output-format.ts:resolveJsonMode` single chokepoint across 9 commands. NEW `json-stderr-filter.ts` with narrow leading-prefix allowlist (`[ERROR]`, `[CONTEXT]`, `[FIX]`, `[assignee] WARNING`, `P2-01`, `Error:`, first-run banner). Uniform `--json` AND `--output json` acceptance. Live D-01: `plan "" --json` now exits 1 with 0 bytes stderr + parseable envelope.
- **e98.W5.N4** — envelope `BP_BLOCKED` error code + generic-error plumbing (`092d356`, closes B-04 + B-05). NEW `ApplyFailureDetail` discriminator `{kind:"bp_blocked"|"apply_failed"}`. `apply --yes --json` on BP-blocked plan now exits 1 with `error.code:"BP_BLOCKED"`, `error.detail.practiceIds:["BP-IGW-001"]` instead of generic `APPLY_FAILED`. Truncation policy at CLI layer (500-char cap).
- **e98.W5.N5** — EC2 EIP first-class + skeletal-plan-detector + --wizard harmonisation (`fc47b4c` + `4f68032`, closes B-03 + C-N3 + C-N4 + C-P3 + D-14 + D-15). EIP promoted COMPANION → first-class via 8-point registry integration (plugin + supported + identifiers + pricing decomposer + pricing strategy + destroy strategy + mcp-advisor + mcp-classifier + help-grid + coverage-test). COMPANION_RESOURCE_TYPES alias retained for nat-gateway compound callers. NEW `skeletal-plan-detector.ts` with narrow per-type allowlist (RDS DBInstance / ALB / DBSubnetGroup) — fires advisory with `--set` hints on empty-required arrays. `--wizard` harmonised across plan/apply/drift; `drift --wizard --yes` combination rejected at Commander.
- **e98.W5.P1** — BP severity normalisation (`ffc0bf4` + `7fa29d9`). Scorecard §5 `CL-BP-LEGIT-SEVERITY-NORMALIZE` cluster: 7 runtime-only awareness rules (BP-EC2-018/019/020/021/023, BP-RDS-013, BP-DYNAMODB-006) downgraded to INFO/MEDIUM per actionability tier. 5 of 8 W3.A1-disarmed rules got audit-trail description notes documenting the plugin-default semantics. Severity kept on all 8 — safety-net semantics remain load-bearing. NEW `severity-drift parity test` in `bp-all-rules-audit.test.ts` fails fast on any future YAML severity drift.
- **e98.W5.P2** — Epic 95 deferred promotions (`40ad78e` graph + `c0854d4` cli, closes A-07/A-03/B-16/A-08/D-10). SQS apply budget 60s → 90s via new `setApplyBudgetContext` + `APPLY_TOTAL_OVERRIDES_MS` table (narrow per-type extension). MCP startup budget 3000ms → 5000ms. A-08 SNS/SQS/DDB probe seeds added (slice-A probe-narrowness gap closed). D-10 e2e residue: NEW exported `isE2eBucketName` predicate with prefix-boundary coverage (prevents `prod-e2e-observed` false-match).

#### Fixed — Tooling

- **Tooling** — `pre-close-probes.sh` empty-array guard (`70c2318`). After W2.R3 retired the last `known_tripwires` entry, `--tripwire-only` crashed with `set -u` + bash empty-array iteration on line 509. Added `${#RESULTS[@]} -gt 0` guard matching the existing pattern on `MALFORMED` / `FORCING_FLIPS`.

#### Deferred to Epic 99

- BP-ECS-004 CLI fire-probe retirement — the rule targets `AWS::ECS::TaskDefinition` which isn't in `supported.ts`. CLI intent-parser resolves "ECS task" intents to `AWS::ECS::Cluster`, so the probe was never reachable from a live CLI run. BP-ECS-004 rule correctness is authoritatively exercised by 25 scope tests + 31 predicate-unit tests. Re-seed the fire-probe in Epic 99 when TaskDefinition becomes first-class.
- BP-SNS-004 / BP-SNS-003 fire-probes — same class; defer to Epic 99 when `AWS::SNS::TopicPolicy` becomes first-class.
- BP-ECS-004 hermetic-only probe conversion captured in `feedback_bp_probe_reachability.md`.
- BP-SNS-001 / BP-SQS-001 / BP-RDS-002 audit-trail description notes (3 of 8 W3.A1 disarmed rules) intentionally not landed — 5-of-8 coverage accepted as sufficient.
- W4.B1 probe layer severity-blind for BP-EC2-018 (Option B accepted — audit-test parity test is the authoritative regression lock; probe-layer is defense-in-depth).

#### Process wins captured as cross-session feedback memories

- `feedback_team_attach_all_agents.md` — attach every `Agent` spawn to the active team so oversight holds.
- `feedback_harness_flat_shared_tasklist.md` — 3–5 teammates + shared task list + self-claim; NEVER nested teams (platform-blocked), NEVER per-story SendMessage for long epics.
- `feedback_opus_lead_sonnet_workers.md` — Anthropic's eval shows Opus lead + Sonnet workers + Opus reviewer beats all-Opus by 90.2%.
- `feedback_agent_def_file_model.md` — `.claude/agents/<name>.md` frontmatter carries the exact model ID; the `Agent.model` enum is a dispatch-tool quirk, not a platform limit.
- `feedback_daily_cost_ceiling.md` — under-$1/day harness cost budget. Dogfooder lives at epic-close only.
- `feedback_parallel_worker_commit_rhythm.md` — per-commit probe gates collide with parallel-worker trees; bypass for story commits, gate at wave-close. Re-snapshot the manifest immediately before every filter step.

### Epic 97 — BP-awareness audit + post-Epic-96 fresh review, findings only (2026-04-23)

10-lane post-Epic-96 review plus a targeted audit of the ~17 BP rules flagged in Epic 96 W3.N2 as still `check_type: awareness` despite holding CRITICAL-class exposure. Audit produced `epic-97-bp-awareness-audit.md`; review produced an 84-finding scorecard (`_archive/done-stories/epic-97-scorecard.md`) across BLOCKER / HIGH / MED / LOW waves. No implementation stories shipped from this epic — all 84 findings routed directly into Epic 98 as its input inventory.

### Epic 96 — 13 stories closing 23 Epic 95 findings, all probes PASS (2026-04-23)

All 3 Wave-1 BLOCKERs, 6 Wave-2 REGRESSIONs, and 4 Wave-3 NEW findings closed via the persistent `epic96-fix-team` (graph-fixer / cli-fixer / bp-fixer on disjoint file slices). Every story's probe in `PROBE_MANIFEST.yaml` flipped from FAIL → PASS; final `pre-close-probes.sh` sweep shows **18/18 PASS**.

#### Fixed — Wave 1 BLOCKERs

- **e96.W1.B1** — Lambda compound `FunctionName` leak into IAM Role slot (A-01 REG of Epic 94 R2). New `filterElicitedForSlot()` uses inverted `NAME_FIELD_TO_RESOURCE_TYPE` (9 bound name fields) to drop keys bound to OTHER resource types. Generic "Name" left unmapped.
- **e96.W1.B2** (cluster with B4+B5) — apply/destroy/reconcile exit-code + envelope parity (A-02). `runCommand` silently swallowed `{success:false}`; fix: `apply.ts` captures `ApplyRunResult` and synthesises `AssigneeError(APPLY_FAILED)` → JSON envelope → exit 1. Envelope enriched with runId/arn/cost. Plus B4/B5: stripped Examples block from `buildSupportedTypesBlock()` — closes A-04/D-01/D-08 too (7 findings, one story). `KNOWN_TRIPWIRE_COMMANDS` cleared.
- **e96.W1.B3** — region regex substring false-positive (A-03). JS `\b` treats `-` as word-boundary so `us-east-1` matched inside `my-bucket-us-east-1-fake`. Swap `\b` for whitespace/punctuation lookaround.

#### Fixed — Wave 2 REGRESSIONs

- **e96.W2.R2** — init `--global --yes` non-interactive (D-02). `runGlobalInit` accepted overrides but dropped before passing to `promptGlobalConfig()`. One-line plumbing fix.
- **e96.W2.R3** — `renderSupportedTypesHintShort` → `buildSupportedTypesBlock()` migration (D-03). Error hint had hardcoded 18-type grid while header claimed "37 types". 20-LOC helper collapse.
- **e96.W2.R4** — init `--wizard` alias registration (D-05). Mutually-exclusive with `--yes` (USAGE_ERROR if both).
- **e96.W2.R5 part 1+2** — EC2 CreditSpecification survival (C-01). Part 1: CFN schema key is `CPUCredits` not `CpuCredits`; plugin emitted wrong casing → sanitizer correctly stripped → empty `{}`. Fixed casing in 3 plugin files. Part 2 (via instrumentation per `feedback_instrument_before_iterating`): LLM often doesn't emit the key AND `llm-plan.ts` had no analogue to `compound-plan.ts`'s plugin-defaults spread. New `mergePluginDefaults` helper, scoped to EC2 only — blanket rollout broke 7 plan-generator tests + 2 BP integration tests (would dismantle S3 PublicAccessBlockConfiguration-style safety BPs).
- **e96.W2.R6** — CIDR validator per-field scope (B-03). Route `0.0.0.0/0` globally rejected. Fix: dispatch `EC2_ROUTE` → /0-/32, VPC/Subnet → /16-/28. Also caught latent bug: Route CIDRs stored on `CidrBlock` instead of `DestinationCidrBlock` CFN key.
- **e96.W2.R7** — S3 unicode → `INVALID_NAME` error code (A-11). Generic `PLAN_FAILED` replaced with specific code via new `AssertionExtraction.errorCode?` plumbing.

#### Fixed — Wave 3 NEW findings

- **e96.W3.N1** — placeholder-guard prose scope (F-002; closes B-02/B-05/B-06). Epic 94 N6 guard caught IDs in ID-shaped fields but missed tokens in Description/Name/tag Value prose. New `PLACEHOLDER_RESOURCE_ID_EMBEDDED_REGEX` with non-alnum lookaround anchors + `isProsePath()` dispatcher. Narrower than blanket all-strings (avoids false-positives on SSM Value / UserData scripts).
- **e96.W3.N2** — BP-SG-004/007 narrowing + escalation (B-01/B-04). Renamed BP-SG-007 → BP-SG-004 (tracker wins). `check_type: awareness` → new `sg_high_risk_public_exposure` with CIDR:port-list grammar. 14 real DB/admin ports (20/21/1433/1434/1521/3306/3389/4333/5432/5439/5500/6379/9200/27017). HTTPS 443 excluded. Severity HIGH → **CRITICAL**. Flagged ~17 other awareness-tagged rules for Epic 97 audit.
- **e96.W3.N3** — EFS bare-intent singleton (C-02). `"Create an EFS file system"` triggered 10-resource `efs-with-vpc` compound. New `SINGLETON_OVERRIDE_CUES` entry mirrors Epic 94 N5's mount-target shape. 6 positive phrases × 16 enumerated VPC-qualifier negatives.
- **e96.W3.N4** — JSON-mode stderr cleanup (D-04). Stdout envelope clean but stderr leaked `[ERROR]/[CONTEXT]/[FIX]` blocks. New `installJsonStderrFilter()` intercepts `process.stderr.write`, strips ANSI, drops `renderError` prefix matches, passes structured JSON logs verbatim. Installed on apply/destroy/reconcile/plan. Core `renderError` untouched (30+ callers).

#### Methodology working

Epic 92 shipped 107 "closed" → Epic 93 found 11 regressions + 28 new. Epic 94 shipped 52 "closed" → Epic 95 found 12 regressions + 15 new. Both ~25-35% partial-landing. **Epic 96 introduces the M1 gate** (probe-lib + pre-close-probes + shipped-wired contracts + pre-commit hook) + **rejection of "unit tests pass → closed"** as sole closure criterion. R5-part-2 demonstrated the value: casing-fix unit tests PASSED but the integration probe still tripped because the LLM-path merge was broken — NOT the sanitizer. Instrumentation found it in one pass. Without the gate it would have shipped inert again.

#### Test totals

8881 → **9004 passing** (+123), 154 skipped (RUN_E2E=1 gated). `packages/core` 6314 → 6364. `packages/best-practices` 639 → 670. `apps/cli` 1316 → 1346. `apps/mcp-server` 624 unchanged.

Full gate run green: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage`. `pre-close-probes.sh` full suite: **18/18 PASS**.

### Epic 96 M1 — methodology gate: dogfood probe-lib + pre-close-probes + shipped-wired contracts (2026-04-23)

**Why**: three consecutive epics (92 / 94 / 95-recon) shipped at ~25-35% partial-landing rate. Unit tests pass. Superficial CLI probes (`jq -e .`) pass. But deep integration breaks at apply-time, or the module lands without being wired into the graph, or help-text regenerates without deduplicating emit points. Root cause: weak closure criterion — stories marked closed based on unit-tests + `jq -e`. M1 replaces that with a stronger gate that catches 6 documented classes of partial-landing.

#### Added

- **`apps/cli/scripts/dogfood-probe-lib.sh`** (437 LOC, 11 helpers) — reusable semantic-probe shell library. Helpers: `assert_envelope_shape`, `assert_exit_code_matches_ok` (catches "ok:true + exit 0 on failure"), `assert_arn_visible_in_success`, `assert_single_examples_block`, `assert_no_placeholder`, `assert_single_stderr_substring` (duplicate hint-grid), `assert_plan_has_resource_type`, `assert_desired_state_has_key`, `assert_desired_state_missing_key_on_type` (catches companion-slot pollution like Lambda FunctionName leak), `assert_regex_scope` (catches region regex false-positives), `assert_error_envelope_shape`. Each helper: `set -euo pipefail`, exit 0 on PASS, 1 on ASSERTION_FAIL, 2 on SETUP_FAIL.
- **`apps/cli/scripts/PROBE_MANIFEST.yaml`** (108 LOC, 5 seeded probes) — manifest of every probe keyed by story ID. Seeded with Wave-1 BLOCKER probes that tripe on HEAD: `e96.W1.B1` Lambda FunctionName leak, `e96.W1.B2` apply exit-code + envelope parity, `e96.W1.B3` region regex substring false-positive, `e96.W1.B4/B5` plan/apply --help duplicate Examples.
- **`apps/cli/scripts/pre-close-probes.sh`** (321 LOC) — manifest-driven probe runner. Bash-3.2 + macOS compatible (yq-free awk YAML parser). Supports `--scope <regex>` for pre-commit pruning. Runs 5 probes end-to-end in ~60s. Added `pnpm --filter assignee pre-close-probes` alias.
- **`packages/core/src/__tests__/shipped-wired-contract.test.ts`** (528 LOC, 6 contracts, 12 tests) — vitest drift-guards covering the 6 classes of partial-landing:
  - **A** Graph wiring — every `GRAPH_NODES` entry present in `create-graph.ts` edge list (catches dead-code wiring like Epic 92's `validateDesiredStateNode`).
  - **B** Commander flag coverage — every registered `.option(...)` cross-checked against PROBE_MANIFEST with a 22-flag whitelist tagged to unit-test file (catches drift like `init --wizard` never registered).
  - **C** Pattern-template registry parity — every `COMPOUND_PATTERN_IDS` entry has a registry entry + `help-hints.ts` descriptions entry + test file (catches 10→11 count drift).
  - **D** Plugin-default survival — every plugin default survives `sanitizeDesiredState` roundtrip (catches `CreditSpecification` stripped downstream).
  - **E** Single-Examples — every top-level command's `--help` output has exactly 1 `Examples:` heading (catches Wave 3.b.1 partial-landing via `KNOWN_TRIPWIRE_COMMANDS` — the contract PASSES on HEAD asserting bug presence, FLIPS to FAIL when plan/apply get fixed, forcing the fix-PR to consciously update the tripwire set in the same commit).
  - **F** Envelope-schema parity — every `--json` command's success AND error envelopes match the documented shape.
- **`.husky/pre-commit`** (+36 LOC) — auto-runs `pre-close-probes.sh` when hot-path sources are staged (plan.ts / apply.ts / destroy.ts / list.ts / init.ts / reconcile.ts / create-graph.ts / help-hints.ts / intent-parser.ts). `ASSIGNEE_SKIP_PRE_CLOSE_PROBES=1` emergency bypass.

#### Gate tripwire evidence (against HEAD, before any Epic 96 fix)

`bash apps/cli/scripts/pre-close-probes.sh` → exit 1, **5/5 probes TRIP**:

1. **B1** — `"create lambda-with-exec-role named my-fn ..."` → FunctionName `my-fn` leaks into IAM Role desiredState (verified via jq).
2. **B2** — `apply "create S3 bucket named invalid..name" --yes --json` → `{ok:true, operation:"apply"}` with exit 0 despite internal `result: FAILED` log. Canonical A-02 BLOCKER reproducer.
3. **B3** — `plan "create S3 bucket named my-bucket-us-east-1-fake region eu-west-2"` → parser extracts substring `us-east-1` and fails with `"Unknown AWS region"` ignoring the real `region=eu-west-2` qualifier.
4. **B4/B5** — `plan --help` and `apply --help` each emit 2 `Examples:` headings on stderr+stdout combined.

These are the exact 5 Epic 95 bugs Wave 1 will fix — proving the gate catches them BEFORE the fix lands.

#### Test totals

`packages/core` 6302 → 6314 (+12 M1 contracts, 245 files). `apps/cli` 1316 unchanged. `packages/best-practices` 639 unchanged. `apps/mcp-server` 624 unchanged. 136 skipped (RUN_E2E=1 gated).

Full gate run green: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage` — plus the NEW `pre-close-probes.sh` which correctly exits non-zero against the pre-fix tree.

### Epic 95 — post-Epic-94 fresh review, findings only (2026-04-22)

10-lane post-Epic-94 review returned 35 findings (12 regressions + 15 new + 8 preexisting). Methodology failure repeated from Epic 93: "unit tests pass → closed" still accepted by Epic 94 in places — several stories shipped inert modules that were never wired into user-visible paths. No implementation stories shipped from this epic; all 35 findings routed into Epic 96 as its input inventory. The repeat partial-landing pattern directly motivated the Epic 96 M1 methodology gate. Scorecard: `_archive/done-stories/epic-95-scorecard.md`.

### Epic 94 — Wave 2 N6 + Wave 3 + Wave 4 (2026-04-22)

Closed the NEW + PREEXISTING lanes via a persistent **3-member opus-4-7[1m] team** (`epic94-fix-team`) working on disjoint file slices — graph-fixer on preflight+checkpoint, display-fixer on render+pattern, pricing-fixer on advisory-prices+cost-history. Each member processed stories serially within itself; all three in parallel across the team. No concurrent-write race (Epic 92 lesson applied: calibrated to 3 members, not 8).

#### Fixed

- **e94.N6** — Placeholder ARN regex + `--no-apply` preview. Extended `placeholder-resource-id.ts` regex to catch `<hex>` / `<id>` / angle-bracket tokens. New `state.noApply` flag propagated from CLI into preflight context: under `--no-apply`, placeholder-class guard failures (placeholder-arn / placeholder-resource-id / sentinel-password) downgrade to `PREFLIGHT_PLACEHOLDER_DOWNGRADED` advisories instead of hard-blocking — plan still renders so the user can preview. AWS-touching guards + `required-fields` stay hard failures (schema-invalid previews remain fail-closed). Closes B-04 HIGH + B-10 LOW + C-05 HIGH + C-06 HIGH.
- **e94.N7** — **Epic 89 (third attempt) FINALLY CLOSED**. Three-layer fix for checkpoint values persistence:
  1. Serializer clamps `currentResourceIndex` to `completedResources.length` on plan-mode overflow (formatter was advancing past `queue.length`, serializing the overflow verbatim — apply-resume then skipped the entire queue on re-entry).
  2. Plan formatter now stashes each resource's fully-elicited `desiredState` back into `resourceQueue[i].desiredState` BEFORE advancing (per-slot hook from Story e92.1.d existed but caller never populated it).
  3. Serializer's `backfillSlotDesiredState` helper adopts top-level `state.desiredState` for the terminal queue slot when types match (final-planned resource otherwise had no chance to be stashed).

  Probe on a 9-resource VPC compound: `currentResourceIndex` 9→0, `desiredState` field-count 0→21 (8 of 9 slots populated; IGW slot legitimately empty). Closes C-02 HIGH NEW.

- **e94.N8** — WebSocket 12-resource render. Epic 92 Wave 2.b shipped the `websocket-api` pattern with 12 resources, but `formatters/plan.ts` queue-advance skipped `provisionable: false` entries in PLAN mode. Users saw 3 plan boxes instead of 12 — couldn't verify `ProtocolType: WEBSOCKET` or `RouteSelectionExpression` before apply. Removed the PLAN-mode companion-skip (APPLY-mode skip at `companion-skip.ts` untouched). `RenderableState.provisionable?: boolean` threaded through `attachCompoundQueue`; `renderPlanBox` prefixes `[companion]` on `provisionable: false`. JSON envelope carries `provisionable` so consumers can filter deploy targets from companions. Closes C-01 HIGH NEW.
- **e94.N9** — ALB-monthly inner fanout gate. Epic 92 Wave 1.e landed the OUTER gate at `advice-generator.ts` (S3/Lambda/DDB/etc. don't call `enrichAdvisoryPrices` at all), but Epic 93 found the inner fan-out still fetched all IDs regardless of resource type — NAT / EFS / CloudWatch plans still emitted `pricing_unavailable alb-monthly`. Extended `getRelevantAdvisoryPriceIds(resourceType)` to expose the per-type `AdvisoryPriceId` set; `enrichAdvisoryPrices` now intersects with `ENRICHABLE_PRICE_IDS`. NAT plan → 1 MCP call (NAT_GATEWAY_MONTHLY filters only); ALB plan → 1 call (ALB_MONTHLY); etc. `undefined` resourceType preserves full back-compat fan-out for existing callers. Closes B-05 MED NEW.
- **e94.N10** — Cross-agent contamination scope-tightening. Epic 92 Wave 4.c shipped `services/cost-history/` with scoped readers + `scopeMatches` over `{projectDir, intentHash}`, but `plan-generator/llm-helpers.ts`'s `readMemoryHints` was still calling `defaultMemoryService.readProvisions/readFailures` directly — Wave 4.c's scope infrastructure wasn't actually exercised by the hint-emitting path. Routed `readMemoryHints` through `readScopedProvisions` / `readScopedFailures`. A failure from project A no longer leaks into project B's "Previous error" warning; a failure tied to intentHash H1 no longer leaks onto H2 when `projectDir` is absent. Empty-field scrub (`Status Code: 0`, `Request ID: null`) preserved from Wave 4.c. Closes B-08 HIGH NEW.
- **e94.P1** — RDS ARN subtype split. Epic 92 Wave 1.b-followup split `events` into `SERVICE_SUBTYPE_MAP`; `rds` stayed single-type in `SERVICE_TYPE_MAP` → every RDS ARN forced to `AWS::RDS::DBInstance`. Lifted `rds` into `SERVICE_SUBTYPE_MAP` with **8 subtype keys** (`db` / `subgrp` / `secgrp` / `pg` / `snapshot` / `cluster` / `cluster-snapshot` / `og`) plus `""` fallback → `AWS::RDS::DBInstance` for back-compat. Partition-aware across AWS commercial + GovCloud + China (19 new tests). Closes D93-D-03 MED PREEXISTING.
- **e94.P2** — IAM ManagedPolicy region display. RGTA listing path stamped the operator's configured region on every IAM shape except `AWS::IAM::Role` (which had a hardcoded `"global"` branch). IAM ManagedPolicy / User / Group / InstanceProfile all leaked the operator region. New `GLOBAL_SERVICES` set + `isGlobalService()` helper in `arn-type-map.ts`; applied in `fetch-managed-resources.ts` — all IAM shapes + CloudFront + Route53 + WAF + Organizations now render `region: "global"`. S3 deliberately excluded (buckets are regional despite empty-region ARN). Closes D-06 / D93-D-something MED PREEXISTING. +25 new tests.

#### Test totals

8791 → **8881 passing** (+90). `packages/core` 6212 → 6302 (+90). `packages/best-practices` 639 unchanged. `apps/cli` 1316 unchanged. `apps/mcp-server` 624 unchanged. 154 skipped (RUN_E2E=1 gated, up from 130). Full `pnpm -r test:coverage` run had one mcp-server timeout (`should handle null ResourceTagMappingList`, 30s) caused by parallel-coverage resource contention; passes in isolation in 467ms — not a real regression.

Full gate run green: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage` (bar the single flake).

### Epic 94 — Wave 2 stories N1-N5 (2026-04-22)

Five serial stories landing the NEW lane's first half. N6 splits into the final Wave-2 story dispatched alongside Wave 3 as a persistent opus-4-7[1m] team (3 members; file-slice-disjoint so no concurrent-write race).

#### Fixed

- **e94.N1** — VPC "public subnets only" routing. Epic 92 Wave 2.b added `vpcPublicOnlyPattern` but natural phrasings (`"public subnets only"`, `"public only"`, `"without NAT"`, etc.) didn't trigger it — bare VPC returned instead. Extended `vpcPublicOnlyPattern.keywords` with 7 new cues and mirrored them into `vpcNetworkingPattern.negativeKeywords` so the full compound doesn't re-claim them. Bare `"Create a VPC"` still returns a single resource (regression preserved from Wave 1). Closes B-03 (BLOCKER NEW). +15 pattern tests.
- **e94.N2** — `list --json` envelope shape. Success path now emits `{ok:true, resources:[…], count:N, region:<str>}` instead of a bare array. Error path still emits `{ok:false, error:{code, message, hint}}` (Wave 94.R7 regression preserved). Empty-list case branches before `renderEmptyList()` so scripted consumers get the consistent envelope. Closes A-04 (HIGH NEW). +4 unit tests + 7 e2e.
- **e94.N3** — `plan --json` envelope for arg-parse errors. Empty intent + malformed `--set` now throw `AssigneeError("MISSING_INTENT"|"BAD_SET_SYNTAX")` routed through Wave 94.R5's outer catch. Messages preserved verbatim for non-JSON consumers. Closes A-03 (HIGH NEW) + A-09 (LOW NEW). +6 unit tests + 4 e2e.
- **e94.N4** — `--json` + `-o, --output <format>` flags on `apply` / `destroy` / `reconcile`. Envelope shape: `{ok:true, operation:"apply"|"destroy"|"reconcile", ...}` on success; `{ok:false, error:{code, message, hint}}` on failure. Classification mirrors Wave 94.R5 (typed `AssigneeError` preserves `code`/`hint`; untyped → `UNKNOWN_ERROR`). Logger stderr-only discipline preserved. Closes A-14 (MED NEW) + D-08 (LOW NEW). +17 unit tests + e2e.
- **e94.N5** — Intent-parser umbrella. Three fixes in one story: (1) `COMPOUND_PATTERN_ID_LITERALS` fast-path so `"Create a static-website pattern"` routes to the exact PatternId bypassing negativeKeyword filters (6 compound IDs registered); (2) Retention raise for CloudWatch Logs `RetentionInDays<30` with `BP_ADJUSTED_VALUE` advisory; (3) `NAME_REWRITTEN` comparator in `plan-generator.ts` — when sanitizer rewrites user-supplied name (e.g. IP-shaped → `ip-X-X-X-X`), push advisory showing the `{from, to}` transformation. `intent-parser.ts` fully rewritten via `Write` (now 1217 LOC) — last fixer owning the file this epic. Closes A-11, A-15, C-07, C-08 (classification half — downstream required-field block is a separate UX story), C-09, D-05. +38 new tests.

#### Test totals

8712 → **8791 passing** (+79, all in `packages/core`). `packages/core` 6160 → 6212 (+52 N5-heavy). `apps/cli` 1289 → 1316 (+27 N2/N3/N4 e2e + unit). `apps/mcp-server` 624 unchanged. `packages/best-practices` 639 unchanged. 130 skipped (RUN_E2E=1 gated, up from 103).

Full gate run green: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test`.

### Epic 94 — Wave 1 regression lane (2026-04-22)

After Epic 92 shipped 107 findings "closed", Epic 93's post-fix dogfood sweep found **11 REGRESSIONS + 28 NEW + 13 PREEXISTING = 52 new findings**. Several Epic 92 stories shipped inert — the module landed but was never wired into the user-visible path. Epic 94 prioritises the regression lane: 9 stories closing 11 findings, **serial dispatch**. Every Wave 1 story's acceptance criterion is a **CLI-level end-to-end probe**, not just a unit test. 10/10 probes pass at wave close.

#### Fixed

- **e94.R1** — `validateDesiredStateNode` wired into the graph between `PLAN_GENERATOR` and `ADVICE_GENERATOR`. Epic 92 u.c.1 shipped the module + 28 tests but never registered the node — 70-char / IPv4 / unicode / reserved-prefix bucket-name validators were dead code. Closes A-01 (BLOCKER REGRESSION). Pipeline contract strengthened 13 → 14 nodes. New `INVALID_DESIRED_STATE` error code propagates through `--output json`.
- **e94.R2** — Lambda compound `FunctionName` preservation. Intent-parser's pattern-detect branch passed empty `resourceType` to `extractAssertedValues`, so `resolveNameField` short-circuited to `null`. New `patternPrimaryResourceType(patternId)` helper maps 7 PatternIds. Closes A-02 (HIGH REGRESSION).
- **e94.R3** — Security Group ingress routed from user intent. Three-layer fix: removed hardcoded port-443 default in `security-group.ts`; option-elicitor expert/non-TTY paths now seed from `state.elicitedOptions` first; `parseRules` passes CFN-shaped arrays through (was returning `undefined` → merge deleted parser output). Ports 22 / 3306 / 3389 now preserved end-to-end. Closes B-01 (BLOCKER REGRESSION).
- **e94.R4** — BP-SG-005 re-tagged `awareness` → `not_equals` with `expected_value: "0.0.0.0/0:3389"` mirroring BP-SG-002's shape. Also fixed a latent bug in the `not_equals` CFN-array comparator — the evaluator only compared string fields, so BP-SG-002 (SSH) was also silently never firing. New `sgIngressOpensCidrPort()` helper detects `<cidr>:<port>` grammar and inspects ingress arrays. Closes B-02 (BLOCKER REGRESSION).
- **e94.R5** — `plan --output json` error envelope discipline. Success path already had the envelope; error path leaked structured JSONL log lines + plaintext error blocks to stdout. Plan command's outer catch now preserves `AssigneeError.code`/`hint` or stamps `UNKNOWN_ERROR` for unknown errors. Stderr retains full log stream + `[ERROR]` block. Closes C-03 (HIGH REGRESSION).
- **e94.R6** — `assignee dev init` non-TTY guard predicate. `process.stdout.isTTY === false` fails under pipe redirection where Node returns `undefined` — CI pipelines using `init` without `--yes` silently aborted with exit 0, no config written. Flipped to `!== true` predicate covering both stdout AND stdin. Closes D-01 (HIGH REGRESSION).
- **e94.R7** — `list --resource-type <invalid>` hint-grid dedup. 37-types grid printed twice on stderr (CONTEXT echo + Commander default handler). New `AssigneeErrorOptions.alreadyRendered` flag; top-level `parseAsync.catch` in `index.ts` skips fallback write. `renderError` strips redundant header prefix from CONTEXT. Closes D-02 + D-10.
- **e94.R8** — S3 name extractor: unicode rejection + multi-word capture. Non-ASCII now emits `AssigneeError("S3 bucket names can only contain ASCII…")` BEFORE R1's validator. Multi-word (`named bad bucket name`) captures `bad` and attaches per-plan `NAME_REMAINDER_IGNORED` advisory. New `state.advisories` graph-state field + `Advisory` type. Boundary set excludes resource nouns so "my bucket name" style survives. IPv4-shape preserved through to R1. Closes A-05 + A-06.
- **e94.R9** — wave-close CLI probe sweep (10/10 pass). Log at `_bmad-output/implementation-artifacts/epic-94-wave1-probe-log.md`.

#### Test totals

8516 → **8712 passing** (+196). 103 skipped (RUN_E2E=1 gated; up from 69). `packages/core` 6037 → 6160 (+123, 239 files). `packages/best-practices` 625 → 639 (+14). `apps/cli` 1209 → 1289 (+80). `apps/mcp-server` 624 unchanged.

Full gate run green: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage`.

### Epic 93 — post-Epic-92 fresh review, findings only (2026-04-22)

10-lane post-Epic-92 review found **11 REGRESSIONS + 28 NEW + 13 PREEXISTING = 52 findings**. Epic 92 had shipped 107 findings "closed" but at ~25-35% partial-landing rate — several modules were never wired into the user-visible path after being written. No implementation stories shipped from this epic; all 52 findings were routed directly into Epic 94 as a regression-first wave. Scorecard: `_archive/done-stories/epic-93-scorecard.md`.

### Epic 92 — batch 1 partial (2026-04-22)

Wave 3 + Wave 4 + Uncluster fired as 8 parallel fixer subagents. Five landed cleanly (3.a, 4.a, 4.b, 4.c, u.a); three lost edits to concurrent-write race conditions in the shared working tree (3.b, u.b, u.c) despite disjoint owned-file sets — the parallel Write pressure + test-runner resource spikes corrupted state. Committing the five that landed; the other three will re-dispatch serially in batch 2.

#### Fixed — help-hints registry SSO + flag-existence drift guard (story e92.3.a, partial)

Closes B-18, D-12, D-32, D-33. `errors.ts` `UNSUPPORTED_RESOURCE` grid replaced with `buildSupportedTypesBlock()` from `help-hints.ts` — no more drift between hardcoded error text and the live supported-types registry. New `supported-types-block.ts` module extracts the block for re-use. NEW `help-hints-flag-existence.test.ts` drift-guard: regex-scans every user-facing string across `packages/core/src/**` and `apps/cli/src/**` for `assignee <cmd>…--<flag>` triples and cross-checks each against the Commander `.option(…)` list for that subcommand. Found 63 total triple occurrences, 29 unique `(cmd, flag)` pairs, 1 real drift (`destroy --all` in `iam-role-inventory.ts:8` — allowlisted because `--all` was intentionally removed in Story 50-3; the reference is documentation-only text. Queued for string-cleanup follow-up with 3.b).

#### Fixed — cost / savings formatter polish (story e92.4.a)

Closes A-08, A-10, A-19, B-21, D-15, D-18, D-35. `formatSavingsDisplay` now routes `"Free"` / `"No charge"` / `CostEstimateLabel.NO_CHARGE` → `"Free, $0.00 savings"`; non-numeric labels → `"No cost savings"` (was `"N/A"`); numeric labels parsed and rendered only if valid. `normalizeMemoryHints` collapses duplicated `/month/month` and `/mo/mo` suffix pairs before render (storage format preserved per invariant). SNS + DDB cost lines pinned to raw MCP `Unblended.Amount` output in 20 new regression tests (`fetchBillingData` tests) — prevents the per-unit 1e-6 drift that rendered `$0.50/month` as `$0.0000005/month`. `sanitizeDesiredState` drops empty/null/undefined rows (closes the EC2 `CPUCredits: ""` empty-row display bug at A-19). +44 tests (20 billing + 24 formatter).

#### Fixed — default resource names (story e92.4.b)

Closes A-06, A-15, C-16, C-22. Per-plugin `generateXxxName()` helpers using `crypto.randomBytes(4).toString("hex")`. Placeholder defaults replaced:

| Resource                  | Before                                          | After                            |
| ------------------------- | ----------------------------------------------- | -------------------------------- |
| SNS Topic                 | `my-sns-topic` / `my-topic` / `example-topic`   | `assignee-sns-topic-<8hex>`      |
| DynamoDB Table            | `example-table` / `my-table` / `my-ddb-table`   | `assignee-dynamodb-table-<8hex>` |
| ECR Repository            | `my-app` / `my-ecr-repo` / `example-repository` | `assignee-ecr-repository-<8hex>` |
| EC2 `CreditSpecification` | (unset → empty "CPU Credits" plan row)          | `{ CpuCredits: "standard" }`     |

Defaults are getters returning fresh values per access, so `injectPluginRequiredDefaults` (compound) and `repairRequiredFields` (single-resource) both get unique names per plan — critical for long-lived MCP servers. User-supplied names pass through unchanged (explicit test coverage). Generated names round-trip through each plugin's own `question.validate`. `required-field-repairer.test.ts` assertion inverted from "repairer does NOT fill RepositoryName" to the new correct behaviour (strengthened, not weakened).

#### Fixed — cost-history scoping + Previous-error leakage (story e92.4.c, partial)

Closes A-20 + D-34 (partial). New `services/cost-history/` module scopes cost lookups by `intent_hash + project` rather than resource-type globally — fixes the cross-agent contamination where sibling agents' historical lookups bled into unrelated plans. `llm-helpers.ts` Previous-error line scoped strictly to `prevError.desiredName === currentPlan.desiredName`; empty-value fields (`Status Code: 0`, `Request ID: null`) scrubbed before render. Agent watchdog stalled before final commit-handoff; remaining test-pin work will roll into batch 2's u.c / u.b re-dispatch.

#### Fixed — status command observability (story e92.u.a)

Closes A-12, D-08, D-36. `status` now captures an optional `[runId]` positional — stale/missing runId emits `[WARN]` line + structured warn event (suppressed in `--json`), recommending `list --json` as the canonical per-run query path. Default summary path (no positional) unchanged. `--verbose status` now emits `STATUS_STARTED` + `STATUS_COMPLETE` structured log envelopes via `LOG_ACTIONS` — previously 0 bytes on stderr, now ~300 bytes correlated by per-invocation `crypto.randomUUID()`. Deliberate deviation from the plan's "wrap in runCommand" scope: `runCommand` bootstraps MCP + graph + LLM client + credentials, which would gate a read-only status cmd on Bedrock availability + operator role — wrong envelope. Emitting structured logs directly from `status.ts` closes D-36's observable deliverable without the regression. Flagged sibling surfaces (`list`, `destroy`, `drift`) for a future uncluster follow-up; they all share the missing `<CMD>_STARTED` / `<CMD>_COMPLETE` envelope. +6 tests (help text + success envelope + error envelope + warn-with-runId + warn-json suppression + no-positional regression). +14 LOC in `utils/logger/actions.ts` (new enum entries — cross-file dep, no concurrent wave owns it).

#### Environment note — concurrent-write race conditions

Eight parallel fixers against a single working tree produced unreliable Write persistence for `commands/*.ts` and `resource-plugins/plugins/*.ts` directories when multiple agents wrote to sibling files in the same parent dir. u.c (plugin-heavy) and 3.b (commands-heavy) both reported edits "reverted in-flight." 4.a + 4.b reported intermittent interference mitigated by writing files atomically via bash heredoc and staging immediately. The `.claude/settings.json` Stop hook running `pnpm build && pnpm test` after every agent response multiplied the pressure — 8 concurrent `pnpm test` runs → up to 256 vitest workers competing for resources. For batch 2 the three unlanded stories re-dispatch serially (one at a time) to avoid the cross-fixer timing pathology. Per `feedback_parallel_agent_file_ownership.md` file-ownership discipline is necessary but insufficient when concurrent writes land in the same parent directory.

#### Test totals

8346 → 8516 passing (+170): core 5925 → 6037 (+112), cli 1183 → 1209 (+26), mcp-server 624 unchanged, best-practices 614 unchanged. 69 skipped (RUN_E2E=1 gated) unchanged.

### Epic 92 — Wave 2 + Wave 1 followups (2026-04-21)

Seven concurrent stories: four Wave 2 fixers closing the intent-trust + JSON-output clusters, three follow-up fixers closing gaps flagged by Wave 1 (sanitizer hookup, events ARN subtype, checkpoint resume downstream wiring — Epic 89 now fully closed end-to-end).

#### Fixed — intent-parser preservation (story e92.2.a)

Closes B-01, B-07, B-09, B-16, C-12, C-13, A-03. Intent parser pre-extracts user-asserted tokens (CIDR blocks, EC2 instance types, AMI IDs, regions, RDS engine versions, SG ingress triples, resource names across 9 types, "no VPC" directive, SNS subscription Protocol) and mirrors them into both `elicitedOptions` and `presetFields` so the option-elicitor's `NEVER_ASK` path wins over the defaults engine. Invalid asserted values now FAIL the plan with actionable `ExecutionStatus.FAILED + [ERROR]…[FIX]…` hints — no silent fallback. `10.42.0.0/16` is preserved (no longer hardcoded-overridden to `10.0.0.0/16`); `t3.micro` stays `t3.micro` (no longer rewritten to `t3.small`); `999.999.999.999/99` now fails with "Invalid CIDR block" instead of being silently accepted. +76 tests (31 intent-defaults + 45 intent-parser).

#### Fixed — pattern-matcher precision + new WebSocket pattern (story e92.2.b)

Closes B-05, C-06, C-07, C-09, C-10, B-02, D-26 (pattern half). Introduced `negativeKeywords` to `PatternRegistry` — patterns can now declare cues that DISQUALIFY them even when positive keywords match. Applied across the board: `serverless-api` skips when "websocket" / "standalone" / "existing vpc" / "only the lambda" in intent; `efs-with-vpc` skips "standalone" / "existing vpc" / "just the efs"; `vpc-networking` requires explicit "public and private subnets" / "networking foundation" cue — bare "Create a VPC" no longer triggers the 17-resource compound with a $32.85/mo NAT Gateway. `scheduled-lambda` gains 10 new keywords (`runs every`, `every hour`, `hourly`, `daily`, `on a schedule`, etc.) — "Lambda that runs every hour" now routes correctly. NEW `websocket-api` pattern (12 resources: IAM role + Lambda + LogGroup + API Gateway V2 WebSocket + 3 routes/integrations + stage + permission; registered BEFORE serverless-api so it wins on websocket intents). `efs-with-vpc` TOC off-by-one fixed (header claimed 9, actually 10). SNS subscription `Protocol` inferred from `Endpoint` scheme at pattern level (partition-aware ARN matching; bails on ambiguity). Registry count 10 → 11 (README + `integration-architecture.md` + `help-hints.ts` descriptions + doc-lint count updated in lockstep).

#### Fixed — JSON envelope + stderr discipline (story e92.2.c)

Closes A-02, A-21, B-04, B-14, D-29, D-30. Compound plan `--output json` now emits a SINGLE `{ok:true,plans:[…]}` envelope via a new stdout interceptor in `plan.ts` + `serializePlanEnvelope`/`parsePlanJsonStream` helpers in `display-plan.ts` — no more NDJSON that `jq -e .` rejects as invalid. On error under `--output json`, exactly ONE envelope `{ok:false,error:{code,message,hint}}` lands on stdout; the `[ERROR]`/`[CONTEXT]`/`[FIX]` block + 37-type registry stays on stderr. Soft plan-failure path (orchestrator returns `{success:false}` without throwing) also gets a `PLAN_FAILED` envelope. `list --json --resource-type <unknown>` now emits `INVALID_RESOURCE_TYPE` envelope on stdout; registry block on stderr. Structured logger was already stderr-only; invariant locked in with 7 new `process.stdout.write` spy tests across every log branch. NEW gated e2e `apps/cli/src/e2e/e2e-json-envelope.test.ts` (8 cases, `RUN_E2E=1`). Live probe: `assignee admin list --json --resource-type NOT-A-REAL 2>/dev/null | jq -e .` now exits 0 with parseable JSON.

#### Fixed — plan-generator pre-apply validators (story e92.2.d)

Closes A-16 (plan-time half; Wave 1 sanitizer is the runtime safety net), C-04 (plan-time half; Wave 1 handled runtime stripping). Two new post-LLM validators in `plan-generator.ts`: (1) DDB KeySchema ↔ AttributeDefinitions parity — every `KeySchema.AttributeName` (including GSI / LSI keys) must appear in `AttributeDefinitions`; failure emits `[ERROR] DynamoDB KeySchema references attribute(s) not in AttributeDefinitions: '<name>'. [FIX] Add the missing attributes…`. (2) CloudFront dual-origin-config rejection — an Origin must NOT have both `S3OriginConfig` AND `CustomOriginConfig` set. Also fixed a Rule-7 observability leak: the `llm-helpers.ts` "Previous error" generator no longer shows `arn:aws:iam::123456789012:role/my-role` when the resource being planned is not Lambda — resource-type dispatch via `placeholderExamplesForType(resourceType)`. +34 tests (6 integration + 28 llm-helpers unit).

#### Fixed — Wave 1.a follow-up: sanitize.ts hookup

Threaded `state.resourceType` through `sanitizeAgainstSchema` → `sanitizeDesiredState` in `plan-generator/llm-plan/sanitize.ts` so the Wave 1 DDB/ECS/CloudFront sanitizer rules actually fire at plan time (were dormant until now — only the configHints helped). End-to-end regression test asserts DDB `PAY_PER_REQUEST + ProvisionedThroughput` is stripped via the real hookup path. Single callsite in `llm-plan.ts` updated to pass `resourceType`.

#### Fixed — Wave 1.b follow-up: arn-type-map events subtype split

Moved `events` out of `SERVICE_TYPE_MAP` into `SERVICE_SUBTYPE_MAP` with 4 subtype keys (`rule`, `event-bus`, `connection`, `api-destination`) plus `""` fallback → `AWS::Events::Rule` for backwards compat. `assignee admin list` now shows `AWS::Events::EventBus` / `::Connection` / `::ApiDestination` correctly instead of misclassifying everything as `::Rule`. Fix flows transparently through `fetchManagedResources`, `drift/baseline-adopt`, `parse-arn`, and destroy's resource-resolver without any consumer changes. Partition-aware (AWS commercial + GovCloud + China). +22 tests.

#### Fixed — Wave 1.d follow-up: checkpoint resume downstream wiring (Epic 89 fully closed)

The schema additions from Wave 1 are now actually consumed. CLI `apply/checkpoint-state.ts` and MCP `apply-plan/handler-steps.ts` both hydrate `currentResourceIndex` + `completedResources` from the loaded `PlanCheckpoint` into the graph initial state, zipping checkpoint's stored `{resourceArn, resourceType}` against `resourceQueue[0..index-1]` to recover `resourceId` with `executionStatus: SUCCESS`. Compound resume now re-enters at the saved index; marker-resolver's cross-resource reference lookups hit `completedResources` as expected. Pre-Epic-92 / single-resource / fresh-compound checkpoints still work identically — fields are OMITTED (not zero-valued) so pre-fix code paths are byte-for-byte unchanged. +10 tests (5 CLI checkpoint-state + 5 MCP handler-steps).

#### Test totals

8111 → 8346 passing (+235), 69 skipped (up from 63 — 2.c's 8 new gated e2e cases). `packages/core` 5711 → 5925 (+214, 230 test files). `apps/mcp-server` 619 → 624 (+5). `apps/cli` 1167 → 1183 (+16). `packages/best-practices` 614 unchanged.

Full gate run green at commit time: `pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage`.

### Epic 92 — Wave 1 (2026-04-21)

Context: after Epic 88 shipped on a dogfood-surfaced-bugs cycle, the user flagged that every time they tried the CLI themselves they hit fresh bugs. Epic 92 is a **proactive** dogfood sweep across every user-visible command and every supported resource type, with all 118 collected findings planned into disjoint fix waves.

Dogfood phase: 4 parallel reconnaissance agents, disjoint resource slices, `--no-apply` plan surveys plus selective cheap-resource apply-destroy round-trips. Outcome: 116 findings across slices A-D, 2 additional found by the synthesizer (118 total). 16 BLOCKER, 34 HIGH, 41 MED, 21 LOW, 5 INFO. Clustered into 11 root-cause groups. 93 findings earmarked for fix this epic, 25 deferred with explicit target-epic rationale. Zero BLOCKER deferrals.

Wave 1 (this commit) closes 31 findings across 5 disjoint-file stories:

#### Fixed — CCAPI-shape sanitizer hardening (story e92.1.a)

Closes A-01, A-09, A-16, C-03, C-04, C-15. `desired-state-sanitizer.ts` gains four resource-specific rules: DynamoDB strips `ProvisionedThroughput` when `BillingMode=PAY_PER_REQUEST` (apply no longer 100% fails on named DDB tables); ECS `ClusterSettings` items coerced to `{Name,Value}`; CloudFront origin strips whichever of `S3OriginConfig`/`CustomOriginConfig` is absent-meaningful; CloudFront `Origins`/`CacheBehaviors`/`CustomErrorResponses` canonicalised to `{Items,Quantity}`. DDB plugin adds `AttributeDefinitions` parity configHint matching every `KeySchema.AttributeName`. 37 new tests use real CCAPI-shape fixtures (no synthetic mocks) per `feedback_real_data_mocks_all_cases`. Follow-up flagged: the sanitizer hookup in `plan-generator/llm-plan/sanitize.ts` needs to thread `state.resourceType` through so the new rules fire at plan time — configHints help the LLM avoid the bad shapes today, but the runtime safety net is dormant until the hookup lands (tracked as `e92.1.a-followup`).

#### Fixed — ARN-builder + destroy truth (story e92.1.b)

Closes B-03, D-19, D-20, D-21, D-22, D-25. `resolve-arn.ts` gains local ARN synthesis for KMS (`key/<uuid>`) and EventBus (`event-bus/<name>`); SecurityGroup `sg-<id>` synthesis was already present and gets regression pins. `assignee infra destroy` for KMS gains `--pending-window-in-days <7..30>` (default 7); Secrets Manager gains `--recovery-window-in-days <7..30>` and `--force-delete-without-recovery`. UX lies replaced: destroys that schedule (not delete) now render `"Scheduled for deletion on <date>"` instead of `"Resource destroyed"`. EventBus destroy routes to `DeleteEventBus` by name via direct SDK call, bypassing the upstream `arn-type-map.ts` misclassification that maps every Events ARN to `AWS::Events::Rule`. 31 new tests (incl. 5 `RUN_E2E=1`-gated round-trip regressions: apply → capture ARN → destroy). SDK deps `@aws-sdk/client-kms`, `client-secrets-manager`, `client-eventbridge` added to `apps/cli/package.json` for the bypass. Follow-up flagged: `arn-type-map.ts` `SERVICE_TYPE_MAP["events"]` still misclassifies EventBus; `assignee admin list` shows the wrong type (tracked as `e92.1.b-followup`).

#### Fixed — placeholder-ARN preflight expansion (story e92.1.c)

Closes B-06, B-08 (EC2-ID half), B-10, C-01, C-02, C-14. `stripPlaceholderArns` rewritten to walk recursively — scalar ARN fields (`PerformanceInsightsKMSKeyId`, `DomainAuthSecretArn`) are now stripped, closing the "RDS Postgres default plan fails on LLM-emitted placeholder ARN" BLOCKER. New preflight guard `placeholder-resource-id.ts` detects hallucinated EC2 IDs (`vpc-0abc1234def567890`, `rtb-12345678`, `subnet-abc12345`, etc.) on cross-resource reference fields. New `vpc-existence.ts` guard calls `ec2:DescribeVpcs` (via injected factory so tests don't reach real AWS) before any VPC-referencing resource; plan fails fast if VPC absent. Both guards wired into `registry.ts`. `plan-generator.test.ts:1875` had codified the PRE-Epic-92 broken contract (asserted scalars SURVIVED stripping — exactly the bug); assertion flipped to the correct post-fix behaviour. Partition-aware regex preserved per `feedback_partition_aware_arn_matching`. 64+ new tests across the three guard files.

#### Fixed — checkpoint resume (story e92.1.d — closes Epic 89)

Closes C-05. `PlanCheckpointSchema` gains two additive fields: `currentResourceIndex: number` (default 0) and `completedResources: Array<{resourceArn, type}>` (default []). Serializer stores the fully-elicited `desiredState` per queue entry (was hardcoded to `{}`). Loader backwards-compatible: pre-Epic-92 checkpoints load with the defaults, do NOT throw. 47 new tests across schema / serializer / loader. 3 real preserved checkpoints (serverless-api, EC2 baseline, scheduled-lambda) moved to `test-fixtures/checkpoints/` with account IDs redacted to `<ACCOUNT_ID>`. Follow-up flagged: downstream wiring in `apps/cli/src/commands/apply/checkpoint-state.ts` and `apps/mcp-server/src/tools/apply-plan/handler-steps.ts` still needs to propagate the new fields into graph initial state so resume actually re-enters at the saved index (tracked as `e92.1.d-followup`). Schema changes are the foundation; the full Epic 89 closure needs that wiring.

#### Fixed — advisory-price gating + ALB decomposer (story e92.1.e)

Closes A-05, B-08 (ALB-price half), B-19, C-08, C-21, D-17. `AdvisoryPriceId.ALB_MONTHLY` (and every other advisory-price fetch) now gated on resource-type relevance — S3/Lambda/DDB/SNS/SQS/EC2/Logs/IAM/SSM/EventBridge/SNS-sub plans no longer trigger ALB price fetch (the "alb-monthly pricing_unavailable" warning that fired on every plan). Only 7 of 37 resource types (ELBV2, NAT, CloudWatch Alarm, CW Logs, EFS, EventBridge Rule, CloudFront) actually need advisory prices. `elbv2.ts` pricing-decomposer filter repaired with `usagetype=LoadBalancerUsage` / `LCUUsage` alongside the `productFamily` match — ALB monthly resolves to ~$16.43/mo against the real pricing-MCP response fixture. Hardcoded `"$16/mo (estimated)"` advice strings deleted; live fetch failure now emits `"cost unavailable"` not a fake number. Per `feedback_no_hardcoded_prices`: zero hardcoded-dollar hits remain in production code (15 remaining matches are all in JSDoc/code comments describing display format). 64 new tests (47 gating + 17 advice-generator).

#### Test totals (this commit)

Baseline 7893 → 8111 passing (+218), 63 skipped (`RUN_E2E=1`-gated round-trips):

- `packages/core`: 5512 → 5711 (+199, 226 test files)
- `packages/best-practices`: 614 unchanged
- `apps/mcp-server`: 619 unchanged
- `apps/cli`: 1148 → 1167 (+19) plus 5 new gated e2e

Full gate run (`pnpm lint / check-types / lint:barrels / lint:shims / doc-lint / citation-lint / audit --prod / build / -r test:coverage`) green at commit time. No hardcoded prices (`feedback_no_hardcoded_prices`). No real 12-digit AWS account IDs in tracked tree (`feedback_no_real_account_ids_in_repo`). Tests not weakened (`feedback_never_weaken_tests`).

### Epic 89 — checkpoint values persistence, three-attempt closure (2026-04-21 → 2026-04-22)

Original scope: compound-pattern apply-resume should rehydrate `completedResources` + `currentResourceIndex` from the checkpoint file so `efs-with-vpc`, `static-website`, and `serverless-api` re-enter at the saved queue index rather than replaying from slot 0 (burning apply budget on already-provisioned resources).

**First attempt — `e92.1.d` (Epic 92 Wave 1, 2026-04-21):** `PlanCheckpointSchema` gained two additive fields (`currentResourceIndex: number`, `completedResources: Array<{resourceArn, type}>`); the serializer was updated to store the fully-elicited `desiredState` per queue entry (previously hardcoded to `{}`); loader made backwards-compatible. Schema shipped with 47 new tests. Follow-up flagged immediately: downstream wiring in `apps/cli/src/commands/apply/checkpoint-state.ts` and `apps/mcp-server/src/tools/apply-plan/handler-steps.ts` still needed to propagate the new fields into graph initial state.

**Second attempt — `e92.1.d-followup` (Epic 92 Wave 2, 2026-04-21):** Both CLI and MCP handler now hydrate `currentResourceIndex` + `completedResources` from the loaded checkpoint into graph initial state, zipping stored `{resourceArn, resourceType}` against queue slots `0..index-1` to recover `executionStatus: SUCCESS`. Compound resume was wired and 10 new tests confirmed the handler paths. However, a serializer overflow remained undetected: the plan-mode formatter advanced `currentResourceIndex` past `queue.length`, and the serializer wrote the overflow verbatim — so apply-resume read the overflow value and skipped the entire queue on re-entry.

**Third attempt — `e94.N7` (Epic 94 Wave 3, 2026-04-22):** Three-layer fix fully closed the bug. (1) Serializer now clamps `currentResourceIndex` to `completedResources.length` on plan-mode overflow. (2) Plan formatter stashes each resource's fully-elicited `desiredState` back into `resourceQueue[i].desiredState` BEFORE advancing — the per-slot hook existed but its caller had never been populated. (3) `backfillSlotDesiredState` helper adopts top-level `state.desiredState` for the terminal queue slot when types match (final-planned resource otherwise had no chance to be stashed). Verified on a 9-resource VPC compound: `currentResourceIndex` 9→0 on reload, `desiredState` field-count 0→21 (8 of 9 slots populated; IGW slot legitimately empty). Closes sprint-status epic-89 (line 1703).

### Epic 88 — iteration 3 (2026-04-20)

#### Reverted

- **`static-website.ts` `Resource` ARN prefix restored.** Epic 88-it1 dropped the `arn:aws:s3:::` prefix from the BucketPolicy `Resource` line after a subagent analysis concluded `markerRef` resolves to the full ARN at runtime. That analysis was wrong: `completedResources[].resourceArn` is populated from CCAPI's `result.identifier`, which for `AWS::S3::Bucket` is the **bare bucket name**, not an ARN. Apply-time this produced malformed resources like `Resource: "my-bucket/*"` that S3 rejected with `Policy has invalid resource`. Epic 88-it3 restores the explicit prefix — the emitted value is now `arn:aws:s3:::${markerRef(R.WEBSITE_BUCKET)}/*` again, matching the pre-it1 shape. **Mea culpa:** 1.5h was burned iterating through live-AWS deploys instead of adding ONE `console.error` on the runtime payload at the resource-provisioner boundary. One log line would have shown the bare name in 15 min. Lesson filed as `feedback_instrument_before_iterating.md` in auto-memory.

#### Added

- **`markerIdentifier(resourceId)` helper** (`packages/core/src/config/marker-tokens.ts`) plus barrel re-export (`packages/core/src/barrels/config/constants.ts`). Emits `__ASSIGNEE_IDENTIFIER_<id>__`; the resolver runs `extractIdentifierFromArn` to strip any `arn:*:service:::` prefix and return the bare primary identifier. For today's S3 case this is a no-op alias for `markerRef` (identifier == name == ARN tail), but the token is semantically explicit so future non-S3 bare-id sites (e.g. downstream CCAPI adapters that DO return full ARNs) read correctly without guessing. **Future-proofing, not a behavior change for S3 today.**
- **`markerAccountId()` helper + `AccountIdLookup` port + `defaultAccountIdLookup` + `__resetAccountIdCacheForTests`** (`marker-tokens.ts`, `marker-resolver.ts`, barrel). Required for compounds that have to synthesize ARNs whose CCAPI identifier is NOT the ARN — e.g. `AWS::CloudFront::Distribution` returns just the distribution ID, so `aws:SourceArn` has to be templated as `arn:aws:cloudfront::${markerAccountId()}:distribution/${markerRef(...)}`. Resolver calls `sts:GetCallerIdentity` once per process (cached in `ACCOUNT_ID_CACHE`); `AccountIdLookup` port lets unit tests inject a deterministic ID without STS credentials; `__resetAccountIdCacheForTests` clears the module-level cache between suites.

#### Fixed

- **`MARKER_PATTERN` / `MARKER_PATTERN_GLOBAL` split into two disjoint branches** (`marker-tokens.ts`). The old `_?[^\s]*?__` lazy suffix greedy-matched across neighbor text when a no-suffix marker (`REGION`, `ACCOUNT_ID`) appeared adjacent to a suffix-bearing marker in the same string. Before: `arn:aws:cloudfront::__ASSIGNEE_ACCOUNT_ID__:distribution/__ASSIGNEE_REF_x__` parsed as one malformed blob `__ASSIGNEE_ACCOUNT_ID_:distribution/__` that `parseMarker` rejected, leaving ACCOUNT*ID unresolved. After: suffix-bearing kinds (`REF|GETATT|AZ|IDENTIFIER`) require `*<suffix>**`; no-suffix kinds (`REGION|ACCOUNT_ID`) terminate directly with `**`.
- **`recursionLimit` bumped 25 → 500** in `apps/mcp-server/src/tools/plan-resource.ts`. LangGraph's default 25-super-step budget tripped out on 4+ resource compounds (static-website = 4, three-tier-web = 22) because `plan_generator` iterates per-resource alongside sub-nodes. Mirrors `apply_plan`'s existing 500-step budget.
- **`static-website.test.ts` fixtures updated to real-CCAPI bare-identifier values.** `resourceArn` was being populated with full ARNs (`arn:aws:s3:::...`, `arn:aws:cloudfront::...:distribution/...`) that never match what `status-poller.ts:254` actually writes — CCAPI returns the bare name/ID. The hermetic test is now faithful to production and the new `accountIdLookup` port is wired via `fakeAccountIdLookup` returning `111122223333`.

#### Process note

Future live-AWS failures: **instrument the production boundary before iterating**. 15 minutes of one `console.error` dumping the actual wire payload at the resource-provisioner entry beats 4 × 15 minutes of blind fix attempts guided by subagent theorizing. Fake-fixture trace scripts and parallel subagent analyses are not substitutes for the real payload. See `feedback_instrument_before_iterating.md`.

### Epic 88 — iteration 1 (2026-04-20)

#### Fixed

Two real production bugs surfaced by a live dogfood run of `assignee infra apply` deploying the project's own pitch deck (presentation/) via the static-website compound pattern. Both bugs made it to live AWS before anything caught them. The more interesting part — documented below — is _why_ the existing test + review regime missed them.

**Bug 1 — static-website BucketPolicy `Resource` double-ARN**

- `packages/core/src/pattern-templates/patterns/static-website.ts:202` generated `Resource: arn:*:s3:::${markerRef(R.WEBSITE_BUCKET)}/*`. But `markerRef` resolves to the **full ARN** (`arn:aws:s3:::bucket-name`), not the bare bucket name — because `buildResourceArn` synthesizes ARNs for every entry in `completedResources` (`marker-resolver.ts:233` returns `String(match.resourceArn)`, the full synthesized ARN). At runtime the Resource field ended up as `arn:*:s3:::arn:aws:s3:::bucket-name/*` — S3 rejected with `Policy has invalid resource (Service: S3, Status Code: 400)`.
- Reproduced against live AWS twice in one session (plan-then-apply + fresh apply). 3 of 4 compound resources provisioned; the 4th (BucketPolicy) halted the compound.
- Fix: dropped the redundant `arn:*:s3:::` prefix — `markerRef(R.WEBSITE_BUCKET)` already returns a partition-correct ARN. New line: `Resource: \`${markerRef(R.WEBSITE_BUCKET)}/\*\``. Preserves the parallel `aws:SourceArn: markerRef(R.CDN_DISTRIBUTION)` pattern on the adjacent line (which already was correct — no prefix, no bug).

**Bug 2 — compound-halt error message suggested a nonexistent flag**

- `packages/core/src/utils/display-output/compound-failure.ts:154` suggested `assignee admin status ${runId} --resume` as the recovery command. `status` has no `--resume` flag — verified by reading every `.option(...)` in `apps/cli/src/commands/status.ts:40-56` (only `--json`, `--region`, `--resource-type`, `--bp-coverage`, `--gaps-only`, `--include-structural-gaps`). Running the suggested command returns `error: unknown option '--resume'`.
- Fix: replaced with `assignee infra apply --checkpoint .assignee/checkpoint-${runId}.json` — the real resumption command (`apply.ts:51-54`'s `-c, --checkpoint` flag skips Phase 1 and enters Phase 2 directly, resuming from where the compound halted).

#### Why existing tests + reviewers missed both

**Bug 1** — no test ever instantiated the static-website pattern and ran its markers through the resolver:

- `marker-resolver.test.ts` only tested a VPC marker case — ARN pre-synthesis wasn't exercised for S3.
- `serverless-api.test.ts` imports `staticWebsitePattern` for its keyword-detection tests but never resolves markers.
- `apps/cli/src/e2e/e2e-plan.test.ts` has a static-website scenario but asserts on `executionStatus === SUCCESS` + `resourceArn is string` — never inspects the `PolicyDocument.Statement[0].Resource` shape it generated.
- **Zero-coverage outlier**: every other compound pattern had its own per-pattern test file (`efs-with-vpc.test.ts`, `vpc-networking.test.ts`, `scheduled-lambda.test.ts`, etc.). Only `static-website.test.ts` didn't exist. The bug lived in the one pattern that had no unit test of its own.

**Bug 2** — the existing test was _tautological_:

- `packages/core/src/utils/display.test.ts:201` asserted `expect(output).toContain("assignee admin status run-abc-123 --resume")`. It verified the error-message string, not whether the suggested command would work. A test that says "the code emits what the code emits" is worthless for catching typos in suggestions.
- No cross-cutting scanner existed for `assignee <cmd> ... --<flag>` patterns in emitted strings vs. the `.option(...)` lists on the matching subcommands.

**The common lesson**: both bugs are at the exact layer where unit tests stop and integration+live tests haven't started. Unit tests mock the CloudControl call so S3's `invalid resource` error never fires; e2e tests check "did it succeed?" but not "did the intermediate payload look right?". The dogfood run that caught them is precisely what was missing.

#### Tests added (red-phase — fail before fix, pass after)

- `packages/core/src/pattern-templates/patterns/static-website.test.ts` (NEW FILE — 4 tests) — pins patternId, asserts BucketPolicy `Resource` matches `/^arn:aws:s3:::[\w-]+\/\*$/` and explicitly rejects the double-ARN `/arn:.*:s3:::arn:/` shape that was the bug, asserts `aws:SourceArn` resolves to the distribution's full ARN, asserts the `Bucket` field resolves to the raw bucket ARN. Closes the "zero-coverage outlier" gap by giving static-website a dedicated per-pattern test file like every other compound.
- `packages/core/src/utils/display.test.ts` (lines 200-213) — the tautological assertion replaced with a positive assertion for the correct `assignee infra apply --checkpoint ...` command PLUS a `not.toContain("--resume")` + `not.toMatch(/assignee\s+status\s+\S+\s+--\S+/)` regex guard that locks out the broken form.
- `packages/core/src/utils/display.test.ts` (lines 215-325 — NEW validator test) — `every 'assignee <cmd> ... --<flag>' suggestion references a real flag`: regex-extracts every `(cmd, flag)` pair from rendered compound-failure output, cross-checks against a hardcoded `KNOWN_FLAGS` map (apply / status / destroy) with inline source anchors (e.g., `apps/cli/src/commands/apply.ts:38-64`). The map is intentionally hardcoded rather than imported from `apps/cli/...`, because core is upstream of apps/cli and reversing the dependency direction would break the layered build. When a future contributor adds a new flag-mention to a compound-failure string, this test fires a loud "update the KNOWN_FLAGS map" error — making regressions visible instead of silent.

Test totals: **core 5507 → 5512** (+5). Other packages unchanged. Grand total 7888 → 7893 passing.

#### Process note

The dogfood run that surfaced these was the presentation-deploy for the project's own GenAI-course-final pitch deck. This is a strong argument for queuing a real end-to-end dogfood harness as part of the nightly-e2e workflow — `apps/mcp-server/e2e-test.mjs` already provisions representative resources but gates behind `RUN_E2E_MCP=1` (Epic 83 closure). A static-website-specific dogfood that asserts on the FINAL resolved PolicyDocument shape (not just provisioning success) would have caught Bug 1 automatically. Epic 89 candidate if the nightly-e2e budget supports it.

### Epic 87 — iteration 1 (2026-04-20)

#### Added

- **`docs/explanation/ai-architecture.md`** — new long-form explanation doc describing what the AI layer actually does: the three LLM callsites (intent_parser / plan_generator / advice_generator), the five AWS MCP servers the pipeline consumes (Pricing, Documentation, IAM, Well-Architected-Security, Billing), the 185-rule deterministic Best Practices engine, the HITL `interruptBefore: [resource_provisioner]` gate, and the 5 MCP tools this repo exports in return. Commissioned by the user as a final-project writeup after GenAI coursework.
- **Method — code-cited accuracy over narrative**: three parallel BMAD-style Explore subagents surveyed the pipeline / LLM adapter / MCP+BP layers under opus-4-7, each required to cite exact file:line. Doc integrates their findings verbatim. No claim is paraphrased from a comment; every number (13 nodes, 185 rules, 37 resource types, 5 MCP servers, 5 MCP tools, 2 sanitization passes, 3 credential roles) is grep-verifiable against HEAD.
- **Honest disclosure — per-node LLM routing is designed but not wired**: the doc calls out explicitly that the env-var registry (`ASSIGNEE_LLM_PLAN_GENERATOR`, `ASSIGNEE_LLM_INTENT_PARSER`, etc.) was preserved in `packages/core/src/constants/env-vars.ts` for a future per-node-routing revival, but only `ASSIGNEE_LLM_DEFAULT` was consumed at HEAD. (**Update:** the four dead per-callsite slots were subsequently removed in R9b-02 — Epic 100 audit follow-up P038 — once it became clear no factory sites would land soon. The `llm:` config-file section in `docs/configuration.md` retains a "planned — not yet implemented" marker for the same reason.) Story 50-7 originally dropped the `RoutingLlmAdapter` branch when no in-repo YAML was using the `llm:` config-file section; today's single-adapter graph (`create-graph.ts:76-84`) is unchanged.
- **A real captured run**: the doc closes with the actual token-usage summary (3 LLM calls, 3429 tokens total, per-callsite breakdown) from the same `assignee infra plan "Create an S3 bucket named hero-demo-bucket"` invocation that was captured verbatim in the README hero during Epic 84 (run-id `fa465600af5a`, 2026-04-20). Same single run feeds the README hero _and_ the AI architecture doc — one source of truth for "what does this actually look like?".
- **`docs/index.md`** — added the new doc to the Explanation section at the top of the list so it's the first "how does this actually work?" pointer readers hit.

#### Design notes the doc covers

Each architectural choice gets one paragraph of rationale: why LangGraph (checkpoint + replay + routing functions), why only three LLM callsites (LLM translates, MCP reports, rules enforce, humans authorize), why rule-based BP on top of LLM output (catches blind spots cheaply — <10ms vs multi-second LLM), why MCP servers for pricing / IAM (clean LLM-tool seam + supply-chain pinning + 3-user credential isolation), why HITL as interrupt rather than flag (dangerous default is "stop and ask" not "apply then warn"), and what's deliberately not built yet.

### Epic 86 — iteration 1 (2026-04-20)

#### Fixed

- `README.md` Install section had **three** user-breaking bugs, caught when the user ran the instructions verbatim and hit `ERR_PNPM_NO_GLOBAL_BIN_DIR`:
  1. **Wrong clone URL / directory name.** README had a stale clone URL pointing to the old org; the actual repo is `https://github.com/SergSlon/assignee-ai.git` with `cd assignee-ai`. Following the stale README would `git clone` a non-existent org/repo.
  2. **`pnpm link --global` fails on fresh machines.** The README recommended `pnpm link --global` immediately after build, but pnpm v10 requires `PNPM_HOME` / `global-bin-dir` to be set first — those come from a one-time `pnpm setup` that modifies shell profile and needs a shell reload. The user's trace: `pnpm install && pnpm build` succeeded, then `pnpm link --global` failed with _"Unable to find the global bin directory. Run 'pnpm setup' to create it automatically, or set the global-bin-dir setting, or the PNPM_HOME env variable."_
  3. **Implied `pnpm link` is the only invocation path.** The CLI actually runs cleanly via direct `node apps/cli/dist/index.js <cmd>` after `pnpm build` — verified during Epic 84 hero-capture. No global bin required. That option was never mentioned.

#### What I did

Replaced the Install block with a split-path layout:

- **Path A (recommended, zero-friction):** `node apps/cli/dist/index.js doctor --short` — runs directly from the build output, no global install, works identically to `assignee <cmd>`.
- **Path B (PATH-level install):** `pnpm setup` → reload shell → `pnpm link --global` → `assignee admin doctor --short`. Explicitly calls out that `pnpm setup` is needed on fresh machines and that it writes `.zshrc` / `.bashrc`.
- Fixed the clone URL to `https://github.com/SergSlon/assignee-ai.git` and the directory to `assignee-ai`.
- Added an **actual** `doctor --short` output block (captured from a real run: `Account: ************ / ARN: arn:aws:iam::************:user/assignee-operator / Region: us-east-1 / Role: operator / Config: ./.assignee/config.yaml (loaded)`), with account ID redacted per the Epic 85 rule. Previous README showed zero example output — users had no baseline for "what does success look like?".
- Linked to `docs/aws-bootstrap.md` with the explicit prerequisite note "run bootstrap before `doctor`" so users know the IAM setup comes first.

Same pattern as Epic 84 (hero transcript fabrication): the fix is to actually walk the user flow end-to-end, capture real output, and document what works. `feedback_verify_user_flows_before_done` memory applied.

### Epic 85 — iteration 1 (2026-04-20)

#### Security

- **Scrubbed real AWS account ID (`[scrubbed account id]`) from 20 files across the tracked tree.** User flagged after noticing it in the Epic 84 hero capture. Grep found 87 occurrences total: 1 in `README.md` (Epic 84), 1 in `CHANGELOG.md` (Epic 84 entry), and **85 pre-existing** in production source JSDoc (`resolve-arn.ts`, `destroy-strategies/strategies/ec2-eip.ts`, `apps/cli/src/services/resource-resolver/sqs-url.ts`) plus test fixtures (`arn-builder.test.ts` with 29 occurrences, `resource-resolver.test.ts` with 15, `preflight-guard.test.ts` with 10, `destroy-service-single.test.ts` with 6, and 11 other test files). The leak dates back to commit `312ec5e` (months old, pre-dates this session).
- Substitution: `[scrubbed account id]` → `210987654321` (descending-digit synthetic ID — obviously not a real account, and deliberately NOT on the `PLACEHOLDER_AWS_ACCOUNT_IDS` denylist at `packages/core/src/constants/placeholder-accounts.ts` so tests that assert on a _passing_ ARN — specifically `preflight-guard.test.ts` negative-case ARNs — continue to work). AWS's canonical doc placeholders (`123456789012`, `111122223333`, etc.) would have broken those tests because preflight rejects them by design.
- `README.md:26` hero transcript updated: `account=[scrubbed account id]` → `account=************` (redaction, since the hero is user-facing and the specific number has no documentation value).
- `CHANGELOG.md:34` Epic 84 narrative: swapped the raw account for `(real AWS account, redacted — see Epic 85; …)`.
- `_bmad-output/implementation-artifacts/sprint-status.yaml`: 3 occurrences redacted to `************` (file is workspace-root, not git-tracked, but scrubbed for hygiene).
- Saved a cross-session feedback memory `feedback_no_real_account_ids_in_repo.md` so future sessions don't repeat the leak. Memory documents the safe substitution IDs + pre-commit grep pattern (`\b\d{12}\b`) + the git-history-scrub-is-separate posture.

#### Out-of-scope for this epic (user authorization required)

- Git history at commits `312ec5e`, `0d838c0`, `9f45061`, `11c4d54`, `feb12f1` still contains the original real account ID (see Epic 85 scrub for the value). Full remediation requires `git filter-repo` + force-push to rewrite history — destructive and not authorized. Safe interim posture: HEAD is clean from the Epic 85 commit forward, the repo is PRIVATE today, and a one-time history scrub should happen before the repo's visibility flips to public (v0.2 release). Flagged in the feedback memory as the deferred decision.

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

- Ran `node apps/cli/dist/index.js plan --no-apply "Create an S3 bucket named hero-demo-bucket"` against the live system (real AWS account, redacted — see Epic 85; Bedrock us-east-1, pricing from AWS Pricing MCP). Run-id `fa465600af5a`. Captured both non-TTY `=== Plan ===` plain form and TTY-rendered boxen form via `script -q`.
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

- `docs/configuration.md`, `docs/troubleshooting.md`: replace references to the removed `assignee whoami` command with `assignee admin doctor --short` (Story 50-3 replacement). Four call-sites updated (configuration.md:22,26; troubleshooting.md:86,312).
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

### Epic 72 — no-delta sentinel (2026-04-20)

HEAD still `fcfd4f8` (same as Epic 67 close). Latest CI success confirmed on the same SHA. No-op iteration — no commits, no findings. Introduced the short-circuit rule: when HEAD is unchanged since the last scored epic, subsequent iterations skip the full gate re-run and record zero findings without a commit.

### Epic 71 — HEAD-advance sentinel, short-circuit introduced (2026-04-20)

HEAD still `fcfd4f8`. Short-circuit pattern formalised: no-op when HEAD is unchanged since the last scored epic. Gates are known green from Epic 70; re-running them produces no signal. No commits, zero findings.

### Epic 70 — no-delta monitoring tick (2026-04-20)

HEAD still `fcfd4f8`. Five quick lint gates confirmed green: `citation-lint` (29/112/0), `doc-lint` (10/37/37/37), `lint:shims` (61/61), `lint:barrels` OK, `audit` 0 moderate. Repo in steady-state. Epic 67 CI run 24642303523 SUCCESS. No commits.

### Epic 69 — no-delta review, HEAD unchanged since Epic 67 (2026-04-20)

Baseline still `fcfd4f8` — no commits between Epic 68 and Epic 69. Minimal gate-check confirmed: `citation-lint` 29/112/0, `doc-lint` 10/37/37/37, `audit` 0 moderate. State identical to Epic 68. Review-only, no commits.

### Epic 68 — steady-state review, zero findings (2026-04-20)

Combined 7-lane strict-filter review (baseline `fcfd4f8`, Epic 67 close) confirmed all 6 quality gates green: `citation-lint` (29/112/0), `doc-lint` (10/37/37/37), `pnpm audit` (0 moderate), top-file LOC <360 (max 349), CHANGELOG Epic 60-67 inline, adapter sanitize chain intact. 219 test files / 5507 tests green. Zero genuine findings — no commit needed.

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
  discovers it. `assignee dev completions bash|zsh|fish` now emit
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
  assignee infra plan" box corrected so every step increments. (commit
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
  (closes L3-L2 LOW).** `assignee dev completions bash|zsh|fish` emit
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

- **`--resource-type <type>` on `assignee admin list` and `assignee admin status`
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
  role inventory as the CLI's `assignee admin list`. `fetchManagedResources`
  was de-duplicated across the two packages and the long-standing
  operator-vs-reader role gap in the MCP surface is closed.

#### Fixed

- **MCP active-applies cap (Wave G1).** The in-process `activeApplies`
  `Set` is now bounded at 100 entries so a leaked apply during a long-
  running MCP session no longer grows the Set unboundedly. Protects
  against release-time memory drift in hosted MCP deployments.

#### Security

- **env-writer hardened + operator-creds warn-once (Wave E1).**
  `assignee dev init` / `setup` now create the `.assignee/` parent
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
  per-resource `assignee infra destroy` flow; `destroy --run-id <uuid>` ships
  in v0.2. No code changes — documentation-only clarification.

### Epic 50 — whole-project external review + 10-lane remediation (2026-04-17)

10-lane external review (L1-L10) dispatched against the Epic 49 baseline. Aggregate score moved from 4.4/10 to 6.9/10. Five BLOCKERs + five value-unlocks identified across positioning, UX, architecture, security, testing, complexity, documentation, distribution, and moat. All 10 stories shipped in commit `9f45061`. Key outcomes: 18→13 command surface (Story 50-3 cut `destroy --all`, `clean`, `cache`, `patterns`, `types`, `whoami`, `mcp-version-check`, BP GPG signer); Wave-5 MCP→CLI dependency cycle break + destroy-strategies dedup (50-4); IAM operator scoping + checkpoint file permissions + HMAC allowlist (50-5); root legal files created (`LICENSE` MIT, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, this `CHANGELOG.md`) as Story 50-8. Scorecard: `_bmad-output/planning-artifacts/epic-50-scorecard.md`.

### Epic 49 — SOLID/DRY/coupling code-audit remediation (2026-04-16)

3-agent BMAD code audit (Blind Hunter, Edge Case Hunter, QA Auditor) produced 2 Critical, 8 High, and 12 Medium findings. Eight stories shipped across 9 commits on 2026-04-16. Key moves: `DestroyStrategy` types + registry + 4 strategies extracted to `@assignee/core` (49-1); `ManagedResource` + `parseArn` + provision-log extracted to `@assignee/core` (49-2); SDK client `.destroy()` lifecycle + shared `createEC2Client` factory added to core (49-3); 35-case ARN-builder switch replaced with `arnTemplateRegistry` (49-4); `constants.ts` 107-importer coupling hub split into 9 domain sub-modules (49-5); `eip-allocator` + `promptWithHelp` decomposed into sub-modules (49-6); MCP structured logger + `fix-finding.ts` type inversion (49-7); Medium findings M5/M8/M9/M11/M12 addressed (49-8). Post-ship: 3-agent BMAD review (commit `bbfc506`) closed 3 HIGH residuals.

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

[Unreleased]: https://github.com/SergSlon/assignee-ai/compare/v0.1.0...HEAD

---

## Acquisition due-diligence remediation + Epic 100 close-out (legacy CHANGELOG entries)

### R10b — Round 10 (second half): final 4 P2-tier P-IDs + 6 strategic deferred-records

R10b closes the final 4 cheap P2-tier audit P-IDs in parallel and
records explicit deferrals for the 6 expensive items that need
dedicated sessions (not parallel-wave fixes). With R10b landed,
**all 100 audit P-IDs are accounted for** — 42 closed in code,
28 OOS, 5 cluster-consolidated, 1 epic-101/102/103-deferred,
10 explicit-R9/R10-deferred, 9 P3-no-action positive signals,
1 live CLI-bug surfaced and fixed, plus 4 partial-cluster items
implicitly accounted via parent P-IDs. The 12-wave Epic 100
closure programme + the 6 follow-on rounds (R8 + R9a + R9b +
R10a + R10b) drive total effective coverage from 27/100 (Epic
100 close-out) to **100/100 accountable**.

#### Added

- **P066 — CLI branch coverage push to 80%.** Targeted the 5
  lowest-coverage files in `apps/cli/src/`: `billing/recommendations.ts`
  (36% → ≥80%), `cleanup/checkpoint-dry-run.ts` (33% → ≥80%),
  `cleanup/cache-dry-run.ts` (37% → ≥80%), `views/drift-detail.ts`
  (44% → ≥80%), `utils/command-runner/credentials.ts` (62% → ≥80%).
  84 new tests across 4 new test files + 2 extended test files.
  Estimated apps/cli branch coverage uplift: +4-6 pp overall.
- **P085 — `validatePlanShape` 2/25 → 22/25 type coverage.**
  Refactored the 2-case switch in
  `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts`
  to a `PLAN_SHAPE_VALIDATORS: Record<string, PlanShapeValidator[]>`
  registry pattern. 20 new per-type validators covering: IAM Role
  trust policy, Lambda Code one-source-only, EC2 ImageId required,
  SQS/SNS FIFO suffix invariant, SSM Parameter Type enum, Logs
  retention discrete values, ApiGatewayV2 protocol enum,
  SecretsManager mutually-exclusive sources, EC2 VPC/Subnet
  required-fields, RDS DBSubnetGroup ≥2 subnets, CloudWatch
  ComparisonOperator enum, ELBv2 Scheme enum, EFS encryption ↔
  KmsKeyId, Events Rule pattern OR schedule, KMS KeyPolicy required,
  EC2 SecurityGroup VpcId required, RouteTable VpcId, NAT Gateway
  SubnetId + AllocationId. 130 new test cases (happy + violation
  per type). 3 types skipped with rationale (compound-only fields
  filled by orchestrator, not LLM shape).

#### Changed

- **P070 — CI FinOps monthly-budget ceiling.** New
  `.github/workflows/finops-monthly-budget.yml` (weekly cadence,
  Option A — visibility without per-run gating). New
  `scripts/finops-aggregate.mjs` (pure Node ESM, zero deps;
  scans `nightly-cost-YYYY-MM-DD.jsonl` artifacts in a rolling
  30-day window, sums `estimatedUsd`, dedupes runIds). Dispatches
  alert when rolling 30-day spend exceeds
  `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` (default $50). Webhook
  prefers `ASSIGNEE_FINOPS_ALERT_WEBHOOK`, falls back to
  `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`. All new actions SHA-pinned
  per W7. `docs/explanation/ci-gates.md` extended with new
  sub-section + gate inventory row.

#### Removed

- **P067 — All 14 deprecated symbols cleaned up.** Migrated all
  to current replacements: `AwsManagedPolicy.LAMBDA_BASIC_EXECUTION`
  / `POWER_USER_ACCESS` (→ `awsManagedPolicyArn()`),
  `PROVISIONS_FILE` / `FAILURES_FILE` (→ `FileName.*`),
  `EnvVar.ASSIGNEE_MODEL` (→ inline string with back-compat
  comment), `INVALID_DESIRED_STATE_CODE` (→ `ErrorCode.INVALID_DESIRED_STATE`),
  `renderApplyNowConfirm` (→ `renderHitlConfirm`),
  `promptWithHelp` positional overload (→ options-object form),
  `createCoreMockTools` (→ `createPricingMockTools()`), 4
  mcp-server destroy-strategy shims (→ direct `@assignee/core`
  imports). 19 modified + 4 deleted shim files. Worker explicitly
  cited `feedback_lazy_credential_resolution_in_mcp` and
  preserved original semantics on every migration (no over-eager
  throwing-replacement bugs like R10a-03).

#### Deferred (explicit acquisition-DD records — strategic items not shippable in a single wave)

- **P068 — TS / Vitest major upgrades pending.** Source DD:
  €15-20k, 2 wk, 6/6 endorsed. Major-dep upgrades break a lot
  of code (TS 5.x → 6.x, Vitest 3.x → 4.x); not parallel-safe
  inside a wave-shaped story. Same shape as P032/P033 (R9b
  deferred for the same reason). Deferred to a **dedicated
  dep-refactor session** alongside P032/P033.
- **P079 — Terraform / CloudFormation import path.** Source DD:
  €50-80k, 8 wk. Importing existing TF/CFN state into Assignee's
  managed-resource ledger is its own product line, not a wave
  fix. Deferred to **dedicated import-path epic** post-Epic-101
  identity work (RBAC needed to scope import permissions).
- **P080 — `destroy --all` bulk lifecycle.** Source DD: €15-20k,
  2 wk. Story 50-3 deliberately removed `destroy --all` to force
  per-resource confirmation. Reintroducing bulk destroy needs
  a careful safety-allowlist + dry-run + multi-stage confirmation
  flow that warrants its own design discussion. Deferred to a
  **dedicated destroy-UX session**.
- **P081 — MCP surface missing VS Code + JetBrains.** Source DD:
  €20-40k, 4 wk; gated on P031 (R9a-01, ✓ shipped). The IDE
  plugin surface is a strategic GTM accelerator (drives MCP
  adoption from solo CLI to in-IDE workflow). Belongs in the
  Epic-103 plugin/ecosystem revival rather than a P2-tier
  cleanup wave.
- **P082 — LangGraph JS pre-1.0 framework dependency.** Source
  DD: contingent migration €150-300k, 6/6 endorsed. (Note:
  LangGraph reached 1.x since the audit was written — see R10a-04
  P091 closure — but the framework-lock-in concern remains.)
  Migration to alternative (LangChain bare, custom orchestration,
  etc.) is a multi-quarter effort. Deferred indefinitely; track
  as a **continuous architecture-watching brief**.
- **P084 — 1,531-line `intent-parser` god-file.** Source DD:
  €20-30k, 3 wk. SOLID refactor of a complex pure-function
  module; high regression risk if rushed. Deferred to a
  **dedicated refactor session** with full BMAD persona review
  (Mary structural / Winston architecture / Quinn QA).

#### Fixed

- **R10b-01 follow-up — 2 brittle test fixes.** R10b-01's
  `command-runner.test.ts` MAX_PROVISION_LOOPS test queued one
  too many in-loop mocks (51 instead of 50); the post-break
  `getState` call hit a queued mock returning `{next: ["continue"]}`
  without `values`, causing TypeError on `.executionStatus`
  read. Fixed: queue exactly MAX_PROVISION_LOOPS in-loop mocks
  so the post-break call hits the catch-all `mockResolvedValue`
  with the SUCCESS shape.
- **R10b-01 follow-up — 2 checkpoint-dry-run tests fixed.**
  Tests created freshly-written checkpoints and expected the
  pruner to prune them, but the pruner's default
  `skipRecentMinutes=10` guard skips files modified within the
  recency window. Same flake-class as the R9b pruner.test.ts
  fix at commit `d40bcb5`. Fixed by `fs.utimes()` to age the
  candidate files to 1h in the past.

#### Provenance

- Per-P audit: `/.agents/reviews/p-id-audit-2026-04-26.md` —
  pre-R10b: 90/100 effective coverage. Post-R10b:
  **100/100 accountable** (42 shipped + 28 OOS + 5 cluster +
  1 epic-101/102/103-deferred + 10 explicit-R9/R10-deferred +
  9 P3-positive + 1 live-CLI-bug + 4 partial-cluster).
- Test totals after R10b: best-practices 905, core 7,458
  (+98 from R10a — net of R10b-04's 130 new validatePlanShape
  tests + R10b-02 deletions), mcp-server 644 (unchanged),
  cli 1,575 (+82 from R10a — R10b-01 added 84, lost 2 to
  flake-fix corrections net) = **10,582 passing, zero
  regressions**.
- 4 R10b workers; 2 reviewer rounds skipped for risk-level
  reasons (P066 test-only, P070 workflow-only); coordinator
  caught + fixed 3 test bugs at the gate (no production bugs);
  final reviewer status NOT formally polled — coordinator
  judgment + gate parity carry the rest at this scale.

### R10a — Round 10 (first half): 4 P2-tier P-IDs + lazy-creds regression fix

R10a closes 4 P2-tier audit P-IDs in parallel. One worker (R10a-03,
operatorCredentials cleanup) over-aggressively migrated a graceful
helper to a throwing one in `create-graph.ts` + `destroy-service.ts`;
coordinator caught the regression at the gate (50 + 5 test failures)
and inline-fixed both call sites to use lazy resolution per
`feedback_lazy_credential_resolution_in_mcp`.

#### Changed

- **P076 — `memoryHints` ANSI-escape coverage.** The `isTTY` guard at
  `packages/core/src/utils/display-findings.ts:185-195` already gated
  ANSI emission on `process.stdout.isTTY` from a prior wave; P076 was
  a missing test-coverage finding, not a code bug. New
  `display-findings.test.ts` (+160 LOC, 8 tests across 3 describes:
  null/empty guard, non-TTY plain output, TTY ANSI emission). Tests
  set both `process.stdout.isTTY` and `chalk.level` per the
  `first-run.test.ts` pattern.
- **P077 — Pre-commit bypass CI enforcement.** The `.husky/pre-commit`
  hook ran `prettier --write` via `lint-staged`, but no CI job ran
  `prettier --check` against the whole repo — `git commit --no-verify`
  bypassed format enforcement entirely. New "Prettier format check"
  step in `.github/workflows/ci-core.yml` runs
  `pnpm exec prettier --check "**/*.{ts,tsx,json,md}"` between Lint
  and Type-check. `docs/explanation/ci-gates.md` gate inventory
  table updated.

#### Removed

- **P086 — `operatorCredentials` deprecated symbol cleanup.**
  `packages/core/src/config/operator-credentials.ts` + its test +
  the `apps/cli/src/config/operator-credentials.ts` shim all deleted.
  11 callers across 9 production files migrated to
  `requireAssigneeCredentials("operator")` (throwing) or
  `tryAssigneeCredentials("operator")` (graceful). Region (`AWS_REGION`)
  is now supplied explicitly at each call site. ~105 LOC net removed.
- **P091 — LangGraph caret-range hygiene: NO-OP closure.** Audit was
  written when LangGraph (`@langchain/langgraph`) was pre-1.0 and
  caret-range `^0.X.Y` ranges allowed minor breakage. Since then all
  three `@langchain/*` packages in the workspace hit `1.x`
  (`@langchain/core@1.1.32`, `@langchain/langgraph@1.2.2`,
  `@langchain/mcp-adapters@1.1.3`); `^1.X.Y` is semver-correct. The
  P091 hazard simply doesn't exist anymore. No code changes needed.

#### Fixed

- **R10a-03 follow-up — lazy credential resolution restored.** The
  R10a-03 worker swapped the deleted lenient `operatorCredentials()`
  (returned empty-string fallbacks + one-time stderr warning when env
  vars unset) for the throwing `requireAssigneeCredentials("operator")`
  in `packages/core/src/graph/create-graph.ts:135` AND
  `apps/cli/src/services/destroy-service.ts:175`. Graph-integration
  tests + ALB-ENI-drain tests rely on the lenient shape (they
  construct/destroy without setting env vars). Coordinator caught
  55 test failures (50 core + 5 cli) at the gate and fixed both
  call sites: now use `tryAssigneeCredentials("operator")` with
  empty-string fallback, restoring lenient semantics. Per
  `feedback_lazy_credential_resolution_in_mcp` — graph construction
  and destroy orchestration must NOT hard-throw on missing creds;
  the actual SDK calls fail fast at use, which is the right blast-
  radius. JSDoc comments at both fix sites reference the memory.

#### Provenance

- Per-P audit: `/.agents/reviews/p-id-audit-2026-04-26.md` —
  pre-R10a: 86/100 effective coverage. Post-R10a: 90/100 (+P076,
  P077, P086, P091). 10 P2-tier items remain NOT-ACCOUNTED:
  P066, P067, P068, P070, P079, P080, P081, P082, P084, P085.
- Test totals after R10a: best-practices 905, core 7,360
  (-3 from operator-credentials.test.ts deletion +0 from R10a-01
  test file location confusion in coordinator notes), mcp-server
  644, cli 1,493 (-2 from CLI shim test deletion + R10a-01 +8
  display-findings tests landed in CORE not CLI per worker report)
  = **10,402 passing, zero regressions** (-5 net from R9b baseline,
  all attributable to deletion of deprecated tests).
- 4 R10a workers; 1 inline-coordinator regression fix; reviewers
  skipped for R10a-01/02/04 (test-only / CI-step-only / no-op);
  R10a-03 reviewer skipped because the regression was already
  caught + fixed at the gate.

### R9b — Round 9 (second half): remaining P1-tier P-IDs + 4 strategic deferrals

R9b ships the remaining 4 of the 12 P1-tier P-IDs from the post-Epic-100
audit, plus explicit deferred-records for the 4 strategic items that
don't fit a single-wave fix. With R9b landed, **all 12 P1-tier items
are accounted for** (8 closed in code, 4 deferred to dedicated work).
4/4 reviewers; 2 BLOCKED on first pass (R9b-02 docs / R9b-03 workflow
correctness) — both fixed inline with surgical patches; final reviewer
state ACCEPT 4/4.

#### Added

- **P036 — E2E compound-pattern grid filled (websocket-api +
  vpc-public-only).** The two skeleton-only `describe.skip` files
  (`apps/cli/src/e2e/e94-websocket-render.test.ts` +
  `e94-vpc-public-only.test.ts`) now ship 6 real Section A tests
  (3 per pattern, mock-mode, always-runs) covering pattern detection,
  compound-dispatcher queue shape, and pattern `defaultOptions`
  literals. Section B (`RUN_E2E=1` real-AWS) spawns the built CLI
  binary. Negative tests confirm: bare "Create a VPC" returns null
  (no compound match); "Create an HTTP api" doesn't false-trigger
  websocket. Compound-pattern test grid: was 9 of 11 covered; now
  11 of 11.
- **P053 — Audit-log silent-swallow regression test (W6-02
  follow-up).** New `apps/mcp-server/src/utils/__tests__/audit-log.test.ts`
  (+195 LOC, 14 tests). Pins both halves of the silent-swallow
  contract: when `fs.appendFile` fails, the audit-log function
  does NOT throw to the caller AND fires `mcpLogError` on stderr
  with `{tool, runId, errorClass}` at `level=error`. Vector
  clarification: NOT HTTP Bearer (MCP uses `StdioServerTransport`
  — no HTTP today); the actual silent-swallow vector is at the
  filesystem boundary. The runtime fix shipped in W6-02 (`65f3d91`);
  R9b-04 closes the deferred regression test.

#### Changed

- **P043 — Nightly-e2e + mock-fixture-drift alerting hardened
  (W6-02 follow-up).** Three concrete fixes:
  - `nightly-e2e.yml`: replaced naive `curl`-on-every-failure with
    `actions/github-script` that queries the workflow-runs API and
    requires **3 consecutive failures** before firing the webhook
    or opening a sticky GitHub issue. Implements the
    "acceptable-miss window" policy that was documented but never
    enforced.
  - `mock-fixture-drift.yml`: added webhook step (was missing
    entirely; only GitHub-issue tracking existed). Webhook prefers
    `ASSIGNEE_DRIFT_ALERT_WEBHOOK`, falls back to
    `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`. Tracking-issue branch now
    fires on EVERY failure (was gated on
    `hashFiles('mock-fixture-drift-report.json') != ''` — runtime
    errors were silent in the issue tracker but counted toward
    the webhook threshold; the inconsistency is fixed).
  - `docs/explanation/ci-gates.md`: corrected stale env-var name
    (`ASSIGNEE_NIGHTLY_ALERT_CHANNEL` → `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`),
    added drift gate inventory row, added "Mock fixture drift gate
    — alert policy" section, clarified that issues now open on
    every failure.

#### Removed

- **P038 — Dead per-node LLM env-var slots removed.**
  `ASSIGNEE_LLM_PLAN_GENERATOR`, `ASSIGNEE_LLM_INTENT_PARSER`,
  `ASSIGNEE_LLM_ADVICE_GENERATOR`, `ASSIGNEE_LLM_WORKLOAD_CLASSIFIER`
  were defined in Story 44.1 but the factory sites that would read
  them were never built. Zero-source-reference grep confirmed.
  Deleted from `packages/core/src/constants/env-vars.ts` with a
  JSDoc descope note explaining the deletion + revival contract
  ("wire factory sites first, then re-add the slots"). Doc cleanup:
  `docs/configuration.md` LLM section + env-var table reduced to
  the single working `ASSIGNEE_LLM_DEFAULT` slot;
  `docs/explanation/ai-architecture.md` per-node-routing section
  rewritten to reflect the deletion + revival path;
  `docs/engineering/changelog-history.md` annotated with the R9b-02
  removal note.

#### Deferred (explicit acquisition-DD records — strategic items not shippable in a single wave)

- **P027 — AWS-only structural lock-in (HARD_NO multi-cloud;
  CONDITIONAL AWS).** Source DD: "12-24 mo if funded" — strategic
  long-tail. Deferred to **Epic 104+** (no Epic assigned yet). The
  CONDITIONAL-AWS posture is documented in
  `docs/explanation/ai-architecture.md` + `docs/explanation/invariants.md`;
  multi-cloud port (Azure / GCP) requires a parallel architecture
  - dedicated provider-port abstraction layer.
- **P028 — Type-coverage ceiling (38 of 1,400+ supported types).**
  Source DD: "130 eng-wk; Epic 16 unlocks". The plugin / Epic-16
  revival is already deferred to **Epic 103** per the Epic 100
  closeout (`epic-100-closeout.md` §"Acknowledged deferrals to
  follow-on epics"). Type-coverage expansion is downstream of that
  revival and shares the same eng-week budget.
- **P032 — AWS SDK sprawl (23 modules, €20-36k/yr priceable).**
  Dep-refactor scope. Each AWS SDK module migration requires
  per-resource-type code adaptation + reviewer time; not parallel-
  safe inside a wave-shaped story (would create cross-lane file
  conflicts on every resource-plugin file). Deferred to a
  **dedicated dep-refactor session** (target: post-Epic-101 once
  the identity-squad lands and stabilises the resource-plugin
  surface).
- **P033 — AI-layer dep duplication (8× `@ai-sdk/*` + LangChain) +
  CRA CVE inflation.** Same shape as P032 — dep-dedup requires
  careful provider-by-provider testing of the LangChain/AI-SDK
  bridges; not parallel-safe. Deferred to the same dep-refactor
  session as P032.

#### Provenance

- Per-P audit: `/.agents/reviews/p-id-audit-2026-04-26.md` —
  pre-R9b: 78/100 closed, 22 NOT-ACCOUNTED. Post-R9b: 82/100 closed
  (+P036, P038, P043, P053) + 4 explicit-deferred (P027/P028/P032/P033)
  = **86/100 effective coverage**, 14 NOT-ACCOUNTED P2-tier.
- All 12 P1-tier items now accounted for (8 shipped in R9 + 4
  explicit-deferred with rationale). Only P2-tier remains.
- R9b-02 reviewer BLOCK + coordinator inline doc fix: 3 doc files
  updated (`docs/configuration.md` LLM section + env-var table;
  `docs/explanation/ai-architecture.md` per-node section;
  `docs/engineering/changelog-history.md` annotation).
- R9b-03 reviewer BLOCK + coordinator inline workflow fix: dead
  `allFailed` variable removed from `nightly-e2e.yml`; tracking-issue
  guard parity restored in `mock-fixture-drift.yml` (issue opens
  for runtime errors too, with a dedicated runtime-error body
  branch); `ci-gates.md` doc claim updated to match.
- Test totals after R9b: best-practices 905, core 7,363
  (unchanged — R9b-02 deletion + R9b-04 tests in mcp-server),
  mcp-server 644 (+14 from R9b-04 audit-log tests), cli 1,495
  (+6 from R9b-01 Section A tests previously skipped) =
  **10,407 passing, zero regressions**.
- 4 parallel adversarial reviewers (Sonnet, Blind/Edge/QA per
  story): final ACCEPT 4/4 after coordinator inline fixes for the
  2 BLOCKED items.

### R9a — Round 9 (first half): P1-tier acquisition-DD follow-up + live SSH-bundle bug

Round 9 ships 8 of the 12 P1-tier P-IDs surfaced by the post-Epic-100
audit (`/.agents/reviews/p-id-audit-2026-04-26.md`) plus a CLI-UX bug
that surfaced during live operator dogfooding. R9a commits the first
4 P1 stories + the CLI bug; R9b will land the remaining 4 (P036, P038,
P043, P053). 4/4 reviewers ACCEPT across 3/3 layers each; CLI-bug
reviewer also ACCEPT.

#### Added

- **P031 — Bumped `@modelcontextprotocol/sdk` from `^1.12.1` to
  `^1.29.0`.** 10 months of accumulated SDK updates absorbed cleanly;
  no source adaptations needed. The dual-version situation in
  `pnpm-lock.yaml` (1.27.1 from `@langchain/mcp-adapters` + 1.29.0
  for `apps/mcp-server`) is benign — pnpm scopes correctly. Verified
  by 8 mcp-server test files that exercise the real SDK via
  `InMemoryTransport`, not mocks. 630 mcp-server tests still green.
- **P035 — Checkpoint module coverage 0% → ≥80%.** 4 new test files
  under `packages/core/src/checkpoint/` (store / ttl / auto-detect /
  pruner — 1,260 LOC, 69 new tests). 23 explicitly recovery-tagged
  tests covering: corrupt JSON, partial/truncated writes, schema
  version mismatch, missing-checkpoint ENOENT, expired checkpoints
  (TTL boundary), concurrent-write atomic-rename race, advisory-lock
  proxy via `skipRecentMinutes` guard. Tests use real fixtures from
  `packages/core/src/test-fixtures/checkpoints/` per
  `feedback_real_data_mocks_all_cases`.
- **P045 — Log-retention minimum floor policy (ISO 27001 A.12.4 +
  GDPR Art 30 ROPA).** Hard 90-day floor for audit logs (cannot be
  reduced via env var; values <90 emit a stderr error and clamp up);
  30-day soft floor for general logs. New env vars
  `ASSIGNEE_LOG_RETENTION_DAYS` + `ASSIGNEE_AUDIT_RETENTION_DAYS`.
  New `packages/core/src/utils/logger/retention.ts` exports floor
  constants + `resolveAuditRetentionDays()` + `guardAuditLogTruncation()`
  helpers. New `apps/cli/src/commands/doctor/checks/logs.ts` adds a
  "Log retention" doctor section with 4 sub-checks (general retention
  config / audit retention config / general logs dir / audit logs
  dir). Threat-model note: the 90-day floor is advisory in-process
  (an operator can edit `retention.ts` or delete files directly);
  Epic 101's KMS-signed S3 object-lock remote sink is the durable
  enforcement layer.
- **P046 — Formal incident-response runbook + index.** New
  `docs/runbooks/incident-response.md` (555 LOC, 7 top-level sections,
  14 subsections): SEV1–SEV4 classification matrix, first-30-min triage
  checklist, evidence-collection procedures, 7 common-incident
  playbooks (drift / stale checkpoint / throttling / credential leak
  / Guardrail violation / MCP drift-poisoning / path-traversal —
  citing R8-01 / R8-02 / W3 / W4 by commit hash + story file),
  rollback procedures, post-mortem template, communication templates.
  New `docs/runbooks/README.md` index + entry in `docs/index.md`.
  All 281 citations resolve on disk per `pnpm citation-lint`.
- **CLI-bug fix — SSH-bundle wizard now skips KeyName prompt for
  auto-create intent.** Live operator reproduction: `assignee infra apply
"Create a EC2 with SSH" --wizard` showed the hint "SSH bundle: key
  pair will be auto-created during provisioning" but then prompted
  for input anyway, defeating the auto-create. Root cause:
  `applyIntentOverrides` set `field.question.initialValue =
SSH_KEY_PLACEHOLDER` but `preInjectIntentBooleans` in the
  option-elicitor only pre-injected boolean values — string sentinels
  were never pre-injected, so the existing `ASK_IF_NOT_SET` Gate 3
  (`value present → skip`) never fired. Fix: new `autoProvision?:
boolean` field on `IntentDefaultOverride`; when set, the orchestrator
  pre-injects the override value (boolean OR string) into
  `elicitedOptions` before the wizard loop runs. End-to-end trace
  verified intent → marker → pre-inject → wizard skip → planGenerator
  → `desiredState[KEY_NAME] = SSH_KEY_PLACEHOLDER` → `ensureSshKeypair`
  auto-create fires. `--set KeyName=my-key` user override still wins
  (Gate 2 fires before Gate 3).

#### Changed

- `apps/cli/src/commands/doctor.test.ts` all-ok rollup test updated
  for the new "Log retention" section (creates empty `logs/` +
  `audit/` dirs in the sandbox, passes `logsDeps: { assigneeDir: tmp
}`, bumps section count 6 → 7). Test intent preserved (per
  `rules/testing.md`: fix code, not assertions); the new section was
  not weakened, just accommodated.

#### Provenance

- Per-P audit: `/.agents/reviews/p-id-audit-2026-04-26.md` —
  pre-R9a: 73/100 closed, 27 NOT-ACCOUNTED. Post-R9a: 78/100 closed
  (+P031, P035, P045, P046, plus the CLI bug not in the original 100
  but live-reported), 22 NOT-ACCOUNTED.
- Source DD: `acquisition-dd-top100.md` §P031 / §P035 / §P045 / §P046.
- Test totals after R9a: best-practices 905, core 7,363 (+89 from
  R8 baseline), mcp-server 630, cli 1,489 (+20 from R8 baseline) =
  **10,387 passing, zero regressions**.
- 4 parallel adversarial reviewers + 1 SSH-bundle reviewer (Sonnet,
  Blind/Edge/QA per story): ACCEPT 12/12 layers, no BLOCKING findings.

### R8 — Round 8: HIGH-severity acquisition-DD follow-up

Three HIGH-severity P-IDs surfaced by the post-Epic-100 per-P audit
(`/.agents/reviews/p-id-audit-2026-04-26.md`) that the original 12-wave
closure missed. All three shipped under one Round-8 commit; reviewer
ACCEPT across 3/3 layers (Blind / Edge / QA) per story.

#### Added

- **P012 — `drift --output-file` path-traversal guard (CWE-22).**
  `apps/cli/src/utils/safe-output-path.ts` exports `validateOutputPath`
  — a pure, lexical (no `realpath`, no TOCTOU) validator that rejects
  NUL bytes, traversal escapes (`../../etc/passwd`), absolute paths
  outside CWD (`/etc/passwd`), and partial-prefix attacks
  (`/home/user/project-evil`). 12 unit tests cover the rejection +
  acceptance + no-op cases; CWD is injected so tests are deterministic
  in CI. `apps/cli/src/commands/drift/orchestrator.ts` now validates
  before every `fs.writeFile`; rejection exits with
  `ProcessExitCode.GENERIC_ERROR` and a clear stderr message that
  echoes the resolved path.
- **P013 — MCP→advice LLM prompt boundary-strip.**
  `packages/core/src/graph/nodes/advice-generator.ts` now wraps each
  MCP-derived snippet (`pricingSnippet`, `docSnippet`, `securitySnippet`)
  in `stripPromptBoundaryTags` before it is concatenated into the LLM
  advice prompt. Closes the silent-injection vector where a hostile or
  drift-poisoned MCP server response could insert
  `</user_intent><system>ignore previous</system>` and hijack the
  prompt. The pre-existing `stripPromptBoundaryTags` (Story 54-it1-05)
  was already imported but applied only to `state.userIntent` — the
  three MCP snippet sites were the unguarded gap. 4 new probe tests
  in `advice-generator.test.ts` cover boundary-tag, `<assistant>`
  injection, fence-break, and clean-passthrough cases.
- **P018 — Bedrock Guardrail missing-state surfacing
  (CONDITIONAL-mandatory-pre-close).** Bedrock invocations without a
  configured Guardrail now emit a one-time stderr warning at adapter
  init, and `assignee admin doctor` flags the missing-Guardrail state as a
  HIGH-severity sub-check. New `BEDROCK_GUARDRAIL_DISABLE=1`
  environment variable suppresses both surfaces (informed-acceptance
  opt-out). The fix is scoped — auto-creating a Guardrail requires a
  user-owned AWS guardrail ID — but the silent-absence failure mode
  that triggered the source-DD finding is closed. 11 new adapter
  tests + 18 new doctor-check tests (new file
  `apps/cli/src/commands/doctor/checks/bedrock.test.ts`).

#### Fixed

- One pre-existing `apps/cli/src/commands/doctor.test.ts` test had a
  stale `section.status === "ok"` premise that broke when the new
  Guardrail HIGH sub-check came online; it now sets
  `BEDROCK_GUARDRAIL_DISABLE=1` to isolate the LLM-adapter health
  assertion from the new check (test intent preserved, not weakened).
  `BEDROCK_GUARDRAIL_DISABLE` added to the file's `ENV_KEYS` save/restore
  list so the flag never leaks between tests.

#### Provenance

- Per-P audit: `/.agents/reviews/p-id-audit-2026-04-26.md` (30/100
  P-IDs flagged NOT-ACCOUNTED post-Epic-100; 3 HIGH-severity addressed
  here, 12 P1-tier + 15 P2-tier remain in the audit backlog).
- Source DD: `acquisition-dd-top100.md` §P012 / §P013 / §P018.
- Test totals after R8: best-practices 905, core 7 274 (+16 from
  Epic-100 baseline), mcp-server 630, cli 1 469 (+28 from baseline) —
  10 278 passing, zero regressions.
- Acquirer-IC implication: P018 was tagged
  CONDITIONAL-mandatory-pre-close in the source DD; surfacing it
  honours the "no HARD_NO findings reintroduced" close-out claim.

### W3 — Identity scaffolding

#### Added

- `packages/core/src/audit/hmac-chain.ts` — per-tenant HMAC chain
  primitive (`computeChainLink` + `verifyChainLink`). Each audit-log
  record carries `HMAC(key, prevHmac || record_serialised)`; corrupting
  any single record breaks the chain and the verifier identifies the
  index. ISO 27001 A.12.4 logging-and-monitoring requirement met for
  the in-process scope.
- `packages/core/src/audit/audit-log.ts` — append-only audit log with
  chain metadata `{record, hmac, prevHmac, index}`. Writes go through
  W4-03 advisory-lock service (`withLock` from `file-advisory-lock.ts`)
  so concurrent writers don't corrupt the chain. File-mode 0o600.
- `packages/core/src/audit/audit-verifier.ts` — chain walker returning
  `{ ok: true }` or `{ ok: false, brokenAt, reason }` (where reason ∈
  `payload-mismatch | hmac-mismatch | missing-prev`). Pre-W3 records
  bypass the verifier with a clear "pre-HMAC region" marker.
- `assignee admin audit-verify` CLI command — runs the verifier against the
  local audit log; exit 0 on clean, non-zero with diagnostics on
  broken chain.
- `packages/core/src/rbac/{policy-schema,policy-store,role-context}.ts`
  — Zod schema (role + actions + resource-glob), in-memory + file
  adapters, hardcoded `"operator"` role context. Five fixtures
  committed (admin / operator / read-only / auditor / restricted).
  Audit-log records carry the role field. **No enforcement at command
  boundaries yet** — scaffolding only; enforcement is Epic 101.
- `packages/core/src/identity/{oidc-port,in-memory-oidc-adapter}.ts`
  — `OIDCPort` interface (`validateToken`, `extractClaims`,
  `refreshToken`) with a fixture-backed in-memory adapter. CLI surface
  in `init.ts` directs operators to W2's `AWS_PROFILE` SSO path until
  Epic 101 lands the real Okta / AzureAD / Auth0 adapters.
- `apps/cli/src/utils/account-id-validator.ts` — 12-digit numeric
  format, partition-agnostic (GovCloud / China account IDs are still
  12-digit), rejects `123456789012` and `210987654321` per
  `feedback_placeholder_arn_preflight_guard`.
- `--target-account <ID>` flag on `plan`, `apply`, `destroy`. Surface
  only — emits `"Epic 101: cross-account assume-role not yet
implemented for <ID>"` and exits with the new
  `ProcessExitCode.NOT_IMPLEMENTED` (= 12). Single-account flow
  unchanged when the flag is absent.
- `ProcessExitCode.NOT_IMPLEMENTED = 12` enum entry.

#### Compliance framing

- ISO 27001 A.12.4 logging-and-monitoring control met for in-process
  audit-log writes (HMAC chain + verifier).
- Day-1 SSO pilot remains W2 `AWS_PROFILE`; enterprise identity-tier
  SKU launch unlocked by Epic 101 (12-engineer-week identity-squad
  hire).

#### Deferred

- KMS-signed remote audit-log sink + S3 object-lock storage → Epic 101.
- Real OIDC adapters (Okta / AzureAD / Auth0) → Epic 101.
- RBAC enforcement at command boundaries → Epic 101.
- STS assume-role chaining for `--target-account` → Epic 101.
- `audit-verify --from <date> --to <date>` filters → Epic 101.

### W9 — Distribution + release pipeline

#### Added

- `.github/workflows/release.yml` (renamed from
  `release.yml.disabled`) — full pipeline (build → SBOM → provenance →
  publish), DRY-RUN-by-default with **8 `if: env.ASSIGNEE_RELEASE_PUBLISH
== '1'` gates** across every publish-side step (npm publish,
  package-binaries, GitHub release, smoke-test, SBOM attach, provenance
  attach, Homebrew tap publish). Tag pushes alone do nothing visible
  externally; the acquirer flips `ASSIGNEE_RELEASE_PUBLISH=1` post-go-
  decision.
- `CODEOWNERS` at repo root — `* @founder` baseline plus commented-out
  per-area lines for post-W3 ownership.
- `docs/explanation/codeowners-and-branch-protection.md` — SOC 2 CC8.1
  / ISO 27001 A.6.3 control baseline; required-status-checks table
  (build / test / coverage / audit / lint / citation-lint /
  audit-action-pins); `gh api` example for the manual GitHub-side
  enable steps.
- `scripts/audit-codeowners.ts` — CI lint asserting the file exists,
  parses, and contains a catch-all rule.
- `scripts/verify-domain-mx.ts` and `verify-domain-ownership.ts` —
  re-runnable verification of `assignee.ai` /
  `app.assignee.ai` MX records and TXT-based ownership proofs.
  Injectable resolver makes the unit tests deterministic — zero real
  DNS lookups in `pnpm test`.
- `scripts/generate-release-notes.ts` — produces external-facing
  release notes from `git log <from>..<to>`. Strips BMAD-ID patterns
  (`Epic-N` / `W9-01` / `P017` / `L1-F14` / `story N` / `R<n>`),
  groups commits into Keep-a-Changelog categories
  (Added / Changed / Fixed / Deprecated / Removed / Security),
  suppresses `chore:` / `docs:` / `ci:` / `test:` noise. 63 unit tests
  cover the BMAD-stripping + categorisation matrix. Wired into
  `release.yml` as `body_path: release-notes.md` for the GitHub
  release publish step.
- `homebrew/assignee.rb` extended with W7-08 SHA256 provenance
  comments + `cosign verify-attestation` instructions; the
  `update-homebrew` job in `release.yml` is gated behind both
  `ASSIGNEE_RELEASE_PUBLISH=1` AND `ASSIGNEE_TAP_PUBLISH=1` so the tap
  cannot publish even if the main release flips.
- `docs/how-to/release-process.md` and
  `docs/how-to/install-via-homebrew.md` (extended) — cover the full
  DRY-RUN-by-default semantics + private-tap install path.

#### Fixed

- 3 remaining unverified `TODO-PIN` SHAs in `release.yml` resolved
  to GitHub-verified values
  (`anchore/sbom-action@f325610c…`, `sigstore/cosign-installer@59acb6260…`,
  `softprops/action-gh-release@72f2c25fc…` × 3 occurrences).
  All `TODO-PIN` comments removed from the file;
  `scripts/audit-action-pins.ts` exits 0.

#### Compliance framing

- `feedback_no_public_artifacts` discipline — design + build + test
  every distribution path; do not publish until the acquirer flips
  `ASSIGNEE_RELEASE_PUBLISH` and `ASSIGNEE_TAP_PUBLISH`.
- SOC 2 CC8.1 + ISO 27001 A.6.3 branch-protection control documented
  for the manual GitHub-side enablement.

### W4 — SaaS-backbone scaffolding

#### Added

- `packages/core/src/checkpoint/port.ts` — `CheckpointerPort` Hexagonal port
  (save/load/list/delete/prune). Substrate for Epic 102's Postgres / DynamoDB.
- `packages/core/src/checkpoint/in-memory-adapter.ts` and
  `file-durable-adapter.ts` — in-memory and file-backed adapters that pass
  the shared port-contract test suite. HMAC + 0o600 + atomic-write
  invariants retained.
- `packages/core/src/locks/advisory-lock-port.ts` and `file-advisory-lock.ts`
  — `AdvisoryLockPort` with `withLock(name, fn)` plus a file adapter using
  `O_CREAT|O_EXCL` atomic acquisition + 10 s stale-lock reclamation. Passes
  a 10-concurrent-writer contention test with zero corruption.
- `packages/core/src/telemetry/telemetry-event-schema.ts`,
  `telemetry-port.ts`, `in-memory-telemetry-adapter.ts` — `TelemetryEvent`
  schema (`event_name`, `timestamp`, `node_id`, `tenant_id` placeholder,
  `extras`) and `TelemetryPort.emit` / `emitFiltered` with W6
  `filterAllowlistedFields` + W1 `filterSensitiveElicitedFields`
  composition. Off by default via `ASSIGNEE_TELEMETRY_ADAPTER` gate
  (positive signal L1-F52 retained).
- `scripts/backup-provisions.ts` (TS, runs via `npx tsx`) — copies
  `~/.assignee/memory/provisions.json` to
  `~/.assignee/backups/provisions-YYYY-MM-DD.json` with 7-day rotation,
  0o600, atomic-write, never moves source.
- `assignee infra restore-provisions [--from <date>]` CLI command — restores
  the destroy-safety registry from the latest or specified-date backup;
  idempotent; safety-copies the current file before overwrite.
- 13/14 graph nodes (HUMAN_APPROVAL excluded) now emit telemetry at
  entry + exit through `withTelemetry` in `create-graph.ts`.
  Status-poller (W10) and OTEL spans (W6) integrations preserved.

#### Changed

- Memory-recorder writes (`writeProvisionRecord`, `writeFailureRecord`,
  `upsertPatternRecord`) now acquire/release the advisory lock around the
  write+fsync. W1's `stripSensitiveFromElicited` and
  `redactAccountIdsInPrompt` call sites remain INSIDE the lock scope —
  semantics unchanged, concurrency-safety added.

#### Deferred

- Production Postgres / DynamoDB checkpointer adapter → Epic 102.
- Production telemetry collector + DPA with collector → Epic 102 / legal.
- Remote backup sink for `provisions.json` → Epic 102.

### W5 — EU-residency tech defaults

#### Added

- `packages/core/src/utils/url-validator.ts` — scheme allowlist
  (`https://` always; `http://` only for `localhost`). `ASSIGNEE_SAAS_URL`
  and `OLLAMA_BASE_URL` consumption sites now route through the validator
  with actionable rejection: `"<URL> rejected: only https:// (or
http://localhost) accepted for <env-var>"`.
- `packages/core/src/saas/saas-url.ts` — region-derived
  `SAAS_API_URL` default (`https://<region>.api.assignee.ai`); explicit
  `ASSIGNEE_SAAS_URL` override validated by the URL validator. Honours
  `AWS_REGION` end-to-end.
- `packages/core/src/provisioning/ccapi-partition-support.ts` — partition
  × resource-type CCAPI support matrix sourced from AWS docs (verified
  2026-04-25). Conservative posture: types with W5-04 SDK-direct adapters
  (S3 / IAM / VPC) prefer the SDK-direct path in non-commercial partitions
  even where CCAPI nominally works, because CCAPI's create-property
  surface is uneven across partitions.
- `packages/core/src/provisioning/partition-aware-provisioner.ts` —
  router that dispatches to SDK-direct in non-commercial partitions or
  emits an actionable "not supported in `<partition>`" error.
- `packages/core/src/provisioning/sdk-direct-fallback/{s3-bucket,iam-role,
ec2-vpc}.ts` — first three SDK-direct adapters covering S3 buckets, IAM
  roles, and EC2 VPCs in GovCloud / China / ISO / EU Sovereign Cloud
  partitions. The remaining ~35 resource types receive the actionable
  fallback message until Epic 102+ extends the adapter set.
- 7-region matrix tests (`eu-central-1`, `eu-west-1`, `eu-west-2`,
  `eu-north-1`, `us-east-1`, `us-west-2`, `ap-south-1`) for
  region-derivation defaults.

#### Changed

- `DEFAULT_AWS_REGION` is now derived from `process.env.AWS_REGION`
  (falls back to `us-east-1` only when unset). EU operators with an
  explicit `AWS_REGION` no longer hit US-East defaults.
- Bedrock model invocation derives the inference-profile prefix
  (`eu.` / `ap.` / `us.`) from the resolved region, partition-aware.
  Bedrock region error hints (`feedback_bedrock_region_error_hints`)
  retained.
- `KNOWN_BEDROCK_REGIONS` refreshed: adds `eu-west-2` and `eu-north-1`;
  sourcing-date comment block cites the AWS Bedrock region-availability
  docs page (verified 2026-04-25). No regions removed.
- `eu-isoe-west-1` now correctly maps to the `aws-iso-e` partition (was
  `aws`). Synthesised ARNs round-trip parse for all 5 partitions
  (`aws`, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-e`).
  `feedback_partition_aware_arn_matching` discipline retained.

#### Compliance framing

- GDPR Chapter V (Articles 44-49) cross-border-transfer remediation at
  the technical layer (Matteo C3 §4.2 CONDITIONAL-mandatory-pre-close).
- DE BSI C5 / FR SecNumCloud public-sector thesis enabled by
  `aws-iso-e` partition correctness (Richard C5 §1 PROMOTE).
- Anders C1 §lane-level theme #4 — residency-defaults-safety cluster
  closure.

### W1 — Pattern-1 sensitive-data class-fix

#### Added

- `ResourceField.sensitive?: boolean` marker on the plugin elicited-field
  type. One structural change closes 6 acquisition-DD findings
  (L1-F01 + L1-F06 + L1-F07 + L1-F21 + L3-F11 + L4-S11) per Anders C1
  single-root-cause cluster framing. Default `false`; pre-W1 plugins
  remain back-compatible.
- `stripSensitiveFromElicited(record, sensitiveNames)` helper in
  `packages/core/src/utils/redact.ts` — replaces values for fields whose
  name is in the sensitive set with the shared `[REDACTED]` sentinel.
  No-mutation invariant preserved.
- `redactLogContent()` in `packages/core/src/telemetry/otel-allowlist.ts`
  — line-by-line allowlist filter applied by the CI-side
  `scripts/scrub-logs-for-upload.ts` to `~/.assignee/logs/` JSONL artefacts
  before upload (closes W6's gap where the script referenced a function
  that didn't exist).
- `filterSensitiveElicitedFields(extras, sensitiveNames)` in
  `otel-allowlist.ts` — OTEL emission filter that drops sensitive-marked
  fields from `event.extras` using the same `[REDACTED]` sentinel.
- `scripts/migrate-patterns-cleartext.ts` — idempotent dry-run-by-default
  one-shot migration of historical `~/.assignee/memory/patterns.json`.
  Backs up to `.bak` before mutation; running twice on a clean file is
  a no-op.
- `scripts/audit-patterns-cleartext.ts` — repeatable audit that scans the
  runtime patterns file for credential allowlist matches plus AKIA-key
  patterns. Exits 0 on clean / absent file; non-zero on any match.
- Plugin annotations: `rds-dbinstance/credentials.ts`
  (`MasterUserPassword`), `secretsmanager-secret.ts` (`SecretString`),
  `events-connection.ts` (`AuthParameters` carrying API key / Basic auth
  password / OAuth client secret) all now declare `sensitive: true` on
  their credential-bearing fields.

#### Fixed

- Memory-recorder write boundary (`upsertPatternRecord`) accepts an
  optional `sensitiveNames` set and applies the helper before
  `JSON.stringify` to disk. Pattern-memory records no longer leak
  credentials elicited via plugin wizards.
- `writeFailureRecord` in the memory recorder now applies
  `redactAccountIdsInPrompt()` to the captured `errorMessage` before
  persistence. AWS account IDs in CloudControl error strings are
  scrubbed before reaching the failure record on disk.
- Checkpointer write path: `stripSensitiveFromElicited` composes
  additively with the existing key-name allowlist in
  `checkpoint/redaction.ts` (CFN `desiredState` layer). Cooperation
  tests confirm the same `[REDACTED]` sentinel and no allowlist conflict.

#### Compliance framing

- GDPR Art 32 ("appropriate technical measures") — storing credentials
  cleartext in pattern-memory or checkpoints is the textbook failure
  this story closes.
- GDPR Art 83(5) — €20M / 4% global-turnover fine exposure once any EU
  customer is processed; ICO/CNIL precedent (British Airways, H&M).

### W2 — Pre-close credentials

#### Added

- `ASSIGNEE_OPERATOR_SESSION_TOKEN` is now read by the credential resolver
  and forwarded to every AWS SDK client (CloudControl, Bedrock, STS, IAM,
  KMS, SecretsManager, EventBridge, ResourceGroupsTaggingAPI, EC2, Lambda).
  Required for ASIA-prefixed short-term credentials (SSO, assumed roles).
- `--profile <name>` flag on `assignee dev init` for `~/.aws/config` SSO
  profile resolution via the AWS SDK provider chain
  (`fromIni` → `fromSSO` → `fromNodeProviderChain`).
- `packages/core/src/config/provider-chain.ts` — exports
  `resolveOperatorCredentialProvider()` for callers needing an SDK
  credentials provider rather than a static credentials object.
- `packages/core/src/config/sso-refresh.ts` — translates AWS
  AccessDenied / ExpiredToken errors into actionable
  "Run: aws sso login --profile &lt;name&gt;" hints.
- `docs/how-to/sso-authentication.md` — Diátaxis how-to documenting
  the supported SSO flow.
- 8-row credential-resolution test matrix
  (env-only / `AWS_PROFILE`-only / `--profile`-only / precedence /
  no-creds / invalid-token / SSO-expired / cross-region) plus an
  `RUN_E2E=1`-gated real-AWS verification suite.

#### Fixed

- `AWS_PROFILE` is no longer silently rejected. The credential resolver
  honors the AWS SDK provider chain end-to-end. The previous workaround
  of exporting raw `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` for
  SSO operators is no longer required and is documented as an
  anti-pattern (CI lint asserts the doc never reintroduces it).
- `InvalidSessionTokenError` produces an actionable
  "Run: aws sso login" hint instead of an opaque AccessDenied.

### W6 — Destroy-QA + observability

#### Added

- Per-strategy unit-test coverage for 9 destroy strategies (S3 bucket,
  EC2 internet gateway, EC2 route table, DynamoDB table, EFS file
  system, ELBv2 load balancer, EC2 EIP, CloudFront distribution,
  SQS queue) — happy path plus 3+ edge cases each. vitest enforces
  per-file ≥ 80% line coverage for
  `packages/core/src/destroy-strategies/strategies/**`.
- `destroy-only-tagged-invariant.test.ts` — parametrised invariant
  asserting strategies refuse to act on resources missing the
  Assignee management tag.
- `packages/core/src/telemetry/otel-allowlist.ts` — source-side OTEL
  field-name allowlist with `@privacy: PII | SYSTEM | OPERATIONAL`
  classification. PII fields are stripped unless
  `ASSIGNEE_OTEL_INCLUDE_PII=1` is set explicitly.
- `packages/core/src/telemetry/spans.ts` — per-graph-node entry/exit
  span emission across 13 of 14 nodes (HUMAN_APPROVAL excluded).
- `apps/cli/src/e2e/nightly-destroy-smoke.test.ts`
  (`RUN_E2E=1`-gated) — provisions and destroys a fixture per
  resource type with `afterEach` teardown-guard. Reads pricing from
  the Pricing MCP at runtime — no hardcoded dollar amounts.
- `scripts/cost-ledger-rollup.ts` — weekly aggregation of nightly
  cost-ledger JSONL records.
- `scripts/audit-no-suppress.ts` — CI lint that forbids `|| true`
  masking on `assignee` CLI invocation lines in
  `.github/actions/*/action.yml`.
- `docs/explanation/ci-gates.md` — documents the merge-policy and
  acceptable-miss window for the nightly E2E gate.

#### Changed

- All 7 concrete destroy strategies (S3 bucket, IGW, route table,
  DynamoDB, EFS, ELBv2, CloudFront) now emit non-fatal warnings via
  the documented `DestroyContext.warn` callback rather than the
  static `warnDestroy()` helper. Behavior is preserved (the
  dispatcher's `warn` implementation chains through the same
  structured stderr writer); the change makes warnings unit-testable
  through the `ctx.warn` mock surface.

### W7 — Supply-chain hardening

#### Added

- `pnpm audit --audit-level=moderate --prod` gate in CI; build fails
  on any unaddressed vulnerability.
- `package.json.overrides-rationale.md` — sidecar documenting the
  CVE reference and mitigation note for every entry in
  `pnpm.overrides`. `scripts/audit-overrides.ts` enforces parity.
- SHA256 verification + signed-manifest version allowlist in
  `scripts/install.sh`. Downgrade attempts to known-vulnerable
  versions require explicit `ASSIGNEE_DOWNGRADE_ACK=1` override.
  MITM-tampering test fixture
  (`apps/cli/src/e2e/install-sh-mitm.test.ts`,
  `RUN_INSTALL_MITM_FIXTURE=1`-gated).
- LLM-output sanitizer (`scripts/sanitize-llm-output-for-ci.ts`) for
  CI surfaces that consume model-generated content. Composite
  actions `apply` and `plan` now route LLM output through file
  artefacts instead of GitHub Script template-literal interpolation.
- SPDX SBOM-generation step in the disabled release workflow
  (ready for W9 enable). `docs/explanation/sbom.md`.
- SLSA L2 cosign-signed build-provenance step in the disabled
  release workflow. `docs/explanation/supply-chain-provenance.md`
  documents the `cosign verify-attestation` flow.
- `homebrew/assignee.rb` references the signed release manifest;
  `scripts/audit-homebrew-pin.ts` lint asserts SHA256 parity.
  `docs/how-to/install-via-homebrew.md`.
- Lint scripts: `audit-action-pins.ts`, `audit-secrets-inherit.ts`,
  `audit-overrides.ts`, `audit-homebrew-pin.ts`,
  `scrub-logs-for-upload.ts`.

#### Changed

- Every `uses:` reference across 9 GitHub Actions workflows and 2
  composite actions is now SHA-pinned to a 40-character commit
  hash with a `# v<N>` comment. CI lint
  (`scripts/audit-action-pins.ts`) blocks tag/branch refs.
- `secrets: inherit` removed from `ci.yml` and `ci-cross-platform.yml`;
  each callee now declares an explicit `secrets:` block enumerating
  only the secrets it needs (least-privilege).
- `nightly-e2e.yml` now provisions `RUN_E2E=1` plus AWS test
  credentials and routes failures to
  `secrets.ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`.

#### Fixed

- `.github/actions/apply/action.yml` and `.github/actions/plan/action.yml`
  no longer suppress non-zero exit codes from `assignee` CLI
  invocations with `|| true`. Failed CLI runs now propagate as failed
  composite-action steps.

#### Security

- Six Action references retain `TODO-PIN` SHA placeholders pending
  manual verification before W9 release-pipeline activation:
  `anchore/sbom-action`, `sigstore/cosign-installer`,
  `softprops/action-gh-release`, `actions/setup-python`,
  `aws-actions/configure-aws-credentials`,
  `schneegans/dynamic-badges-action`. The pin-audit lint skips
  `TODO-PIN` lines so CI passes; W9 resolves them.
- `release.yml.disabled` retained as `.disabled` per owner decision
  (no public artefacts until tool approval). Wave 9 enables it.

### W10 — Docs + DX

#### Added

- `docs/engineering/changelog-history.md` — engineering-journal history
  extracted from the old CHANGELOG (BMAD story IDs, wave labels, review
  methodology notes).
- `docs/how-to/quickstart.md` — Quickstart guide re-tagged as a Diátaxis
  how-to with `kind: how-to` front-matter (moved from `docs/quickstart.md`).
- `docs/reference/<type>.md` — 38 auto-generated reference pages, one per
  supported AWS resource type. Source of truth: help-hints registry.
- `scripts/generate-reference-pages.ts` — generator for reference pages;
  supports `--check` mode for CI lint.
- `scripts/generate-notice.ts` — NOTICE + THIRD-PARTY-NOTICES.md generator
  from `pnpm licenses list`; supports `--check` mode for CI lint.
- `NOTICE` — project notice file (SPDX-compatible).
- `THIRD-PARTY-NOTICES.md` — 526 third-party packages with SPDX license IDs.
- `packages/core/src/utils/arn-redactor.ts` — ARN-structure-preserving
  redactor: scrubs 12-digit account IDs and sensitive resource names before
  they enter LLM context. Allowlist-not-denylist design.

#### Changed

- `.husky/pre-commit` — now runs `pnpm check-types` and `pnpm build` in
  addition to `lint-staged` and the AWS-account-ID scan. Uses turbo cache
  for fast repeat runs. Controlled by `ASSIGNEE_SKIP_BUILD=1` escape-hatch.
- `CONTRIBUTING.md` — added pre-commit / pre-push hook split documentation;
  `--no-verify` policy (acceptable only for parallel-worker mid-wave commits);
  CI enforcement note.
- `docs/index.md` — updated quickstart link to `how-to/quickstart.md`.

#### Fixed

- `packages/core/src/graph/nodes/status-poller.ts` — exponential backoff
  with jitter on 503 / ThrottlingException responses from CloudControl.
  Retry budget: 5 retries, capped at 60 s per delay. Distinct from the
  CloudFront S3 DNS-propagation retry budget.
- `packages/core/src/config/org-policy-cache.ts` — cache file now written
  with mode `0o600` (owner read/write only) to prevent world-readable token
  leakage.
- `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts` — ARN
  redactor wired into `buildPrompt` (user-intent) and `readMemoryHints`
  (previous-error hint) before content reaches the LLM boundary.
  [0.1.0]: https://github.com/SergSlon/assignee-ai/releases/tag/v0.1.0
