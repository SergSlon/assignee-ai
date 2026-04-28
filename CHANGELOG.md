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

### Full-project audit closure (2026-04-26 / 2026-04-27)

Closes the highest-ROI cluster of findings from a 9-persona / 11-input
full-project audit: release-pipeline correctness, supply-chain hygiene,
process-governance enforcement (reviewer-evidence on every commit body),
and two follow-on bug-hunt remediation passes that fixed real issues
introduced by the prior waves' rapid integration. Five commits land the
changes (`80d639b` release/CI gates, `f4bbf7d` governance + audit
closures, `7223642` first bug-hunt remediation, `2422324` second
bug-hunt remediation, `fc22e6a` tenant-cache scoping as a
SaaS-readiness foundation step).

#### Added

- CodeQL security analysis workflow (`.github/workflows/codeql.yml`)
  with weekly cadence plus push and pull-request triggers.
- Dependabot configuration (`.github/dependabot.yml`) with grouped npm
  and `github-actions` ecosystem updates.
- CI security gate workflow (`.github/workflows/ci-security.yml`)
  running 5 previously-orphaned audit scripts (`audit-action-pins`,
  `audit-secrets-inherit`, `audit-overrides`, `audit-homebrew-pin`,
  `audit-codeowners`) on every push and PR.
- Anchore SBOM scanning step in the release pipeline; SARIF results
  surface in the GitHub Security tab.
- Cost-ledger artifact upload in the nightly E2E workflow so the
  FinOps monthly-budget gate has data to enforce against (the
  monthly-budget consumer was previously reading an artifact that
  no producer step ever uploaded).

#### Changed

- Release-pipeline gates now read from repository Variables
  (Settings → Secrets and variables → Actions → Variables) instead
  of Secrets. Prior `env.*` references inside job-level `if:`
  clauses were silently ineffective per GitHub Actions
  context-availability rules; gates appeared green but were
  actually never evaluated.
- The pre-push hook now enforces a reviewer-evidence token on every
  commit body being pushed: one of `Reviewer: ACCEPT`,
  `Reviewer: SKIP — <reason>`, or a
  `_archive/reviews/<sha>-review.md` citation. Force-push and
  shallow-clone scenarios fail closed; tag pushes are exempted.
- `audit-no-suppress` script extended to scan
  `.github/workflows/*.yml` in addition to
  `.github/actions/*/action.yml`, closing the gap where workflow
  files could silently mask CLI failures with `|| true`.

#### Fixed

- `vacation-quality.yml` no longer suppresses doc-lint failures with
  `|| true`. The doc-lint command was also corrected to invoke the
  workspace-root script (the previous `pnpm --filter assignee
doc-lint` never matched any package and the suppression hid the
  failure).
- `nightly-e2e.yml` cost-ledger upload now resolves `$HOME`
  correctly. The previous configuration used a literal `~`, which
  `actions/glob` does not shell-expand, so the artifact glob
  matched nothing.

### Full-project audit closure (continued)

A second bug-hunt remediation pass landed at `2422324` after a
review of the integration state at `7223642` surfaced a fresh round
of issues, and a tenant-cache scoping wave landed at `fc22e6a` as
a SaaS-readiness foundation step.

#### Changed

- The release-pipeline SBOM job now declares all four required
  permissions explicitly (`contents`, `id-token`, `attestations`,
  `security-events`). The previous configuration relied on
  workflow-level defaults that GitHub Actions does not propagate
  into job permission blocks once any job declares its own
  `permissions:` map; the SARIF upload to the Security tab and the
  release-asset upload were both silently denied even though the
  job appeared green.
- The pre-push hook is now exempted for tag pushes
  (`refs/tags/*`). The reviewer-evidence gate fired on
  release-tag pushes that legitimately carry no new commits,
  blocking the publish flow; tag pushes now skip the scan.
- The pre-push hook's `git log -n 50` fallback is removed in
  favour of a fail-closed posture: if the upstream-range
  computation fails (force-push, shallow clone, missing
  remote-tracking ref), the hook errors out with a remediation
  hint instead of silently scanning a 50-commit window that
  could let unreviewed commits ride along.
- The pre-push hook's default-branch detection now falls back
  through `main` → `master` → `develop` → `trunk` rather than
  hardcoding `main`, so the gate works on repositories that
  haven't migrated branch names.
