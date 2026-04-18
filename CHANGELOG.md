# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

## [Unreleased]

### Epic 53 — iteration 1 (2026-04-18)

#### Docs

- **Citation drift sweep (L8-B1, L8-H1..H3, L8-MEDs).** Full-repo
  citation audit. Removed the dead `mcp-intelligence-audit.md` "See
  also" from `docs/configuration.md` (target relocated to
  `_bmad-output/planning-artifacts/_archive/` under Epic 52). Repointed
  `apps/cli/src/test-fixtures/mcp-mock-responses/` references to the
  real location `packages/core/src/test-fixtures/mcp-mock-responses/`
  in `README.md` (architecture tree + testing-fixtures section) and
  `docs/testing-guide.md`. Removed the stale `apps/cli/scripts/check-mcp-versions.ts`
  paragraph + exit-code bullets from `docs/mcp-servers.md` — no such
  script exists; the in-process doctor flow described above it is the
  only implementation. Repointed `docs/testing-guide.md` MCP Server
  E2E row from the nonexistent `apps/mcp-server/src/e2e/` to
  `apps/mcp-server/e2e-test.mjs`. Dropped the gitignored
  `_bmad-output/implementation-artifacts/_archive/done-stories/` link
  from `docs/explanation/contributing-a-bp-rule.md` (regression of
  Epic 51 L8-006 class — invisible to external clones). Corrected
  `docs/architecture-flows.md` header note after `architecture.md`
  moved into `_bmad-output/planning-artifacts/_archive/`. Fixed
  `docs/explanation/telemetry-design.md` `audit-log.ts` pointer from
  the deleted CLI module to the surviving MCP-server module
  (`apps/mcp-server/src/utils/audit-log.ts`). Corrected the compound
  pattern count and the invented pattern IDs (`s3-static-site`,
  `rds-with-vpc`) in `docs/explanation/oss-vs-saas.md` to match the
  ten patterns actually registered in
  `packages/core/src/pattern-templates/`.

#### Tooling

- **`apps/cli/scripts/citation-lint.mjs`.** Added a lightweight Node
  ESM checker that scans `README.md`, `CHANGELOG.md`, and
  `docs/**/*.md` for relative markdown citations and fails on broken
  targets. Wired as the root script `pnpm citation-lint`. Skips
  external URLs, anchor-only links, and citations inside code fences.
  Catches the Step-6c scope-incomplete pattern mechanically so future
  iterations never ship stale citations.

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
- Support for 37 AWS resource types, 9 compound architecture patterns.
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
