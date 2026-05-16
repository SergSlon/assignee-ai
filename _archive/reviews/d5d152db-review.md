# Reviewer: ACCEPT — qa (Quinn) — 108-B-04-intent-routing-telemetry

**Commit (pre-amend)**: `d5d152db` — feat(telemetry): intent-routing miss-rate telemetry + assignee doctor check
**Round-1**: `e14d2212` — BOUNCED on 4 findings (2 MED telemetry coverage gaps + 2 LOW comment/test)
**Round-2**: `d5d152db` — ACCEPTED
**Base**: `5b15db0d` (origin/main post Wave 1 merges)
**Story spec**: `_bmad-output/implementation-artifacts/epic-108-B-04-intent-routing-telemetry.md`
**Epic**: 108-B Quality Infrastructure — closes Gap 6 (intent-routing miss-rate visibility)

## Scope

- `packages/core/src/graph/nodes/intent-parser/index.ts` — 4 routing branches instrumented (singleton, pattern-registry, llm-fallback, llm-primary, query, destroy, llm-primary-unsupported, llm-zod-error, llm-generic-error) with `emitRoutingTelemetry()` calls; classifierPath set in state update on all paths.
- `packages/core/src/graph/graph-state.ts` — `classifierPath` optional field with `default: () => undefined` reducer (no AgentState bloat, 0 snapshot churn).
- `packages/core/src/telemetry/local-log-writer.ts` (NEW) — `appendRoutingEvent()` async fire-and-forget JSONL append. PII safe: `IntentRoutingEvent` shape omits raw `intent`; only `patternKey`/`resourceType`/`timestamp`/`durationMs`/`classifierPath` stored.
- `packages/core/src/telemetry/telemetry-event-schema.ts` (NEW) — Zod schema for the event shape.
- `apps/cli/src/commands/doctor/checks/intent-routing-health.ts` (NEW) — 9th doctor section reading the JSONL and computing miss-rate.
- `packages/core/src/constants/env-vars.ts` — `ASSIGNEE_TELEMETRY_ADAPTER` env-var entry.
- Tests: `telemetry-emit.test.ts` (9 tests including Axes B+/B- for new emission paths), `local-log-writer.test.ts` (12 tests), `intent-routing-health.test.ts` (13 tests).
- `CHANGELOG.md` — Unreleased entry.

## Round-1 findings (closed in round 2)

- **F1 MED**: destroy branch was emitting `classifierPath: "unsupported"` — inflated miss-rate. Fixed: now emits `"llm-primary"` (destroy is a recognized kind that LLM resolved).
- **F2 MED**: Zod-validation-failure + generic-LLM-error paths returned without emitting telemetry — under-counted unsupported decisions. Fixed: both paths now emit `"unsupported"` with 4-line justifying comment.
- **F3 LOW**: misleading `// TODO 108-B-04 insertion point` comment in graph-state.ts:466. Fixed: rewritten to `// Story 108-B-04 — classifierPath field:` (closed-story marker).
- **F4 LOW**: missing tests for the new error-path emissions. Fixed: 2 new describe blocks ("Axis B+ Zod validation failure" + "Axis B- generic LLM error") with proper `SequentialMockLlm` extension returning `new LlmError("ZodError: ...")`.

## Round-2 verification (Opus reviewer)

- Diff R1→R2: exactly 5 files (intent-parser/index.ts, telemetry-emit.test.ts, graph-state.ts, local-log-writer.test.ts, intent-routing-health.test.ts). No drive-bys.
- TS strictness fixes (non-null assertions for `noUncheckedIndexedAccess` in 2 test files) — legitimate and mechanical; required for build/lint gate. Pre-existing, surfaced by round-2 amend re-running the gate after R1's turbo cache had hidden them.
- Independent tests: 2802 graph tests / 117 files pass (63s). 78 doctor tests pass (7s).
- Reviewer: PENDING token confirmed on last line.
- Anti-regression: concurrent-write safety (POSIX appendFile atomicity) preserved; PII non-emission preserved (resourceType + classifierPath only, no raw intent).
- AC-1 through AC-8 all closed; verified by independent test runs and code reads.

## Verdict

ACCEPT.