- The `audit-no-suppress` script's CLI surface was rewritten as
  an explicit YAML state machine (was a hand-rolled regex chain
  that mis-handled multi-line scripts and quoted strings); the
  same script now also indirects its `|| true` and `2>/dev/null`
  idiom-detection through a small lookup so the patterns are
  testable in isolation.

#### Changed (continued — `fc22e6a` SaaS-readiness foundation)

- Introduced a tenant-scoped cache abstraction that prepares the
  codebase for multi-tenant SaaS operation. Five module-level
  singletons (best-practices rule loader, marker resolver,
  free-tier catalogue, ARN resolver, EC2 instance-type catalogue)
  migrated from per-process caches to per-tenant caches isolated
  by a request-scoped tenant identifier. Twenty-four new isolation
  tests assert that two concurrent tenants cannot observe each
  other's cached state. No user-visible behaviour changes for the
  single-tenant CLI path; this is a foundation step for upcoming
  SaaS work.

### Code quality and test coverage improvements

Closed the final batch of deferred audit items: raised CLI branch
coverage to ≥80% in the five lowest-covered files, expanded
`validatePlanShape` from 2 to 22 of 25 resource types, added a CI
FinOps monthly-budget workflow, and cleaned up all 14 deprecated
symbols across the codebase.

#### Added

- CLI branch coverage raised to ≥80% for
  `apps/cli/src/billing/recommendations.ts`,
  `apps/cli/src/cleanup/checkpoint-dry-run.ts`,
  `apps/cli/src/cleanup/cache-dry-run.ts`,
  `apps/cli/src/views/drift-detail.ts`, and
  `apps/cli/src/utils/command-runner/credentials.ts`. 84 new tests
  across 4 new test files and 2 extended test files.
- `validatePlanShape` in
  `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts`
  refactored to a `PLAN_SHAPE_VALIDATORS` registry. 20 new per-type
  validators covering IAM Role trust policy, Lambda Code one-source-only,
  EC2 ImageId required, SQS/SNS FIFO suffix, SSM Parameter Type enum,
  Logs retention discrete values, ApiGatewayV2 protocol enum,
  SecretsManager mutually-exclusive sources, EC2 VPC/Subnet required
  fields, RDS DBSubnetGroup ≥2 subnets, CloudWatch ComparisonOperator
  enum, ELBv2 Scheme enum, EFS encryption ↔ KmsKeyId, Events Rule
  pattern OR schedule, KMS KeyPolicy required, EC2 SecurityGroup VpcId,
  RouteTable VpcId, and NAT Gateway SubnetId + AllocationId.

#### Changed

- New `.github/workflows/finops-monthly-budget.yml` (weekly cadence)
  and `scripts/finops-aggregate.mjs` aggregate nightly cost-ledger
  JSONL files in a rolling 30-day window and fire an alert webhook
  when spend exceeds `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` (default
  $50). `docs/explanation/ci-gates.md` extended with a new sub-section
  and gate inventory row.
- ANSI-escape coverage for `memoryHints` in
  `packages/core/src/utils/display-findings.ts:185-195` verified with
  new `display-findings.test.ts` (8 tests: null/empty guard, non-TTY
  plain output, TTY ANSI emission).
- CI Prettier format check added to `.github/workflows/ci-core.yml`
  between Lint and Type-check steps, closing the gap where
  `git commit --no-verify` could bypass format enforcement entirely.

#### Removed

- All 14 deprecated symbols removed: `AwsManagedPolicy.LAMBDA_BASIC_EXECUTION`
  / `POWER_USER_ACCESS`, `PROVISIONS_FILE` / `FAILURES_FILE`,
  `EnvVar.ASSIGNEE_MODEL`, `INVALID_DESIRED_STATE_CODE`,
  `renderApplyNowConfirm`, `promptWithHelp` positional overload,
  `createCoreMockTools`, and 4 mcp-server destroy-strategy shims.
  19 files modified; 4 shim files deleted.
- `operatorCredentials` deprecated symbol and its test file removed.
  `packages/core/src/config/operator-credentials.ts`,
  `apps/cli/src/config/operator-credentials.ts`, and their tests
  deleted. 11 call sites across 9 files migrated to
  `requireAssigneeCredentials("operator")` or
  `tryAssigneeCredentials("operator")`. ~105 LOC net removed.
