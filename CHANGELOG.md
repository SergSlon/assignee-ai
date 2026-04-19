# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

## [Unreleased]

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
