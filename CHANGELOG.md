# Changelog

All notable changes to Assignee.ai are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Both `@assignee/cli` and `@assignee/mcp-server` packages are currently
`private: true` — nothing is published to npm yet. `0.1.0` below is the
internal development baseline; the first published version (`0.2.0` or
later) will land when the project is ready for public release.

For the full engineering history including BMAD story IDs, wave labels, and
review methodology notes, see
[`docs/engineering/changelog-history.md`](docs/engineering/changelog-history.md).

---

## [Unreleased]

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
- `--profile <name>` flag on `assignee init` for `~/.aws/config` SSO
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

---

## [0.1.0] — 2026-04-24

Internal development baseline. Not published to npm.

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
- Support for 38 AWS resource types, 11 compound architecture patterns.
- 14-node LangGraph pipeline: intent_parser → schema_fetcher →
  option_elicitor → compound_dispatcher → plan_generator → bp_evaluator
  → fix_applicator → preflight_guard → human_approval →
  resource_provisioner → status_poller → result_formatter →
  advice_generator → validate_desired_state.
- AWS MCP server integrations: pricing, documentation, IAM,
  well-architected-security, billing-cost-management.
- Drift detection, reconcile, cost-rightsizing optimizer (Graviton
  swap recommendations).
- Exponential-backoff retry on throttled CloudControl poll responses.
- CloudFront S3 DNS-propagation retry (up to 3 attempts) for transient
  origin validation failures on compound deployments.
- Partition-aware ARN handling for GovCloud and China regions.
- File-mode 0o600 on sensitive cache writes (org-policy-cache).
- Pre-commit hook: lint-staged + AWS-account-ID scan + type-check + build.
- Pre-push hook: full lint chain + type-check + barrel/shim/doc/citation lint
  - test suite.
- 5-level CI lint chain: barrels + shims + doc-lint + citation-lint +
  ci-multiplier.
- Node 20 + 22 matrix in CI.
- NFR floor: startup p95 < 1300 ms / p99 < 1400 ms; memory heap ±20%
  stability (gated on `RUN_PERF=1`).
- Flake-rate policy: `retry: 1` in all vitest configs; 0.1% SLO.
- `docs/explanation/` quadrant with AI architecture, invariants, telemetry
  design, run-ledger design, flake policy, contributing-a-bp-rule.
- Diátaxis documentation structure: tutorials / how-to / reference / explanation.

### Changed

- Quickstart moved to `docs/how-to/quickstart.md` (Diátaxis re-tag).
- All reference pages auto-generated from the supported-types registry.

### Security

- ARN-preserving redactor applied at LLM prompt boundary: account IDs and
  sensitive resource names scrubbed before reaching Bedrock.
- Pre-commit AWS-account-ID guard blocks commits containing real dogfood
  account IDs.
- org-policy-cache written with `0o600` permissions.

---

[Unreleased]: https://github.com/assignee-ai/assignee.ai/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/assignee-ai/assignee.ai/releases/tag/v0.1.0