- `@langchain/langgraph` caret-range concern resolved: all three
  `@langchain/*` packages reached `1.x`; no code changes required.

#### Fixed

- `apps/cli/src/utils/command-runner/credentials.ts` test: queued
  exactly `MAX_PROVISION_LOOPS` in-loop mocks so the post-break
  `getState` call hits the catch-all mock with the expected SUCCESS
  shape, eliminating a TypeError on `.executionStatus` read.
- `checkpoint-dry-run` tests: used `fs.utimes()` to age candidate
  files to 1h in the past, bypassing the pruner's
  `skipRecentMinutes=10` recency guard.
- Lazy credential resolution restored at
  `packages/core/src/graph/create-graph.ts` and
  `apps/cli/src/services/destroy-service.ts` — both sites now use
  `tryAssigneeCredentials("operator")` with empty-string fallback
  so graph construction and destroy orchestration do not hard-throw
  on missing credentials.

### Security hardening and compliance follow-up

Addressed high-severity audit findings: E2E compound-pattern test
coverage completed, CI alerting hardened, dead env-var slots removed,
and audit-log silent-swallow pinned with regression tests.

#### Added

- E2E compound-pattern test grid completed: `e94-websocket-render.test.ts`
  and `e94-vpc-public-only.test.ts` now ship 6 real Section A tests
  (3 per pattern, mock-mode, always-runs) covering pattern detection,
  compound-dispatcher queue shape, and pattern `defaultOptions`. All
  11 compound patterns now have E2E coverage.
- Audit-log silent-swallow regression test:
  `apps/mcp-server/src/utils/__tests__/audit-log.test.ts` (+195 LOC,
  14 tests) pins that when `fs.appendFile` fails, the function does
  not throw to the caller and fires `mcpLogError` on stderr with
  `{tool, runId, errorClass}`.

#### Changed

- `nightly-e2e.yml` now requires 3 consecutive failures before firing
  the alert webhook or opening a sticky GitHub issue (implements the
  documented acceptable-miss window policy).
- `mock-fixture-drift.yml` now fires a webhook on every failure (was
  missing the webhook step entirely). Tracking-issue branch fires for
  both runtime errors and fixture mismatches.
- `docs/explanation/ci-gates.md`: corrected stale env-var name, added
  drift gate inventory row, and clarified the issue-open policy.

#### Removed

- Dead per-node LLM env-var slots removed from
  `packages/core/src/constants/env-vars.ts`:
  `ASSIGNEE_LLM_PLAN_GENERATOR`, `ASSIGNEE_LLM_INTENT_PARSER`,
  `ASSIGNEE_LLM_ADVICE_GENERATOR`, `ASSIGNEE_LLM_WORKLOAD_CLASSIFIER`.
  Factory sites were never built; `ASSIGNEE_LLM_DEFAULT` remains the
  single active slot. `docs/configuration.md` and
  `docs/explanation/ai-architecture.md` updated accordingly.

### Security audit — high-severity findings remediation

Three high-severity security findings addressed: path-traversal guard
on `drift --output-file`, prompt-injection hardening for MCP-derived
snippets, and Bedrock Guardrail visibility in the doctor command.

#### Added

- `apps/cli/src/utils/safe-output-path.ts` — `validateOutputPath`
  rejects NUL bytes, path-traversal escapes, and absolute paths
  outside CWD (CWE-22). `apps/cli/src/commands/drift/orchestrator.ts`
  validates before every `fs.writeFile`.
- `packages/core/src/graph/nodes/advice-generator.ts` now wraps each
  MCP-derived snippet (`pricingSnippet`, `docSnippet`, `securitySnippet`)
  in `stripPromptBoundaryTags` before concatenation into the LLM advice
  prompt, closing the silent-injection vector for drift-poisoned MCP
  responses.
- Bedrock Guardrail missing-state surfacing: Bedrock invocations without
  a configured Guardrail emit a one-time stderr warning and `assignee doctor`
  flags it as a HIGH-severity sub-check. `BEDROCK_GUARDRAIL_DISABLE=1`
  suppresses both surfaces as an informed-acceptance opt-out.

#### Fixed

- `apps/cli/src/commands/doctor.test.ts`: stale `section.status === "ok"`
  assertion updated to set `BEDROCK_GUARDRAIL_DISABLE=1`, isolating the
  LLM-adapter health check from the new Guardrail sub-check.

