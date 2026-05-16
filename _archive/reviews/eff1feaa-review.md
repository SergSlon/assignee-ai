# Reviewer: ACCEPT — qa (Quinn) — docs-env-example-2026-05-16

**Commit (pre-amend)**: `eff1feaa` — docs(env-example): rewrite to match current code
**Base**: `a6b66db4` (origin/main)
**Story**: `.env.example` rewrite per docs-audit-2026-05-16

## Scope

- `.env.example` — full rewrite to match current production env-var consumers; 20 vars added, 5 stale blocks dropped, 3 description mismatches fixed, regrouped into 13 sections (required → optional → CI-only → test gates → SaaS future). Descriptions lifted verbatim from JSDoc in `packages/core/src/constants/env-vars.ts`.
- `CHANGELOG.md` — Unreleased entry documenting the rewrite.

## Verification (Opus reviewer, single round)

**Diff scope**: PASS — exactly 2 files (.env.example +387/-123, CHANGELOG.md +4).

**Add-claims spot-check (5 of 20 vars verified)**:

- `ASSIGNEE_TELEMETRY_ADAPTER` — old=0, new=2, prod consumer at `packages/core/src/ports/telemetry-port.ts:66` ✅
- `ASSIGNEE_AUDIT_KEY` — old=0, new≥1, prod consumer at `packages/core/src/audit/hmac-chain.ts:199` ✅
- `ASSIGNEE_AUDIT_FSYNC` — old=0, new≥1, prod consumer at `apps/cli/src/utils/audit-log.ts:202` ✅
- `ASSIGNEE_OTEL_INCLUDE_PII` — old=0, new≥1, prod consumer at `packages/core/src/telemetry/otel-allowlist.ts:235` ✅
- `ASSIGNEE_NO_CLARIFIER` — old=0, new≥1, prod consumer at `apps/cli/src/services/clarifier.ts:126` ✅

**Drop-claims (production grep, .test.ts/dist/ excluded)**:

- `ASSIGNEE_OUTPUT_FORMAT` — 0 prod reads (only JSDoc-only mention in `env-overrides.ts:12`) ✅
- 4× per-node LLM routing vars — 0 prod reads (retired per env-vars.ts:57-66) ✅
- `ASSIGNEE_ENABLE_REMOTE_MCP` — 0 prod reads (retired per env-vars.ts:267-272, only retirement-doc + test references) ✅
- `ASSIGNEE_BP_INTEGRITY` / `_SIGNING_KEY` / `_REQUIRE_SIGNATURE` trio — 0 prod reads ✅

**Mismatch fixes**:

- `ASSIGNEE_LOG_RETENTION_DAYS` default 30 now matches `MINIMUM_LOG_RETENTION_DAYS=30` in `apps/cli/src/commands/doctor/checks/retention.ts:37` ✅
- `ASSIGNEE_OTEL_SERVICE_NAME` now commented-out (clearly optional) ✅
- Per-node LLM block replaced with retired-notice ✅

**JSDoc fidelity (3 random)**: `ASSIGNEE_LLM_MAX_RETRIES`, `ASSIGNEE_NIGHTLY_BUDGET_USD`, `ASSIGNEE_NIGHTLY_LEDGER_DIR` — descriptions verbatim or near-verbatim against `env-vars.ts:121-126, :181-188, :190-195`. ✅

**Section structure**: 13/13 sections present, all vars commented out by default ✅.

**Anti-fabrication**: `init.ts:211` reads `ASSIGNEE_OIDC_ADAPTER` ✅; `telemetry-port.ts:9-10` contains the lifted description ✅.

**Adversarial completeness**: `comm` of `env-vars.ts` vs new `.env.example` — only omissions are the 4 deliberately-dropped vars. No accidental missing prod vars.

## Non-blocking observations

- F1 [LOW] CHANGELOG bullet says "17 missing prod vars" but commit body says "20 (17 audit + 3 bonus)". Off-by-3 in user-facing changelog. Cosmetic; not a blocker.
- F2 [LOW] Nightly/FinOps vars are read only in `nightly-destroy-smoke.test.ts`, not main-process code. Section warning makes scope clear; CI operators do need to know about them, so retention is defensible.

## Verdict

ACCEPT.
