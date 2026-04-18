# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

## [Unreleased]

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

## [0.1.0] — YYYY-MM-DD

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