### Identity scaffolding

#### Added

- `packages/core/src/audit/hmac-chain.ts` — per-tenant HMAC chain
  (`computeChainLink` + `verifyChainLink`). Each audit-log record
  carries `HMAC(key, prevHmac || record_serialised)`; corrupting any
  single record breaks the chain and the verifier identifies the index.
  Meets ISO 27001 A.12.4 logging-and-monitoring for the in-process scope.
- `packages/core/src/audit/audit-log.ts` — append-only audit log with
  chain metadata `{record, hmac, prevHmac, index}`. Writes go through
  the advisory-lock service so concurrent writers don't corrupt the
  chain. File-mode 0o600.
- `packages/core/src/audit/audit-verifier.ts` — chain walker returning
  `{ ok: true }` or `{ ok: false, brokenAt, reason }`. Pre-HMAC records
  bypass the verifier with a clear marker.
- `assignee audit-verify` CLI command — runs the verifier against the
  local audit log; exit 0 on clean, non-zero with diagnostics on a
  broken chain.
- `packages/core/src/rbac/{policy-schema,policy-store,role-context}.ts`
  — Zod schema (role + actions + resource-glob), in-memory and file
  adapters, `"operator"` role context. Five fixtures committed (admin /
  operator / read-only / auditor / restricted). Audit-log records carry
  the role field. RBAC enforcement at command boundaries is deferred.
- `packages/core/src/identity/{oidc-port,in-memory-oidc-adapter}.ts`
  — `OIDCPort` interface (`validateToken`, `extractClaims`,
  `refreshToken`) with a fixture-backed in-memory adapter.
- `apps/cli/src/utils/account-id-validator.ts` — 12-digit numeric
  format, partition-agnostic, rejects placeholder test account IDs.
- `--target-account <ID>` flag on `plan`, `apply`, `destroy` (surface
  only — emits a not-yet-implemented message; single-account flow
  unchanged when the flag is absent).
- `ProcessExitCode.NOT_IMPLEMENTED = 12` enum entry.

#### Compliance

- HMAC chain + verifier satisfies ISO 27001 A.12.4 for in-process
  audit-log writes. KMS-signed S3 object-lock remote sink and RBAC
  command-boundary enforcement are deferred to the enterprise identity
  tier.

### Distribution and release pipeline

#### Added

- `.github/workflows/release.yml` — full build → SBOM → provenance →
  publish pipeline, DRY-RUN-by-default. Eight `ASSIGNEE_RELEASE_PUBLISH=1`
  gates across every publish-side step (npm, binaries, GitHub release,
  smoke-test, SBOM, provenance, Homebrew tap). Nothing publishes until
  the flag is flipped; tag pushes alone produce no external artefacts.
- `CODEOWNERS` at repo root with `* @founder` catch-all baseline.
- `docs/explanation/codeowners-and-branch-protection.md` — SOC 2 CC8.1
  / ISO 27001 A.6.3 control baseline; required-status-checks table and
  `gh api` enablement example.
- `scripts/audit-codeowners.ts` — CI lint asserting `CODEOWNERS` exists,
  parses, and contains a catch-all rule.
- `scripts/verify-domain-mx.ts` and `verify-domain-ownership.ts` —
  re-runnable MX and TXT verification for `assignee.ai` /
  `app.assignee.ai`. Injectable resolver keeps unit tests deterministic.
- `scripts/generate-release-notes.ts` — produces external-facing
  release notes from `git log <from>..<to>`. Groups commits into
  Keep-a-Changelog categories and suppresses internal noise.
- `homebrew/assignee.rb` extended with SHA256 provenance comments and
  `cosign verify-attestation` instructions; the Homebrew tap publish job
  is gated behind both `ASSIGNEE_RELEASE_PUBLISH=1` and
  `ASSIGNEE_TAP_PUBLISH=1`.
- `docs/how-to/release-process.md` and
  `docs/how-to/install-via-homebrew.md` — cover DRY-RUN-by-default
  semantics and the private-tap install path.

#### Fixed

- Remaining unverified `TODO-PIN` SHAs in `release.yml` resolved to
  GitHub-verified values for `anchore/sbom-action`,
  `sigstore/cosign-installer`, and `softprops/action-gh-release`.
  `scripts/audit-action-pins.ts` now exits 0.

### SaaS-backbone scaffolding

#### Added

