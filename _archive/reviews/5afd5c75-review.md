# Reviewer: ACCEPT — qa (Quinn) — docs-accuracy-sweep-2026-05-16

**Commit (post-rebase)**: `5afd5c75` — docs: code-drift sweep across 10 docs + doc-lint cross-doc guards (15 nodes, +3 patterns, +1 command)
**Pre-amend commit**: `10012e7d` (rebased onto current main)
**Base**: `ccff0a2e` (origin/main after PR #99 merge)
**Story**: docs-audit-2026-05-16 cluster — 21 findings across 10 docs files + doc-lint guard hardening

## Scope (12 files)

- `docs/architecture.md`, `docs/architecture-flows.md`, `docs/integration-architecture.md`, `docs/explanation/ai-architecture.md`, `docs/explanation/oss-vs-saas.md`, `docs/how-to/quickstart.md` — node count `14` → `15` (Epic-104 added `QUERY_HANDLER`)
- `docs/commands.md` — new `### update` section, restore-provisions `--from-audit-log` flag, doctor `BEDROCK_GUARDRAIL_DISABLE=1` opt-out, line-ref corrections
- `docs/resource-types.md` — 3 new compound patterns (`sqs-with-dlq`, `sns-with-email-subscription`, `lambda-with-exec-role`) + promoted `vpc-public-only`
- `docs/troubleshooting.md` — new `STALE_SESSION_TOKEN` entry
- `docs/tutorials/getting-started.md` — Node version `22` → `20.11+`
- `apps/cli/scripts/doc-lint.mjs` — new `graphNodeCount` derived guard (counts `addNode(` in `create-graph.ts`); `patternCount` guard already existed
- `CHANGELOG.md` — Unreleased entry

## Round 1 (commit `71549fa9`) — BOUNCED with 3 findings

- **F1 BLOCKER** `docs/commands.md` — ToC linked to `(#update)` but no section body existed.
- **F2 HIGH** restore-provisions — `--from-audit-log` flag missing.
- **F3 HIGH** doctor section — `BEDROCK_GUARDRAIL_DISABLE` opt-out missing.

Plus commit message contained aspirational claims that didn't match the diff.

## Round 2 (commit `10012e7d`, rebased to `5afd5c75`) — ACCEPT

- **F1 CLOSED**: `### update` section at lines 296-339 with argument + all 8 flags (`-s/--source`, `--delete`, `--invalidation-paths`, `--no-invalidation`, `--wait`, `-y/--yes`, `-o/--output`, `--json`) sourced from `apps/cli/src/commands/update.ts:24-46`; includes Behavior, Prerequisites, and 5 Examples. ToC anchor resolves.
- **F2 CLOSED**: `--from-audit-log` row at line 798 with HMAC-chained audit-log description matching `restore-provisions.ts:294-300`. Behavior paragraph at line 807 explains `apply_resource_created` event replay + mutual-exclusion with `--from` (exit code 73 via `AssigneeError → USAGE_ERROR` mapping at `restore-provisions.ts:318-336`).
- **F3 CLOSED**: `BEDROCK_GUARDRAIL_DISABLE=1` documented at line 685 within doctor Check 2 (Bedrock/LLM), alongside the **Guardrail [HIGH]** sub-check description. Matches `bedrock.ts:143, 146, 160`.

## Verification (Opus reviewer, round 2)

- Diff scope: 1 file in the round-2 amend (`docs/commands.md`); full branch touches 12 files as listed above.
- Anti-fabrication: 3 random `update` flags spot-checked verbatim against `update.ts`.
- doc-lint output verified independently: `patterns=13 types=38 strategies=38 decomposers=38 commands=17 graphNodes=15`.
- citation-lint: 0 broken / 348 citations / 101 files.
- Round-1 fixes (node-count, line-refs, resource-types patterns, STALE_SESSION_TOKEN, Node version, doc-lint guard) all still intact after round-2 amend.
- Doc-lint `graphNodeCount` guard verified DERIVED not hardcoded (reads `create-graph.ts` at runtime; injection test confirmed it fires on drift).
- Commit message: truthful, no aspirational claims, `Reviewer: PENDING` present pre-amend.

## Verdict

ACCEPT.