- `packages/core/src/checkpoint/port.ts` — `CheckpointerPort` Hexagonal
  port (save/load/list/delete/prune). In-memory and file-backed adapters
  ship with shared port-contract test coverage; HMAC + 0o600 +
  atomic-write invariants retained.
- `packages/core/src/locks/advisory-lock-port.ts` and
  `file-advisory-lock.ts` — `AdvisoryLockPort` with `withLock(name, fn)`
  plus a file adapter using `O_CREAT|O_EXCL` atomic acquisition and 10 s
  stale-lock reclamation. Verified with a 10-concurrent-writer contention
  test.
- `packages/core/src/telemetry/telemetry-event-schema.ts`,
  `telemetry-port.ts`, `in-memory-telemetry-adapter.ts` — `TelemetryEvent`
  schema and `TelemetryPort.emit` / `emitFiltered`. Off by default via
  `ASSIGNEE_TELEMETRY_ADAPTER` gate.
- `scripts/backup-provisions.ts` — copies
  `~/.assignee/memory/provisions.json` to dated backups with 7-day
  rotation, 0o600, atomic-write.
- `assignee restore-provisions [--from <date>]` CLI command — restores
  the destroy-safety registry from the latest or specified-date backup.
- 13 of 14 graph nodes (HUMAN_APPROVAL excluded) now emit telemetry at
  entry and exit through `withTelemetry` in `create-graph.ts`.

#### Changed

- Memory-recorder writes (`writeProvisionRecord`, `writeFailureRecord`,
  `upsertPatternRecord`) now acquire the advisory lock around the
  write+fsync, adding concurrency safety without changing semantics.

### EU-residency and partition support

#### Added

- `packages/core/src/utils/url-validator.ts` — scheme allowlist
  (`https://` always; `http://` only for `localhost`). `ASSIGNEE_SAAS_URL`
  and `OLLAMA_BASE_URL` now validate through this helper with actionable
  rejection messages.
- `packages/core/src/saas/saas-url.ts` — region-derived
  `SAAS_API_URL` default (`https://<region>.api.assignee.ai`); explicit
  `ASSIGNEE_SAAS_URL` override validated by the URL validator.
- `packages/core/src/provisioning/ccapi-partition-support.ts` — partition
  × resource-type CCAPI support matrix. S3, IAM, and VPC prefer the
  SDK-direct path in non-commercial partitions even where CCAPI nominally
  works, due to uneven property-surface coverage.
- `packages/core/src/provisioning/partition-aware-provisioner.ts` —
  router dispatching to SDK-direct in non-commercial partitions or
  emitting an actionable "not supported in `<partition>`" message.
- `packages/core/src/provisioning/sdk-direct-fallback/{s3-bucket,iam-role,ec2-vpc}.ts`
  — SDK-direct adapters for S3, IAM, and EC2 VPC in GovCloud / China /
  ISO / EU Sovereign Cloud partitions.
- 7-region matrix tests for region-derivation defaults.

#### Changed

- `DEFAULT_AWS_REGION` derived from `process.env.AWS_REGION` (falls
  back to `us-east-1` only when unset). EU operators with `AWS_REGION`
  set no longer hit US-East defaults.
- Bedrock model invocation derives the inference-profile prefix
  (`eu.` / `ap.` / `us.`) from the resolved region.
- `KNOWN_BEDROCK_REGIONS` updated: adds `eu-west-2` and `eu-north-1`.
- `eu-isoe-west-1` now correctly maps to the `aws-iso-e` partition.
  Synthesised ARNs round-trip parse for all 5 partitions (`aws`,
  `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-e`).

#### Compliance

- GDPR Chapter V (Articles 44-49) cross-border-transfer remediation at
  the technical layer. GovCloud, China, ISO, and EU Sovereign Cloud
  partitions now receive SDK-direct provisioning paths.

### Sensitive-field redaction in plugin memory

#### Added

- `ResourceField.sensitive?: boolean` marker on the plugin elicited-field
  type. Default `false`; existing plugins remain back-compatible.
- `stripSensitiveFromElicited(record, sensitiveNames)` helper in
  `packages/core/src/utils/redact.ts` — replaces sensitive field values
  with `[REDACTED]` before writing to disk.
- `redactLogContent()` in `packages/core/src/telemetry/otel-allowlist.ts`
  — line-by-line allowlist filter used by `scripts/scrub-logs-for-upload.ts`
  before uploading JSONL log artefacts.
- `filterSensitiveElicitedFields(extras, sensitiveNames)` in
  `otel-allowlist.ts` — OTEL emission filter that drops sensitive fields
  from `event.extras`.
- `scripts/migrate-patterns-cleartext.ts` — idempotent dry-run-by-default
  migration that redacts credentials from existing
  `~/.assignee/memory/patterns.json`. Backs up before mutation.
- `scripts/audit-patterns-cleartext.ts` — CI-runnable audit scanning the
  patterns file for credential and AKIA-key patterns.
- Plugin annotations: `rds-dbinstance/credentials.ts` (`MasterUserPassword`),
  `secretsmanager-secret.ts` (`SecretString`), and
  `events-connection.ts` (`AuthParameters`) now declare `sensitive: true`.

#### Fixed

- `upsertPatternRecord` now strips sensitive fields before `JSON.stringify`.
  Pattern-memory records no longer persist credentials elicited by wizards.
- `writeFailureRecord` applies `redactAccountIdsInPrompt()` to the
  captured `errorMessage`, scrubbing AWS account IDs from CloudControl
  error strings before they reach the failure record.
- Checkpointer write path: `stripSensitiveFromElicited` composes
  additively with the existing CFN `desiredState` allowlist.

#### Security

- GDPR Art 32 — cleartext credential storage in plugin pattern-memory and
  checkpoints is closed.

### SSO credential support

#### Added

- `ASSIGNEE_OPERATOR_SESSION_TOKEN` read by the credential resolver and
  forwarded to every AWS SDK client. Required for ASIA-prefixed
  short-term credentials from SSO and assumed-role sessions.
- `--profile <name>` flag on `assignee init` for `~/.aws/config` SSO
  profile resolution via the AWS SDK provider chain
  (`fromIni` → `fromSSO` → `fromNodeProviderChain`).
- `packages/core/src/config/provider-chain.ts` — exports
  `resolveOperatorCredentialProvider()`.
- `packages/core/src/config/sso-refresh.ts` — translates AWS
  `AccessDenied` / `ExpiredToken` errors into actionable
  `aws sso login --profile <name>` hints.
- `docs/how-to/sso-authentication.md` — Diátaxis how-to for the
  supported SSO flow.

#### Fixed

- `AWS_PROFILE` is no longer silently rejected; the credential resolver
  honours the full AWS SDK provider chain.
- `InvalidSessionTokenError` now produces an actionable hint instead
  of an opaque `AccessDenied`.

### Destroy-strategy QA and observability

#### Added

- Per-strategy unit-test coverage for 9 destroy strategies (S3 bucket,
  EC2 internet gateway, EC2 route table, DynamoDB table, EFS file
  system, ELBv2 load balancer, EC2 EIP, CloudFront distribution, SQS
  queue) — happy path plus 3+ edge cases each. vitest enforces ≥80%
  line coverage for `packages/core/src/destroy-strategies/strategies/**`.
- `destroy-only-tagged-invariant.test.ts` — parametrised invariant
  asserting strategies refuse to act on resources missing the Assignee
  management tag.
- `packages/core/src/telemetry/otel-allowlist.ts` — OTEL field-name
  allowlist with `@privacy: PII | SYSTEM | OPERATIONAL` classification.
  PII fields stripped unless `ASSIGNEE_OTEL_INCLUDE_PII=1`.
- `packages/core/src/telemetry/spans.ts` — per-graph-node entry/exit
  span emission across 13 of 14 nodes (HUMAN_APPROVAL excluded).
- `apps/cli/src/e2e/nightly-destroy-smoke.test.ts`
  (`RUN_E2E=1`-gated) — provisions and destroys a fixture per resource
  type with `afterEach` teardown-guard.
- `scripts/cost-ledger-rollup.ts` — weekly aggregation of nightly
  cost-ledger JSONL records.
- `scripts/audit-no-suppress.ts` — CI lint forbidding `|| true`
  suppression on `assignee` CLI invocation lines in composite actions.
- `docs/explanation/ci-gates.md` — documents the merge-policy and
  acceptable-miss window for the nightly E2E gate.

#### Changed

- All 7 concrete destroy strategies now emit non-fatal warnings via
  `DestroyContext.warn` rather than the static `warnDestroy()` helper,
  making warnings unit-testable through the `ctx.warn` mock surface.

### Supply-chain hardening

#### Added

- `pnpm audit --audit-level=moderate --prod` gate in CI.
- `package.json.overrides-rationale.md` — documents the CVE reference
  and mitigation note for every entry in `pnpm.overrides`.
  `scripts/audit-overrides.ts` enforces parity in CI.
- SHA256 verification and signed-manifest version allowlist in
  `scripts/install.sh`. Downgrade to known-vulnerable versions requires
  explicit `ASSIGNEE_DOWNGRADE_ACK=1`. MITM-tampering test fixture in
  `apps/cli/src/e2e/install-sh-mitm.test.ts` (`RUN_INSTALL_MITM_FIXTURE=1`-gated).
- LLM-output sanitizer (`scripts/sanitize-llm-output-for-ci.ts`);
  composite actions `apply` and `plan` now route LLM output through file
  artefacts instead of template-literal interpolation.
- SPDX SBOM-generation and SLSA L2 cosign-signed build-provenance steps
  in the release workflow. `docs/explanation/sbom.md` and
  `docs/explanation/supply-chain-provenance.md`.
- `homebrew/assignee.rb` references the signed release manifest;
  `scripts/audit-homebrew-pin.ts` asserts SHA256 parity.
- Lint scripts: `audit-action-pins.ts`, `audit-secrets-inherit.ts`,
  `audit-overrides.ts`, `audit-homebrew-pin.ts`,
  `scrub-logs-for-upload.ts`.

#### Changed

- Every `uses:` reference across 9 GitHub Actions workflows and 2
  composite actions SHA-pinned to a 40-character commit hash with a
  `# v<N>` comment. `scripts/audit-action-pins.ts` blocks tag/branch
  refs in CI.
- `secrets: inherit` removed from `ci.yml` and `ci-cross-platform.yml`;
  each callee now declares an explicit least-privilege `secrets:` block.
- `nightly-e2e.yml` provisions `RUN_E2E=1` plus AWS test credentials
  and routes failures to `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`.

#### Fixed

- `.github/actions/apply/action.yml` and `.github/actions/plan/action.yml`
  no longer suppress non-zero exit codes with `|| true`. Failed CLI
  runs now propagate as failed composite-action steps.

### Documentation and developer experience

#### Added

- `docs/engineering/changelog-history.md` — engineering-journal history
  with BMAD story IDs, wave labels, and review methodology notes.
- `docs/how-to/quickstart.md` — Quickstart guide re-tagged as a Diátaxis
  how-to (moved from `docs/quickstart.md`).
- `docs/reference/<type>.md` — 38 auto-generated reference pages, one per
  supported AWS resource type, sourced from the help-hints registry.
- `scripts/generate-reference-pages.ts` — generator with `--check` mode
  for CI lint.
- `scripts/generate-notice.ts` — NOTICE + THIRD-PARTY-NOTICES.md generator
  from `pnpm licenses list`; `--check` mode for CI lint.
- `NOTICE` — SPDX-compatible project notice file.
- `THIRD-PARTY-NOTICES.md` — 526 third-party packages with SPDX license IDs.
- `packages/core/src/utils/arn-redactor.ts` — ARN-structure-preserving
  redactor scrubbing account IDs and sensitive resource names before they
  enter LLM context. Allowlist-not-denylist design.

#### Changed

- `.husky/pre-commit` now runs `pnpm check-types` and `pnpm build` in
  addition to `lint-staged` and the AWS-account-ID scan. Uses turbo cache.
  `ASSIGNEE_SKIP_BUILD=1` escape-hatch available.
- `CONTRIBUTING.md` — added pre-commit / pre-push hook split documentation
  and CI enforcement note.
- `docs/index.md` — updated quickstart link to `how-to/quickstart.md`.

#### Fixed

- `packages/core/src/graph/nodes/status-poller.ts` — exponential backoff
  with jitter on 503 / ThrottlingException responses from CloudControl.
  Retry budget: 5 retries, capped at 60 s per delay.
- `packages/core/src/config/org-policy-cache.ts` — cache file written
  with mode `0o600` to prevent world-readable token leakage.
- `packages/core/src/graph/nodes/plan-generator/llm-helpers.ts` — ARN
  redactor wired into `buildPrompt` and `readMemoryHints` before content
  reaches the LLM boundary.

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
